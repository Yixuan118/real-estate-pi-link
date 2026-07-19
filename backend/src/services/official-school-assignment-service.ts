import { Property, SchoolDistrictEvidence, SchoolEvidence } from "../core/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { firecrawlRequestBudget } from "./firecrawl-request-budget";
import { defaultCacheFile, PersistentJsonCache } from "./persistent-json-cache";
import { readEnvironmentSecret } from "./environment-secret";
import { createRequire } from "node:module";

type FetchLike = typeof fetch;

export interface OfficialSchoolLocatorConfig {
  districtGeoid?: string;
  districtName?: string;
  sourceUrl: string;
  layers: Array<{
    type: SchoolEvidence["type"];
    queryUrl: string;
    nameField: string;
    gradesField?: string;
  }>;
}

interface AssignmentResult {
  districts: SchoolDistrictEvidence[];
  schools: SchoolEvidence[];
  locatorConfigured: boolean;
}

const CENSUS_SOURCE = "https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html";
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (buffer: Buffer) => Promise<{ text: string }>;
const CLARKE_GEOID = "1301170";
const CLARKE_STREET_INDEX = "https://files-backend.assets.thrillshare.com/documents/asset/uploaded_file/4638/Ccsd/d2f87f00-63f6-4034-abe5-b069b7a9131e/STREET-INDEX---REVISED-6.3.26.xlsx---All.pdf?disposition=inline";

