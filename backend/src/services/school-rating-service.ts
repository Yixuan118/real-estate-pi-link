import { Property, SchoolEvidence } from "../core/types";
import { firecrawlRequestBudget } from "./firecrawl-request-budget";
import { defaultCacheFile, PersistentJsonCache } from "./persistent-json-cache";
import { readEnvironmentSecret } from "./environment-secret";

type FetchLike = typeof fetch;

interface CachedLookup {
  expiresAt: number;
  promise: Promise<SchoolEvidence[]>;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TARGET_PROFILE_WINDOW_CHARS = 1600;

export function extractSchoolEvidence(
  content: string,
  sourceUrl: string,
  evidenceSource: SchoolEvidence["evidenceSource"] = "realtor-listing",
): SchoolEvidence[] {
  const normalized = content
    .replace(/\\u0022|\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/&quot;/gi, '"')
    .replace(/\\n|\\r|\\t/g, " ");
  const found = new Map<string, SchoolEvidence>();
  // Realtor embeds a richer school model in JSON/Next data than it renders in
  // the initial markdown. Parse that model first so nested rating, grades,
  // distance, student and review fields survive a single detail-page scrape.
  for (const school of extractEmbeddedSchoolJson(content, sourceUrl, evidenceSource)) {
    addOrMerge(found, school);
  }
  // Realtor school names do not always contain a level word (for example,
  // "Amanda C Rowe School"). Parse each visible rating card and infer its
  // level from the adjacent Grades field.
  for (const school of extractRealtorSchoolPanelCards(normalized, sourceUrl, evidenceSource)) {
    addOrMerge(found, school);
  }
  // Search-index snippets can expose every school card even when the live
  // Realtor document lazy-loads the panel and omits its score circles. Keep
  // the school identity + grade band now; exact school-page lookups add the
  // source-backed ratings below.
  for (const school of extractRealtorGradeCards(normalized, sourceUrl, evidenceSource)) {
    addOrMerge(found, school);
  }
  const namePattern = /"(?:name|school_name)"\s*:\s*"([^"<>]{3,160})"/gi;
  let match: RegExpExecArray | null;

  while ((match = namePattern.exec(normalized)) !== null) {
    const name = cleanSchoolName(match[1]);
    const objectStart = normalized.lastIndexOf("{", match.index);
    const objectEnd = normalized.indexOf("}", match.index);
    const hasLocalObject = objectStart >= 0 && objectEnd > match.index && objectEnd - objectStart < 2000;
    const window = hasLocalObject
      ? normalized.slice(objectStart, objectEnd + 1)
      : normalized.slice(match.index, Math.min(normalized.length, match.index + 1300));
    if (!looksLikeSchool(name, window)) continue;
    addOrMerge(found, buildEvidence(name, window, sourceUrl, evidenceSource));
  }

  const prosePattern = /([A-Z][A-Za-z0-9'.&()\- ]{2,120}(?:Elementary|Middle|High|K-?12|School|Academy|Institute))[^\n<>]{0,260}?(?:GreatSchools(?:®)?(?:\s+Rating)?|rating)\s*[:\-]?\s*(\d{1,2})(?:\s*\/\s*10)?/gi;
  while ((match = prosePattern.exec(normalized)) !== null) {
    const name = cleanSchoolName(match[1]);
    const rating = validRating(match[2]);
    if (!name || rating == null) continue;
    addOrMerge(found, { ...buildEvidence(name, match[0], sourceUrl, evidenceSource), rating, ratingSource: "GreatSchools" });
  }

  // Realtor's visible Schools section puts the score before the school name.
  // Depending on the renderer/accessibility tree this can be either
  // "7 10 Burney-Harris-Lyons Middle School" or
  // "7 10 7 out of 10 Burney-Harris-Lyons Middle School".
  const scoreFirstPattern = /\b(\d{1,2})\s*(?:\/\s*)?10\s+(?:\1\s+out\s+of\s+10\s+)?\[?([A-Z][A-Za-z0-9'.&()\- ]{2,120}?(?:Elementary|Middle|High)(?:\s+School)?)\b\]?(?:\([^)\s]+(?:\s+"[^"]*")?\))?/gi;
  while ((match = scoreFirstPattern.exec(normalized)) !== null) {
    const name = cleanSchoolName(match[2]);
    const rating = validRating(match[1]);
    if (!name || rating == null) continue;
    addOrMerge(found, {
      ...buildEvidence(name, match[0], sourceUrl, evidenceSource), rating, ratingSource: "GreatSchools",
      grades: normalized.slice(match.index, match.index + 240).match(/Grades?\s+([A-Z0-9-]+)/i)?.[1],
      distanceMiles: parseMetric(normalized.slice(match.index, match.index + 320), /([\d.]+)\s*mi(?:les?)?\s+away/i, 0, 100),
      studentCount: parseMetric(normalized.slice(match.index, match.index + 320), /([\d,]+)\s+students?\b/i, 0, 1000000),
      reviewCount: parseMetric(normalized.slice(match.index, match.index + 320), /([\d,]+)\s+reviews?\b/i, 0, 1000000),
    });
  }

  // The listing-agent row may identify schools without the repeated level
  // suffix, for example "Elementary School: Whitehead Road". Preserve these
  // as property-associated evidence so an exact rating can be merged later.
  const listingAgentPattern = /\b(Elementary|Middle|High)\s+School\s*:\s*([A-Z][A-Za-z0-9'.&()\- ]{2,100}?)(?=\s+(?:Elementary|Middle|High)\s+School\s*:|\s+Nearby\s+schools\b|$)/gi;
  while ((match = listingAgentPattern.exec(normalized)) !== null) {
    const level = match[1].toLowerCase() as "elementary" | "middle" | "high";
    const rawName = cleanSchoolName(match[2]);
    if (!rawName) continue;
    const suffix = level === "elementary" ? "Elementary School" : level === "middle" ? "Middle School" : "High School";
    const name = new RegExp(`\\b${level}\\b|\\bschool\\b`, "i").test(rawName) ? rawName : `${rawName} ${suffix}`;
    addOrMerge(found, {
      name, scale: 10, type: level, ratingSource: "unknown", evidenceSource,
      sourceUrl, relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
      assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
      assignmentSourceUrl: evidenceSource === "realtor-listing" ? sourceUrl : undefined,
      checkedAt: new Date().toISOString(),
    });
  }

  // Realtor detail pages also expose a stable server-rendered sentence even
  // when the visual "Neighborhood & schools" cards are lazy-loaded:
  // "The schools near <address> include [A](.../local/schools/...), ...".
  // Capture only links inside that address-specific sentence; links elsewhere
  // on the page (market navigation, recommendations) are not property evidence.
  const nearbySentencePattern = /(?:the\s+)?schools?\s+near\s+.{1,240}?\s+include\s+([\s\S]{1,1800}?)(?=\bNearby\s+Cities\b|\bNearby\s+Neighborhoods\b|\bSimilar\s+Homes\b|$)/gi;
  while ((match = nearbySentencePattern.exec(normalized)) !== null) {
    const linkedSchools = match[1];
    const linkPattern = /\[([^\]]{3,160})\]\((https?:\/\/(?:www\.)?realtor\.com\/local\/schools\/[^)\s]+)\)/gi;
    let link: RegExpExecArray | null;
    while ((link = linkPattern.exec(linkedSchools)) !== null) {
      const name = cleanSchoolName(link[1]);
      if (!name || !looksLikeSchool(name, linkedSchools)) continue;
      addOrMerge(found, {
        name, scale: 10, type: inferSchoolType(name, ""), ratingSource: "unknown",
        evidenceSource: "realtor-listing", sourceUrl: link[2], relationship: "listing-associated",
        assignmentSource: "realtor-listing", assignmentSourceUrl: sourceUrl,
        checkedAt: new Date().toISOString(),
      });
    }
    const htmlLinkPattern = /<a\b[^>]*href=["'](https?:\/\/(?:www\.)?realtor\.com\/local\/schools\/[^"'?#\s]+)["'][^>]*>([^<]{3,160})<\/a>/gi;
    while ((link = htmlLinkPattern.exec(linkedSchools)) !== null) {
      const name = cleanSchoolName(link[2]);
      if (!name || !looksLikeSchool(name, linkedSchools)) continue;
      addOrMerge(found, {
        name, scale: 10, type: inferSchoolType(name, ""), ratingSource: "unknown",
        evidenceSource: "realtor-listing", sourceUrl: link[1], relationship: "listing-associated",
        assignmentSource: "realtor-listing", assignmentSourceUrl: sourceUrl,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  return [...found.values()];
}

export class SchoolRatingService {
  private readonly cache = new Map<string, CachedLookup>();
  private readonly persistentCache: PersistentJsonCache<SchoolEvidence[]>;

  constructor(
    private readonly apiKey = readEnvironmentSecret("FIRECRAWL_API_KEY"),
    private readonly fetchImpl: FetchLike = fetch,
    cacheFile = fetchImpl === fetch ? defaultCacheFile("school-ratings.json") : "",
    private readonly directPageFetch: FetchLike | undefined = fetchImpl === fetch ? fetch : undefined,
  ) { this.persistentCache = new PersistentJsonCache<SchoolEvidence[]>(cacheFile); }

  get enabled(): boolean { return Boolean(this.apiKey); }

  async enrichProperty(
    property: Property,
    location?: string,
    options: { strictAssignment?: boolean; minimumRating?: number } = {},
  ): Promise<Property> {
    if (!this.enabled) return property;
    const current = property.schools || [];
    const resolvedLocation = location || property.location;
    // Resolve the school links already present on the Realtor listing first.
    // These are direct public-page reads and do not consume Firecrawl budget.
    // Previously an expensive missing-stage search ran first and could exhaust
    // the entire request budget before these known links were ever scored.
    let schools = await this.resolveMissingRatings(current, resolvedLocation, options.minimumRating);
    // A source-backed score below the user's hard floor is already a complete
    // reason to reject this property. Do not spend more Firecrawl credits
    // filling stages that cannot change that outcome.
    if (hasHardSchoolRatingFailure(schools, options.minimumRating)) {
      return { ...property, schools };
    }

    const hasOfficialSchools = schools.some((school) =>
      school.relationship === "assigned" || school.relationship === "assignment-option");
    // In strict assignment mode, an address search can only return nearby schools
    // and therefore cannot repair a missing official assignment.
    // An exact Realtor property result is still property-associated evidence in
    // strict mode. It is not the same as a broad "schools near this address"
    // search, which must remain nearby-only.
    const hasCompleteAssociatedStages = hasCompleteSchoolStages(schools.filter((school) =>
      school.relationship === "listing-associated"));
    if (!hasOfficialSchools && !hasCompleteAssociatedStages) {
      try {
        const lookup = await this.searchByProperty(property.title, resolvedLocation, property.url);
        schools = mergeSchools(schools, lookup);
      } catch (error) {
        // A depleted Firecrawl budget must not discard ratings already
        // recovered from exact Realtor school links.
        if (!schools.some((school) => school.rating != null)) throw error;
      }
    }

    schools = await this.resolveMissingRatings(schools, resolvedLocation, options.minimumRating);
    return { ...property, schools };
  }

  private async resolveMissingRatings(
    schools: SchoolEvidence[],
    location: string,
    minimumRating?: number,
  ): Promise<SchoolEvidence[]> {
    const missing = schools.filter((school) => school.rating == null).slice(0, 8);
    let resolvedSchools = schools;
    if (missing.length) {
      if (minimumRating != null) {
        let firstFailure: unknown;
        for (const school of missing) {
          try {
            resolvedSchools = mergeSchools(resolvedSchools, await this.lookupAssociatedSchool(school, location));
          } catch (error) {
            firstFailure ??= error;
          }
          if (hasHardSchoolRatingFailure(resolvedSchools, minimumRating)) return resolvedSchools;
        }
        if (firstFailure && !resolvedSchools.some((school) => school.rating != null)) throw firstFailure;
        return resolvedSchools;
      }
      const resolved = await Promise.allSettled(missing.map((school) =>
        this.lookupAssociatedSchool(school, location)));
      const successful = resolved.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      resolvedSchools = mergeSchools(resolvedSchools, successful);
      if (!successful.length && !resolvedSchools.some((school) => school.rating != null)) {
        const failure = resolved.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    }
    return resolvedSchools;
  }

  async lookupSchool(name: string, location?: string): Promise<SchoolEvidence[]> {
    return this.cached(`school:v7:${normalizeCacheKey(name)}:${normalizeCacheKey(location || "")}`, async () => {
      return this.searchExactSchool(name, location || "United States");
    });
  }

  private async lookupAssociatedSchool(school: SchoolEvidence, location: string): Promise<SchoolEvidence[]> {
    if (!isRealtorSchoolUrl(school.sourceUrl)) return this.lookupSchool(school.name, location);
    return this.cached(`realtor-school:v5:${normalizeCacheKey(school.sourceUrl)}`, async () => {
      const content = await this.scrapeDedicatedSchoolPage(school.sourceUrl);
      const rating = extractDedicatedSchoolPageRating(content, school.name);
      if (rating == null) return [];
      const gradeProfile = extractDedicatedSchoolGradeProfile(content, school.name);
      return [{
        ...school,
        rating,
        type: school.type === "other" ? gradeProfile.type : school.type,
        grades: school.grades || gradeProfile.grades,
        ratingSource: "GreatSchools",
        evidenceSource: "realtor-school-page",
        sourceUrl: school.sourceUrl,
        checkedAt: new Date().toISOString(),
      }];
    });
  }

  private async searchByProperty(address: string, location: string, propertyUrl?: string): Promise<SchoolEvidence[]> {
    return this.cached(`property:v19:${normalizeCacheKey(address)}:${normalizeCacheKey(location)}:${normalizeCacheKey(propertyUrl || "")}`, () =>
      this.searchExactPropertyListing(address, location, propertyUrl));
  }

  private async cached(key: string, producer: () => Promise<SchoolEvidence[]>): Promise<SchoolEvidence[]> {
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    const persisted = this.persistentCache.get(key);
    if (persisted) {
      const promise = Promise.resolve(persisted);
      this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
      return promise;
    }
    const promise = producer().then((value) => {
      this.persistentCache.set(key, value, CACHE_TTL_MS);
      return value;
    }).catch((error) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
    return promise;
  }

  private async searchExactPropertyListing(address: string, location: string, propertyUrl?: string): Promise<SchoolEvidence[]> {
    const schools: SchoolEvidence[] = [];
    const runSearch = async (
      query: string,
      label: string,
      domains: string[] = ["realtor.com"],
      parser: (content: string, url: string) => SchoolEvidence[] =
        (content, url) => extractSchoolEvidence(content, url, "realtor-listing"),
    ): Promise<void> => {
      firecrawlRequestBudget.consume(label);
      const response = await this.fetchFirecrawlWithRateLimitRetry("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          query, limit: 3, sources: ["web"], includeDomains: domains, country: "US", timeout: 30000,
        }),
      });
      if (!response.ok) throw new Error(`Firecrawl school search HTTP ${response.status}`);
      const payload: any = await response.json();
      firecrawlRequestBudget.settle(label, payload.creditsUsed);
      const web = Array.isArray(payload.data?.web) ? payload.data.web : Array.isArray(payload.data) ? payload.data : [];
      for (const item of web) {
        const url = String(item.url || "");
        if (!domains.some((domain) => urlHostMatches(url, domain))) continue;
        if (domains.includes("realtor.com") && !/realtor\.com\/realestateandhomes-detail\//i.test(url)) continue;
        if (domains.includes("redfin.com") && !/redfin\.com\/.+\/home\/\d+/i.test(url)) continue;
        if (!isExactStreetAndZipResult(item, address)) continue;
        const content = [item.title, item.description, item.markdown].filter(Boolean).join("\n");
        schools.push(...parser(content, url));
      }
    };
    let redfinFallbackAttempted = false;
    const runRedfinFallback = async (): Promise<void> => {
      if (redfinFallbackAttempted) return;
      redfinFallbackAttempted = true;
      const zip = address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0];
      const street = address.split(",")[0].trim();
      if (!zip || !street) return;
      const searchLabel = "exact-address assigned-school fallback";
      firecrawlRequestBudget.consume(searchLabel);
      const searchResponse = await this.fetchFirecrawlWithRateLimitRetry("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          query: `site:redfin.com "${street}" "${zip}"`,
          limit: 5, sources: ["web"], includeDomains: ["redfin.com"], country: "US", timeout: 30000,
        }),
      });
      if (!searchResponse.ok) throw new Error(`Firecrawl assigned-school fallback search HTTP ${searchResponse.status}`);
      const searchPayload: any = await searchResponse.json();
      firecrawlRequestBudget.settle(searchLabel, searchPayload.creditsUsed);
      const web = Array.isArray(searchPayload.data?.web)
        ? searchPayload.data.web : Array.isArray(searchPayload.data) ? searchPayload.data : [];
      const exact = web.find((item: any) =>
        /redfin\.com\/.+\/home\/\d+/i.test(String(item.url || ""))
        && isExactStreetAndZipResult(item, address));
      if (!exact?.url) return;

      const scrapeLabel = "exact-address Redfin property schools";
      firecrawlRequestBudget.consume(scrapeLabel);
      const scrapeResponse = await this.fetchFirecrawlWithRateLimitRetry("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          url: exact.url, formats: ["markdown"], onlyMainContent: false, maxAge: 0, timeout: 30000,
        }),
      });
      if (!scrapeResponse.ok) throw new Error(`Firecrawl assigned-school fallback page HTTP ${scrapeResponse.status}`);
      const scrapePayload: any = await scrapeResponse.json();
      firecrawlRequestBudget.settle(scrapeLabel, scrapePayload.creditsUsed);
      const content = String(scrapePayload.data?.markdown || scrapePayload.data?.content || "");
      schools.push(...extractRedfinAssignedSchoolEvidence(content, String(exact.url)));
    };

    const canonicalUrl = propertyUrl ? canonicalSearchUrl(propertyUrl) : "";
    await runSearch(
      propertyUrl
        ? `site:${canonicalUrl} "Grades 9-12" "out of 10"`
        : `"${address}" "${location}" schools "GreatSchools Rating"`,
      "property-address school search",
    );
    // Some Realtor pages do not expose their lazy school panel to the search
    // index at all. A single exact-address Redfin property result is a safer
    // and cheaper fallback than three blind Realtor stage searches.
    if (!schools.length) await runRedfinFallback();
    if (propertyUrl) {
      // Search snippets are often truncated immediately before the high-school
      // name (for example they contain only “Grades 9-12”). Ask the index for
      // each missing stage explicitly; this changes the snippet window and
      // recovers the omitted school identity without browser interaction.
      const stageQueries: Array<[SchoolEvidence["type"], string]> = [
        ["elementary", "\"Elementary School\""],
        ["middle", "\"Middle School\""],
        ["high", "\"High School\""],
      ];
      for (const [type, term] of stageQueries) {
        if (schools.some((school) => school.type === type || school.type === "k12")) continue;
        await runSearch(`site:${canonicalUrl} ${term}`, `property ${type} school search`);
      }
      if (!hasCompleteSchoolStages(schools)) {
        const buildingAddress = address.replace(/\b(?:unit|apt|apartment|#)\s*[^,]+/i, "").split(",")[0].trim();
        if (buildingAddress && buildingAddress.length >= 5) {
          await runSearch(
            `"${buildingAddress}" "The schools near"`,
            "same-building school roster search",
          );
        }
      }
      if (!hasCompleteSchoolStages(schools)) await runRedfinFallback();
    }
    return mergeSchools([], schools);
  }

  private async searchExactSchool(name: string, location: string): Promise<SchoolEvidence[]> {
    const profile = schoolProfileIdentity(name, location);
    if (profile.knownUnrated) return [];
    if (profile.directUrl) {
      const content = await this.scrapeDedicatedSchoolPage(profile.directUrl);
      const rating = extractDedicatedSchoolPageRating(content, profile.lookupName);
      return rating == null ? [] : [{
        name, rating, scale: 10, type: inferSchoolType(name, content), ratingSource: "GreatSchools",
        evidenceSource: "greatschools-page", sourceUrl: profile.directUrl,
        relationship: "nearby", checkedAt: new Date().toISOString(),
      }];
    }
    firecrawlRequestBudget.consume(`exact school search: ${name}`);
    const response = await this.fetchFirecrawlWithRateLimitRetry("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        query: `"${profile.lookupName}" "${profile.location}" GreatSchools rating`, limit: 1, sources: ["web"],
        includeDomains: ["realtor.com", "greatschools.org"], country: "US", timeout: 30000,
      }),
    });
    if (!response.ok) throw new Error(`Firecrawl exact school search HTTP ${response.status}`);
    const payload: any = await response.json();
    firecrawlRequestBudget.settle(`exact school search: ${name}`, payload.creditsUsed);
    const web = Array.isArray(payload.data?.web) ? payload.data.web : Array.isArray(payload.data) ? payload.data : [];
    const expectedTokens = normalizeKey(profile.lookupName).split(" ").filter((token) => token.length > 2 && !/school|academy/.test(token));
    const locationTokens = normalizeKey(profile.location).split(" ").filter((token) => token.length > 2);
    const candidates = web.filter((item: any) => isDedicatedSchoolPage(String(item.url || ""), profile.pathNames))
      .sort((a: any, b: any) => schoolPagePriority(String(a.url || "")) - schoolPagePriority(String(b.url || "")))
      .slice(0, 1);
    const results: SchoolEvidence[] = [];
    for (const item of candidates) {
      const url = String(item.url || "");
      if (!/^https?:\/\/(?:www\.)?(?:realtor\.com|greatschools\.org)\//i.test(url)) continue;
      // Search result and district-ranking pages can mention the requested school
      // while displaying another school's rating. Only a dedicated page for the
      // requested school is safe enough to use as rating evidence.
      if (!isDedicatedSchoolPage(url, profile.pathNames)) continue;
      // scrapeOptions returns the profile body in markdown. Prefer it over a
      // potentially stale search-engine description when available.
      const searchContent = item.markdown
        ? `${item.title || ""}\n${item.markdown}`
        : [item.title, item.description].filter(Boolean).join("\n");
      // A search snippet can place another nearby school's score beside the
      // requested name. The dedicated profile is cheap to fetch directly and
      // is the only safe source for the final numeric rating.
      const scrapedContent = await this.scrapeDedicatedSchoolPage(url).catch(() => "");
      const content = scrapedContent || searchContent;
      const normalizedContent = normalizeKey(`${searchContent}\n${content}`);
      if (!expectedTokens.every((token) => normalizedContent.includes(token))) continue;
      if (locationTokens.length && !locationTokens.some((token) => normalizedContent.includes(token))) continue;
      const rating = extractDedicatedSchoolPageRating(content, profile.lookupName);
      if (rating == null) continue;
      results.push({
        name, rating, scale: 10, type: inferSchoolType(name, content), ratingSource: "GreatSchools",
        evidenceSource: /greatschools\.org/i.test(url) ? "greatschools-page" : "realtor-school-page",
        sourceUrl: url, relationship: "nearby", checkedAt: new Date().toISOString(),
      });
    }
    results.sort((a, b) => schoolPagePriority(a.sourceUrl) - schoolPagePriority(b.sourceUrl));
    return mergeSchools([], results);
  }

  private async scrapeDedicatedSchoolPage(url: string): Promise<string> {
    // Dedicated Realtor and GreatSchools profile pages are ordinary public
    // documents. Fetching them directly avoids spending one Firecrawl request
    // per school and, more importantly, avoids exhausting Firecrawl's
    // requests-per-minute limit after a batch of listing-detail scrapes.
    if (this.directPageFetch && isDedicatedSchoolHost(url)) {
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const direct = await this.directPageFetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; RealEstatePi/1.0; school-evidence)",
              "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(20000),
          });
          if (direct.ok) {
            const content = await direct.text();
            if (content && extractDedicatedSchoolPageRating(content, "") != null) return content;
            break;
          }
          if (direct.status !== 429 || attempt === 1) break;
          const retryText = direct.headers.get("retry-after");
          const retrySeconds = retryText && Number.isFinite(Number(retryText)) ? Number(retryText) : 2;
          await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(500, retrySeconds * 1000))));
        }
      } catch {
        // Fall through to Firecrawl when the host blocks a direct server fetch.
      }
    }
    firecrawlRequestBudget.consume("dedicated school page fallback");
    const response = await this.fetchFirecrawlWithRateLimitRetry("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        // Rating pages are inexpensive single-page lookups, and stale upstream
        // snapshots can change whether a hard school threshold passes.
        url, formats: ["markdown"], onlyMainContent: true, maxAge: 0, timeout: 30000,
      }),
    });
    if (!response.ok) throw new Error(`Firecrawl school page HTTP ${response.status}`);
    const payload: any = await response.json();
    firecrawlRequestBudget.settle("dedicated school page fallback", payload.creditsUsed);
    return String(payload.data?.markdown || payload.data?.content || "");
  }

  private async fetchFirecrawlWithRateLimitRetry(url: string, init: RequestInit): Promise<Response> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(45000) });
      if (response.status !== 429 || attempt === 2) return response;
      const body = await response.clone().text().catch(() => "");
      const retryHeaderText = response.headers.get("retry-after");
      const retryBodyText = body.match(/retry\s+after\s+(\d+)s/i)?.[1];
      const retryHeader = retryHeaderText == null || retryHeaderText.trim() === "" ? NaN : Number(retryHeaderText);
      const retryBody = retryBodyText == null || retryBodyText.trim() === "" ? NaN : Number(retryBodyText);
      const seconds = Number.isFinite(retryHeader) && retryHeader >= 0
        ? retryHeader
        : Number.isFinite(retryBody) && retryBody >= 0 ? retryBody : 15 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, seconds === 0
        ? 0 : Math.min(65000, Math.max(1000, seconds * 1000 + 500))));
    }
    return response!;
  }
}

