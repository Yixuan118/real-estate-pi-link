import { spawn } from "node:child_process";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Property, SearchCriteria } from "../core/types";
import { DEFAULT_LLM_MODEL } from "../config";


export interface PiAgentActivity {
  agent: string;
  action: string;
  detail: string;
}

export interface PiRuntimeResult {
  assistant_message: string;
  agent_activity: PiAgentActivity[];
  ranked_property_ids: string[];
  warnings: string[];
  properties?: any[];
  data_error?: string;
}

export interface PiRuntimeInput {
  userMessage: string;
  criteria: unknown;
  properties: unknown[];
}

class PiRuntimeService {
  async analyze(input: PiRuntimeInput): Promise<PiRuntimeResult> {
    let scrapeSource = "";
    let scrapeWarning = "";
    console.log("[PiRuntime] mode=pi-collaborating-agents, using .claude/skills/firecrawl-real-estate-scraper/SKILL.md");
    if (process.env.PI_RUNTIME_ENABLED !== "true") {
      throw new Error("Pi runtime is disabled. Set PI_RUNTIME_ENABLED=true.");
    }

    const repoRoot =
      process.env.RE_PROJECT_ROOT || path.resolve(process.cwd(), "..");

    // Listing research is part of PiRuntime; there is no separate/basic scraper mode.
    if (!input.properties || input.properties.length === 0) {
      console.log("[PiRuntime] researching listings via Firecrawl...");
      try {
        const { FirecrawlSkill } = await import("../skills/firecrawl-skill");
        const fcSkill = new FirecrawlSkill();
        const fcResult = await fcSkill.searchProperties(input.criteria as any);
        if (fcResult.error && (!fcResult.properties || fcResult.properties.length === 0)) {
          const message = `Live Realtor listing retrieval failed: ${fcResult.error}. Demo properties were not substituted. Check the Firecrawl quota, API key, and service status, then retry.`;
          return {
            assistant_message: message,
            agent_activity: [
              { agent: "ScraperAgent", action: "error", detail: fcResult.error },
              { agent: "ValidationAgent", action: "stopped", detail: "No live properties were available; demo properties were not substituted." },
            ],
            ranked_property_ids: [],
            warnings: [message],
            properties: [],
            data_error: fcResult.error,
          };
        }
        if (fcResult.properties && fcResult.properties.length > 0) {
          (input as any).properties = fcResult.properties;
          (input as any).scrapedProperties = fcResult.properties;
          scrapeSource = fcResult.source;
          scrapeWarning = fcResult.error || "";
          console.log("[PiRuntime] Firecrawl returned", fcResult.properties.length, "properties from", fcResult.source);
        } else {
          console.log("[PiRuntime] Firecrawl returned 0 properties, keeping empty");
        }
      } catch (err: any) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log("[PiRuntime] Firecrawl scrape error:", detail);
        return {
          assistant_message: `Live Realtor listing retrieval failed: ${detail}. Demo properties were not substituted.`,
          agent_activity: [{ agent: "ScraperAgent", action: "error", detail }],
          ranked_property_ids: [], warnings: [detail], properties: [], data_error: detail,
        };
      }
    }

    // Embed compact data directly in prompt (no file IO -> more reliable on Windows)
    const compactProps = Array.isArray(input.properties)
      ? input.properties.slice(0, 20).map((p: any) => ({
          id: p.id, title: p.title, price: p.price,
          bedrooms: p.bedrooms, bathrooms: p.bathrooms,
          fullBathrooms: p.fullBathrooms, halfBathrooms: p.halfBathrooms,
          sqft: p.sqft, sqftSource: p.sqftSource,
          location: p.location, features: p.features,
          latitude: p.latitude, longitude: p.longitude,
          exteriorMaterials: p.exteriorMaterials, exteriorCoverage: p.exteriorCoverage,
          communityFeatures: p.communityFeatures, nearbyPlaces: p.nearbyPlaces,
          nearbyWaterBodies: p.nearbyWaterBodies,
          listingFacts: p.listingFacts,
          listingEvidenceSourceUrl: p.listingEvidenceSourceUrl,
          schools: p.schools,
          schoolDistricts: p.schoolDistricts,
          distanceEvaluations: p.distanceEvaluations, coordinateSource: p.coordinateSource,
          highwayAccessEvaluation: p.highwayAccessEvaluation,
          evidenceDiagnostics: p.evidenceDiagnostics,
          criteriaMatch: p.criteriaMatch,
        }))
      : [];

