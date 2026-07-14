import { spawn } from "node:child_process";
import * as path from "node:path";


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
}

export interface PiRuntimeInput {
  userMessage: string;
  criteria: unknown;
  properties: unknown[];
  mode?: string;
}

class PiRuntimeService {
  async analyze(input: PiRuntimeInput): Promise<PiRuntimeResult> {
    const mode = input.mode || "basic";
    let scrapeSource = "";
    if (mode === "agent-scrape") {
      console.log("[PiRuntime] mode=" + mode + ", using .claude/skills/firecrawl-real-estate-scraper/SKILL.md");
    }
    if (process.env.PI_RUNTIME_ENABLED !== "true") {
      throw new Error("Pi runtime is disabled. Set PI_RUNTIME_ENABLED=true.");
    }

    const repoRoot =
      process.env.RE_PROJECT_ROOT || path.resolve(process.cwd(), "..");

    // For agent-scrape mode, scrape properties via Firecrawl directly (Pi -p cannot call MCP)
    // This gives Pi real data to analyze with the SKILL.md workflow
    if (mode === "agent-scrape" && (!input.properties || input.properties.length === 0)) {
      console.log("[PiRuntime] agent-scrape mode: scraping via Firecrawl...");
      try {
        const { FirecrawlSkill } = await import("../skills/firecrawl-skill");
        const fcSkill = new FirecrawlSkill();
        const fcResult = await fcSkill.searchProperties(input.criteria as any);
        if (fcResult.properties && fcResult.properties.length > 0) {
          (input as any).properties = fcResult.properties;
          (input as any).scrapedProperties = fcResult.properties;
          scrapeSource = fcResult.source;
          console.log("[PiRuntime] Firecrawl returned", fcResult.properties.length, "properties from", fcResult.source);
        } else {
          console.log("[PiRuntime] Firecrawl returned 0 properties, keeping empty");
        }
      } catch (err: any) {
        console.log("[PiRuntime] Firecrawl scrape error:", err.message);
      }
    }

    // Embed compact data directly in prompt (no file IO -> more reliable on Windows)
    const compactProps = Array.isArray(input.properties)
      ? input.properties.slice(0, 5).map((p: any) => ({
          id: p.id, title: p.title, price: p.price,
          bedrooms: p.bedrooms, bathrooms: p.bathrooms, sqft: p.sqft,
          location: p.location, features: p.features,
        }))
      : [];

    const prompt = mode === "agent-scrape"
      ? [
          "Use the collaborating-agents-system skill.",
          "",
          "Read the Firecrawl Real Estate Scraper skill:",
          ".claude/skills/firecrawl-real-estate-scraper/SKILL.md",
          "",
          "Properties were scraped via Firecrawl from Realtor.com using JSON-LD extraction.",
          "Your task: validate, normalize, and rank these properties using the skill schema.",
          "",
          "Coordinate three subagents:",
          "1. CriterionEvaluator - validate criteria and properties against the skill schema",
          "2. Ranker - rank properties by user criteria using the skill output format",
          "3. ReporterAgent - produce final answer and JSON",
          "",
          "Rules: Do not edit files. Do not expose API keys. Use only data below. Return JSON only.",
          "",
          "User:", input.userMessage,
          "Criteria:", JSON.stringify(input.criteria, null, 2),
          "Properties:", JSON.stringify(compactProps, null, 2),
          "",
          "Output schema:",
          '{ "assistant_message": "string",',
          '  "agent_activity": [',
          '    { "agent": "CriterionEvaluator", "action": "checked", "detail": "..." },',
          '    { "agent": "Ranker", "action": "ranked", "detail": "..." },',
          '    { "agent": "ReporterAgent", "action": "reported", "detail": "..." }',
          "  ],",
          '  "ranked_property_ids": ["id1"],',
          '  "warnings": ["..."]',
          "}",
        ].join("\n")
      : [
          "Analyze this real estate search result and return JSON only.",
          "",
          "User:", input.userMessage,
          "Criteria:", JSON.stringify(input.criteria, null, 2),
          "Properties:", JSON.stringify(compactProps, null, 2),
          "",
          "Output schema:",
          '{ "assistant_message": "string",',
          '  "agent_activity": [',
          '    { "agent": "PiRuntime", "action": "analysis", "detail": "..." }',
          "  ],",
          '  "ranked_property_ids": ["id1"],',
          '  "warnings": ["..."]',
          "}",
        ].join("\n");

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
    if ((input as any).scrapedProperties) result.properties = (input as any).scrapedProperties;
    return result;
  }
private callLLM(prompt: string): Promise<string> {
    const apiKey = process.env.DEEPSEEK_API_KEY || "";
    const model = process.env.RE_LLM_MODEL || "deepseek-chat";
    const baseUrl = process.env.RE_LLM_BASE_URL || "https://api.deepseek.com";
    if (!apiKey) return Promise.reject(new Error("No DEEPSEEK_API_KEY configured"));
    return fetch(baseUrl + "/chat/completions", {
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
    }).then(function(r) { if (!r.ok) r.text().then(function(t: any){throw new Error("API " + r.status + ": " + t.substring(0,200))}); return r.json(); })
    .then(function(data: any) { return data.choices?.[0]?.message?.content || ""; });
  }

    private readAgentsMd(): string {
    try {
      const fs = require("fs");
      const path = require("path");
      const p = path.resolve(process.cwd(), "..", "AGENTS.md");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    } catch {}
    return "Roles: IntentAgent, ValidationAgent, RankingAgent, ReporterAgent.";
  }

  private readSkillMd(): string {
    try {
      const fs = require("fs");
      const path = require("path");
      const p = path.resolve(process.cwd(), "..", ".claude/skills/firecrawl-real-estate-scraper/SKILL.md");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
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