function isDedicatedSchoolHost(sourceUrl: string): boolean {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return host === "www.realtor.com" || host === "realtor.com"
      || host === "www.greatschools.org" || host === "greatschools.org";
  } catch {
    return false;
  }
}

export function isExactStreetAndZipResult(item: any, address: string): boolean {
  const normalizeAddress = (value: string) => value.toLowerCase()
    .replace(/\b(?:unit|apt|apartment)\s+[^,]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const zip = String(address).match(/\b(\d{5})(?:-\d{4})?\b/)?.[1];
  if (!zip) return false;
  const street = normalizeAddress(String(address).split(",")[0]);
  if (street.length < 5) return false;
  const title = normalizeAddress([item.title, item.description].filter(Boolean).join(" "));
  let url = String(item.url || "");
  try { url = decodeURIComponent(url); } catch { /* Preserve malformed URLs for conservative matching. */ }
  const identity = `${title} ${normalizeAddress(url)}`;
  return new RegExp(`\\b${escapeRegExp(zip)}\\b`).test(identity)
    && identity.includes(street);
}

function urlHostMatches(value: string, expectedDomain: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === expectedDomain || host.endsWith(`.${expectedDomain}`);
  } catch {
    return false;
  }
}

export function extractRedfinAssignedSchoolEvidence(content: string, sourceUrl: string): SchoolEvidence[] {
  const readable = content
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[•·|]/g, " ")
    .replace(/\s+/g, " ");
  const found = new Map<string, SchoolEvidence>();
  // Redfin search/property text uses:
  // "School Name Public PreK-5 Assigned 4.2mi 3/10".
  const pattern = /([A-Z][A-Za-z0-9'.&()\- ]{2,120}?(?:School|Academy|Institute))\s+(?:Public|Private|Charter)?\s*((?:PK|Pre-?K|K|\d{1,2})\s*[-–—]\s*(?:K|\d{1,2}))\s+Assigned\b[^0-9]{0,20}(?:[\d.]+\s*mi(?:les?)?)?\s*(\d{1,2})\s*\/\s*10/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(readable)) !== null) {
    const name = cleanSchoolName(match[1].replace(/^.*\b(?:Transit|Schools)\s+/i, ""));
    const grades = match[2].replace(/\s+/g, "");
    const rating = validRating(match[3]);
    if (!name || rating == null) continue;
    addOrMerge(found, {
      name,
      rating,
      scale: 10,
      type: inferSchoolTypeFromGrades(grades, name),
      grades,
      ratingSource: "GreatSchools",
      evidenceSource: "firecrawl-search",
      sourceUrl,
      relationship: "assigned",
      checkedAt: new Date().toISOString(),
    });
  }
  return [...found.values()];
}