    // Single LLM call: pi orchestrates all 4 agents internally (matches baochunli/pi-collaborating-agents pattern)
    const agentsContent = this.readAgentsMd();
    const skillContent = this.readSkillMd();
    const dataStr = "User: " + input.userMessage + "\nCriteria: " + JSON.stringify(input.criteria, null, 2) + "\nProperties: " + JSON.stringify(compactProps, null, 2);
    const fullPrompt = [
      "## Pi Collaborating Agents Instructions",
      agentsContent,
      "",
      "## Firecrawl Real Estate Scraper Skill",
      skillContent,
      "",
      "## Task",
      "Coordinate the 4 subagents (IntentAgent, ValidationAgent, RankingAgent, ReporterAgent) to analyze the following real estate data.",
      "IntentAgent must interpret mildly ambiguous natural language using ordinary real-estate meaning, preserve explicit numeric constraints, and report material assumptions. Official assignment-option pools follow criteria.schoolAlternativePolicy.",
      "Treat criteriaMatch evidence as authoritative. Never claim an unknown constraint is satisfied. Exclude failed properties and rank verified matches before unknown candidates.",
      "Never infer distance from Athens, a ZIP code, or general area membership; only a verified criteriaMatch check proves the distance requirement.",
      "",
      "## Input Data",
      dataStr,
      "",
      "## Required Output Schema",
      '{ "assistant_message": "string",',
      '  "agent_activity": [',
      '    { "agent": "IntentAgent", "action": "checked", "detail": "..." },',
      '    { "agent": "ValidationAgent", "action": "validated", "detail": "..." },',
      '    { "agent": "RankingAgent", "action": "ranked", "detail": "..." },',
      '    { "agent": "ReporterAgent", "action": "reported", "detail": "..." }',
      "  ],",
      '  "ranked_property_ids": ["id1"],',
      '  "warnings": ["..."]',
      "}",
    ].join("\n");
    const raw = await this.callLLM(fullPrompt);
    const result = this.parseJson(raw);
    this.applyDeterministicCollaboration(result, (input.properties || []).slice(0, 20) as Property[], input.criteria as SearchCriteria);
    if (scrapeWarning) {
      result.warnings.push(scrapeWarning);
      result.agent_activity.unshift({
        agent: "ScraperAgent",
        action: "cached-fallback",
        detail: `${scrapeSource}: ${scrapeWarning}`,
      });
    }
    if ((input as any).scrapedProperties) result.properties = (input as any).scrapedProperties;
    return result;
  }
  private applyDeterministicCollaboration(result: PiRuntimeResult, properties: Property[], criteria: SearchCriteria): void {
    const statusOrder = { verified: 0, unknown: 1, failed: 2 } as const;
    const ranked = [...properties].sort((a, b) => {
      const aMatch = a.criteriaMatch, bMatch = b.criteriaMatch;
      const statusDifference = (statusOrder[aMatch?.overall || "unknown"] - statusOrder[bMatch?.overall || "unknown"]);
      if (statusDifference !== 0) return statusDifference;
      const scoreDifference = (bMatch?.score || 0) - (aMatch?.score || 0);
      return scoreDifference !== 0 ? scoreDifference : a.price - b.price;
    });
    const verified = properties.filter((property) => property.criteriaMatch?.overall === "verified").length;
    const failed = properties.filter((property) => property.criteriaMatch?.overall === "failed").length;
    const unknown = properties.length - verified - failed;
    const criteriaSummary = [
      ...(criteria.exteriorMaterials || []).map((item) => `exterior:${item}`),
      ...(criteria.communityFeatures || []).map((item) => `community:${item}`),
      ...(criteria.distanceConstraints || []).map((item) => `${item.name}<=${item.maxMiles}mi`),
      ...(criteria.highwayAccess ? [`${criteria.highwayAccess.highwayName} access<=${criteria.highwayAccess.maxMiles}mi`] : []),
      ...(criteria.schoolMinRating != null ? [`${criteria.schoolAssignmentRequired ? "property-associated (Realtor page or official locator)" : "Realtor-listed"} K-12 schools>=${criteria.schoolMinRating}/10`] : []),
      ...(criteria.schoolAtLeastOneRating != null ? [`at least one school>=${criteria.schoolAtLeastOneRating}/10`] : []),
    ].join(", ");
    const checks = properties.flatMap((property) => property.criteriaMatch?.checks || []);
    const criterionNames = [...new Set(checks.map((check) => check.criterion))];
    const warnings = criterionNames
      .filter((criterion) => !checks.some((check) => check.criterion === criterion && check.status === "verified"))
      .map((criterion) => `No analyzed property has verified evidence for ${criterion}.`);

    result.ranked_property_ids = ranked.map((property) => property.id);
    result.warnings = warnings;
    result.agent_activity = [
      { agent: "IntentAgent", action: "checked", detail: `Parsed criteria (${criteriaSummary || "basic search"}) and received exactly ${properties.length} properties for collaborative analysis.` },
      { agent: "ValidationAgent", action: "validated", detail: `Evidence status: ${verified} verified, ${unknown} unknown, ${failed} failed. Only criteriaMatch checks were used.` },
      { agent: "RankingAgent", action: "ranked", detail: `Deterministic order by overall status, evidence score, then price: ${result.ranked_property_ids.join(", ") || "none"}.` },
      { agent: "ReporterAgent", action: "reported", detail: `Prepared an evidence-only report for ${properties.length} analyzed properties; unknown checks were not described as satisfied.` },
    ];
    result.assistant_message = `Analyzed ${properties.length} properties: ${verified} verified, ${unknown} unknown, ${failed} failed.`;
  }
