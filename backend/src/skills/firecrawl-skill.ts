import { SearchCriteria, Property } from "../core/types";

import { assessProperty, extractCoreListingMetrics, extractPropertyEvidence, propertyMatchesRequestedMarket } from "../core/property-matcher";
import * as store from "../core/store";
import type { UserSession } from "../core/types";
import { geoValidationService } from "../services/geo-validation-service";
import { schoolRatingService } from "../services/school-rating-service";
import { officialSchoolAssignmentService } from "../services/official-school-assignment-service";
import { listingEvidenceSearchService } from "../services/listing-evidence-search-service";
import { firecrawlRequestBudget } from "../services/firecrawl-request-budget";
import { defaultCacheFile, PersistentJsonCache } from "../services/persistent-json-cache";
import { readEnvironmentSecret } from "../services/environment-secret";
import { waterbodyService } from "../services/waterbody-service";

export class FirecrawlSkill {
  private apiKey: string;
  private readonly listingCache: PersistentJsonCache<Property[]>;
  private readonly listingFetch: typeof fetch;
  // Keep scraping, enrichment, Pi analysis, and UI output on the same bounded set.
  // Several evidence providers are intentionally capped at 20 requests per search.
  private readonly maxResults = 20;

  constructor(listingFetch: typeof fetch = fetch, apiKey = readEnvironmentSecret("FIRECRAWL_API_KEY")) {
    this.apiKey = apiKey;
    this.listingFetch = listingFetch;
    this.listingCache = new PersistentJsonCache<Property[]>(defaultCacheFile("realtor-market-listings.json"));
  }

  async searchProperties(criteria: SearchCriteria): Promise<{ properties: Property[]; source: string; totalCount: number; error?: string }> {
    const configuredBudget = resolveFirecrawlBudget(criteria);
    return firecrawlRequestBudget.run(async () => {
      try {
        return await this.searchPropertiesWithinBudget(criteria);
      } finally {
        const budget = firecrawlRequestBudget.snapshot();
        if (budget) console.log(`[FirecrawlBudget] credits ${budget.used}/${budget.limit}, HTTP requests ${budget.requests}: ${budget.labels.join(", ")}`);
      }
    }, configuredBudget);
  }

  private async searchPropertiesWithinBudget(criteria: SearchCriteria): Promise<{ properties: Property[]; source: string; totalCount: number; error?: string }> {
    console.log("[FirecrawlSkill] Search:", JSON.stringify(criteria));
    if (!criteria.location) return { properties: [], source: "none", totalCount: 0, error: "Please specify a location" };

    const applyFilters = (props: any[], content?: string): any[] => {
      if (!props.length) return props;
      return props.filter((p: any) => {
        if (criteria.location) {
          if (!propertyMatchesRequestedMarket(p, criteria.location)) return false;
        }
        if (criteria.minPrice != null && p.price < criteria.minPrice) return false;
        if (criteria.maxPrice != null && p.price > criteria.maxPrice) return false;
        // Zero is the legacy sentinel for "not extracted", not evidence that a
        // listing has zero rooms. Keep unknowns until detail enrichment/assessment.
        if (criteria.minBedrooms != null
            && (p.bedroomsSource || p.bedrooms > 0)
            && p.bedrooms < criteria.minBedrooms) return false;
        if (criteria.minBathrooms != null && p.bathrooms > 0 && p.bathrooms < criteria.minBathrooms) return false;
        // Do not reject feature requirements from search cards. Many Realtor
        // facts only appear on the detail page and are evaluated after enrichment.
        return true;
      });
    };

    try {
      const loc = await this.parseLocation(criteria.location);
      // All downstream filters and assessments must use the exact market that
      // produced the Realtor URL. A bare ambiguous city such as Portland or
      // Athens must not accept a result from another state.
      criteria = { ...criteria, location: canonicalMarketLocation(loc) };
      let targetUrl = "https://www.realtor.com/realestateandhomes-search/" + loc.citySlug + "_" + loc.stateCode;

      const page = (criteria as any).page || 1;
      if (page > 1) {
        targetUrl += `/pg-${page}`;
      }

      // Version the cache whenever core metric normalization changes.
      // v9 invalidates records created before Studio cards were treated as an
      // explicit zero-bedroom value and kept inside their own card boundary.
      const cacheKey = `v9:${targetUrl.toLowerCase()}`;
      const cachedMarket = this.listingCache.get(cacheKey);
      // A basic market cache normally contains only the first result page.
      // Feature searches intentionally inspect additional pages so likely
      // lake/brick candidates can enter the bounded 20-detail evidence set.
      // Reusing the first-page cache here silently disabled that discovery
      // after any ordinary search had warmed the cache.
      if (cachedMarket?.length && shouldUseCachedMarket(criteria)) {
        const warning = "Using recently cached real Realtor listings to avoid another listing-page scrape; results are not guaranteed to be current.";
        const cached = applyFilters(cachedMarket.map(repairCachedCoreMetrics))
          .map((property) => addDiagnostic(property, "listing-search", "warning", warning));
        const matched = await this.finalizeComplexMatches(cached, criteria);
        return { properties: matched, source: "Realtor.com (recent live cache)", totalCount: matched.length, error: warning };
      }

      console.log("[FirecrawlSkill] Fetching:", targetUrl);

      const data = await this.scrapeListingPage(targetUrl);

      if (data.success && data.data) {
        const raw = data.data.rawHtml || "";
        if (raw.length > 1000) {const md = data.data.markdown || data.data.content || "";
          console.log("[FirecrawlSkill] Got rawHtml:", raw.length, "chars");
          let fromHtml = this.parsePropertiesFromHtml(raw, criteria, md);
          await yieldToEventLoop();
          if (fromHtml.length > 0) {
            if (page === 1) fromHtml = await this.supplementListingPages(targetUrl, fromHtml, criteria, applyFilters);
            console.log("[FirecrawlSkill] Extracted", fromHtml.length, "properties from JSON-LD");
            this.cacheLiveListings(cacheKey, fromHtml);
            const filteredHtml = applyFilters(fromHtml, raw);
            const matchedHtml = await this.finalizeComplexMatches(filteredHtml, criteria);
            return { properties: matchedHtml, source: "realtor.com (via Firecrawl)", totalCount: matchedHtml.length };
          }
          console.log("[FirecrawlSkill] JSON-LD yielded 0, trying markdown...");
        }
        const md = data.data.markdown || data.data.content || "";
        if (md.length > 100) {
          console.log("[FirecrawlSkill] Got markdown:", md.length, "chars");
          const fromMd = this.parseContent(md, criteria);
          if (fromMd.length > 0) {
            console.log("[FirecrawlSkill] Parsed", fromMd.length, "properties from markdown");
            this.cacheLiveListings(cacheKey, fromMd);
            const matchedMarkdown = await this.finalizeComplexMatches(applyFilters(fromMd, md), criteria);
            return { properties: matchedMarkdown, source: "realtor.com (via Firecrawl)", totalCount: matchedMarkdown.length };
          }
          console.log("[FirecrawlSkill] Markdown parser returned 0");
        }
      } else {
        console.log("[FirecrawlSkill] Firecrawl returned no data:", JSON.stringify(data).substring(0, 300));
      }
    } catch (err: any) {
    console.error("[FirecrawlSkill]");
    console.error(err);

    if (err.name === "AbortError") {
        console.error("Firecrawl Timeout (>120s)");
    }

    const message = err instanceof Error ? err.message : String(err);
    if (/not a supported US City, ST market|Cannot determine the state for location/i.test(message)) {
      return { properties: [], source: "location-error", totalCount: 0, error: message };
    }
    const cached = this.loadPriorLiveListings(criteria.location!);
    if (cached.length) {
      const warning = `Live Realtor scrape failed (${message}); using previously captured real Realtor listings. Results are not live and may include sold or changed listings.`;
      const candidates = applyFilters(cached)
        .map((property) => addDiagnostic(property, "listing-search", "warning", warning));
      const results = await this.finalizeComplexMatches(candidates, criteria);
      return { properties: results, source: "Realtor.com (cached prior live results)", totalCount: results.length, error: warning };
    }
    if (/^(?:1|true|yes)$/i.test(process.env.RE_ALLOW_DEMO_FALLBACK || "")) {
      console.warn("[FirecrawlSkill] Explicit demo fallback enabled for", criteria.location);
      const results = await this.finalizeComplexMatches(this.demoSearch(criteria), criteria, false);
      return { properties: results, source: "demo-database", totalCount: results.length, error: message };
    }
    console.error("[FirecrawlSkill] Live scrape failed; demo fallback is disabled.");
    return { properties: [], source: "firecrawl-error", totalCount: 0, error: message };
}

    const message = "Firecrawl returned no parseable live Realtor listings.";
    const cached = this.loadPriorLiveListings(criteria.location!);
    if (cached.length) {
      const warning = `${message} Using previously captured real Realtor listings; results are not live.`;
      const candidates = applyFilters(cached)
        .map((property) => addDiagnostic(property, "listing-search", "warning", warning));
      const results = await this.finalizeComplexMatches(candidates, criteria);
      return { properties: results, source: "Realtor.com (cached prior live results)", totalCount: results.length, error: warning };
    }
    if (/^(?:1|true|yes)$/i.test(process.env.RE_ALLOW_DEMO_FALLBACK || "")) {
      const results = await this.finalizeComplexMatches(this.demoSearch(criteria), criteria, false);
      return { properties: results, source: "demo-database", totalCount: results.length, error: message };
    }
    return { properties: [], source: "firecrawl-error", totalCount: 0, error: message };
  }