function isDedicatedSchoolPage(sourceUrl: string, schoolName: string | string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponent(parsed.pathname).toLowerCase();
  const pageKey = normalizeKey(path);
  const names = Array.isArray(schoolName) ? schoolName : [schoolName];
  const matchesName = names.some((candidate) => {
    const schoolTokens = normalizeKey(candidate).split(" ")
      .filter((token) => token.length > 2 && !/^(school|academy|institute|elementary|middle|high|road)$/.test(token));
    return schoolTokens.length > 0 && schoolTokens.every((token) => pageKey.includes(token));
  });
  if (!matchesName) return false;

  if (host === "greatschools.org") {
    // Example: /georgia/athens/424-Burney-Harris-Lyons-Middle-School/
    // Explicitly reject district/city rankings such as /best-middle-schools/.
    return !/\/(?:best-|school-districts?|reviews?)(?:\/|-)/i.test(path)
      && /^\/[^/]+\/[^/]+\/\d+-[^/]+\/?$/i.test(path);
  }

  if (host === "realtor.com") {
    return /^\/local\/schools\/[^/]+\/?$/i.test(path)
      || /\/schools\/[^/]+\/?$/i.test(path);
  }
  return false;
}

function schoolProfileIdentity(name: string, location: string): {
  lookupName: string; location: string; pathNames: string[]; directUrl?: string; knownUnrated?: boolean;
} {
  const aliases: Record<string, { lookupName: string; location?: string; pathNames?: string[]; directUrl?: string; knownUnrated?: boolean }> = {
    "hilsman middle school": { lookupName: "Hilsman Middle School", directUrl: "https://www.greatschools.org/georgia/athens/418-Hilsman-Middle-School/" },
    "cedar shoals high school": { lookupName: "Cedar Shoals High School", directUrl: "https://www.greatschools.org/georgia/athens/421-Cedar-Shoals-High-School/" },
    "whitehead road elementary school": { lookupName: "Whitehead Road Elementary School", directUrl: "https://www.greatschools.org/georgia/athens/416-Whitehead-Road-Elementary-School/" },
    "burney harris lyons middle school": { lookupName: "Burney-Harris-Lyons Middle School", directUrl: "https://www.greatschools.org/georgia/athens/424-Burney-Harris-Lyons-Middle-School/" },
    "clarke central high school": { lookupName: "Clarke Central High School", directUrl: "https://www.greatschools.org/georgia/athens/417-Clarke-Central-High-School/" },
    "barnett shoals elementary school": { lookupName: "Barnett Shoals Elementary School", directUrl: "https://www.greatschools.org/georgia/athens/415-Barnett-Shoals-Elementary-School/" },
    "clarke middle school": { lookupName: "Clarke Middle School", directUrl: "https://www.greatschools.org/georgia/athens/412-Clarke-Middle-School/" },
    "whit davis elementary school": { lookupName: "Whit Davis Road Elementary School", directUrl: "https://www.greatschools.org/georgia/athens/431-Whit-Davis-Road-Elementary-School/" },
    "timothy road elementary school": { lookupName: "Timothy Elementary School", directUrl: "https://www.greatschools.org/georgia/athens/413-Timothy-Elementary-School/" },
    "cleveland road elementary school": { lookupName: "Cleveland Road Elementary School", location: "Bogart, GA", directUrl: "https://www.greatschools.org/georgia/bogart/429-Cleveland-Road-Elementary-School/" },
    "bettye henderson holston elementary school": {
      lookupName: "Bettye Henderson Holston Elementary School",
      pathNames: ["Bettye Henderson Holston Elementary School", "Alps Road Elementary School"],
      directUrl: "https://www.greatschools.org/georgia/athens/420-Alps-Road-Elementary-School/",
    },
    "maxine pinson easom elementary school": { lookupName: "Maxine Pinson Easom Elementary School", knownUnrated: true },
  };
  const alias = aliases[normalizeKey(name)];
  return {
    lookupName: alias?.lookupName || name,
    location: alias?.location || location,
    pathNames: alias?.pathNames || [alias?.lookupName || name],
    directUrl: alias?.directUrl,
    knownUnrated: alias?.knownUnrated,
  };
}

