import assert from "node:assert/strict";
import test from "node:test";
import { extractPropertyEvidence } from "../core/property-matcher";
import { defaultSearchCriteria, Property, UserSession } from "../core/types";
import { canonicalMarketLocation, detailNeedsInteractiveExpansion, extractInteractText, FirecrawlSkill, isSchoolOnlyDetailRequest, prepareDetailEvidenceContent, prepareSearchPagePropertyEvidence, prioritizeCandidatesForCriteria, requiresListingDetail, resolveFeatureEnrichmentLimit, resolveFirecrawlBudget, selectCachedLiveProperties, shouldUseCachedMarket, shouldVerifyBathroomsSeparately } from "./firecrawl-skill";

test("caps the assessed result set at 20 properties", async () => {
  const properties: Property[] = Array.from({ length: 30 }, (_, index) => ({
    id: `p${index + 1}`,
    title: `Seattle home ${index + 1}`,
    price: 500000 + index,
    bedrooms: 3,
    bathrooms: 2,
    sqft: 1500,
    location: "Seattle, WA",
    features: [],
    url: "",
    listedAt: new Date().toISOString(),
    source: "test",
  }));
  const criteria = { ...defaultSearchCriteria(), location: "Seattle, WA", minBedrooms: 3 };
  const result = await (new FirecrawlSkill() as any).finalizeComplexMatches(properties, criteria, false);

  assert.equal(result.length, 20);
  assert.ok(result.every((property: Property) => property.criteriaMatch?.overall === "verified"));
});

test("community-lake searches prioritize likely discovery candidates before the 20-detail cap", () => {
  const property = (id: string, title: string, description = ""): Property => ({
    id, title, description, price: 400000, bedrooms: 3, bathrooms: 2, sqft: 1800,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  });
  const generic = Array.from({ length: 25 }, (_, index) => property(`g${index}`, `${index + 1} Main St, Athens, GA`));
  const candidates = [
    ...generic,
    property("lake-address", "1031 Founders Lake Dr, Athens, GA"),
    property("lake-description", "353 Plain Dr, Athens, GA", "Neighborhood residents have access to a community lake."),
  ];
  const prioritized = prioritizeCandidatesForCriteria(candidates, {
    ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"],
  });
  assert.deepEqual(prioritized.slice(0, 2).map((item) => item.id), ["lake-description", "lake-address"]);
  assert.equal(prioritized.length, candidates.length);
});

test("feature searches bypass a first-page market cache so pagination discovery still runs", () => {
  assert.equal(shouldUseCachedMarket({
    ...defaultSearchCriteria(), location: "Athens, GA",
  }), true);
  assert.equal(shouldUseCachedMarket({
    ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"],
  }), false);
  assert.equal(shouldUseCachedMarket({
    ...defaultSearchCriteria(), location: "Athens, GA", exteriorMaterials: ["brick"],
  }), false);
});

