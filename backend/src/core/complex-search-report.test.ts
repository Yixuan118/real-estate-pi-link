import assert from "node:assert/strict";
import test from "node:test";
import { buildComplexSearchReport } from "./complex-search-report";
import { defaultSearchCriteria, Property } from "./types";

test("complex report only claims constraints backed by property checks", () => {
  const property: Property = {
    id: "r1", title: "320 Kings Rd, Athens, GA 30606", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
    criteriaMatch: {
      overall: "unknown", score: 25,
      checks: [
        { criterion: "all-sides brick exterior", status: "unknown", detail: "No listing evidence confirms brick on all four sides." },
        { criterion: "UGA within 30 miles", status: "verified", detail: "5.5 driving miles to UGA (HERE)." },
        { criterion: "supermarket within 3 miles", status: "unknown", detail: "HERE Discover request failed." },
      ],
    },
    evidenceDiagnostics: [{ stage: "poi-search", status: "error", detail: "HERE Discover request failed." }],
  };
  const report = buildComplexSearchReport({
    ...defaultSearchCriteria(), exteriorMaterials: ["brick"], communityFeatures: ["lake"],
    distanceConstraints: [{ name: "UGA", maxMiles: 30, category: "university", lat: 33.948, lng: -83.3773 }],
  }, [property]);
  assert.match(report, /✅ UGA within 30 miles/);
  assert.match(report, /⚠️ supermarket within 3 miles/);
  assert.match(report, /HERE Discover request failed/);
  assert.match(report, /0 fully verified, 1 with unresolved evidence/);
});

test("highway-only report gives a relevant unknown-evidence warning", () => {
  const property: Property = {
    id: "r2", title: "151 Winterberry Ln, Athens, GA 30606", price: 320000,
    bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA", features: [],
    url: "", listedAt: new Date().toISOString(), source: "test",
    criteriaMatch: {
      overall: "unknown", score: 0,
      checks: [{
        criterion: "GA-316 legal access within 3 miles",
        status: "unknown",
        detail: "No HERE route evidence is available for access to GA-316.",
      }],
    },
  };
  const report = buildComplexSearchReport({
    ...defaultSearchCriteria(), highwayAccess: { highwayName: "GA-316", maxMiles: 3 },
  }, [property]);
  assert.match(report, /GA-316 access still requires HERE road-segment and route evidence/);
  assert.doesNotMatch(report, /construction or community facts/);
});

test("complex report keeps listing cache diagnostics out of user-facing results", () => {
  const property: Property = {
    id: "r3", title: "Example home", price: 300000, bedrooms: 3, bathrooms: 2, sqft: 1500,
    location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
    criteriaMatch: {
      overall: "unknown", score: 0,
      checks: [{ criterion: "community lake", status: "unknown", detail: "No property-level lake evidence was found." }],
    },
    evidenceDiagnostics: [{
      stage: "listing-search", status: "warning",
      detail: "Using recently cached real Realtor listings; results are not guaranteed to be current.",
    }],
  };
  const report = buildComplexSearchReport({ ...defaultSearchCriteria(), communityFeatures: ["lake"] }, [property]);
  assert.doesNotMatch(report, /recently cached|not guaranteed to be current/i);
  assert.match(report, /No property-level lake evidence was found/);
});