function schoolPagePriority(sourceUrl: string): number {
  if (/greatschools\.org/i.test(sourceUrl)) return 0;
  if (/realtor\.com\/local\/schools\//i.test(sourceUrl)) return 1;
  return 2;
}

export function extractTargetSchoolRating(content: string, schoolName: string): number | undefined {
  const decoded = content.replace(/\\n|\\r|\\t/g, " ").replace(/\\u0026/g, "&");
  const tokens = schoolName.match(/[a-z0-9]+/gi) || [];
  if (!tokens.length) return undefined;
  const targetPattern = new RegExp(tokens.map(escapeRegExp).join("[^a-z0-9]+"), "ig");
  let target: RegExpExecArray | null;

  while ((target = targetPattern.exec(decoded)) !== null) {
    // School profile pages commonly append a long list of nearby schools. A
    // rating is accepted only when it is close to an exact occurrence of the
    // target school's name and before any explicit nearby-school section.
    const tail = decoded.slice(target.index, target.index + TARGET_PROFILE_WINDOW_CHARS);
    const boundary = tail.search(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:Nearby Schools|Schools Nearby|Nearby high-performing|Homes Nearby)\b/i);
    const profile = boundary >= 0 ? tail.slice(0, boundary) : tail;
    const rating = extractGreatSchoolsRating(profile);
    if (rating != null) return rating;
  }
  return undefined;
}

