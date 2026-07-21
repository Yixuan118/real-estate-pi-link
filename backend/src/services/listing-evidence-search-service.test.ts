import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "../core/types";
import { extractCommunityName, ListingEvidenceSearchService } from "./listing-evidence-search-service";

test("adds exact-address four-sided-brick and community-lake evidence", async () => {
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.includeDomains, ["realtor.com", "redfin.com", "homes.com"]);
    return new Response(JSON.stringify({ data: { web: [{
      title: "320 Kings Rd, Athens, GA 30606",
      description: "A four-sided brick home in a neighborhood whose community amenities include a lake.",
      url: "https://www.realtor.com/realestateandhomes-detail/320-Kings-Rd_Athens_GA_30606",
    }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const property: Property = {
    id: "p", title: "320 Kings Rd, Athens, GA 30606", price: 1, bedrooms: 1, bathrooms: 1, sqft: 1,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
  const result = await new ListingEvidenceSearchService("key", mockFetch).enrichProperty(property, {
    ...defaultSearchCriteria(), exteriorMaterials: ["brick"], communityFeatures: ["lake"],
  });
  assert.equal(result.exteriorCoverage, "all-sides");
  assert.deepEqual(result.communityFeatures, ["lake"]);
  assert.equal(result.featureEvidence?.length, 2);
});

test("rejects four-sided-brick evidence from a different property that only mentions the target as related", async () => {
  const mockFetch = (async () => new Response(JSON.stringify({ data: { web: [
    {
      title: "1185 Tallassee Rd, Athens, GA 30606",
      description: "Four Sided Brick Exterior Elevation. Related homes: 180 Pointers Ridge Dr, Athens, GA 30606.",
      url: "https://www.homes.com/property/1185-tallassee-rd-athens-ga/h3stglvytz0v4/",
    },
    {
      title: "120 Maynard Ct, Athens, GA 30606",
      description: "FOUR SIDED BRICK RANCH. Nearby: 180 Pointers Ridge Dr, Athens, GA 30606.",
      url: "https://www.homes.com/property/120-maynard-ct-athens-ga/99x77x41zmhcl/",
    },
  ] } }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  const property: Property = {
    id: "pointers-ridge", title: "180 Pointers Ridge Dr, Athens, GA 30606", price: 275000,
    bedrooms: 3, bathrooms: 2, sqft: 1160, location: "Athens, GA 30606", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test", exteriorCoverage: "unknown",
  };

  const result = await new ListingEvidenceSearchService("key", mockFetch).enrichProperty(property, {
    ...defaultSearchCriteria(), exteriorMaterials: ["brick"],
  });

  assert.equal(result.exteriorCoverage, "unknown");
  assert.deepEqual(result.featureEvidence || [], []);
});

test("searches subdivision amenities once and reuses the evidence across homes", async () => {
  let calls = 0;
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.query, /Lantern Walk/);
    assert.equal(body.includeDomains, undefined);
    return new Response(JSON.stringify({ data: { web: [{
      title: "Lantern Walk community amenities",
      description: "Lantern Walk is a neighborhood whose community amenities include a residents lake and walking trail.",
      url: "https://lantern-walk.example/amenities",
    }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const base: Property = {
    id: "one", title: "108 Alice Walker Dr, Athens, GA 30607", price: 289900, bedrooms: 3, bathrooms: 2.5, sqft: 1514,
    location: "Athens, GA 30607", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
    listingFacts: { "Listing: Source Neighborhood": ["Lantern Walk"] },
  };
  assert.equal(extractCommunityName(base), "Lantern Walk");
  const service = new ListingEvidenceSearchService("key", mockFetch);
  const criteria = { ...defaultSearchCriteria(), communityFeatures: ["lake"] };
  const first = await service.enrichProperty(base, criteria);
  const second = await service.enrichProperty({ ...base, id: "two", title: "110 Alice Walker Dr, Athens, GA 30607" }, criteria);

  assert.equal(calls, 1);
  assert.deepEqual(first.communityFeatures, ["lake"]);
  assert.deepEqual(second.communityFeatures, ["lake"]);
  assert.equal(first.featureEvidence?.[0]?.sourceUrl, "https://lantern-walk.example/amenities");
});

test("verifies a new-construction bathroom breakdown by exact address and caches it", async () => {
  let calls = 0;
  const mockFetch = (async (_url: string, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.match(body.query, /287 Pondview Dr/);
    assert.ok(body.includeDomains.includes("lennar.com"));
    return new Response(JSON.stringify({ data: { web: [{
      title: "287 Pondview Dr, Athens, GA 30605",
      description: "This property has 4 bedrooms, 2 full bathrooms and 1 partial bathroom.",
      url: "https://www.lennar.com/example",
    }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const property: Property = {
    id: "pondview", title: "287 Pondview Dr, Athens, GA 30605", price: 382900,
    bedrooms: 4, bathrooms: 2, sqft: 1809, location: "Athens, GA 30605",
    features: ["new construction"], url: "https://www.realtor.com/example",
    listedAt: new Date().toISOString(), source: "Realtor.com",
  };
  const service = new ListingEvidenceSearchService("key", mockFetch);
  const first = await service.enrichBathroomDetails(property);
  const second = await service.enrichBathroomDetails(property);
  assert.equal(calls, 1);
  assert.deepEqual(
    { bathrooms: first.bathrooms, fullBathrooms: first.fullBathrooms, halfBathrooms: first.halfBathrooms },
    { bathrooms: 3, fullBathrooms: 2, halfBathrooms: 1 },
  );
  assert.equal(second.bathrooms, 3);
});
