import { extractPropertyEvidence } from "../core/property-matcher";
import { Property, SearchCriteria } from "../core/types";
import { firecrawlRequestBudget } from "./firecrawl-request-budget";
import { readEnvironmentSecret } from "./environment-secret";

type FetchLike = typeof fetch;

export class ListingEvidenceSearchService {
  private readonly cache = new Map<string, Promise<{ content: string; urls: string[] }>>();
  private readonly communityCache = new Map<string, Promise<{ content: string; urls: string[] }>>();
  private readonly bathroomCache = new Map<string, Promise<{ content: string; urls: string[] }>>();

  constructor(
    private readonly apiKey = readEnvironmentSecret("FIRECRAWL_API_KEY"),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get enabled(): boolean { return Boolean(this.apiKey); }

  async enrichBathroomDetails(property: Property): Promise<Property> {
    if (!this.enabled || property.fullBathrooms != null || property.halfBathrooms != null) return property;
    const key = normalizeAddress(property.title);
    let request = this.bathroomCache.get(key);
    if (!request) {
      request = this.searchBathroomDetails(property.title).catch((error) => {
        this.bathroomCache.delete(key);
        throw error;
      });
      this.bathroomCache.set(key, request);
    }
    const result = await request;
    return result.content ? extractPropertyEvidence(property, result.content) : property;
  }

  async enrichProperty(property: Property, criteria: SearchCriteria): Promise<Property> {
    const needsBrick = Boolean(criteria.exteriorMaterials?.includes("brick") && property.exteriorCoverage !== "all-sides");
    const needsLake = Boolean(criteria.communityFeatures?.some((item) => /lake|pond/i.test(item))
      && !(property.communityFeatures || []).some((item) => /lake|pond/i.test(item)));
    if (!this.enabled || (!needsBrick && !needsLake)) return property;

    const communityName = needsLake ? extractCommunityName(property) : "";
    const wasAllSides = property.exteriorCoverage === "all-sides";
    const hadLake = (property.communityFeatures || []).some((item) => /lake|pond/i.test(item));
    let enriched = property;
    const evidence = [...(property.featureEvidence || [])];
    const checkedAt = new Date().toISOString();

    if (needsBrick || (needsLake && !communityName)) {
      const key = `${property.title.toLowerCase()}|${needsBrick}|${needsLake && !communityName}`;
      let request = this.cache.get(key);
      if (!request) {
        request = this.searchAddress(property.title, needsBrick, needsLake && !communityName).catch((error) => {
          this.cache.delete(key);
          throw error;
        });
        this.cache.set(key, request);
      }
      const result = await request;
      enriched = extractPropertyEvidence(enriched, result.content);
      if (!wasAllSides && enriched.exteriorCoverage === "all-sides") {
        evidence.push({ criterion: "all-sides-brick", sourceUrl: result.urls[0] || property.url, source: "targeted-web-search", checkedAt });
      }
    }

    if (needsLake && communityName) {
      const cityState = property.location.replace(/\s+\d{5}(?:-\d{4})?$/, "").trim();
      const key = `${normalizeAddress(communityName)}|${normalizeAddress(cityState)}`;
      let request = this.communityCache.get(key);
      if (!request) {
        request = this.searchCommunity(communityName, cityState).catch((error) => {
          this.communityCache.delete(key);
          throw error;
        });
        this.communityCache.set(key, request);
      }
      const result = await request;
      enriched = extractPropertyEvidence(enriched, result.content);
      const hasLake = (enriched.communityFeatures || []).some((item) => /lake|pond/i.test(item));
      if (!hadLake && hasLake) {
        evidence.push({ criterion: "community-lake", sourceUrl: result.urls[0] || property.url, source: "targeted-web-search", checkedAt });
      }
    } else {
      const hasLake = (enriched.communityFeatures || []).some((item) => /lake|pond/i.test(item));
      if (!hadLake && hasLake) evidence.push({ criterion: "community-lake", sourceUrl: property.url, source: "targeted-web-search", checkedAt });
    }
    for (const item of enriched.featureEvidence || []) {
      const existing = evidence.find((candidate) =>
        candidate.criterion === item.criterion && candidate.sourceUrl === item.sourceUrl);
      if (!existing) evidence.push(item);
      else if (!existing.excerpt && item.excerpt) existing.excerpt = item.excerpt;
    }
    return { ...enriched, featureEvidence: evidence };
  }

  private async searchAddress(address: string, needsBrick: boolean, needsLake: boolean): Promise<{ content: string; urls: string[] }> {
    const terms = [
      needsBrick ? '"four-sided brick" "all brick exterior"' : "",
      needsLake
        ? '("Community Features: Lake" OR "Association Amenities: Lake" OR "Association Fee Includes: Lake/Pond" OR "Lake Privileges" OR "community lake" OR "neighborhood lake")'
        : "",
    ].filter(Boolean).join(" ");
    firecrawlRequestBudget.consume("targeted listing evidence search");
    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: `"${address}" ${terms}`, limit: 3, sources: ["web"],
        includeDomains: ["realtor.com", "redfin.com", "homes.com"], country: "US", timeout: 30000,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`Firecrawl listing evidence search HTTP ${response.status}`);
    const payload: any = await response.json();
    const web = Array.isArray(payload.data?.web) ? payload.data.web : Array.isArray(payload.data) ? payload.data : [];
    const relevant = web.filter((item: any) => {
      const url = String(item.url || "");
      return /^https?:\/\/(?:www\.)?(?:realtor\.com|redfin\.com|homes\.com)\//i.test(url)
        && isExactAddressResult(item, address);
    });
    return {
      content: relevant.map((item: any) => [item.title, item.description, item.markdown].filter(Boolean).join("\n")).join("\n"),
      urls: relevant.map((item: any) => String(item.url || "")).filter(Boolean),
    };
  }