  private async scrapeListingPage(url: string): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      firecrawlRequestBudget.consume("listing search page");
      const response = await this.listingFetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ url, formats: ["rawHtml", "markdown"], waitFor: 5000 }),
        signal: controller.signal,
      });
      console.log("[FirecrawlSkill] HTTP Status:", response.status);
      if (!response.ok) throw new Error(`Firecrawl HTTP ${response.status}`);
      const data: any = await response.json();
      firecrawlRequestBudget.settle("listing search page", data.creditsUsed);
      console.log("[FirecrawlSkill] success:", data.success, "hasData:", Boolean(data.data));
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async supplementListingPages(
    baseUrl: string,
    initial: Property[],
    criteria: SearchCriteria,
    applyFilters: (properties: Property[]) => Property[],
  ): Promise<Property[]> {
    const target = Math.max(1, Math.min(Number(process.env.RE_MIN_RESULT_TARGET || 10), this.maxResults));
    const pageLimit = Math.max(1, Math.min(Number(process.env.RE_LISTING_PAGE_LIMIT || 3), 5));
    const merged = new Map<string, Property>();
    const add = (property: Property) => {
      const key = normalizePropertyAddress(property);
      if (!merged.has(key)) merged.set(key, property);
    };
    initial.forEach(add);
    const featureDiscovery = Boolean(criteria.exteriorMaterials?.length || criteria.communityFeatures?.length);
    for (let page = 2; page <= pageLimit
      && (featureDiscovery || applyFilters([...merged.values()]).length < target); page++) {
      try {
        const data = await this.scrapeListingPage(`${baseUrl}/pg-${page}`);
        const raw = data?.data?.rawHtml || "";
        const markdown = data?.data?.markdown || data?.data?.content || "";
        if (raw.length < 1000) break;
        const parsed = this.parsePropertiesFromHtml(raw, criteria, markdown);
        await yieldToEventLoop();
        if (!parsed.length) break;
        parsed.forEach(add);
      } catch (error) {
        console.warn("[FirecrawlSkill] Additional listing page failed:", error instanceof Error ? error.message : String(error));
        break;
      }
    }
    return [...merged.values()].map((property, index) => ({ ...property, id: `r${index + 1}` }));
  }

  private cacheLiveListings(cacheKey: string, properties: Property[]): void {
    const ttlMs = positiveNumber(process.env.RE_LISTING_CACHE_TTL_MS, 30 * 60 * 1000);
    const candidateLimit = Math.max(this.maxResults, Math.min(Number(process.env.RE_LISTING_CACHE_CANDIDATE_LIMIT || 60), 100));
    this.listingCache.set(cacheKey, properties.slice(0, candidateLimit).map(clearDerivedMatch), ttlMs);
  }

  private loadPriorLiveListings(location: string): Property[] {
    const maxAgeMs = positiveNumber(process.env.RE_PRIOR_LISTING_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
    const sessions = store.listSessions()
      .map((id) => store.loadSession(id))
      .filter((session): session is UserSession => Boolean(session));
    return selectCachedLiveProperties(sessions, location, maxAgeMs, this.maxResults);
  }

  private hasComplexCriteria(criteria: SearchCriteria): boolean {
    return Boolean(criteria.mustHave?.length || criteria.exteriorMaterials?.length || criteria.communityFeatures?.length
      || criteria.distanceConstraints?.length || criteria.highwayAccess || criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null);
  }

  private async finalizeComplexMatches(properties: Property[], criteria: SearchCriteria, enrich = true): Promise<Property[]> {
    const hasSchoolCriteria = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
    const resultLimit = this.maxResults;
    let candidates = prioritizeCandidatesForCriteria(properties, criteria)
      .filter((property) => !criteria.location || propertyMatchesRequestedMarket(property, criteria.location))
      .slice(0, resultLimit)
      .map(addCoreDataDiagnostic);
    const needsListingDetail = requiresListingDetail(criteria);
    // Realtor cards can expose a stale/incomplete bathroom total even for
    // ordinary resale homes. Verify unresolved summaries against their own
    // detail URL, prioritizing implausible bed/bath ratios and large homes.
    if (enrich && listingEvidenceSearchService.enabled && shouldVerifyBathroomsSeparately(criteria)) {
      const limit = Math.max(0, Math.min(Number(process.env.RE_BATHROOM_VERIFY_LIMIT || 5), 10));
      const verificationTimeouts = resolveBathroomVerificationTimeouts();
      const batchController = new AbortController();
      const batchTimer = setTimeout(() => batchController.abort(), verificationTimeouts.batchMs);
      const indexes = candidates.map((property, index) => ({ property, index }))
        .map((candidate) => ({ ...candidate, priority: bathroomVerificationPriority(candidate.property) }))
        .filter(({ priority }) => priority > 0)
        .sort((left, right) => right.priority - left.priority)
        .slice(0, limit);
      try {
        await mapWithConcurrency(indexes, 2, async ({ index }) => {
          try {
            if (batchController.signal.aborted) return;
            const property = candidates[index];
            if (!property.url) return;
            const url = property.url.startsWith("http") ? property.url : `https://www.realtor.com${property.url.startsWith("/") ? "" : "/"}${property.url}`;
            const detail = await this.scrapeDetail(
              url, false, false, verificationTimeouts.requestMs, batchController.signal,
            );
            const enriched = extractPropertyEvidence(property, prepareDetailEvidenceContent(
              detail.markdown, detail.rawHtml, criteria, property.title,
            ));
            const verified = enriched.bathrooms > 0;
            candidates[index] = addDiagnostic(enriched, "listing-search", verified ? "success" : "warning", verified
              ? `Bathroom total verified from the exact Realtor property page: ${enriched.bathrooms} baths${enriched.fullBathrooms != null ? ` (${enriched.fullBathrooms} full, ${enriched.halfBathrooms || 0} half)` : ""}.`
              : "The exact Realtor property page did not provide a usable bathroom total.");
          } catch (error) {
            candidates[index] = addDiagnostic(candidates[index], "listing-search", "warning",
              `Exact Realtor bathroom verification stopped: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      } finally {
        clearTimeout(batchTimer);
      }
    }
    if (!this.hasComplexCriteria(criteria)) {
      return rankAssessedProperties(candidates, criteria);
    }
    // Realtor detail pages are the cheapest shared source for requested listing
    // features, nearby amenities, and source-backed school ratings. Official
    // locators still provide attendance assignment proof below.
    if (needsListingDetail && enrich && this.apiKey) {
      const limit = resolveFeatureEnrichmentLimit(criteria, process.env.RE_DETAIL_ENRICH_LIMIT);
      const concurrency = Math.max(1, Math.min(Number(process.env.RE_DETAIL_CONCURRENCY || 2), 4));
      const defaultInteractLimit = hasSchoolCriteria ? 20 : 3;
      const interactLimit = Math.max(0, Math.min(Number(process.env.RE_INTERACT_FALLBACK_LIMIT || defaultInteractLimit), 20));
      let interactFallbacks = 0;
      // Firecrawl permits several ordinary scrapes in parallel, but starting
      // multiple browser-interaction sessions together is much more likely to
      // be rate-limited. Keep only the interaction part sequential while the
      // surrounding detail-page work retains its configured concurrency.
      let interactionQueue: Promise<void> = Promise.resolve();
      const runInteraction = <T>(operation: () => Promise<T>): Promise<T> => {
        const queued = interactionQueue.then(operation, operation);
        interactionQueue = queued.then(() => undefined, () => undefined);
        return queued;
      };
      candidates = candidates.map((property, index) => index >= limit
        ? addDiagnostic(property, "listing-detail", "warning", `Detail enrichment limit ${limit} reached.`)
        : !property.url
          ? addDiagnostic(property, "listing-detail", "warning", "Listing detail URL is missing; brick and community amenities cannot be verified.")
          : property);
      const indexes = candidates.slice(0, limit).map((_, index) => index).filter((index) => Boolean(candidates[index].url));
      await mapWithConcurrency(indexes, concurrency, async (index) => {
        const property = candidates[index];
        try {
          const url = property.url.startsWith("http") ? property.url : `https://www.realtor.com${property.url.startsWith("/") ? "" : "/"}${property.url}`;
          // School-only requests use a longer render timeout, while mixed
          // evidence requests share one raw-HTML/markdown document.
          const schoolLight = isSchoolOnlyDetailRequest(criteria);
          const freshEvidence = hasSchoolCriteria || Boolean(criteria.exteriorMaterials?.length || criteria.communityFeatures?.length);
          const detail = await this.scrapeDetail(url, schoolLight, freshEvidence);
          let detailContent = `${detail.markdown}\n${detail.rawHtml}`;
          let supplementalDetail = "";
          // Only resume an interactive session when the initial response is
          // missing a requested dynamic panel. One session expands all useful
          // school/community tabs so this is not a request per accordion.
          const interactEnabled = /^(?:1|true|yes)$/i.test(process.env.RE_INTERACT_FALLBACK_ENABLED || "true");
          // Realtor currently returns an empty 327-character page when a
          // Firecrawl browser session resumes this URL. For school searches,
          // use the server-rendered address-specific school links plus cached
          // exact-school rating lookups instead of spending credits on a known
          // empty interaction session.
          if (interactEnabled && !hasSchoolCriteria && detail.scrapeId && interactFallbacks < interactLimit
              && detailNeedsInteractiveExpansion(detailContent, criteria)) {
            interactFallbacks += 1;
            const expanded = await runInteraction(() => this.expandInteractiveDetail(detail.scrapeId!)).catch((error) => {
              console.warn("[FirecrawlSkill] Interactive expansion failed for", property.id, error instanceof Error ? error.message : String(error));
              return "";
            });
            if (hasSchoolCriteria) console.log(`[SchoolPanel] ${property.id}: interaction returned ${expanded.length} character(s)`);
            if (expanded) {
              supplementalDetail = expanded;
              detailContent = `${detailContent}\n${expanded}`;
            }
          }
          const evidenceContent = prepareDetailEvidenceContent(
            `${detail.markdown}\n${supplementalDetail}`,
            detail.rawHtml,
            criteria,
            property.title,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          const enriched = extractPropertyEvidence(property, evidenceContent);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (hasSchoolCriteria) {
            const ratedSchools = (enriched.schools || []).filter((school) => school.rating != null);
            console.log(`[SchoolPanel] ${property.id}: ${(enriched.schools || []).length} associated school link(s), ${ratedSchools.length} inline rating(s), stages=${[...new Set((enriched.schools || []).map((school) => school.type))].join("/") || "none"}`);
          }
          const found = [
            enriched.exteriorCoverage === "all-sides" ? "four-sided brick" : null,
            enriched.communityFeatures?.length ? `community ${enriched.communityFeatures.join("/")}` : null,
            enriched.schools?.some((school) => school.rating != null)
              ? `${enriched.schools.filter((school) => school.rating != null).length} school ratings`
              : enriched.schools?.length ? `${enriched.schools.length} property-associated school links` : null,
          ].filter(Boolean);
          candidates[index] = addDiagnostic(enriched, "listing-detail", "success",
            found.length ? `Detail page evidence found: ${found.join(", ")}.` : "Detail page loaded, but no requested listing evidence was found.");
        } catch (error) {
          if (hasSchoolCriteria && !isSchoolOnlyDetailRequest(criteria)) {
            try {
              const url = property.url.startsWith("http") ? property.url : `https://www.realtor.com${property.url.startsWith("/") ? "" : "/"}${property.url}`;
              const schoolDetail = await this.scrapeDetail(url, true, true);
              const enriched = extractPropertyEvidence(property, prepareDetailEvidenceContent(
                schoolDetail.markdown, schoolDetail.rawHtml, criteria, property.title,
              ));
              const rated = (enriched.schools || []).filter((school) => school.rating != null).length;
              candidates[index] = addDiagnostic(enriched, "listing-detail", rated ? "success" : "warning",
                rated ? `Full detail request failed, but the lightweight Schools panel fallback found ${rated} rating(s).`
                  : "Full detail request failed; the lightweight Schools panel fallback returned no ratings.");
              return;
            } catch (fallbackError) {
              console.warn("[FirecrawlSkill] Lightweight school fallback failed for", property.id,
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
            }
          }
          console.warn("[FirecrawlSkill] Detail enrichment failed for", property.id, error instanceof Error ? error.message : String(error));
          candidates[index] = addDiagnostic(property, "listing-detail", "error", `Firecrawl detail request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } else if (needsListingDetail && !enrich) {
      candidates = candidates.map((property) => addDiagnostic(property, "listing-detail", "warning",
        "Detail-page evidence is unavailable for fallback/demo data."));
    }

    const needsFeatureEvidence = Boolean(criteria.exteriorMaterials?.length || criteria.communityFeatures?.length);
    if (needsFeatureEvidence && enrich && listingEvidenceSearchService.enabled) {
      const limit = resolveFeatureEnrichmentLimit(criteria, process.env.RE_FEATURE_SEARCH_LIMIT);
      const concurrency = Math.max(1, Math.min(Number(process.env.RE_FEATURE_SEARCH_CONCURRENCY || 2), 4));
      candidates = candidates.map((property, index) => index < limit ? property
        : addDiagnostic(property, "listing-search", "warning", `Targeted feature search limit ${limit} reached.`));
      const unresolvedIndexes = candidates.slice(0, limit).map((_, index) => index)
        .filter((index) => needsTargetedFeatureSearch(candidates[index], criteria));
      await mapWithConcurrency(unresolvedIndexes, concurrency, async (index) => {
        const before = candidates[index].featureEvidence?.length || 0;
        try {
          const enriched = await listingEvidenceSearchService.enrichProperty(candidates[index], criteria);
          const found = (enriched.featureEvidence || []).slice(before).map((item) => item.criterion);
          candidates[index] = addDiagnostic(enriched, "listing-search", found.length ? "success" : "warning",
            found.length
              ? `Targeted exact-address evidence found: ${found.join(", ")}.`
              : "Exact-address Realtor/Redfin/Homes search returned no explicit four-sided-brick or community-lake statement.");
        } catch (error) {
          candidates[index] = addDiagnostic(candidates[index], "listing-search", "error",
            `Targeted listing evidence search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }

    // Score the exact Realtor school links before invoking official-locator
    // fallbacks. Direct school profile reads do not consume Firecrawl budget,
    // and complete K-12 evidence can avoid the expensive locator entirely.
    if ((criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) && enrich && schoolRatingService.enabled) {
      const limit = Math.max(1, Math.min(Number(process.env.RE_SCHOOL_ENRICH_LIMIT || 20), 20));
      const concurrency = Math.max(1, Math.min(Number(process.env.RE_SCHOOL_CONCURRENCY || 2), 4));
      await mapWithConcurrency(candidates.slice(0, limit).map((_, index) => index), concurrency, async (index) => {
        try {
          const enriched = await schoolRatingService.enrichProperty(candidates[index], criteria.location, {
            strictAssignment: criteria.schoolAssignmentRequired === true,
          });
          const rated = (enriched.schools || []).filter((school) => school.rating != null);
          const assignedRatings = rated.filter((school) => school.relationship === "assigned" || school.relationship === "assignment-option" || school.relationship === "listing-associated").length;
          console.log(`[SchoolRatings] ${enriched.id}: ${rated.length} rated school(s), stages=${[...new Set(rated.map((school) => school.type))].join("/") || "none"}`);
          candidates[index] = addDiagnostic(enriched, "school-rating", rated.length ? "success" : "warning",
            rated.length
              ? assignedRatings
                ? `Using ${assignedRatings} source-backed rating(s) associated with this property by Realtor or an official locator.`
                : `Found ${rated.length} source-backed Realtor/GreatSchools rating(s); schools are nearby, not verified attendance assignments.`
              : "No source-backed K-12 rating was found through the listing or targeted Realtor search.");
        } catch (error) {
          candidates[index] = addDiagnostic(candidates[index], "school-rating", "error",
            `School rating enrichment failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } else if ((criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) && !schoolRatingService.enabled) {
      candidates = candidates.map((property) => addDiagnostic(property, "school-rating", "error",
        "FIRECRAWL_API_KEY is not configured; school ratings cannot be verified."));
    }

    if ((criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) && enrich) {
      const limit = Math.max(1, Math.min(Number(process.env.RE_SCHOOL_ENRICH_LIMIT || 20), 20));
      const concurrency = Math.max(1, Math.min(Number(process.env.RE_SCHOOL_CONCURRENCY || 2), 4));
      candidates = candidates.map((property, index) => index < limit ? property
        : addDiagnostic(property, "school-rating", "warning", `School rating enrichment limit ${limit} reached.`));
      await mapWithConcurrency(candidates.slice(0, limit).map((_, index) => index), concurrency, async (index) => {
        let property = candidates[index];
        if (hasCompleteRealtorSchoolEvidence(property)) {
          candidates[index] = addDiagnostic(property, "school-assignment", "success",
            "Reused complete elementary/middle/high school evidence displayed on the Realtor property page; official-locator fallback was not needed.");
          return;
        }
        if (property.latitude == null || property.longitude == null) {
          property = geoValidationService.enabled
            ? await geoValidationService.ensureCoordinates(property)
            : addDiagnostic(property, "school-assignment", "warning", "No HERE/Google geocoder is configured for official school assignment lookup.");
        }
        candidates[index] = await officialSchoolAssignmentService.enrichProperty(property);
      });
    }
    const hasWaterCriterion = Boolean(criteria.communityFeatures?.some((item) => /lake|pond/i.test(item)));
    const hasMapCriteria = Boolean(criteria.distanceConstraints?.length || criteria.highwayAccess || hasWaterCriterion);
    if (hasMapCriteria && geoValidationService.enabled) {
      candidates = await geoValidationService.enrichProperties(candidates, criteria, (message) => {
        console.log(`[GeoValidationService] ${message}`);
      });
    } else if (hasMapCriteria) {
      candidates = candidates.map((property) => addDiagnostic(property, "geo-provider", "error",
        "No map provider is configured. Set RE_MAP_PROVIDER=here and HERE_API_KEY."));
    }
    if (hasWaterCriterion) candidates = await waterbodyService.enrichProperties(candidates, criteria);

    return rankAssessedProperties(candidates, criteria);
  }

  private async scrapeDetail(
    url: string,
    schoolLight = false,
    freshEvidence = false,
    timeoutOverrideMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<{ rawHtml: string; markdown: string; scrapeId?: string }> {
    firecrawlRequestBudget.consume("listing detail page");
    // The synchronous v1 endpoint consistently returns Realtor's full raw
    // document. The v2 endpoint intermittently remains pending until our
    // 75/105-second abort, which made evidence disappear after a restart.
    const abortMs = timeoutOverrideMs ?? (schoolLight ? 105000 : 75000);
    const timeoutSignal = AbortSignal.timeout(abortMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
    const request = {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        url,
        // Embedded JSON contains complete Schools cards and collapsed listing
        // facts that markdown can omit, so evidence mode always keeps both.
        formats: ["rawHtml", "markdown"],
        onlyMainContent: false,
        // A short render wait is enough for Realtor's server document while a
        // one-hour cache avoids repeatedly launching an expensive browser job.
        // Exact-address fallbacks still cover an incomplete cached document.
        waitFor: schoolLight ? 3000 : freshEvidence ? 3000 : 0,
        timeout: Math.max(1000, Math.min(schoolLight ? 90000 : 60000, abortMs - 1000)),
        maxAge: schoolLight || freshEvidence ? 3600000 : 604800000,
      }),
      signal,
    } satisfies RequestInit;
    const response = await this.fetchFirecrawlWithRateLimitRetry(
      "https://api.firecrawl.dev/v1/scrape",
      request,
      externalSignal,
    );
    if (!response.ok) {
      const errorBody = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
      throw new Error(`Firecrawl detail HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`);
    }
    const payload: any = await response.json();
    firecrawlRequestBudget.settle("listing detail page", payload.creditsUsed);
    const detail = {
      rawHtml: payload.data?.rawHtml || "", markdown: payload.data?.markdown || payload.data?.content || "",
      scrapeId: payload.data?.metadata?.scrapeId || payload.data?.metadata?.scrape_id || payload.data?.scrapeId || payload.id,
    };
    if (!detail.rawHtml && !detail.markdown) throw new Error("Firecrawl detail returned empty content");
    return detail;
  }

  private async fetchFirecrawlWithRateLimitRetry(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A RequestInit body can be reused when it is a string, as all Firecrawl
      // calls in this class are. Rebuild the timeout because AbortSignal cannot
      // be reused after a rate-limit wait.
      const timeoutSignal = AbortSignal.timeout(105000);
      const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
      response = await this.listingFetch(url, { ...init, signal });
      if (response.status !== 429 || attempt === 2) return response;
      const body = await response.clone().text().catch(() => "");
      const retryHeaderText = response.headers.get("retry-after");
      const retryBodyText = body.match(/retry\s+after\s+(\d+)s/i)?.[1];
      const retryHeader = retryHeaderText == null || retryHeaderText.trim() === "" ? NaN : Number(retryHeaderText);
      const retryBody = retryBodyText == null || retryBodyText.trim() === "" ? NaN : Number(retryBodyText);
      const seconds = Number.isFinite(retryHeader) && retryHeader >= 0
        ? retryHeader
        : Number.isFinite(retryBody) && retryBody >= 0 ? retryBody : 15 * (attempt + 1);
      const waitMs = seconds === 0 ? 0 : Math.min(65000, Math.max(1000, seconds * 1000 + 500));
      console.warn(`[FirecrawlSkill] Rate limited; retrying detail request in ${Math.ceil(waitMs / 1000)}s.`);
      await delay(waitMs);
    }
    return response!;
  }

  private async expandInteractiveDetail(scrapeId: string): Promise<string> {
    firecrawlRequestBudget.consume("interactive detail expansion");
    const endpoint = `https://api.firecrawl.dev/v2/scrape/${encodeURIComponent(scrapeId)}/interact`;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await this.listingFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            language: "node", timeout: 25, origin: "real-estate-pi-detail-expansion",
          code: `
            await page.evaluate(async () => {
              // Realtor lazy-mounts deep sections. Scroll the full document in
              // bounded steps before looking for the accordion heading.
              window.scrollTo(0, 0);
              for (let y = 0; y < document.documentElement.scrollHeight; y += 900) {
                window.scrollTo(0, y);
                await new Promise(resolve => setTimeout(resolve, 140));
              }
              window.scrollTo(0, document.documentElement.scrollHeight);
              await new Promise(resolve => setTimeout(resolve, 500));
              const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,button,[role="button"],summary'));
              const heading = all.find((element) => /Neighborhood\\s*&\\s*schools/i.test(element.textContent || ''));
              if (heading) heading.scrollIntoView({ block: 'center' });
            });
            await page.waitForTimeout(800);
            await page.evaluate(() => {
              const relevant = /neighbou?rhood.*schools|nearby schools|show more/i;
              const controls = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],summary'));
              for (const control of controls) {
                const label = (control.textContent || '').replace(/\\s+/g, ' ').trim();
                if (relevant.test(label)) control.click();
              }
            });
            await page.waitForTimeout(1000);
            const schoolText = await page.evaluate(() => {
              const text = document.body.innerText || '';
              const starts = [
                text.search(/Neighborhood\\s*&\\s*schools/i),
                text.search(/Schools\\s*\\n\\s*From listing agent/i),
                text.search(/Nearby schools\\s*\\n\\s*Elementary\\s*\\n\\s*Middle\\s*\\n\\s*High/i),
              ].filter(index => index >= 0);
              const start = starts.length ? Math.min(...starts) : -1;
              if (start < 0) return text.slice(-40000);
              const tail = text.slice(start);
              const end = tail.search(/\\n(?:Environmental risk|Learn more about|Similar homes|Property history)\\b/i);
              return end > 0 ? tail.slice(0, end) : tail.slice(0, 50000);
            });
            schoolText
          `,
          }),
          signal: AbortSignal.timeout(35000),
        });
        if (response.status === 429 && attempt < 2) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfterSeconds)
            ? Math.max(0, retryAfterSeconds * 1000)
            : 1500 * (attempt + 1);
          await delay(delayMs);
          firecrawlRequestBudget.consume("interactive detail expansion retry");
          continue;
        }
        if (!response.ok) throw new Error(`Firecrawl interact HTTP ${response.status}`);
        const payload: any = await response.json();
        firecrawlRequestBudget.settle("interactive detail expansion", payload.creditsUsed);
        return extractInteractText(payload);
      }
      return "";
    } finally {
      await this.listingFetch(endpoint, {
        method: "DELETE", headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(10000),
      }).catch(() => undefined);
    }
  }

  async checkForNewProperties(criteria: SearchCriteria): Promise<Property[]> {
    // Monitoring only needs a fresh listing index. Full feature, map, and school
    // enrichment is deferred until the user opens a new search.
    const listingOnlyCriteria: SearchCriteria = {
      ...criteria,
      exteriorMaterials: undefined,
      communityFeatures: undefined,
      distanceConstraints: undefined,
      highwayAccess: undefined,
      schoolMinRating: undefined,
      schoolAtLeastOneRating: undefined,
      schoolAssignmentRequired: undefined,
    };
    const result = await this.searchProperties(listingOnlyCriteria);
    return result.properties;
  }

  private async parseLocation(location: string): Promise<{ citySlug: string; stateCode: string }> {
    const cityToState = this.getCityToState();
    // Strip price/noise words before location matching
    let clean = location.toLowerCase().trim();
    clean = clean.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?)\b.*$/i, "").trim();
    clean = clean.replace(/,\s*(?:united states(?: of america)?|u\.?s\.?a?\.?)\s*$/i, "").trim();
    const lower = clean;
    // Explicit City, ST or City, State always wins over aliases. An explicit
    // foreign country/province is rejected instead of silently becoming a US
    // same-name city (for example Athens, Greece or London, UK).
    const commaLocation = lower.match(/^(.+?),\s*([^,]+)$/);
    if (commaLocation) {
      const stateCode = normalizeUsStateCode(commaLocation[2]);
      if (!stateCode) {
        throw new Error(`Location "${location}" is not a supported US City, ST market.`);
      }
      return { citySlug: slugifyCity(commaLocation[1].trim()), stateCode };
    }

    for (const [city, state] of Object.entries(cityToState)) {
      if (lower === city) {
        return { citySlug: city.replace(/[^a-z0-9]+/g, "-").replace(/-$/g, ""), stateCode: state };
      }
    }
    for (const stateName of Object.keys(US_STATE_NAME_TO_CODE).sort((a, b) => b.length - a.length)) {
      if (!lower.endsWith(` ${stateName}`)) continue;
      const city = lower.slice(0, -(stateName.length + 1)).trim();
      if (city) return { citySlug: slugifyCity(city), stateCode: US_STATE_NAME_TO_CODE[stateName] };
    }
    const stateMatch = lower.match(/^(.+?)\s+([a-z]{2})$/);
    if (stateMatch && isUsStateCode(stateMatch[2])) {
      return { citySlug: slugifyCity(stateMatch[1].trim()), stateCode: stateMatch[2].toUpperCase() };
    }
    const hereKey = process.env.HERE_API_KEY || "";
    if (hereKey) {
      const url = new URL("https://geocode.search.hereapi.com/v1/geocode");
      url.search = new URLSearchParams({ q: `${clean}, USA`, limit: "1", apiKey: hereKey }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (response.ok) {
        const payload: any = await response.json();
        const address = payload.items?.[0]?.address;
        const city = String(address?.city || clean).trim();
        const stateCode = String(address?.stateCode || "").replace(/^US-/, "").toUpperCase();
        if (city && /^[A-Z]{2}$/.test(stateCode)) {
          return { citySlug: slugifyCity(city), stateCode };
        }
      }
    }
    throw new Error(`Cannot determine the state for location "${location}". Use the format City, ST.`);
  }

  private getCityToState(): Record<string, string> {
    return {
      "atlanta": "GA", "seattle": "WA", "bellevue": "WA", "redmond": "WA", "kirkland": "WA",
      "new york": "NY", "manhattan": "NY", "brooklyn": "NY",
      "san francisco": "CA", "los angeles": "CA", "san diego": "CA",
      "santa monica": "CA", "long beach": "CA", "sacramento": "CA",
      "miami": "FL", "orlando": "FL",
      "austin": "TX", "dallas": "TX", "houston": "TX",
      "denver": "CO",
      "boston": "MA",
      "chicago": "IL",
      "portland": "OR", "salem": "OR",
      "philadelphia": "PA",
      "washington": "DC",
      "nashville": "TN",

      "phoenix": "AZ",
      "detroit": "MI",
      "athens": "GA",
    };
  }


  private parsePropertiesFromHtml(raw: string, criteria: SearchCriteria, markdown?: string): Property[] {
    const props: Property[] = [];
    try {
      const scriptMatch = raw.match(/<script[^>]*data-testid="seoLinkingData"[^>]*>([\s\S]*?)<\/script>/);
      if (!scriptMatch) throw new Error("No seoLinkingData found");
      const jsonLd = JSON.parse(scriptMatch[1]);
      if (!Array.isArray(jsonLd)) throw new Error("JSON-LD is not an array");
      let listings: any[] = [];
      for (const item of jsonLd) {
        if (item["@type"] === "CollectionPage" && item.mainEntity?.itemListElement) {
          listings = item.mainEntity.itemListElement;
          break;
        }
      }
      if (listings.length === 0) throw new Error("No listings found");
      console.log("[FirecrawlSkill] JSON-LD parsed:", listings.length, "listings");
      const candidateLimit = Math.max(this.maxResults, Math.min(Number(process.env.RE_LISTING_CANDIDATE_LIMIT || 60), 100));
      for (let i = 0; i < listings.length && props.length < candidateLimit; i++) {
        const listing = listings[i];
        if (!listing || !listing["@type"]) continue;
        const me = listing.mainEntity || {};
        const address = me.address || {};
        const offers = listing.offers || {};
        const priceVal = parseInt(offers.price) || 0;
        if (priceVal < 50000 || priceVal > 50000000) continue;
        const bedroomNumber = Number(me.numberOfBedrooms);
        const hasStructuredBedrooms = me.numberOfBedrooms != null
          && String(me.numberOfBedrooms).trim() !== ""
          && Number.isInteger(bedroomNumber)
          && bedroomNumber >= 0 && bedroomNumber < 20;
        const bedroomVal = hasStructuredBedrooms ? bedroomNumber : 0;
        const sqftVal = extractStructuredSqft(me);
        const street = cleanSchemaText(address.streetAddress);
        const city = cleanSchemaText(address.addressLocality);
        const state = cleanSchemaText(address.addressRegion);
        const zipCandidate = cleanSchemaText(address.postalCode);
        const zip = /^\d{5}(?:-\d{4})?$/.test(zipCandidate) ? zipCandidate : "";
        const canonicalTitle = [
          street,
          city,
          [state, zip].filter(Boolean).join(" "),
        ].filter(Boolean).join(", ");
        const imageUrl = listing.image || "";
        const url = listing.url || "";
        const geo = me.geo || listing.geo || {};
        const bathrooms = extractBathroomTotal(me);
        const fullBathrooms = firstPositiveNumber(me.numberOfFullBathrooms, me.bathroomsFull);
        const halfBathrooms = firstPositiveNumber(me.numberOfHalfBathrooms, me.bathroomsHalf);
        props.push({
          id: "r" + (i + 1),
          title: canonicalTitle || cleanSchemaText(listing.name) || (city ? "Home in " + city : bedroomVal + "BR Home"),
          price: priceVal, bedrooms: bedroomVal,
          bedroomsSource: hasStructuredBedrooms ? "structured-data" : undefined,
          bathrooms, fullBathrooms, halfBathrooms,
          bathroomsSource: bathrooms > 0 ? "structured-data" : undefined, sqft: sqftVal,
          sqftSource: sqftVal > 0 ? "structured-data" : undefined,
          location: city ? city + ", " + state + (zip ? " " + zip : "") : state, features: [],
          url: url, imageUrl: imageUrl,
          listedAt: new Date().toISOString(), source: "Realtor.com",
          latitude: Number.isFinite(Number(geo.latitude)) ? Number(geo.latitude) : undefined,
          longitude: Number.isFinite(Number(geo.longitude)) ? Number(geo.longitude) : undefined,
          description: me.description || listing.description || undefined,
        });
      }
    } catch (e: any) {
      console.log("[FirecrawlSkill] JSON-LD parse error:", e.message);
    }
    // Parse visible card text, not raw tag attributes or embedded JSON. Realtor
    // places very large CSS class strings between a card's metrics and address;
    // stripping markup keeps the exact card fields adjacent and prevents the
    // incomplete SEO JSON-LD bath total from winning.
    this.enrichBathroomsFromMarkdown(props, `${markdown || ""}\n${htmlToVisibleSearchText(raw)}`);
    return props;
  }


  private enrichBathroomsFromMarkdown(props: Property[], markdown: string): void {
    // Search responses can exceed 1 MB. Normalizing and regex-scanning the
    // entire response once per listing blocked Render's event loop long enough
    // to fail health checks. Normalize once, then inspect only bounded windows
    // around each property's address/price.
    const normalized = markdown.replace(/\s+/g, " ");
    const lower = normalized.toLowerCase();
    for (const prop of props) {
      const propertyEvidence = propertyEvidenceFromNormalizedSearchPage(normalized, lower, prop.title, prop.price);
      const lines = propertyEvidence.split("\n").map(l => l.trim());
      // Realtor's rendered search payload commonly uses label-first text such
      // as "beds 2 baths 2 sqft square feet 1,570". Match it inside the exact
      // address window before falling back to the older price-card heuristic.
      // The evidence string is already bounded to this exact address. Prefix
      // the identity so metrics rendered before the address (Realtor's common
      // card order) remain inside the property-scoped extractor window.
      const metrics = extractVisibleSearchCardMetrics(normalized, prop.title)
        || extractCoreListingMetrics(`${prop.title}\n${propertyEvidence}`, prop.title);
      if (metrics.bedrooms != null) {
        prop.bedrooms = metrics.bedrooms;
        prop.bedroomsSource = "listing-card";
      }
      if (metrics.bathrooms != null) {
        prop.bathrooms = metrics.bathrooms;
        prop.fullBathrooms = metrics.fullBathrooms;
        prop.halfBathrooms = metrics.halfBathrooms;
        prop.bathroomsSource = "listing-card";
      }
      if (metrics.sqft != null) {
        prop.sqft = metrics.sqft;
        prop.sqftSource = metrics.sqftSource;
      }
      if (hasNewConstructionEvidence(propertyEvidence, prop.title)
          && !prop.features.some((feature) => /new construction/i.test(feature))) {
        prop.features.push("new construction");
      }
      if (prop.bathrooms > 0) continue;
      const streetPart = (prop.title.split(",")[0] || "").replace(/^[0-9]+\s*/, "").substring(0, 20).toLowerCase();
      const priceStr = "$" + prop.price.toLocaleString();
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(priceStr)) continue;
        let addrConfirmed = true;
        if (streetPart.length >= 3) {
          addrConfirmed = lines[i].toLowerCase().includes(streetPart);
          for (let j = i + 1; !addrConfirmed && j < Math.min(lines.length, i + 40); j++) {
            if (lines[j].toLowerCase().includes(streetPart)) { addrConfirmed = true; break; }
            if (/^\$[\d,]+/.test(lines[j]) && !lines[j].includes(priceStr)) break;
          }
          if (!addrConfirmed) continue;
        }
        const ctxStart = Math.max(0, i - 3);
        const ctxEnd = Math.min(lines.length, i + 7);
        const ctx = lines.slice(ctxStart, ctxEnd).join(" ");
        const bathMatch = ctx.match(/(\d[\d.]*)\+?\s*(?:ba|bath|baths)\b/i);
        if (bathMatch) {
          const v = parseFloat(bathMatch[1]);
          if (!isNaN(v) && v > 0 && v < 20) prop.bathrooms = v;
        }
        break;
      }
    }
  }

  private extractAll(str: string, regex: RegExp): any[][] {
    const results: any[][] = [];
    let m;
    while ((m = regex.exec(str)) !== null) results.push(Array.from(m));
    return results;
  }
  private parseContent(content: string, criteria: SearchCriteria): Property[] {
    const props: Property[] = [];
    const seen = new Set<string>();
    let id = 0;
    const lines = content.split("\n").map(l => l.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("|") || line.startsWith("[!") || /^\\+$/.test(line)) continue;

      const pm = line.match(/\$\s*([\d,]+(?:\.\d+)?(?:K|M)?)/i);
      if (!pm) continue;

      let priceStr = pm[1].replace(/[\$,]/g, "").toLowerCase();
      let price = parseFloat(priceStr);
      if (priceStr.includes("m") && !priceStr.includes(".") && price < 1000) price = price * 1000000;
      else if (priceStr.includes("k")) price = price * 1000;
      if (isNaN(price) || price > 10000000 || price < 50000) continue;

      const ctxStart = Math.max(0, i - 3);
      const ctxEnd = Math.min(lines.length, i + 5);
      const key = String(price) + lines.slice(ctxStart, ctxEnd).join(" ").substring(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);

      // Never invent common-looking defaults. A missing field remains unknown
      // and is surfaced as such by validation and the UI.
      let bedrooms = 0, bathrooms = 0, sqft = 0, address = "";
      const contextLines = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 8));
      const context = contextLines.join(" ");

      const isStudio = /\bstudio\b/i.test(context);
      const bedMatch = context.match(/(\d+)\s*(?:bd|bed|beds)\b|\b(\d+)\s*br\b/i);
      const bathMatch = context.match(/(\d[\d.]*)\+?\s*(?:ba|bath|baths)\b/i);
      const sqftMatch = context.match(/([\d,]+)\s*(?:sqft|square feet)/i);
      const coreMetrics = extractCoreListingMetrics(context);

      if (coreMetrics.bedrooms != null) bedrooms = coreMetrics.bedrooms;
      else if (isStudio) bedrooms = 0;
      else if (bedMatch) bedrooms = parseInt(bedMatch[1] || bedMatch[2]) || 0;
      if (coreMetrics.bathrooms != null) bathrooms = coreMetrics.bathrooms;
      else if (bathMatch) bathrooms = parseFloat(bathMatch[1]) || 0;
      if (coreMetrics.sqft != null) sqft = coreMetrics.sqft;
      else if (sqftMatch) sqft = parseInt(sqftMatch[1].replace(/,/g, "")) || 0;

      for (const l of contextLines) {
        if (!l || l.length < 5 || l.length > 120) continue;
        if (/^\$|^- |^\[|^From|^built|^brokered|^open|^pending|^new|^house|^condo|^town|^email|^contact|^property|^agent/i.test(l)) continue;
        if (/^\d+\s+\w/.test(l) || /,\s*(WA|NY|CA|TX|FL|IL|MA|CO|OR|PA|DC|TN|GA|AZ|MI|NC|OH|MN|MO|MD|IN|WI|VA)\s/i.test(l)) {
          address = l.replace(/[,.]$/, "").replace(/\\+$/g, "").trim();
          break;
        }
      }

      const title = address || (criteria.location ? "Home in " + criteria.location : "Property $" + price.toLocaleString());
      id++;
      props.push({
        id: "fc" + id,
        title: title.substring(0, 80), price, bedrooms,
        bedroomsSource: isStudio || coreMetrics.bedrooms != null || Boolean(bedMatch)
          ? "listing-card" : undefined,
        bathrooms, sqft,
        location: criteria.location || "",
        features: [], url: "", imageUrl: "",
        listedAt: new Date().toISOString(),
        source: "Realtor.com",
      });
      if (props.length >= this.maxResults) break;
    }

    if (props.length > 0) {
      const filteredProps = props.filter((p: any) => {
        if (criteria.minBedrooms
            && (p.bedroomsSource || p.bedrooms > 0)
            && p.bedrooms < criteria.minBedrooms) return false;
        if (criteria.minBathrooms && p.bathrooms > 0 && p.bathrooms < criteria.minBathrooms) return false;
        if (criteria.maxPrice && p.price > criteria.maxPrice) return false;
        if (criteria.minPrice && p.price < criteria.minPrice) return false;
        return true;
      });
      console.log(`[FirecrawlSkill] Page yielded ${props.length} total, filtered down to ${filteredProps.length} matching properties.`);
      return filteredProps;
    }

    return [];
  }

  private demoDB: Property[] = [
    { id: "d1", title: "Modern 3BR Townhouse with Pool", price: 850000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Seattle, WA", features: ["pool","garage","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d2", title: "Luxury Waterfront 4BR Estate", price: 1250000, bedrooms: 4, bathrooms: 3, sqft: 2800, location: "Seattle, WA", features: ["water view","garage","balcony","pool","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d3", title: "Cozy 2BR Downtown Apartment", price: 550000, bedrooms: 2, bathrooms: 1, sqft: 950, location: "Seattle, WA", features: ["balcony","gym","in-unit laundry","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d4", title: "Charming 3BR Craftsman with Garden", price: 720000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Seattle, WA", features: ["garden","fireplace","garage","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d5", title: "New 2BR Luxury Condo with Views", price: 620000, bedrooms: 2, bathrooms: 2, sqft: 1100, location: "Bellevue, WA", features: ["view","parking","pool","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d6", title: "Spacious 4BR Family Home", price: 980000, bedrooms: 4, bathrooms: 3, sqft: 2500, location: "Bellevue, WA", features: ["garage","yard","air conditioning","fireplace","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d7", title: "Studio NYC Midtown High-Rise", price: 480000, bedrooms: 1, bathrooms: 1, sqft: 500, location: "New York, NY", features: ["gym","doorman","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d8", title: "2BR Brooklyn Loft with Natural Light", price: 750000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "New York, NY", features: ["balcony","laundry","natural light","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d9", title: "3BR San Francisco Victorian Home", price: 1500000, bedrooms: 3, bathrooms: 2, sqft: 1900, location: "San Francisco, CA", features: ["fireplace","garden","garage","hardwood floors","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d10", title: "Modern 2BR LA Apartment with Pool", price: 680000, bedrooms: 2, bathrooms: 2, sqft: 1050, location: "Los Angeles, CA", features: ["pool","gym","parking","view","balcony"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d11", title: "Luxury Penthouse Miami Beach", price: 2200000, bedrooms: 4, bathrooms: 4, sqft: 3200, location: "Miami, FL", features: ["pool","view","balcony","parking","gym","doorman"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d12", title: "3BR Austin Hill Country Home", price: 580000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Austin, TX", features: ["yard","garage","fireplace","air conditioning","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d13", title: "4BR Denver Mountain View", price: 820000, bedrooms: 4, bathrooms: 3, sqft: 2200, location: "Denver, CO", features: ["view","fireplace","garage","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d14", title: "2BR Chicago Luxury Condo", price: 450000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Chicago, IL", features: ["gym","doorman","view","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d15", title: "3BR Boston Brownstone", price: 1100000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Boston, MA", features: ["fireplace","hardwood floors","garden","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d16", title: "Beachfront 3BR House Seattle", price: 950000, bedrooms: 3, bathrooms: 2, sqft: 2000, location: "Seattle, WA", features: ["view","garage","deck","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d17", title: "Bellevue 2BR Condo with View", price: 650000, bedrooms: 2, bathrooms: 2, sqft: 1050, location: "Bellevue, WA", features: ["pool","balcony","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d18", title: "Redmond 3BR Family Home", price: 880000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Redmond, WA", features: ["yard","garage","fireplace","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d19", title: "Kirkland 2BR Condo", price: 420000, bedrooms: 2, bathrooms: 1, sqft: 800, location: "Kirkland, WA", features: ["parking","gym","balcony"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d20", title: "Manhattan 1BR Condo", price: 380000, bedrooms: 1, bathrooms: 1, sqft: 650, location: "New York, NY", features: ["doorman","gym","pool"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d21", title: "Washington 3BR Single Family Home", price: 780000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Washington, DC", features: ["garage","yard","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d22", title: "SP 3BR Victorian Style", price: 1600000, bedrooms: 3, bathrooms: 2, sqft: 2100, location: "San Francisco, CA", features: ["fireplace","hardwood floors","garden","garage","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d23", title: "LA 2BR Modern Apartment", price: 640000, bedrooms: 2, bathrooms: 2, sqft: 1100, location: "Los Angeles, CA", features: ["pool","balcony","ocean view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d24", title: "Miami 2BR Waterfront Condo", price: 750000, bedrooms: 2, bathrooms: 2, sqft: 1200, location: "Miami, FL", features: ["pool","balcony","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d25", title: "Denver 2BR Townhome", price: 520000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Denver, CO", features: ["fireplace","garden","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d26", title: "Austin 2BR View Home", price: 480000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "Austin, TX", features: ["yard","pool","garage"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d27", title: "Boston 2BR Studio Backbay", price: 700000, bedrooms: 2, bathrooms: 1, sqft: 750, location: "Boston, MA", features: ["parking","laundry","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d28", title: "Chicago 4BR Brownstone", price: 850000, bedrooms: 4, bathrooms: 2, sqft: 2200, location: "Chicago, IL", features: ["fireplace","hardwood floors","garage","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d29", title: "Philadelphia 2BR Historic", price: 550000, bedrooms: 2, bathrooms: 1, sqft: 950, location: "Philadelphia, PA", features: ["fireplace","natural light","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d30", title: "Portland 3BR Craftsman", price: 450000, bedrooms: 3, bathrooms: 2, sqft: 1400, location: "Portland, OR", features: ["natural light","yard","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d31", title: "Dallas 3BR Suburban Home", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Dallas, TX", features: ["yard","pool","garage","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d32", title: "Denver 3BR Townhome", price: 700000, bedrooms: 3, bathrooms: 3, sqft: 1800, location: "Denver, CO", features: ["fireplace","pool","parking","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d33", title: "NYC 2BR Tribeca Style", price: 500000, bedrooms: 2, bathrooms: 1, sqft: 900, location: "New York, NY", features: ["laundry","nursery","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d34", title: "Austin 2BR Modern Condo", price: 450000, bedrooms: 2, bathrooms: 2, sqft: 1000, location: "Austin, TX", features: ["pool","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d35", title: "Santa Monica 3BR House", price: 800000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Santa Monica, CA", features: ["ocean view","garage","pool","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d36", title: "Nashville 4BR Colonial", price: 720000, bedrooms: 4, bathrooms: 3, sqft: 2500, location: "Nashville, TN", features: ["yard","garage","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d37", title: "Salem 3BR Historic View", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Salem, OR", features: ["view","natural light","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d38", title: "Orlando 2BR Modern Condo", price: 350000, bedrooms: 2, bathrooms: 1, sqft: 850, location: "Orlando, FL", features: ["pool","gym","parking"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d39", title: "Long Beach 3BR Living", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 1200, location: "Long Beach, CA", features: ["yard","pool","garage"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d40", title: "Sacramento 4BR Modern Home", price: 620000, bedrooms: 4, bathrooms: 3, sqft: 2000, location: "Sacramento, CA", features: ["yard","pool","fireplace","air conditioning"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d41", title: "Atlanta 3BR Craftsman Style", price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "Atlanta, GA", features: ["yard","garage","fireplace","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d42", title: "Houston 4BR Modern Home", price: 450000, bedrooms: 4, bathrooms: 3, sqft: 2400, location: "Houston, TX", features: ["pool","garage","yard","fireplace","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d43", title: "Phoenix 3BR Desert View", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Phoenix, AZ", features: ["pool","view","garage","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d44", title: "San Diego 2BR Beach Condo", price: 600000, bedrooms: 2, bathrooms: 2, sqft: 950, location: "San Diego, CA", features: ["ocean view","balcony","pool","gym"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d45", title: "Detroit 3BR Historic Home", price: 250000, bedrooms: 3, bathrooms: 2, sqft: 1800, location: "Detroit, MI", features: ["fireplace","hardwood floors","garden","basement"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d46", title: "NYC 3BR Upper West Side Apt", price: 925000, bedrooms: 3, bathrooms: 2, sqft: 1400, location: "New York, NY", features: ["doorman","gym","laundry","view"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d47", title: "NYC 3BR Brooklyn Townhouse", price: 850000, bedrooms: 3, bathrooms: 2, sqft: 1600, location: "New York, NY", features: ["garden","fireplace","hardwood floors","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d48", title: "NYC 3BR Queens Family Home", price: 720000, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "New York, NY", features: ["yard","garage","basement","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d49", title: "Athens 3BR Craftsman Near UGA", price: 380000, bedrooms: 3, bathrooms: 2, sqft: 1700, location: "Athens, GA", features: ["hardwood floors","fireplace","yard","garage","natural light"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d50", title: "Athens 4BR Colonial Milledge", price: 550000, bedrooms: 4, bathrooms: 3, sqft: 2400, location: "Athens, GA", features: ["yard","garage","fireplace","hardwood floors","central ac"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d51", title: "New York 4BR Historic Townhouse", price: 2100000, bedrooms: 4, bathrooms: 3, sqft: 2800, location: "New York, NY", features: ["yard","garage","fireplace"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d52", title: "Brooklyn 4BR Family Home", price: 1250000, bedrooms: 4, bathrooms: 3, sqft: 2200, location: "New York, NY", features: ["garden","hardwood floors"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" },
    { id: "d53", title: "Queens 4BR Single Family", price: 950000, bedrooms: 4, bathrooms: 2, sqft: 1800, location: "New York, NY", features: ["garage","yard"], url: "", imageUrl: "", listedAt: new Date().toISOString(), source: "Demo DB" }
  ];

  private demoSearch(criteria: SearchCriteria): Property[] {
    return this.demoDB.filter((p: any) => {
      if (criteria.location) {
        // Strip price/noise words from criteria location before matching
        const cleanLoc = criteria.location.replace(/\s+(priced|under|over|budget|max|min|million|thousand|k|dollars?).*$/i, "").trim().toLowerCase();
        // Use word-boundary matching: match "new york" in "New York, NY" or "new-york"
        const pLoc = p.location.toLowerCase();
        const locWords = cleanLoc.split(/[\s,]+/).filter(w => w.length > 0);
        const matchAll = locWords.every(word => pLoc.includes(word));
        if (!matchAll) return false;
      }
      if (criteria.minPrice && p.price < criteria.minPrice) return false;
      if (criteria.maxPrice && p.price > criteria.maxPrice) return false;
      if (criteria.minBedrooms && p.bedrooms < criteria.minBedrooms) return false;
      if (criteria.minBathrooms && p.bathrooms < criteria.minBathrooms) return false;
      if (criteria.mustHave && criteria.mustHave.length > 0) {
        for (const f of criteria.mustHave) {
          if (!p.features.some((pf: any) => pf.toLowerCase().includes(f.toLowerCase()))) return false;
        }
      }
      return true;
    });
  }
}

function rankAssessedProperties(properties: Property[], criteria: SearchCriteria): Property[] {
  const statusOrder = { verified: 0, unknown: 1, failed: 2 } as const;
  return properties
    .map((property) => ({ ...property, criteriaMatch: assessProperty(property, criteria) }))
    .sort((a, b) => {
      const statusDifference = statusOrder[a.criteriaMatch.overall] - statusOrder[b.criteriaMatch.overall];
      return statusDifference || b.criteriaMatch.score - a.criteriaMatch.score || a.price - b.price;
    });
}

export function prioritizeCandidatesForCriteria(properties: Property[], criteria: SearchCriteria): Property[] {
  const needsLake = Boolean(criteria.communityFeatures?.some((item) => /lake|pond/i.test(item)));
  const needsBrick = Boolean(criteria.exteriorMaterials?.some((item) => /brick/i.test(item)));
  if (!needsLake && !needsBrick) return properties;
  return properties.map((property, index) => {
    const facts = Object.entries(property.listingFacts || {})
      .flatMap(([label, values]) => [label, ...values]).join(" ");
    const text = `${property.title} ${property.description || ""} ${property.features.join(" ")} ${facts}`;
    let score = 0;
    if (needsLake) {
      if (property.communityFeatures?.some((item) => /lake|pond/i.test(item))) score += 100;
      if (/\b(?:community features?|association amenities?|association fee includes?)\s*:[^.;]{0,240}\b(?:lake|pond)\b/i.test(text)
          || /\b(?:community|neighborhood|subdivision|hoa|residents?)[^.;]{0,180}\b(?:lake|pond)\b/i.test(text)
          || /\b(?:lake privileges?|shared lake access|community dock)\b/i.test(text)) score += 80;
      // Address/name tokens are discovery hints only. The detail page must
      // still provide explicit community evidence before the criterion passes.
      if (/\b(?:lake|pond|water|waterfront|millstone|edgewater|shore|cove|marina)\b/i.test(property.title)) score += 20;
      else if (/\b(?:lake|pond|waterfront)\b/i.test(property.description || "")) score += 10;
    }
    if (needsBrick) {
      if (property.exteriorCoverage === "all-sides") score += 100;
      if (/\b(?:four[- ]sided|4[- ]sided|all[- ]brick|brick\s*4\s*sides?)\b/i.test(text)) score += 80;
      else if (/\bbrick\b/i.test(property.description || "")) score += 10;
    }
    return { property, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(({ property }) => property);
}

export function shouldUseCachedMarket(criteria: SearchCriteria): boolean {
  return !criteria.exteriorMaterials?.length && !criteria.communityFeatures?.length;
}

export function prepareSearchPagePropertyEvidence(
  content: string,
  propertyTitle: string,
  price = 0,
): string {
  const normalized = content.replace(/\s+/g, " ");
  return propertyEvidenceFromNormalizedSearchPage(
    normalized,
    normalized.toLowerCase(),
    propertyTitle,
    price,
  );
}

export function extractVisibleSearchCardMetrics(
  content: string,
  propertyTitle: string,
): ReturnType<typeof extractCoreListingMetrics> | undefined {
  const normalized = content.replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  const address = propertyTitle.split(",")[0].trim().toLowerCase();
  if (!address) return undefined;
  const metricPattern = /(?:(studio)\b|(\d+(?:\.\d+)?)\s*(?:beds?|bd)\b)[\s\S]{0,500}?(\d+(?:\.\d+)?)\s*(?:baths?|ba)\b[\s\S]{0,500}?([\d,]{3,})\s*(?:sqft|square\s+feet)\b/gi;
  let best: { distance: number; metrics: ReturnType<typeof extractCoreListingMetrics> } | undefined;
  let from = 0;
  for (let occurrence = 0; occurrence < 12; occurrence++) {
    const addressIndex = lower.indexOf(address, from);
    if (addressIndex < 0) break;
    const beforeStart = Math.max(0, addressIndex - 2200);
    const before = normalized.slice(beforeStart, addressIndex);
    const beforeMatches = [...before.matchAll(metricPattern)];
    const preceding = beforeMatches.at(-1);
    if (preceding?.index != null) {
      const distance = addressIndex - (beforeStart + preceding.index + preceding[0].length);
      if (distance <= 900 && (!best || distance < best.distance)) {
        best = {
          distance,
          metrics: {
            bedrooms: preceding[1] ? 0 : Number(preceding[2]),
            bathrooms: Number(preceding[3]),
            sqft: Number(preceding[4].replace(/,/g, "")),
            sqftSource: "listing-card",
          },
        };
      }
    }
    const after = normalized.slice(addressIndex + address.length, addressIndex + address.length + 2200);
    const following = [...after.matchAll(metricPattern)][0];
    if (following?.index != null) {
      const distance = following.index;
      if (distance <= 900 && (!best || distance < best.distance)) {
        best = {
          distance,
          metrics: {
            bedrooms: following[1] ? 0 : Number(following[2]),
            bathrooms: Number(following[3]),
            sqft: Number(following[4].replace(/,/g, "")),
            sqftSource: "listing-card",
          },
        };
      }
    }
    from = addressIndex + address.length;
  }
  return best?.metrics;
}

function propertyEvidenceFromNormalizedSearchPage(
  normalized: string,
  lower: string,
  propertyTitle: string,
  price: number,
): string {
  const address = propertyTitle.split(",")[0].trim().toLowerCase();
  // Price is not an identity: many properties share it. Address-only windows
  // prevent a same-price listing from donating its beds/baths/sqft.
  const needles = [...new Set([
    address,
    address.replace(/\bapt\b/g, "unit"),
    address.replace(/\bunit\b/g, "apt"),
  ].filter(Boolean))];
  const ranges: Array<[number, number]> = [];

  for (const needle of needles) {
    let from = 0;
    for (let occurrence = 0; occurrence < 8; occurrence++) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const start = Math.max(0, index - 320);
      const end = Math.min(normalized.length, index + Math.max(needle.length, 1) + 1200);
      if (!ranges.some(([existingStart, existingEnd]) => start <= existingEnd && end >= existingStart)) {
        ranges.push([start, end]);
      }
      from = index + needle.length;
    }
  }

  if (!ranges.length) return "";
  return ranges
    .sort(([left], [right]) => left - right)
    .slice(0, 10)
    .map(([start, end]) => normalized.slice(start, end))
    .join("\n");
}

export function prepareDetailEvidenceContent(
  markdown: string,
  rawHtml: string,
  criteria: SearchCriteria,
  propertyTitle = "",
): string {
  if (rawHtml.length <= 300_000) return `${markdown}\n${rawHtml}`;

  const chunks: string[] = [markdown.slice(0, 100_000), rawHtml.slice(0, 20_000)];
  const needles = new Set<string>([
    propertyTitle.split(",")[0].trim(),
    // Core metrics must survive feature-focused compression too. Realtor
    // often keeps the authoritative full/half breakdown only in a collapsed
    // Bathroom JSON block far beyond the first several hundred KB.
    '"category":"Bathroom"', "total bathrooms", "full bathrooms", "1/2 bathrooms",
    "half bathrooms", "partial bathroom", "living area", '"floorSize"',
    '"category"', "property details", "listing details", "source neighborhood",
    "subdivision", "homeowners association", "association amenities",
  ].filter(Boolean).map((value) => value.toLowerCase()));
  if (criteria.communityFeatures?.some((item) => /lake|pond/i.test(item))) {
    ["amenities and community features", "community features", "waterfront and water access",
      "lake", "pond", "resident access", "lake privileges"].forEach((value) => needles.add(value));
  }
  if (criteria.exteriorMaterials?.some((item) => /brick/i.test(item))) {
    ["building and construction", "exterior", "brick", "four-sided", "4-sided"].forEach((value) => needles.add(value));
  }
  if (criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null) {
    ["neighborhood & schools", "nearby schools", "greatschools", "elementary school",
      "middle school", "high school", "out of 10"].forEach((value) => needles.add(value));
  }

  const lower = rawHtml.toLowerCase();
  let windows = 0;
  for (const needle of needles) {
    let from = 0;
    let needleWindows = 0;
    while (windows < 24 && needleWindows < 2) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      // Prefix the exact property identity so downstream metric extraction
      // treats each retained JSON window as belonging to this listing.
      chunks.push(`${propertyTitle}\n${rawHtml.slice(
        Math.max(0, index - 500),
        Math.min(rawHtml.length, index + 4500),
      )}`);
      windows += 1;
      needleWindows += 1;
      from = index + needle.length;
    }
    if (windows >= 24) break;
  }
  chunks.push(rawHtml.slice(-15_000));
  return chunks.join("\n");
}

export function resolveFeatureEnrichmentLimit(criteria: SearchCriteria, configured?: string): number {
  const requested = Number(configured || 20);
  const bounded = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 20, 20));
  const hasSchoolCriteria = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
  const hasFeatureCriteria = Boolean(criteria.exteriorMaterials?.length || criteria.communityFeatures?.length);
  // School panels require complete coverage for the requested result set.
  // Listing features instead use the relevance-ranked discovery set: ten
  // detail pages cover all high-signal lake/brick candidates without spending
  // another ten slow detail and exact-address requests on generic homes.
  return hasFeatureCriteria && !hasSchoolCriteria ? Math.min(bounded, 10) : bounded;
}

export const firecrawlSkill = new FirecrawlSkill();

export function requiresListingDetail(criteria: SearchCriteria): boolean {
  const schoolRequested = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
  const schoolDetailEnabled = /^(?:1|true|yes)$/i.test(process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED || "true");
  return Boolean(criteria.mustHave?.length || criteria.exteriorMaterials?.length || criteria.communityFeatures?.length
    || criteria.distanceConstraints?.some((constraint) => constraint.category === "grocery")
    || (schoolRequested && schoolDetailEnabled));
}

export function isSchoolOnlyDetailRequest(criteria: SearchCriteria): boolean {
  const schoolRequested = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
  return schoolRequested && !criteria.mustHave?.length && !criteria.exteriorMaterials?.length
    && !criteria.communityFeatures?.length
    && !criteria.distanceConstraints?.some((constraint) => constraint.category === "grocery");
}

export function resolveFirecrawlBudget(criteria: SearchCriteria, configured = process.env.RE_FIRECRAWL_REQUEST_BUDGET): number {
  const hasSchoolCriteria = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
  // These floors are completeness guarantees, not merely defaults. An old
  // PowerShell value such as RE_FIRECRAWL_REQUEST_BUDGET=15 must not silently
  // disable detail enrichment for the later candidates in a 20-property run.
  const hasFeatureCriteria = Boolean(criteria.exteriorMaterials?.length || criteria.communityFeatures?.length);
  const minimum = hasSchoolCriteria ? 100 : hasFeatureCriteria ? 25 : 30;
  const requested = Number(configured);
  return Number.isFinite(requested) && requested > minimum ? Math.min(requested, 100) : minimum;
}

export function shouldVerifyBathroomsSeparately(criteria: SearchCriteria): boolean {
  // When a detail page is already required, its full/half bath fields are both
  // more authoritative and free of an extra exact-address Firecrawl search.
  return !requiresListingDetail(criteria);
}

export function bathroomVerificationPriority(property: Property): number {
  if (!property.url || property.bathroomsSource === "detail-page"
      || property.fullBathrooms != null || property.halfBathrooms != null) return 0;
  // A structured JSON-LD total is provisional because Realtor sometimes
  // publishes only full baths there while the visible card has the fractional
  // consumer total. Card-confirmed values start lower but are still checked
  // when the bed/bath ratio is suspicious.
  let score = property.bathroomsSource === "listing-card" ? 0 : 50;
  if (!/\b\d{5}(?:-\d{4})?\b/.test(`${property.title} ${property.location}`)) score += 120;
  if (property.features.some((feature) => /new construction/i.test(feature))
      && property.bathrooms <= 2) score += 100;
  if (property.bedrooms >= 5 && property.bathrooms <= 2.5) score += 90;
  if (property.sqft >= 3000 && property.bathrooms <= 2.5) score += 80;
  if (property.bathrooms > 0 && property.bathrooms < 2) score += 20;
  return score;
}

export function resolveBathroomVerificationTimeouts(
  requestValue = process.env.RE_BATHROOM_VERIFY_REQUEST_TIMEOUT_MS,
  batchValue = process.env.RE_BATHROOM_VERIFY_BATCH_TIMEOUT_MS,
): { requestMs: number; batchMs: number } {
  const requestMs = Math.max(5000, Math.min(Number(requestValue) || 12000, 20000));
  const batchMs = Math.max(requestMs, Math.min(Number(batchValue) || 20000, 30000));
  return { requestMs, batchMs };
}

export function extractInteractText(payload: unknown): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : { result: payload };
  const flatten = (value: unknown, depth = 0): string => {
    if (value == null || depth > 5) return "";
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^[\[{]/.test(trimmed)) {
        try {
          const nested = flatten(JSON.parse(trimmed), depth + 1);
          if (nested) return nested;
        } catch { /* Keep the original text. */ }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => flatten(item, depth + 1)).filter(Boolean).join("\n");
    if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      const preferred = ["value", "text", "content", "markdown", "output", "result", "stdout"];
      const selected = preferred.map((key) => flatten(object[key], depth + 1)).filter(Boolean);
      if (selected.length) return selected.join("\n");
      return Object.values(object).map((item) => flatten(item, depth + 1)).filter(Boolean).join("\n");
    }
    return String(value);
  };
  for (const value of [root.result, root.output, root.stdout]) {
    const text = flatten(value);
    if (text) return text;
  }
  return "";
}

export function detailNeedsInteractiveExpansion(content: string, criteria: SearchCriteria): boolean {
  if (content.trim().length < 1500 || !/\bProperty details\b/i.test(content)) return true;
  const schoolRequested = criteria.schoolMinRating != null || criteria.schoolAtLeastOneRating != null;
  const hasSchoolRatings = /(?:out\s+of\s+10|GreatSchools(?:\s+Rating)?|(?:rating|score)\s*[:\-]?\s*\d{1,2}\s*\/\s*10)/i.test(content);
  const hasAllSchoolStages = /elementary|primary/i.test(content) && /middle|junior high/i.test(content) && /high school|secondary/i.test(content);
  if (schoolRequested && !(hasSchoolRatings && hasAllSchoolStages)) return true;
  const groceryRequested = criteria.distanceConstraints?.some((constraint) => constraint.category === "grocery");
  if (groceryRequested && !/\b(?:Groceries|Grocery|Supermarket|Shopping Center)\b/i.test(content)) return true;
  if (criteria.communityFeatures?.length && !/\b(?:Community|Amenities|Neighborhood)\b/i.test(content)) return true;
  return false;
}

function hasCompleteRealtorSchoolEvidence(property: Property): boolean {
  const types = new Set((property.schools || [])
    .filter((school) => school.relationship === "listing-associated" && school.rating != null)
    .map((school) => school.type));
  return types.has("k12") || (types.has("elementary") && types.has("middle") && types.has("high"));
}

function needsTargetedFeatureSearch(property: Property, criteria: SearchCriteria): boolean {
  const needsBrick = (criteria.exteriorMaterials || []).some((material) => material.toLowerCase() === "brick")
    && property.exteriorCoverage !== "all-sides";
  const needsCommunity = (criteria.communityFeatures || []).some((requested) =>
    !(property.communityFeatures || []).some((found) => found.toLowerCase().includes(requested.toLowerCase())));
  return needsBrick || needsCommunity;
}

export function selectCachedLiveProperties(
  sessions: UserSession[],
  location: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  limit = 20,
  now = Date.now(),
): Property[] {
  const seen = new Set<string>();
  const results: Property[] = [];
  const recent = [...sessions]
    .filter((session) => now - Date.parse(session.updatedAt) <= maxAgeMs)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  for (const session of recent) {
    for (const property of session.matchedProperties || []) {
      if (!/realtor(?:\.com)?/i.test(property.source || "") || /demo/i.test(property.source || "")) continue;
      if (!propertyMatchesRequestedMarket(property, location)) continue;
      const key = (property.url || `${property.title}|${property.location}`).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(addDiagnostic(
        clearDerivedMatch(sanitizePriorSessionCoreMetrics({ ...property, source: "Realtor.com (cached prior live result)" })),
        "listing-search",
        "warning",
        `Cached from a prior live Realtor search saved at ${session.updatedAt}.`,
      ));
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function sanitizePriorSessionCoreMetrics(property: Property): Property {
  const repaired = repairCachedCoreMetrics(property);
  const content = [property.listingEvidenceText, property.description].filter(Boolean).join("\n");
  const evidenceMetrics = content ? extractCoreListingMetrics(content, property.title) : {};
  if (evidenceMetrics.bathrooms != null) return repaired;
  // A session fallback can be several days old and may predate parser fixes.
  // Showing "Baths unavailable" is safer than repeating an unverified number.
  return { ...repaired, bathrooms: 0, fullBathrooms: undefined, halfBathrooms: undefined };
}

function clearDerivedMatch(property: Property): Property {
  const copy = { ...property };
  delete copy.criteriaMatch;
  // Operational failures from an older run are not property evidence.
  delete copy.evidenceDiagnostics;
  return copy;
}

function repairCachedCoreMetrics(property: Property): Property {
  const content = [property.listingEvidenceText, property.description].filter(Boolean).join("\n");
  if (!content) return property;
  const metrics = extractCoreListingMetrics(content, property.title);
  const hasCurrentBathroomTotal = metrics.bathrooms != null;
  const features = hasNewConstructionEvidence(content, property.title)
    && !(property.features || []).some((feature) => /new construction/i.test(feature))
    ? [...(property.features || []), "new construction"]
    : property.features;
  return {
    ...property,
    features,
    bedrooms: metrics.bedrooms ?? property.bedrooms,
    bedroomsSource: metrics.bedrooms != null ? "cached" : property.bedroomsSource,
    bathrooms: metrics.bathrooms ?? property.bathrooms,
    bathroomsSource: hasCurrentBathroomTotal ? "cached" : property.bathroomsSource,
    fullBathrooms: hasCurrentBathroomTotal ? metrics.fullBathrooms : property.fullBathrooms,
    halfBathrooms: hasCurrentBathroomTotal ? metrics.halfBathrooms : property.halfBathrooms,
    sqft: metrics.sqft ?? property.sqft,
    sqftSource: metrics.sqftSource ?? property.sqftSource ?? (property.sqft > 0 ? "cached" : undefined),
  };
}

function addCoreDataDiagnostic(property: Property): Property {
  const missing = [
    property.bedroomsSource || property.bedrooms > 0 ? "" : "bedrooms",
    property.bathrooms > 0 ? "" : "bathrooms",
    property.sqft > 0 ? "" : "living area",
  ].filter(Boolean);
  return missing.length
    ? addDiagnostic(property, "listing-search", "warning", `Core listing data unavailable: ${missing.join(", ")}. Values were not guessed.`)
    : property;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractStructuredSqft(listing: any): number {
  const candidates = [
    listing?.floorSize?.value,
    listing?.livingArea?.value,
    listing?.livingArea,
    listing?.buildingArea?.value,
    listing?.buildingArea,
    listing?.sqft,
  ];
  for (const candidate of candidates) {
    const parsed = Number(String(candidate ?? "").replace(/,/g, "").match(/[\d.]+/)?.[0]);
    if (Number.isFinite(parsed) && parsed > 100 && parsed < 100000) return Math.round(parsed);
  }
  return 0;
}

function cleanSchemaText(value: unknown): string {
  const text = String(value ?? "").trim();
  return /^(?:null|undefined|n\/a)$/i.test(text) ? "" : text;
}

function htmlToVisibleSearchText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePropertyAddress(property: Property): string {
  return `${property.title}|${property.location}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugifyCity(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function canonicalMarketLocation(location: { citySlug: string; stateCode: string }): string {
  return `${location.citySlug.replace(/-+/g, " ")}, ${location.stateCode.toUpperCase()}`;
}

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};

function normalizeUsStateCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (US_STATE_NAME_TO_CODE[normalized]) return US_STATE_NAME_TO_CODE[normalized];
  return isUsStateCode(normalized) ? normalized.toUpperCase() : "";
}

function isUsStateCode(value: string): boolean {
  return new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","VI","GU","AS","MP",
  ]).has(value.toUpperCase());
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0 && number < 20) return number;
  }
  return undefined;
}

function extractBathroomTotal(listing: any): number {
  const full = firstPositiveNumber(listing.numberOfFullBathrooms, listing.bathroomsFull);
  const half = firstPositiveNumber(listing.numberOfHalfBathrooms, listing.bathroomsHalf);
  const threeQuarter = firstPositiveNumber(listing.numberOfThreeQuarterBathrooms, listing.bathroomsThreeQuarter);
  // Match Realtor's consumer-facing bath convention. Some MLS feeds call
  // 2 full + 1 half "3 total bathrooms", but Realtor displays it as 2.5.
  if (full != null && (half != null || threeQuarter != null)) {
    return full + ((half || 0) * 0.5) + ((threeQuarter || 0) * 0.75);
  }
  return firstPositiveNumber(
    listing.numberOfBathroomsTotal, listing.bathroomsTotal, listing.numberOfBathrooms,
    listing.bathrooms, full, listing.description?.baths,
  ) || 0;
}

function hasNewConstructionEvidence(content: string, propertyTitle: string): boolean {
  const normalized = content.replace(/\s+/g, " ");
  const address = propertyTitle.split(",")[0].trim().toLowerCase();
  if (!address) return false;
  const lower = normalized.toLowerCase();
  let from = 0;
  for (let occurrence = 0; occurrence < 8; occurrence++) {
    const index = lower.indexOf(address, from);
    if (index < 0) break;
    const window = normalized.slice(Math.max(0, index - 240), index + 700);
    if (/\b(?:new construction|built by|builder)\b/i.test(window)) return true;
    from = index + address.length;
  }
  return false;
}

function addDiagnostic(
  property: Property,
  stage: NonNullable<Property["evidenceDiagnostics"]>[number]["stage"],
  status: NonNullable<Property["evidenceDiagnostics"]>[number]["status"],
  detail: string,
): Property {
  return { ...property, evidenceDiagnostics: [...(property.evidenceDiagnostics || []), { stage, status, detail }] };
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) await worker(items[nextIndex++]);
  });
  await Promise.all(runners);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