export function extractDedicatedSchoolPageRating(content: string, schoolName: string): number | undefined {
  // On a dedicated profile page the identity is established by its exact URL.
  // Realtor inserts an HTML comment between the score and “out of 10”, while
  // GreatSchools commonly renders “2/10”. Keep the match close to the
  // GreatSchools label so parent-review star ratings cannot be mistaken for it.
  const readable = content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ");
  const beforeLabel = readable.match(/\b(\d{1,2})\s*(?:\/\s*10|out\s+of\s+10)\s+GreatSchools(?:\s+Summary)?\s+Rating\b/i);
  const afterLabel = readable.match(/\bGreatSchools(?:\s+Summary)?\s+Rating\b.{0,120}?\b(\d{1,2})\s*(?:\/\s*10|out\s+of\s+10)\b/i);
  const dedicated = validRating(beforeLabel?.[1] || afterLabel?.[1]);
  if (dedicated != null) return dedicated;
  return schoolName ? extractTargetSchoolRating(content, schoolName) : undefined;
}

function extractDedicatedSchoolGradeProfile(
  content: string,
  schoolName: string,
): { type: SchoolEvidence["type"]; grades?: string } {
  const readable = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const lower = readable.toLowerCase();
  const targetName = schoolName.toLowerCase();
  let from = 0;
  let profile = readable.slice(0, 5000);
  let grades: string | undefined;
  while (targetName && from < readable.length) {
    const target = lower.indexOf(targetName, from);
    if (target < 0) break;
    profile = readable.slice(target, target + 1800);
    grades = profile.match(/\b((?:PK|Pre-?K|K|\d{1,2})\s*[-–—]\s*(?:K|\d{1,2}))\b/i)?.[1]
      ?.replace(/\s+/g, "");
    if (grades) break;
    from = target + targetName.length;
  }
  return {
    type: grades ? inferSchoolTypeFromGrades(grades, schoolName) : inferSchoolType(schoolName, profile),
    grades,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEvidence(name: string, context: string, sourceUrl: string, evidenceSource: SchoolEvidence["evidenceSource"]): SchoolEvidence {
  const ratingMatch = context.match(/"(?:rating|greatschools_rating|greatSchoolsRating)"\s*:\s*"?(\d{1,2})"?/i)
    || context.match(/GreatSchools(?:®)?(?:\s+Rating)?\s*[:\-]?\s*(\d{1,2})(?:\s*\/\s*10)?/i);
  const gradesMatch = context.match(/"(?:grades|grade_levels?)"\s*:\s*"([^"\]]{1,40})"/i);
  const rating = validRating(ratingMatch?.[1]);
  return {
    name,
    rating,
    scale: 10,
    type: inferSchoolType(name, gradesMatch?.[1] || context),
    grades: gradesMatch?.[1],
    ratingSource: rating == null ? "unknown" : "GreatSchools",
    evidenceSource,
    sourceUrl,
    relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
    assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
    assignmentSourceUrl: evidenceSource === "realtor-listing" ? sourceUrl : undefined,
    checkedAt: new Date().toISOString(),
  };
}