  private async searchCommunity(communityName: string, cityState: string): Promise<{ content: string; urls: string[] }> {
    firecrawlRequestBudget.consume("targeted subdivision amenity search");
    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: `"${communityName}" "${cityState}" (lake OR pond) (amenities OR HOA OR community OR subdivision)`,
        limit: 5, sources: ["web"], country: "US", timeout: 30000,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`Firecrawl subdivision evidence search HTTP ${response.status}`);
    const payload: any = await response.json();
    const web = Array.isArray(payload.data?.web) ? payload.data.web : Array.isArray(payload.data) ? payload.data : [];
    const tokens = normalizeAddress(communityName).split(" ").filter((token) => token.length > 2);
    const marketTokens = normalizeAddress(cityState).split(" ").filter((token) => token.length > 2);
    const relevant = web.filter((item: any) => {
      const content = `${item.title || ""} ${item.description || ""} ${item.markdown || ""}`;
      const normalized = normalizeAddress(content);
      return /^https?:\/\//i.test(String(item.url || ""))
        && tokens.every((token) => normalized.includes(token))
        && marketTokens.every((token) => normalized.includes(token))
        && /\b(?:lake|pond)\b/i.test(content)
        && (/\b(?:community|neighborhood|subdivision|amenit|association|hoa|residents?)[^.;]{0,180}\b(?:lake|pond)\b/i.test(content)
          || /\b(?:lake|pond)\b[^.;]{0,180}\b(?:community|neighborhood|subdivision|amenit|association|hoa|residents?|access|privileges?)\b/i.test(content));
    });
    return {
      content: relevant.map((item: any) => [item.title, item.description, item.markdown].filter(Boolean).join("\n")).join("\n"),
      urls: relevant.map((item: any) => String(item.url || "")).filter(Boolean),
    };
  }

  private async searchBathroomDetails(address: string): Promise<{ content: string; urls: string[] }> {
    firecrawlRequestBudget.consume("exact-address bathroom verification");
    const response = await this.fetchImpl("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: `"${address}" ("full bathrooms" OR "half bathrooms" OR "half ba" OR "total bathrooms")`,
        limit: 5,
        sources: ["web"],
        includeDomains: ["realtor.com", "lennar.com", "coldwellbankerhomes.com", "redfin.com"],
        country: "US",
        timeout: 30000,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`Firecrawl bathroom verification HTTP ${response.status}`);
    const payload: any = await response.json();
    const web = Array.isArray(payload.data?.web) ? payload.data.web : Array.isArray(payload.data) ? payload.data : [];
    const relevant = web.filter((item: any) => {
      const content = `${item.title || ""} ${item.description || ""} ${item.markdown || ""}`;
      return isExactAddressResult(item, address)
        && /\b(?:full|half|partial|total)\s+(?:ba|bath|bathroom)/i.test(content);
    });
    return {
      content: relevant.map((item: any) => [item.title, item.description, item.markdown].filter(Boolean).join("\n")).join("\n"),
      urls: relevant.map((item: any) => String(item.url || "")).filter(Boolean),
    };
  }
}

function normalizeAddress(value: string): string {
  return value.toLowerCase()
    .replace(/\b(?:apartment|unit|apt)\s*#?\s*([a-z0-9-]+)/g, " apt $1 ")
    .replace(/#\s*([a-z0-9-]+)/g, " apt $1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isExactAddressResult(item: any, address: string): boolean {
  const expected = normalizeAddress(address);
  const expectedWithoutZip = expected.replace(/\s+\d{5}(?:\s+\d{4})?$/, "").trim();
  const identities = [...new Set([expected, expectedWithoutZip].filter((value) => value.length >= 8))];
  const title = normalizeAddress(String(item.title || ""));
  let url = String(item.url || "");
  try { url = decodeURIComponent(url); } catch { /* Keep the original URL when percent encoding is malformed. */ }
  const normalizedUrl = normalizeAddress(url);
  // Search snippets often mention the requested address only in a related-home
  // carousel. Evidence belongs to the requested property only when its primary
  // result title or canonical URL identifies that exact address.
  return identities.some((identity) => title === identity || title.startsWith(`${identity} `) || normalizedUrl.includes(identity));
}

export function extractCommunityName(property: Property): string {
  for (const [label, values] of Object.entries(property.listingFacts || {})) {
    if (!/subdivision|neighborhood|community name|development|association name/i.test(label)) continue;
    const value = values.find((item) => isPlausibleCommunityName(item));
    if (value) return value.trim();
  }
  const text = `${property.description || ""}\n${property.listingEvidenceText || ""}`;
  const match = text.match(/\b(?:Subdivision|Neighborhood|Community Name|Development)\s*[:\-]\s*([A-Za-z0-9 &'’.-]{3,80})/i);
  return match && isPlausibleCommunityName(match[1]) ? match[1].trim() : "";
}

function isPlausibleCommunityName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 3 && normalized.length <= 80
    && !/^(?:yes|no|none|n\/a|unknown|annual|monthly|\$?\d)/i.test(normalized);
}

export const listingEvidenceSearchService = new ListingEvidenceSearchService();