private async callLLM(prompt: string): Promise<string> {
    const apiKey = process.env.DEEPSEEK_API_KEY || "";
    const model = process.env.RE_LLM_MODEL || DEFAULT_LLM_MODEL;
    const baseUrl = process.env.RE_LLM_BASE_URL || "https://api.deepseek.com";
    if (!apiKey) throw new Error("No DEEPSEEK_API_KEY configured");
    const response = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a real estate multi-agent coordinator. Follow the Pi Collaborating Agents instructions." },
          { role: "user", content: prompt },
        ],
        // response_format removed - model may not support it
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 300)}`);
    }
    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("DeepSeek returned an empty response");
    return String(content);
  }

    private readAgentsMd(): string {
    try {
      const p = path.resolve(process.cwd(), "..", "AGENTS.md");
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch {}
    return "Roles: IntentAgent, ValidationAgent, RankingAgent, ReporterAgent.";
  }

  private readSkillMd(): string {
    try {
      const p = path.resolve(process.cwd(), "..", ".claude/skills/firecrawl-real-estate-scraper/SKILL.md");
      if (existsSync(p)) return readFileSync(p, "utf-8");
    } catch {}
    return "Firecrawl Real Estate Scraper skill for property scraping.";
  }

  private parseJson(raw: string): PiRuntimeResult {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Pi did not return valid JSON. Raw output: " + raw.slice(0, 500));
    }

    const parsed = JSON.parse(raw.slice(start, end + 1));

    return {
      assistant_message:
        typeof parsed.assistant_message === "string"
          ? parsed.assistant_message
          : "Pi collaborating agents completed the analysis.",
      agent_activity: Array.isArray(parsed.agent_activity)
        ? parsed.agent_activity
        : [],
      ranked_property_ids: Array.isArray(parsed.ranked_property_ids)
        ? parsed.ranked_property_ids
        : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  }
}

export const piRuntimeService = new PiRuntimeService();