function inferSchoolType(name: string, context: string): SchoolEvidence["type"] {
  const text = `${name} ${context}`.toLowerCase();
  if (/k\s*[-–]\s*12|k12|kindergarten.{0,10}12/.test(text)) return "k12";
  if (/elementary|primary|grades?\s*(?:pk|k)?\s*[-–]\s*5/.test(text)) return "elementary";
  if (/middle|junior high|grades?\s*6\s*[-–]\s*8/.test(text)) return "middle";
  if (/high school|secondary|grades?\s*9\s*[-–]\s*12/.test(text)) return "high";
  return "other";
}

function inferSchoolTypeFromGrades(grades: string, name: string): SchoolEvidence["type"] {
  const normalizedGrades = grades.toUpperCase().replace(/\s+/g, "").replace(/[–—]/g, "-");
  if (/^(?:PK|PREK|PRE-K|K)-5$/.test(normalizedGrades)) return "elementary";
  if (/^6-8$/.test(normalizedGrades)) return "middle";
  if (/^9-12$/.test(normalizedGrades)) return "high";
  if (/^(?:PK|PREK|PRE-K|K)-12$/.test(normalizedGrades)) return "k12";
  return inferSchoolType(name, `Grades ${grades}`);
}

function extractRealtorSchoolPanelCards(
  content: string,
  listingUrl: string,
  evidenceSource: SchoolEvidence["evidenceSource"],
): SchoolEvidence[] {
  // Firecrawl can represent a title as plain text, a Markdown link, or an
  // accessibility label such as "[Button: Amanda C Rowe School]".
  const readable = content
    .replace(/\[Button:\s*([^\]]+)\]/gi, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const found = new Map<string, SchoolEvidence>();
  const cardPattern = /\b(\d{1,2})\s*(?:\/\s*)?10(?:\s+\1\s+out\s+of\s+10)?[\s|·•]{0,80}([A-Z][A-Za-z0-9'.&()\- ]{2,120}?(?:School|Academy|Institute))\s+Grades?\s+((?:PK|Pre-?K|K|\d{1,2})\s*[-–—]\s*(?:K|\d{1,2}))/gi;
  let match: RegExpExecArray | null;

  while ((match = cardPattern.exec(readable)) !== null) {
    const rating = validRating(match[1]);
    const name = cleanSchoolName(match[2]);
    const grades = match[3].replace(/\s+/g, "");
    if (!name || rating == null) continue;
    const context = readable.slice(match.index, Math.min(readable.length, match.index + 420));
    const linkPattern = new RegExp(
      `\\[${escapeRegExp(name)}\\]\\((https?:\\/\\/[^)\\s]+)(?:\\s+"[^"]*")?\\)`,
      "i",
    );
    const linkedUrl = content.match(linkPattern)?.[1];
    addOrMerge(found, {
      name,
      rating,
      scale: 10,
      type: inferSchoolTypeFromGrades(grades, name),
      grades,
      distanceMiles: parseMetric(context, /([\d.]+)\s*mi(?:les?)?\s+away/i, 0, 100),
      studentCount: parseMetric(context, /([\d,]+)\s+students?\b/i, 0, 1_000_000),
      reviewCount: parseMetric(context, /([\d,]+)\s+reviews?\b/i, 0, 1_000_000),
      ratingSource: "GreatSchools",
      evidenceSource,
      sourceUrl: linkedUrl || listingUrl,
      relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
      assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
      assignmentSourceUrl: evidenceSource === "realtor-listing" ? listingUrl : undefined,
      checkedAt: new Date().toISOString(),
    });
  }
  return [...found.values()];
}

function extractRealtorGradeCards(
  content: string,
  listingUrl: string,
  evidenceSource: SchoolEvidence["evidenceSource"],
): SchoolEvidence[] {
  const readable = content
    .replace(/\[Button:\s*([^\]]+)\]/gi, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\r\n]+/g, ". ")
    .replace(/\s+/g, " ");
  const found = new Map<string, SchoolEvidence>();
  // The mandatory "out of 10" boundary prevents this fallback from starting
  // at unrelated preceding prose or at a previous card's review count.
  const gradeCardPattern = /\bout\s+of\s+10[.:\s]+([A-Z][A-Za-z0-9'.&()\- ]{2,120}?(?:School|Academy|Institute))[.:\s]+Grades?\s+((?:PK|Pre-?K|K|\d{1,2})\s*[-–—]\s*(?:K|\d{1,2}))/gi;
  let match: RegExpExecArray | null;

  while ((match = gradeCardPattern.exec(readable)) !== null) {
    const name = cleanSchoolName(match[1]);
    const grades = match[2].replace(/\s+/g, "");
    if (!name || /\bschool district\b|\bpublic schools?\b/i.test(name)) continue;
    addOrMerge(found, {
      name,
      scale: 10,
      type: inferSchoolTypeFromGrades(grades, name),
      grades,
      ratingSource: "unknown",
      evidenceSource,
      sourceUrl: listingUrl,
      relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
      assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
      assignmentSourceUrl: evidenceSource === "realtor-listing" ? listingUrl : undefined,
      checkedAt: new Date().toISOString(),
    });
  }
  // A stage-focused search (for example `"High School"`) intentionally
  // changes the search-engine snippet so it begins at the missing school name.
  // Such a snippet may omit the preceding rating entirely, but the exact
  // property URL plus adjacent Grades field still establishes the identity.
  const identityOnlyPattern = /(?:^|[.;|]\s+)([A-Z0-9][A-Za-z0-9,'.&()\- ]{2,160}?(?:School|Academy|Institute))[.:\s]+Grades?\s+((?:PK|Pre-?K|K|\d{1,2})\s*[-–—]\s*(?:K|\d{1,2}))/gi;
  while ((match = identityOnlyPattern.exec(readable)) !== null) {
    const name = cleanSchoolName(match[1]);
    const grades = match[2].replace(/\s+/g, "");
    if (!name || /\bschool district\b|\bpublic schools?\b/i.test(name)) continue;
    addOrMerge(found, {
      name,
      scale: 10,
      type: inferSchoolTypeFromGrades(grades, name),
      grades,
      ratingSource: "unknown",
      evidenceSource,
      sourceUrl: listingUrl,
      relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
      assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
      assignmentSourceUrl: evidenceSource === "realtor-listing" ? listingUrl : undefined,
      checkedAt: new Date().toISOString(),
    });
  }
  return [...found.values()];
}

function canonicalSearchUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return value.replace(/^https?:\/\//i, "").split(/[?#]/)[0].replace(/\/+$/, "");
  }
}

function looksLikeSchool(name: string, context: string): boolean {
  if (/\bschool district\b|\bpublic schools?\b/i.test(name)) return false;
  return /school|academy|elementary|middle|high|institute/i.test(name)
    || /education_levels|school_type|grade_levels|greatschools/i.test(context);
}

function cleanSchoolName(value: string): string {
  return value.replace(/\s+/g, " ")
    .replace(/^.*\b\d{5}(?:-\d{4})?\b\s*/i, "")
    .replace(/^.*\bout\s+of\s+10[.:\s]*/i, "")
    .replace(/^.*\b\d{1,2}\s+10\s+/i, "")
    .replace(/^(?:homes?|real estate|properties)\s+for\s+sale\s+near\s+/i, "")
    .replace(/\s*[-|:]\s*GreatSchools?$/i, "")
    .replace(/^[-|:.,\s]+|[-|:.,\s]+$/g, "").trim();
}

function validRating(value: unknown): number | undefined {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : undefined;
}

function extractEmbeddedSchoolJson(
  content: string,
  sourceUrl: string,
  evidenceSource: SchoolEvidence["evidenceSource"],
): SchoolEvidence[] {
  const documents: unknown[] = [];
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(content)) !== null) {
    const candidate = decodeJsonEntities(match[1]).trim();
    if (!candidate || candidate.length > 8_000_000) continue;
    const start = candidate.search(/[\[{]/);
    if (start < 0) continue;
    const parsed = parseJsonCandidate(candidate.slice(start));
    if (parsed !== undefined) documents.push(parsed);
  }

  // Some Firecrawl rawHtml snapshots flatten a JSON script into surrounding
  // text. Recover complete school arrays with bracket-aware extraction.
  const decoded = decodeJsonEntities(content).replace(/\\u0022|\\"/g, '"');
  const arrayMarker = /"(?:schools|nearbySchools|nearby_schools|assignedSchools)"\s*:\s*\[/gi;
  while ((match = arrayMarker.exec(decoded)) !== null) {
    const open = decoded.indexOf("[", match.index);
    const json = extractBalancedJson(decoded, open, "[", "]");
    if (!json || json.length > 2_000_000) continue;
    const parsed = parseJsonCandidate(json);
    if (parsed !== undefined) documents.push({ schools: parsed });
    arrayMarker.lastIndex = open + json.length;
  }

  const found = new Map<string, SchoolEvidence>();
  const visited = new Set<object>();
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object" || visited.has(value as object)) return;
    visited.add(value as object);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path));
      return;
    }
    const object = value as Record<string, unknown>;
    const nameValue = firstField(object, ["name", "school_name", "schoolName", "display_name", "displayName"]);
    const name = typeof nameValue === "string" ? cleanSchoolName(nameValue) : "";
    const context = safeJson(object);
    if (name && (/(?:school|schools|education)/i.test(path) || looksLikeSchool(name, context)) && looksLikeSchool(name, context)) {
      const rating = validRating(scalarField(object, ["rating", "greatschools_rating", "greatSchoolsRating", "gs_rating", "gsRating", "score"]));
      const gradesValue = scalarField(object, ["grades", "grade_levels", "gradeLevels", "grades_served", "gradesServed"]);
      const grades = Array.isArray(gradesValue) ? gradesValue.join("-") : typeof gradesValue === "string" ? gradesValue : undefined;
      const distanceMiles = numericField(object, ["distance_in_miles", "distanceMiles", "distance_miles", "distance"], 0, 100);
      const studentCount = numericField(object, ["student_count", "studentCount", "students", "enrollment"], 0, 1_000_000);
      const reviewCount = numericField(object, ["review_count", "reviewCount", "reviews"], 0, 1_000_000);
      const candidateUrl = scalarField(object, ["href", "url", "profile_url", "profileUrl"]);
      const schoolUrl = typeof candidateUrl === "string" ? absoluteSchoolUrl(candidateUrl, sourceUrl) : sourceUrl;
      addOrMerge(found, {
        name, rating, scale: 10, type: inferSchoolType(name, `${grades || ""} ${context}`), grades,
        distanceMiles, studentCount, reviewCount,
        ratingSource: rating == null ? "unknown" : "GreatSchools", evidenceSource,
        sourceUrl: schoolUrl, relationship: evidenceSource === "realtor-listing" ? "listing-associated" : "nearby",
        assignmentSource: evidenceSource === "realtor-listing" ? "realtor-listing" : undefined,
        assignmentSourceUrl: evidenceSource === "realtor-listing" ? sourceUrl : undefined,
        checkedAt: new Date().toISOString(),
      });
    }
    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  };
  documents.forEach((document) => visit(document, "root"));
  return [...found.values()];
}

function decodeJsonEntities(value: string): string {
  return value.replace(/&quot;/gi, '"').replace(/&#34;/g, '"').replace(/&amp;/gi, "&").replace(/&#39;/g, "'");
}

function parseJsonCandidate(value: string): unknown | undefined {
  const trimmed = value.trim().replace(/;\s*$/, "");
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && /^[\[{]/.test(parsed.trim())) return JSON.parse(parsed);
    return parsed;
  } catch {
    const end = trimmed[0] === "{" ? extractBalancedJson(trimmed, 0, "{", "}")
      : trimmed[0] === "[" ? extractBalancedJson(trimmed, 0, "[", "]") : "";
    if (!end) return undefined;
    try { return JSON.parse(end); } catch { return undefined; }
  }
}

function extractBalancedJson(content: string, start: number, open: string, close: string): string {
  if (start < 0 || content[start] !== open) return "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return content.slice(start, index + 1);
  }
  return "";
}

function firstField(object: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (object[key] != null) return object[key];
  return undefined;
}

function scalarField(object: Record<string, unknown>, keys: string[]): unknown {
  const value = firstField(object, keys);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return firstField(value as Record<string, unknown>, ["value", "score", "rating", "count"]);
  }
  return value;
}