test("feature-only searches deeply verify the ten most relevant candidates", () => {
  const lake = { ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"] };
  assert.equal(resolveFeatureEnrichmentLimit(lake, "20"), 10);
  assert.equal(resolveFeatureEnrichmentLimit(lake, "6"), 6);
  assert.equal(resolveFeatureEnrichmentLimit({ ...lake, schoolMinRating: 5 }, "20"), 20);
  assert.equal(resolveFeatureEnrichmentLimit({ ...defaultSearchCriteria(), location: "Athens, GA" }, "20"), 20);
});

test("large Realtor documents are reduced to bounded evidence windows without losing collapsed lake facts", () => {
  const collapsedLake = JSON.stringify({
    category: "Amenities and Community Features",
    parent_category: "Community",
    text: ["Community Features: Gated, Lake, Pool, Sidewalks"],
  });
  const bathroomBlock = JSON.stringify({
    key: "bathroom",
    category: "Bathroom",
    detailedText: [{ subCategory: "Bathrooms", text: [
      "Total Bathrooms: 2.5", "Full Bathrooms: 2", "1/2 Bathrooms: 1",
    ] }],
  });
  const raw = `<html>${"x".repeat(350_000)}${collapsedLake}${"y".repeat(350_000)}${bathroomBlock}${"z".repeat(80_000)}</html>`;
  const criteria = { ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"] };
  const prepared = prepareDetailEvidenceContent("Property details for 256 Wood Lake Dr.", raw, criteria, "256 Wood Lake Dr, Athens, GA");
  assert.ok(prepared.length < raw.length / 2);
  assert.match(prepared, /Community Features: Gated, Lake, Pool/);
  assert.match(prepared, /Total Bathrooms: 2\.5/);
  const metrics = extractPropertyEvidence({
    id: "wood-lake", title: "256 Wood Lake Dr, Athens, GA 30606", price: 345000,
    bedrooms: 2, bathrooms: 1.5, sqft: 1863, location: "Athens, GA 30606",
    features: [], url: "https://www.realtor.com/wood-lake",
    listedAt: new Date().toISOString(), source: "Realtor.com",
  }, prepared);
  assert.equal(metrics.bathrooms, 2.5);
  assert.equal(metrics.fullBathrooms, 2);
  assert.equal(metrics.halfBathrooms, 1);
});

test("school evidence mode retains the full 20-candidate result set", async () => {
    const properties: Property[] = Array.from({ length: 20 }, (_, index) => ({
      id: `school-p${index + 1}`, title: `Athens home ${index + 1}`, price: 300000 + index,
      bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA", features: [], url: "",
      listedAt: new Date().toISOString(), source: "test",
    }));
    const criteria = { ...defaultSearchCriteria(), location: "Athens, GA", schoolMinRating: 5, schoolAtLeastOneRating: 8 };
    const result = await (new FirecrawlSkill() as any).finalizeComplexMatches(properties, criteria, false);
    assert.equal(result.length, 20);
});

test("stale low budget environment values cannot disable school detail enrichment", () => {
  const schoolCriteria = { ...defaultSearchCriteria(), location: "Athens, GA", schoolMinRating: 5 };
  assert.equal(resolveFirecrawlBudget(schoolCriteria, "15"), 45);
  assert.equal(resolveFirecrawlBudget(schoolCriteria, "60"), 60);
  assert.equal(resolveFirecrawlBudget({
    ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"],
  }, "15"), 25);
  assert.equal(resolveFirecrawlBudget({ ...defaultSearchCriteria(), location: "Boise, ID" }, "15"), 30);
});

test("school detail pages replace redundant exact-address bathroom searches", () => {
  assert.equal(shouldVerifyBathroomsSeparately({ ...defaultSearchCriteria(), location: "Athens, GA", schoolMinRating: 5 }), false);
  assert.equal(shouldVerifyBathroomsSeparately({ ...defaultSearchCriteria(), location: "Seattle, WA", minBedrooms: 3 }), true);
});

test("Interact object and JSON-string results preserve the Neighborhood and schools text", () => {
  const panel = "Neighborhood & schools Schools 5 10 5 out of 10 Example Elementary School";
  assert.equal(extractInteractText({ result: { type: "string", value: panel }, stdout: "debug" }), panel);
  assert.equal(extractInteractText({ result: JSON.stringify([panel]) }), panel);
  assert.equal(extractInteractText({ output: panel }), panel);
});

test("school searches do not spend a Firecrawl interaction on Realtor's empty resumed page", async () => {
  let interactPosts = 0;
  const panel = `Neighborhood & schools Schools From listing agent
    Elementary School: Whit Davis High School: Cedar Shoals Middle School: Hilsman Nearby schools
    5 10 5 out of 10 Whit Davis Road Elementary School Grades K-5 | 3.4 mi away | 346 students | 6 reviews
    3 10 3 out of 10 Hilsman Middle School Grades 6-8 | 5.5 mi away | 609 students | 9 reviews
    2 10 2 out of 10 Cedar Shoals High School Grades 9-12 | 5.0 mi away | 1508 students | 8 reviews`;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/interact") && init?.method === "POST") {
      interactPosts += 1;
      return new Response(JSON.stringify({ success: true, result: { type: "string", value: panel }, exitCode: 0 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/interact") && init?.method === "DELETE") return new Response("", { status: 200 });
    return new Response(JSON.stringify({ success: true, creditsUsed: 1, data: {
      markdown: `Property details ${"No school panel yet. ".repeat(100)}`,
      metadata: { scrapeId: "belmont-scrape" },
    } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const property: Property = {
    id: "belmont", title: "1080 Belmont Rd, Athens, GA 30605", price: 199000,
    bedrooms: 2, bathrooms: 1, sqft: 1164, location: "Athens, GA 30605", features: [],
    url: "https://www.realtor.com/realestateandhomes-detail/1080-Belmont-Rd_Athens_GA_30605_M53905-58944",
    listedAt: new Date().toISOString(), source: "Realtor.com",
  };
  const criteria = {
    ...defaultSearchCriteria(), location: "Athens, GA", schoolMinRating: 5,
    schoolAtLeastOneRating: 8, schoolAssignmentRequired: true,
  };
  const result = await (new FirecrawlSkill(mockFetch, "test-key") as any).finalizeComplexMatches([property], criteria, true);
  assert.equal(interactPosts, 0);
  assert.equal(result.length, 1);
});

test("explicit City, ST locations work nationwide and override ambiguous aliases", async () => {
  const skill = new FirecrawlSkill() as any;
  assert.deepEqual(await skill.parseLocation("Portland, ME"), { citySlug: "portland", stateCode: "ME" });
  assert.deepEqual(await skill.parseLocation("Athens, OH"), { citySlug: "athens", stateCode: "OH" });
  assert.deepEqual(await skill.parseLocation("Coeur d'Alene, ID"), { citySlug: "coeur-d-alene", stateCode: "ID" });
  assert.deepEqual(await skill.parseLocation("Portland, Maine"), { citySlug: "portland", stateCode: "ME" });
  assert.deepEqual(await skill.parseLocation("Kansas City Missouri"), { citySlug: "kansas-city", stateCode: "MO" });
  assert.deepEqual(await skill.parseLocation("Athens, GA, USA"), { citySlug: "athens", stateCode: "GA" });
  await assert.rejects(() => skill.parseLocation("Athens, Greece"), /not a supported US/i);
  await assert.rejects(() => skill.parseLocation("London, UK"), /not a supported US/i);
  assert.equal(canonicalMarketLocation({ citySlug: "springfield", stateCode: "IL" }), "springfield, IL");
});

test("an explicit foreign location never falls back to cached US same-name listings", async () => {
  let requests = 0;
  const mockFetch = async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  };
  const result = await new FirecrawlSkill(mockFetch as typeof fetch, "test-key").searchProperties({
    ...defaultSearchCriteria(), location: "Athens, Greece",
  });
  assert.equal(requests, 0);
  assert.equal(result.source, "location-error");
  assert.equal(result.properties.length, 0);
  assert.match(result.error || "", /not a supported US/i);
});

test("structured living area accepts comma-formatted values without confusing lot size", () => {
  const jsonLd = [{
    "@type": "CollectionPage",
    mainEntity: { itemListElement: [{
      "@type": "RealEstateListing", name: "Example home", offers: { price: "400000" },
      mainEntity: {
        numberOfBedrooms: 3, numberOfBathrooms: 2, floorSize: { value: "1,809" },
        lotSize: { value: "7,405" },
        address: { streetAddress: "10 Main St", addressLocality: "Boise", addressRegion: "ID", postalCode: "83702" },
      },
    }] },
  }];
  const raw = `<script data-testid="seoLinkingData">${JSON.stringify(jsonLd)}</script>`;
  const result = (new FirecrawlSkill() as any).parsePropertiesFromHtml(raw, defaultSearchCriteria(), "");
  assert.equal(result[0].sqft, 1809);
  assert.equal(result[0].sqftSource, "structured-data");
});

test("large Realtor search pages are reduced to bounded per-property evidence windows", () => {
  const content = [
    "x".repeat(600_000),
    "153 Ponderosa Dr, Athens, GA 30605 beds 2 baths 2.5 sqft square feet 1,570",
    "y".repeat(600_000),
  ].join(" ");
  const evidence = prepareSearchPagePropertyEvidence(
    content,
    "153 Ponderosa Dr, Athens, GA 30605",
    299000,
  );
  assert.ok(evidence.length < 20_000);
  assert.match(evidence, /beds 2 baths 2\.5/);
});

test("bounded pagination supplements a heavily filtered first page without merging distinct units", async () => {
  const requestedPages: string[] = [];
  const listings = Array.from({ length: 11 }, (_, index) => ({
    "@type": "RealEstateListing",
    name: index < 2 ? `100 Main St Unit ${index + 1}, Boise, ID 83702` : `${200 + index} Main St, Boise, ID 83702`,
    offers: { price: "400000" },
    mainEntity: {
      numberOfBedrooms: 3, numberOfBathrooms: 2, floorSize: { value: "1800" },
      address: {
        streetAddress: index < 2 ? `100 Main St Unit ${index + 1}` : `${200 + index} Main St`,
        addressLocality: "Boise", addressRegion: "ID", postalCode: "83702",
      },
    },
  }));
  const raw = `<script data-testid="seoLinkingData">${JSON.stringify([{
    "@type": "CollectionPage", mainEntity: { itemListElement: listings },
  }])}</script>${"x".repeat(1200)}`;
  const mockedFetch: typeof fetch = async (_input, init) => {
    requestedPages.push(JSON.parse(String(init?.body)).url);
    return new Response(JSON.stringify({ success: true, creditsUsed: 1, data: { rawHtml: raw, markdown: "" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const initial: Property[] = [{
    id: "r1", title: "1 First St, Boise, ID 83702", price: 300000, bedrooms: 3, bathrooms: 2,
    sqft: 1500, location: "Boise, ID 83702", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  }];
  const result = await (new FirecrawlSkill(mockedFetch) as any).supplementListingPages(
    "https://www.realtor.com/realestateandhomes-search/boise_ID", initial,
    { ...defaultSearchCriteria(), location: "Boise, ID", minBedrooms: 3 },
    (properties: Property[]) => properties,
  );
  assert.equal(requestedPages[0], "https://www.realtor.com/realestateandhomes-search/boise_ID/pg-2");
  assert.equal(result.length, 12);
  assert.ok(result.some((property: Property) => property.title.includes("Unit 1")));
  assert.ok(result.some((property: Property) => property.title.includes("Unit 2")));
});

test("feature discovery checks all configured listing pages even when page one already has enough homes", async () => {
  const requestedPages: string[] = [];
  const listing = {
    "@type": "RealEstateListing", name: "1031 Founders Lake Dr, Athens, GA 30606",
    offers: { price: "850000" },
    mainEntity: {
      numberOfBedrooms: 4, numberOfBathrooms: 3, floorSize: { value: "3000" },
      address: {
        streetAddress: "1031 Founders Lake Dr", addressLocality: "Athens",
        addressRegion: "GA", postalCode: "30606",
      },
    },
  };
  const raw = `<script data-testid="seoLinkingData">${JSON.stringify([{
    "@type": "CollectionPage", mainEntity: { itemListElement: [listing] },
  }])}</script>${"x".repeat(1200)}`;
  const mockedFetch: typeof fetch = async (_input, init) => {
    requestedPages.push(JSON.parse(String(init?.body)).url);
    return new Response(JSON.stringify({ success: true, creditsUsed: 1, data: { rawHtml: raw, markdown: "" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const initial: Property[] = Array.from({ length: 20 }, (_, index) => ({
    id: `r${index}`, title: `${index + 1} Main St, Athens, GA 30606`, price: 300000 + index,
    bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA 30606", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
  }));
  await (new FirecrawlSkill(mockedFetch) as any).supplementListingPages(
    "https://www.realtor.com/realestateandhomes-search/athens_GA", initial,
    { ...defaultSearchCriteria(), location: "Athens, GA", communityFeatures: ["lake"] },
    (properties: Property[]) => properties,
  );
  assert.deepEqual(requestedPages, [
    "https://www.realtor.com/realestateandhomes-search/athens_GA/pg-2",
    "https://www.realtor.com/realestateandhomes-search/athens_GA/pg-3",
  ]);
});

test("Realtor detail scraping is used by default for school and listing evidence", () => {
  const prior = process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED;
  delete process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED;
  assert.equal(requiresListingDetail({
    ...defaultSearchCriteria(), schoolMinRating: 5, schoolAtLeastOneRating: 8, schoolAssignmentRequired: true,
  }), true);
  process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED = "false";
  assert.equal(requiresListingDetail({ ...defaultSearchCriteria(), schoolMinRating: 5 }), false);
  process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED = "true";
  assert.equal(requiresListingDetail({ ...defaultSearchCriteria(), schoolMinRating: 5 }), true);
  if (prior == null) delete process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED;
  else process.env.RE_REALTOR_SCHOOL_DETAIL_ENABLED = prior;
  assert.equal(requiresListingDetail({ ...defaultSearchCriteria(), exteriorMaterials: ["brick"] }), true);
  assert.equal(requiresListingDetail({ ...defaultSearchCriteria(), communityFeatures: ["lake"] }), true);
  assert.equal(requiresListingDetail({ ...defaultSearchCriteria(), mustHave: ["composition roof"] }), true);
  assert.equal(requiresListingDetail({
    ...defaultSearchCriteria(), distanceConstraints: [{ name: "supermarket", category: "grocery", maxMiles: 3 }],
  }), true);
});

test("school detail requests retain raw HTML and bypass stale document cache", async () => {
  const requestBodies: any[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ success: true, data: { markdown: "Schools 5 10 5 out of 10 Example Elementary School" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const skill = new FirecrawlSkill(mockFetch) as any;
  const schoolCriteria = { ...defaultSearchCriteria(), schoolMinRating: 5 };
  assert.equal(isSchoolOnlyDetailRequest(schoolCriteria), true);
  assert.equal(isSchoolOnlyDetailRequest({ ...schoolCriteria, exteriorMaterials: ["brick"] }), false);
  await skill.scrapeDetail("https://www.realtor.com/example", true);
  await skill.scrapeDetail("https://www.realtor.com/example", false);
  assert.deepEqual(requestBodies.map((body) => body.formats), [["rawHtml", "markdown"], ["rawHtml", "markdown"]]);
  assert.deepEqual(requestBodies.map((body) => body.maxAge), [3600000, 604800000]);
  assert.deepEqual(requestBodies.map((body) => body.waitFor), [3000, 0]);
});

test("feature detail requests bypass stale cache and wait for collapsed property facts", async () => {
  const requestBodies: any[] = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ success: true, data: { rawHtml: "<html>Brick 4 Side</html>", markdown: "" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const skill = new FirecrawlSkill(mockFetch) as any;
  await skill.scrapeDetail("https://www.realtor.com/example", false, true);
  assert.equal(requestBodies[0].maxAge, 3600000);
  assert.equal(requestBodies[0].waitFor, 3000);
  assert.deepEqual(requestBodies[0].formats, ["rawHtml", "markdown"]);
});

test("interactive school extraction retries a transient 429 and returns the panel", async () => {
  let posts = 0;
  let deletes = 0;
  const panel = "Neighborhood & schools 8 out of 10 Example Elementary School";
  const mockFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "DELETE") {
      deletes += 1;
      return new Response("", { status: 200 });
    }
    posts += 1;
    if (posts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ success: true, result: panel }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const skill = new FirecrawlSkill(mockFetch, "test-key") as any;
  assert.equal(await skill.expandInteractiveDetail("example-scrape"), panel);
  assert.equal(posts, 2);
  assert.equal(deletes, 1);
});

test("interactive expansion is used only when a requested detail section is absent", () => {
  const criteria = {
    ...defaultSearchCriteria(), schoolMinRating: 5,
    distanceConstraints: [{ name: "supermarket", category: "grocery" as const, maxMiles: 3 }],
  };
  const complete = `${"x".repeat(1600)} Property details School Information 8 out of 10 A Elementary School 7 out of 10 B Middle School 9 out of 10 C High School Groceries Community`;
  assert.equal(detailNeedsInteractiveExpansion(complete, criteria), false);
  assert.equal(detailNeedsInteractiveExpansion(`${"x".repeat(1600)} Property details Community and Schools Groceries`, criteria), true);
  assert.equal(detailNeedsInteractiveExpansion(`${"x".repeat(1600)} Property details Community`, criteria), true);
  assert.equal(detailNeedsInteractiveExpansion("short", criteria), true);
});

test("rendered Realtor summary overrides incomplete JSON-LD bathroom totals", () => {
  const jsonLd = [{
    "@type": "CollectionPage",
    mainEntity: { itemListElement: [{
      "@type": "RealEstateListing",
      name: "153 Ponderosa Dr, Athens, GA 30605",
      url: "https://www.realtor.com/ponderosa",
      offers: { price: "299000" },
      mainEntity: {
        numberOfBedrooms: 2,
        numberOfBathrooms: 2,
        floorSize: { value: 1570 },
        address: { streetAddress: "153 Ponderosa Dr", addressLocality: "Athens", addressRegion: "GA", postalCode: "30605" },
      },
    }] },
  }];
  const raw = `<script data-testid="seoLinkingData">${JSON.stringify(jsonLd)}</script>`
    + " 153 Ponderosa Dr, Athens, GA 30605 beds 2 baths 2.5 sqft square feet 1,570";
  const result = (new FirecrawlSkill() as any).parsePropertiesFromHtml(raw, defaultSearchCriteria(), "");
  assert.equal(result.length, 1);
  assert.deepEqual(
    { bedrooms: result[0].bedrooms, bathrooms: result[0].bathrooms, sqft: result[0].sqft },
    { bedrooms: 2, bathrooms: 2.5, sqft: 1570 },
  );
});

test("preserves Realtor full and half bathroom fields using the consumer-facing fractional total", () => {
  const jsonLd = [{
    "@type": "CollectionPage",
    mainEntity: { itemListElement: [{
      "@type": "RealEstateListing", name: "108 Alice Walker Dr, Athens, GA 30607",
      offers: { price: "289900" },
      mainEntity: {
        numberOfBedrooms: 3, numberOfBathrooms: 3, numberOfFullBathrooms: 2, numberOfHalfBathrooms: 1,
        floorSize: { value: 1514 },
        address: { streetAddress: "108 Alice Walker Dr", addressLocality: "Athens", addressRegion: "GA", postalCode: "30607" },
      },
    }] },
  }];
  const raw = `<script data-testid="seoLinkingData">${JSON.stringify(jsonLd)}</script>`;
  const result = (new FirecrawlSkill() as any).parsePropertiesFromHtml(raw, defaultSearchCriteria(), "");
  assert.deepEqual(
    { bathrooms: result[0].bathrooms, fullBathrooms: result[0].fullBathrooms, halfBathrooms: result[0].halfBathrooms },
    { bathrooms: 2.5, fullBathrooms: 2, halfBathrooms: 1 },
  );
});

test("markdown fallback never invents bedrooms or bathrooms and preserves fractional baths", () => {
  const skill = new FirecrawlSkill() as any;
  const known = skill.parseContent([
    "$299,000",
    "153 Ponderosa Dr, Athens, GA 30605",
    "beds 2 baths 2.5 sqft square feet 1,570",
  ].join("\n"), { ...defaultSearchCriteria(), location: "Athens, GA", minBathrooms: 2 });
  assert.equal(known.length, 1);
  assert.deepEqual(
    { bedrooms: known[0].bedrooms, bathrooms: known[0].bathrooms, sqft: known[0].sqft },
    { bedrooms: 2, bathrooms: 2.5, sqft: 1570 },
  );

  const unknown = skill.parseContent([
    "$310,000",
    "155 Ponderosa Dr, Athens, GA 30605",
    "Details unavailable",
  ].join("\n"), { ...defaultSearchCriteria(), location: "Athens, GA", minBathrooms: 2 });
  assert.equal(unknown.length, 1, "unknown bathroom data must survive until evidence assessment");
  assert.equal(unknown[0].bedrooms, 0);
  assert.equal(unknown[0].bathrooms, 0);
});

test("prior-live fallback keeps real Realtor listings and rejects demo or wrong-market data", () => {
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const property = (id: string, location: string, source: string): Property => ({
    id, title: `${location} home`, price: 300000, bedrooms: 3, bathrooms: 2, sqft: 1500,
    location, features: [], url: `https://www.realtor.com/${id}`, listedAt: new Date(now).toISOString(), source,
  });
  const session: UserSession = {
    id: "s1", userId: "u1", criteria: defaultSearchCriteria(), conversation: [], watchedProperties: [],
    monitoringInterval: 3600000, lastCheckAt: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    matchedProperties: [
      {
        ...property("athens-live", "Athens, GA 30606", "realtor.com (via Firecrawl)"),
        title: "153 Ponderosa Dr, Athens, GA 30605",
        bathrooms: 0,
        listingEvidenceText: "153 Ponderosa Dr, Athens, GA 30605 beds 2 baths 2 sqft square feet 1,570",
      },
      property("athens-demo", "Athens, GA", "Demo DB"),
      property("seattle-live", "Seattle, WA", "realtor.com (via Firecrawl)"),
    ],
  };

  const result = selectCachedLiveProperties([session], "Athens, GA", 86400000, 20, now);
  assert.deepEqual(result.map((item) => item.id), ["athens-live"]);
  assert.match(result[0].source, /cached prior live/i);
  assert.equal(result[0].criteriaMatch, undefined);
  assert.equal(result[0].bathrooms, 2);
});
