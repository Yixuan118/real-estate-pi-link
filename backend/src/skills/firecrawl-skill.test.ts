import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property, UserSession } from "../core/types";
import { detailNeedsInteractiveExpansion, extractInteractText, FirecrawlSkill, isSchoolOnlyDetailRequest, requiresListingDetail, resolveFirecrawlBudget, selectCachedLiveProperties, shouldVerifyBathroomsSeparately } from "./firecrawl-skill";

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
  assert.deepEqual(result[0].schools, []);
  assert.equal(result[0].criteriaMatch.overall, "unknown");
});

test("explicit City, ST locations work nationwide and override ambiguous aliases", async () => {
  const skill = new FirecrawlSkill() as any;
  assert.deepEqual(await skill.parseLocation("Portland, ME"), { citySlug: "portland", stateCode: "ME" });
  assert.deepEqual(await skill.parseLocation("Athens, OH"), { citySlug: "athens", stateCode: "OH" });
  assert.deepEqual(await skill.parseLocation("Coeur d'Alene, ID"), { citySlug: "coeur-d-alene", stateCode: "ID" });
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

test("school-only detail requests use lightweight markdown while mixed listing evidence keeps raw HTML", async () => {
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
  assert.deepEqual(requestBodies.map((body) => body.formats), [["markdown"], ["rawHtml", "markdown"]]);
  assert.deepEqual(requestBodies.map((body) => body.maxAge), [0, 604800000]);
  assert.deepEqual(requestBodies.map((body) => body.waitFor), [5000, 0]);
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

test("preserves Realtor full and half bathroom fields and total bathroom rooms", () => {
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
    { bathrooms: 3, fullBathrooms: 2, halfBathrooms: 1 },
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