export class OfficialSchoolAssignmentService {
  private readonly cache = new Map<string, Promise<AssignmentResult>>();
  private clarkeStreetIndexContent?: Promise<string>;
  private readonly documentCache: PersistentJsonCache<string>;
  private readonly assignmentCache: PersistentJsonCache<AssignmentResult>;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly locators: OfficialSchoolLocatorConfig[] = readLocatorConfig(),
    private readonly firecrawlApiKey = readEnvironmentSecret("FIRECRAWL_API_KEY"),
    cacheFile = fetchImpl === fetch ? defaultCacheFile("official-school-documents.json") : "",
    private readonly allowCensusFirecrawlFallback = /^(?:1|true|yes)$/i.test(process.env.RE_CENSUS_FIRECRAWL_FALLBACK || ""),
    private readonly clarkeStreetIndexLoader?: () => Promise<string>,
    assignmentCacheFile = fetchImpl === fetch ? defaultCacheFile("official-school-assignments.json") : "",
  ) {
    this.documentCache = new PersistentJsonCache<string>(cacheFile);
    this.assignmentCache = new PersistentJsonCache<AssignmentResult>(assignmentCacheFile);
  }

  async enrichProperty(property: Property): Promise<Property> {
    const existingOfficial = (property.schools || []).filter((school) =>
      school.relationship === "assigned" || school.relationship === "assignment-option");
    const existingTypes = new Set(existingOfficial.map((school) => school.type));
    if (["elementary", "middle", "high"].every((type) => existingTypes.has(type as SchoolEvidence["type"]))) {
      return addDiagnostic(property, "school-assignment", "success",
        `Reused complete official assignment evidence for ${existingOfficial.map((school) => school.name).join(", ")}.`);
    }
    if (property.latitude == null || property.longitude == null) {
      return addDiagnostic(property, "school-assignment", "warning", "Property coordinates are unavailable; official school assignment cannot be resolved.");
    }
    const key = `${property.latitude.toFixed(5)},${property.longitude.toFixed(5)}`;
    let request = this.cache.get(key);
    if (!request) {
      const persisted = this.assignmentCache.get(key);
      request = persisted
        ? Promise.resolve(persisted)
        : this.resolve(property.latitude, property.longitude, property.title).then((result) => {
            this.assignmentCache.set(key, result, 30 * 24 * 60 * 60 * 1000);
            return result;
          });
      this.cache.set(key, request);
    }
    try {
      const result = await request;
      let enriched: Property = { ...property, schoolDistricts: result.districts, schools: mergeSchools(property.schools || [], result.schools) };
      const assignedTypes = new Set(result.schools.filter((school) => school.relationship === "assigned").map((school) => school.type));
      const completeAssignment = ["elementary", "middle", "high"].every((type) => assignedTypes.has(type as SchoolEvidence["type"]));
      enriched = addDiagnostic(enriched, "school-district", result.districts.length ? "success" : "warning",
        result.districts.length
          ? `US Census/NCES district: ${result.districts.map((district) => district.name).join(", ")}.`
          : "US Census Geocoder returned no school district for these coordinates.");
      return addDiagnostic(enriched, "school-assignment", completeAssignment ? "success" : "warning",
        completeAssignment
          ? `Official locator assigned: ${result.schools.map((school) => school.name).join(", ")}.`
          : result.schools.length
            ? `Official locator returned only a partial assignment: ${result.schools.map((school) => school.name).join(", ")}; one or more grade levels are not uniquely assigned by the source.`
          : result.locatorConfigured
            ? "The configured official locator returned no elementary/middle/high assignment for this point."
            : "The school district is known, but no official attendance-zone locator adapter is configured for it.");
    } catch (error) {
      this.cache.delete(key);
      return addDiagnostic(property, "school-assignment", "error", `Official school assignment lookup failed: ${safeError(error)}`);
    }
  }

  private async resolve(lat: number, lng: number, address: string): Promise<AssignmentResult> {
    const districts = await this.resolveDistricts(lat, lng);
    const matching = this.locators.filter((locator) => districts.some((district) =>
      (locator.districtGeoid && locator.districtGeoid === district.geoid)
      || (locator.districtName && normalize(locator.districtName) === normalize(district.name))));
    let schools = (await Promise.all(matching.flatMap((locator) => locator.layers.map((layer) =>
      this.queryArcGisLayer(locator, layer, lat, lng))))).flat().filter(Boolean) as SchoolEvidence[];
    if (!schools.length && districts.some((district) => district.geoid === CLARKE_GEOID)) {
      schools = await this.queryClarkeStreetIndex(address);
    }
    const builtInClarkeLocator = districts.some((district) => district.geoid === CLARKE_GEOID);
    return { districts, schools: mergeSchools([], schools), locatorConfigured: matching.length > 0 || builtInClarkeLocator };
  }

  private async queryClarkeStreetIndex(address: string): Promise<SchoolEvidence[]> {
    const parsed = parseStreetAddress(address);
    if (!parsed) return [];
    try {
      const fullIndex = await this.loadClarkeStreetIndex();
      const directMatch = extractClarkeStreetAssignment(fullIndex, parsed.street, parsed.number);
      if (directMatch.length) return directMatch;
    } catch (error) {
      // The exact-address search below is a lower-cost fallback when PDF parsing is temporarily unavailable.
      console.warn("[SchoolAssignment] Direct CCSD Street Index parse failed:", safeError(error));
    }
    const fallbackSetting = process.env.RE_CCSD_FIRECRAWL_FALLBACK;
    const fallbackAllowed = fallbackSetting == null || /^(?:1|true|yes)$/i.test(fallbackSetting);
    if (!this.firecrawlApiKey || !fallbackAllowed) return [];
    firecrawlRequestBudget.consume("official school street-index fallback search");
    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.firecrawlApiKey}` },
      body: JSON.stringify({
        query: `site:files-backend.assets.thrillshare.com/documents/asset/uploaded_file/4638/Ccsd/d2f87f00 "${parsed.street}"`,
        limit: 3, sources: ["web"], includeDomains: ["files-backend.assets.thrillshare.com"], country: "US", timeout: 30000,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`Clarke County official Street Index search HTTP ${response.status}`);
    const payload: any = await response.json();
    firecrawlRequestBudget.settle("official school street-index fallback search", payload.creditsUsed);
    const web = Array.isArray(payload.data?.web) ? payload.data.web : [];
    const content = web.filter((item: any) => String(item.url || "").includes("d2f87f00-63f6-4034-abe5-b069b7a9131e"))
      .map((item: any) => `${item.title || ""}\n${item.description || ""}\n${item.markdown || ""}`).join("\n");
    return extractClarkeStreetAssignment(content, parsed.street, parsed.number);
  }

  private loadClarkeStreetIndex(): Promise<string> {
    if (this.clarkeStreetIndexContent) return this.clarkeStreetIndexContent;
    const persisted = this.documentCache.get("ccsd-street-index");
    if (persisted) return Promise.resolve(persisted);
    this.clarkeStreetIndexContent = (async () => {
      const content = this.clarkeStreetIndexLoader
        ? await this.clarkeStreetIndexLoader()
        : await this.downloadAndParseClarkeStreetIndex();
      if (!content.trim()) throw new Error("Clarke County official Street Index PDF returned no text");
      this.documentCache.set("ccsd-street-index", content, 7 * 24 * 60 * 60 * 1000);
      return content;
    })();
    return this.clarkeStreetIndexContent;
  }

  private async downloadAndParseClarkeStreetIndex(): Promise<string> {
    try {
      const response = await this.fetchImpl(CLARKE_STREET_INDEX, {
        headers: { "User-Agent": "real-estate-school-project/1.0" },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`official host HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const parsed = await pdfParse(buffer);
      if (parsed.text?.trim()) return parsed.text;
      throw new Error("local PDF parser returned no text");
    } catch (directError) {
      if (!this.firecrawlApiKey) throw directError;
      // One document-level fallback replaces the previous per-address searches.
      firecrawlRequestBudget.consume("official CCSD Street Index PDF");
      const response = await this.fetchImpl("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.firecrawlApiKey}` },
        body: JSON.stringify({
          url: CLARKE_STREET_INDEX, formats: ["markdown"],
          parsers: [{ type: "pdf", mode: "fast" }], onlyMainContent: true,
          maxAge: 604800000, timeout: 120000,
        }),
        signal: AbortSignal.timeout(135000),
      });
      if (!response.ok) throw new Error(`Clarke County official Street Index PDF HTTP ${response.status}`);
      const payload: any = await response.json();
      firecrawlRequestBudget.settle("official CCSD Street Index PDF", payload.creditsUsed);
      const content = String(payload.data?.markdown || payload.data?.content || payload.data?.rawHtml || "");
      if (!content.trim() || /AccessDenied|<Code>\s*AccessDenied/i.test(content)) {
        throw new Error("Clarke County official Street Index is currently access-denied by its document host");
      }
      return content;
    }
  }

  private async resolveDistricts(lat: number, lng: number): Promise<SchoolDistrictEvidence[]> {
    const url = new URL("https://geocoding.geo.census.gov/geocoder/geographies/coordinates");
    url.search = new URLSearchParams({
      x: String(lng), y: String(lat), benchmark: "Public_AR_Current", vintage: "Current_Current",
      layers: "14,16,18", format: "json",
    }).toString();
    let payload: any;
    let primaryError: unknown;
    if (process.platform === "win32" && this.fetchImpl === fetch) {
      try {
        payload = await this.fetchCensusViaPowerShell(url);
      } catch (error) {
        primaryError = error;
      }
    }
    if (!payload) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": "real-estate-school-project/1.0" },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`Census school district HTTP ${response.status}`);
        payload = await response.json();
      } catch (directError) {
        const combinedError = primaryError
          ? new Error(`PowerShell: ${safeError(primaryError)}; Node: ${safeError(directError)}`)
          : directError;
        if (!this.firecrawlApiKey) {
          throw new Error(`Census school district request failed (${safeError(combinedError)}); FIRECRAWL_API_KEY is unavailable for proxy fallback.`);
        }
        payload = await this.fetchCensusViaFirecrawl(url, combinedError);
      }
    }
    const geographies = payload.result?.geographies || {};
    const checkedAt = new Date().toISOString();
    return Object.entries(geographies).flatMap(([key, values]) => {
      if (!/School Districts/i.test(key) || !Array.isArray(values)) return [];
      const level: SchoolDistrictEvidence["level"] = /Elementary/i.test(key) ? "elementary" : /Secondary/i.test(key) ? "secondary" : "unified";
      return values.map((value: any) => ({
        name: String(value.NAME || value.BASENAME || "Unknown school district"),
        geoid: String(value.GEOID || ""), level, lowGrade: value.LOGRADE, highGrade: value.HIGRADE,
        source: "US Census/NCES" as const, sourceUrl: CENSUS_SOURCE, checkedAt,
      }));
    });
  }

  private async fetchCensusViaPowerShell(url: URL): Promise<any> {
    const command = "$ProgressPreference='SilentlyContinue'; Invoke-RestMethod -Uri $env:RE_CENSUS_URL -TimeoutSec 25 | ConvertTo-Json -Depth 12 -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      timeout: 35000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, RE_CENSUS_URL: url.toString() },
      windowsHide: true,
    });
    return JSON.parse(stdout);
  }

  private async fetchCensusViaFirecrawl(url: URL, directError: unknown): Promise<any> {
    if (!this.allowCensusFirecrawlFallback) {
      throw new Error(`Census direct request failed (${safeError(directError)}); Firecrawl Census fallback is disabled to control cost.`);
    }
    firecrawlRequestBudget.consume("Census geocoder proxy fallback");
    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.firecrawlApiKey}` },
      body: JSON.stringify({
        url: url.toString(), formats: ["rawHtml", "markdown"], onlyMainContent: false,
        maxAge: 2592000000, timeout: 30000, proxy: "auto", location: { country: "US", languages: ["en-US"] },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      throw new Error(`Census direct request failed (${safeError(directError)}); Firecrawl proxy HTTP ${response.status}.`);
    }
    const wrapper: any = await response.json();
    const content = String(wrapper.data?.rawHtml || wrapper.data?.markdown || wrapper.data?.content || "");
    const parsed = parseJsonDocument(content);
    if (!parsed) throw new Error(`Census direct request failed (${safeError(directError)}); Firecrawl proxy returned no parseable Census JSON.`);
    return parsed;
  }

  private async queryArcGisLayer(
    locator: OfficialSchoolLocatorConfig,
    layer: OfficialSchoolLocatorConfig["layers"][number],
    lat: number,
    lng: number,
  ): Promise<SchoolEvidence | null> {
    const url = new URL(layer.queryUrl.replace(/\/$/, "") + (layer.queryUrl.endsWith("/query") ? "" : "/query"));
    url.search = new URLSearchParams({
      f: "json", geometry: `${lng},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: [layer.nameField, layer.gradesField].filter(Boolean).join(","),
      returnGeometry: "false",
    }).toString();
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Official ArcGIS locator HTTP ${response.status}`);
    const payload: any = await response.json();
    if (payload.error) throw new Error(`Official ArcGIS locator: ${payload.error.message || "query error"}`);
    const attributes = payload.features?.[0]?.attributes;
    const name = String(attributes?.[layer.nameField] || "").trim();
    if (!name) return null;
    return {
      name, scale: 10, type: layer.type, grades: layer.gradesField ? attributes?.[layer.gradesField] : undefined,
      ratingSource: "unknown", evidenceSource: "official-locator", sourceUrl: locator.sourceUrl,
      relationship: "assigned", assignmentSource: "official-locator", assignmentSourceUrl: locator.sourceUrl,
      checkedAt: new Date().toISOString(),
    };
  }
}

function readLocatorConfig(): OfficialSchoolLocatorConfig[] {
  let raw = process.env.RE_OFFICIAL_SCHOOL_LOCATORS_JSON;
  if (!raw && process.env.RE_OFFICIAL_SCHOOL_LOCATORS_FILE) {
    try {
      raw = readFileSync(resolve(process.env.RE_OFFICIAL_SCHOOL_LOCATORS_FILE), "utf8");
    } catch (error) {
      console.warn(`[OfficialSchoolAssignmentService] Cannot read locator config: ${safeError(error)}`);
    }
  }
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    console.warn("[OfficialSchoolAssignmentService] RE_OFFICIAL_SCHOOL_LOCATORS_JSON is invalid JSON.");
    return [];
  }
}

function mergeSchools(current: SchoolEvidence[], incoming: SchoolEvidence[]): SchoolEvidence[] {
  const merged = new Map(current.map((school) => [normalize(school.name), school]));
  for (const school of incoming) {
    const key = normalize(school.name);
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...school, rating: existing.rating, ratingSource: existing.ratingSource } : school);
  }
  return [...merged.values()];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\broad\b/g, " ").replace(/\s+/g, " ").trim();
}
function safeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
  return [error.message, cause?.code, cause?.message].filter(Boolean).join("; ");
}

function parseJsonDocument(content: string): any | null {
  const decoded = content.replace(/<[^>]+>/g, " ").replace(/&quot;/gi, '"').replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").trim();
  const start = decoded.indexOf("{");
  const end = decoded.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(decoded.slice(start, end + 1)); } catch { return null; }
}
function addDiagnostic(property: Property, stage: NonNullable<Property["evidenceDiagnostics"]>[number]["stage"], status: NonNullable<Property["evidenceDiagnostics"]>[number]["status"], detail: string): Property {
  return { ...property, evidenceDiagnostics: [...(property.evidenceDiagnostics || []), { stage, status, detail }] };
}

export const officialSchoolAssignmentService = new OfficialSchoolAssignmentService();

const CLARKE_SCHOOLS: Array<{ type: SchoolEvidence["type"]; canonical: string; variants: string[] }> = [
  { type: "elementary", canonical: "Barnett Shoals Elementary School", variants: ["BARNETT SHOALS"] },
  { type: "elementary", canonical: "Barrow Elementary School", variants: ["BARROW"] },
  { type: "elementary", canonical: "Bettye Henderson Holston Elementary School", variants: ["BETTYE H. HOLSTON", "BETTYE H HOLSTON", "HOLSTON"] },
  { type: "elementary", canonical: "Cleveland Road Elementary School", variants: ["CLEVELAND"] },
  { type: "elementary", canonical: "Fowler Drive Elementary School", variants: ["FOWLER"] },
  { type: "elementary", canonical: "Gaines Elementary School", variants: ["GAINES"] },
  { type: "elementary", canonical: "Howard B. Stroud Elementary School", variants: ["HOWARD B. STROUD", "STROUD"] },
  { type: "elementary", canonical: "Judia Jackson Harris Elementary School", variants: ["JUDIA JACKSON HARRIS", "J.J. HARRIS", "JJ HARRIS"] },
  { type: "elementary", canonical: "Johnnie Lay Burks Elementary School", variants: ["JOHNNIE L. BURKS", "JOHNNIE LAY BURKS"] },
  { type: "elementary", canonical: "Maxine Pinson Easom Elementary School", variants: ["MAXINE PINSON EASOM"] },
  { type: "elementary", canonical: "Oglethorpe Avenue Elementary School", variants: ["OGLETHORPE"] },
  { type: "elementary", canonical: "Timothy Road Elementary School", variants: ["TIMOTHY"] },
  { type: "elementary", canonical: "Whit Davis Elementary School", variants: ["WHIT DAVIS"] },
  { type: "elementary", canonical: "Whitehead Road Elementary School", variants: ["WHITEHEAD"] },
  { type: "elementary", canonical: "Winterville Elementary School", variants: ["WINTERVILLE"] },
  { type: "middle", canonical: "Burney-Harris-Lyons Middle School", variants: ["BURNEY-HARRIS-LYONS", "B-H-L", "BHL"] },
  { type: "middle", canonical: "Clarke Middle School", variants: ["CLARKE MIDDLE"] },
  { type: "middle", canonical: "Coile Middle School", variants: ["COILE"] },
  { type: "middle", canonical: "Hilsman Middle School", variants: ["HILSMAN"] },
  { type: "high", canonical: "Cedar Shoals High School", variants: ["CEDAR SHOALS"] },
  { type: "high", canonical: "Clarke Central High School", variants: ["CLARKE CENTRAL"] },
];

export function extractClarkeStreetAssignment(content: string, street: string, houseNumber: number): SchoolEvidence[] {
  const withRows = content.toUpperCase().replace(/\r/g, "");
  const text = [
    ...withRows.split("\n").map((line) => line.replace(/\|/g, " ").replace(/\s+/g, " ").trim()),
    withRows.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " "),
  ].filter(Boolean).join("\n");
  for (const target of streetIndexVariants(normalizeStreet(street))) {
    let offset = 0;
    while ((offset = text.indexOf(target, offset)) >= 0) {
      const candidate = text.slice(offset + target.length, offset + target.length + 240);
      const row = candidate.includes("\n") ? candidate.slice(0, candidate.indexOf("\n")) : candidate;
      const elementary = findSchool(row, "elementary");
      const middle = findSchool(row, "middle");
      const high = findSchool(row, "high");
      if (elementary && middle && high && elementary.index < middle.index && middle.index < high.index
          && addressConditionMatches(row.slice(0, elementary.index), houseNumber)) {
        const checkedAt = new Date().toISOString();
        return [elementary, middle, high].map(({ school }) => ({
          name: school.canonical, scale: 10, type: school.type, ratingSource: "unknown",
          evidenceSource: "official-locator", sourceUrl: CLARKE_STREET_INDEX, relationship: "assigned",
          assignmentSource: "official-locator", assignmentSourceUrl: CLARKE_STREET_INDEX, checkedAt,
        }));
      }
      if (!elementary && middle && high && middle.index < high.index
          && /\bELEMENTARY\s+C\b/.test(row.slice(0, middle.index))
          && addressConditionMatches(row.slice(0, row.indexOf("ELEMENTARY C")), houseNumber)) {
        const checkedAt = new Date().toISOString();
        const assignmentGroup = "CCSD Elementary C placement pool";
        const elementaryOptions = ["Cleveland Road Elementary School", "Oglethorpe Avenue Elementary School", "Whitehead Road Elementary School"];
        return [
          ...elementaryOptions.map((name) => ({
            name, scale: 10 as const, type: "elementary" as const, ratingSource: "unknown" as const,
            evidenceSource: "official-locator" as const, sourceUrl: CLARKE_STREET_INDEX,
            relationship: "assignment-option" as const, assignmentGroup, assignmentGroupSize: elementaryOptions.length,
            assignmentSource: "official-locator" as const, assignmentSourceUrl: CLARKE_STREET_INDEX, checkedAt,
          })),
          ...[middle, high].map(({ school }) => ({
          name: school.canonical, scale: 10, type: school.type, ratingSource: "unknown",
          evidenceSource: "official-locator", sourceUrl: CLARKE_STREET_INDEX, relationship: "assigned",
          assignmentSource: "official-locator", assignmentSourceUrl: CLARKE_STREET_INDEX, checkedAt,
          } as SchoolEvidence)),
        ];
      }
      offset += target.length;
    }
  }
  return [];
}

function streetIndexVariants(street: string): string[] {
  const variants = new Set([street]);
  // CCSD's index uses OAK MEADOWS DR while postal/listing sources use OAK MEADOW DR.
  if (/\bMEADOW\b/.test(street)) variants.add(street.replace(/\bMEADOW\b/g, "MEADOWS"));
  if (/\bMEADOWS\b/.test(street)) variants.add(street.replace(/\bMEADOWS\b/g, "MEADOW"));
  return [...variants];
}

function findSchool(row: string, type: SchoolEvidence["type"]): { school: typeof CLARKE_SCHOOLS[number]; index: number } | null {
  let best: { school: typeof CLARKE_SCHOOLS[number]; index: number } | null = null;
  for (const school of CLARKE_SCHOOLS.filter((item) => item.type === type)) {
    for (const variant of school.variants) {
      const index = row.indexOf(variant);
      if (index >= 0 && (!best || index < best.index)) best = { school, index };
    }
  }
  return best;
}

function addressConditionMatches(condition: string, number: number): boolean {
  if (/4\s*DIGIT\s+ADDRESSES?\s+JACKSON\s+CO/.test(condition)) return number < 1000;
  const range = condition.match(/(\d+)\s*[-–]\s*(\d+)\s+ONLY/);
  if (range) return number >= Number(range[1]) && number <= Number(range[2]);
  const below = condition.match(/(\d+)\s+AND\s+BELOW/);
  if (below) return number <= Number(below[1]);
  const above = condition.match(/(\d+)\s+AND\s+ABOVE/);
  if (above) return number >= Number(above[1]);
  const only = condition.match(/(\d+)\s+ONLY/);
  if (only) return number === Number(only[1]);
  if (/\bODD\b/.test(condition)) return number % 2 === 1;
  if (/\bEVEN\b/.test(condition)) return number % 2 === 0;
  return !/\d/.test(condition);
}

function parseStreetAddress(address: string): { number: number; street: string } | null {
  const match = address.match(/^\s*(\d+)\s+(.+?)(?:\s+(?:UNIT|APT|#)\s*[^,]+)?\s*,/i);
  if (!match) return null;
  return { number: Number(match[1]), street: normalizeStreet(match[2]) };
}

function normalizeStreet(value: string): string {
  return value.toUpperCase().replace(/\bROAD\b/g, "RD").replace(/\bDRIVE\b/g, "DR")
    .replace(/\bCOURT\b/g, "CT").replace(/\bLANE\b/g, "LN").replace(/\bPLACE\b/g, "PL")
    .replace(/\bAVENUE\b/g, "AVE").replace(/\bBOULEVARD\b/g, "BLVD").replace(/\s+/g, " ").trim();
}