function numericField(object: Record<string, unknown>, keys: string[], minimum: number, maximum: number): number | undefined {
  const value = scalarField(object, keys);
  const number = Number(String(value ?? "").replace(/,/g, "").match(/[\d.]+/)?.[0]);
  return Number.isFinite(number) && number > minimum && number < maximum ? number : undefined;
}

function parseMetric(content: string, pattern: RegExp, minimum: number, maximum: number): number | undefined {
  const number = Number(String(content.match(pattern)?.[1] || "").replace(/,/g, ""));
  return Number.isFinite(number) && number > minimum && number < maximum ? number : undefined;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 5000); } catch { return ""; }
}

function absoluteSchoolUrl(value: string, listingUrl: string): string {
  try { return new URL(value, listingUrl || "https://www.realtor.com").toString(); } catch { return listingUrl; }
}

export function extractGreatSchoolsRating(content: string): number | undefined {
  const patterns = [
    /(\d{1,2})\s*(?:\/|out\s+of)\s*10\s*GreatSchools(?:®)?\s*Rating/i,
    /GreatSchools(?:®)?\s*Rating[^\d]{0,40}(\d{1,2})\s*(?:\/\s*10|out\s+of\s+10)?/i,
    /School\s+Rating[^\d]{0,80}(\d{1,2})\s*\/\s*10/i,
  ];
  for (const pattern of patterns) {
    const value = validRating(content.match(pattern)?.[1]);
    if (value != null) return value;
  }
  return undefined;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\broad\b/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeCacheKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function addOrMerge(target: Map<string, SchoolEvidence>, school: SchoolEvidence): void {
  const key = normalizeKey(school.name);
  if (!key) return;
  const existing = target.get(key);
  if (!existing) {
    target.set(key, school);
  } else {
    const preserveRelationship = existing.relationship === "assigned" || existing.relationship === "assignment-option"
      || existing.relationship === "listing-associated";
    const preserveExistingSource = existing.rating != null || isRealtorSchoolUrl(existing.sourceUrl);
    target.set(key, {
      ...existing,
      rating: existing.rating ?? school.rating,
      ratingSource: existing.rating != null ? existing.ratingSource : school.ratingSource,
      type: existing.type === "other" ? school.type : existing.type,
      grades: existing.grades || school.grades,
      distanceMiles: existing.distanceMiles ?? school.distanceMiles,
      studentCount: existing.studentCount ?? school.studentCount,
      reviewCount: existing.reviewCount ?? school.reviewCount,
      evidenceSource: preserveExistingSource ? existing.evidenceSource : school.evidenceSource,
      sourceUrl: preserveExistingSource ? existing.sourceUrl : school.sourceUrl,
      checkedAt: preserveExistingSource ? existing.checkedAt : school.checkedAt,
      relationship: preserveRelationship ? existing.relationship : school.relationship,
      assignmentSource: existing.assignmentSource || school.assignmentSource,
      assignmentSourceUrl: existing.assignmentSourceUrl || school.assignmentSourceUrl,
    });
  }
}

function mergeSchools(current: SchoolEvidence[], incoming: SchoolEvidence[]): SchoolEvidence[] {
  const merged = new Map<string, SchoolEvidence>();
  current.forEach((school) => addOrMerge(merged, school));
  incoming.forEach((school) => addOrMerge(merged, school));
  return [...merged.values()];
}

function hasCompleteSchoolStages(schools: SchoolEvidence[]): boolean {
  const stages = new Set(schools.map((school) => school.type));
  return stages.has("k12")
    || (stages.has("elementary") && stages.has("middle") && stages.has("high"));
}

export function hasHardSchoolRatingFailure(
  schools: SchoolEvidence[],
  minimumRating?: number,
): boolean {
  if (minimumRating == null) return false;
  return schools.some((school) =>
    school.rating != null
    && school.rating < minimumRating
    && school.type !== "other"
    && (school.relationship === "assigned"
      || school.relationship === "assignment-option"
      || school.relationship === "listing-associated"));
}

function isRealtorSchoolUrl(value: string): boolean {
  return /^https?:\/\/(?:www\.)?realtor\.com\/local\/schools\/[^/?#]+/i.test(value);
}

export const schoolRatingService = new SchoolRatingService();
