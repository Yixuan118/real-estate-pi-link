import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "../core/types";
import { assessProperty } from "../core/property-matcher";
import { HereMapsService } from "./here-maps-service";

function athensProperty(): Property {
  return {
    id: "here-1", title: "320 Kings Rd", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA 30606", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
}

test("HERE geocodes, discovers groceries, and verifies driving distance", async () => {
  const calls: string[] = [];
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "geocode.search.hereapi.com") {
      return json({ items: [{ position: { lat: 33.95, lng: -83.38 } }] });
    }
    if (url.hostname === "browse.search.hereapi.com") {
      return json({ items: [
        { id: "publix", title: "Publix Super Market", distance: 1500, position: { lat: 33.96, lng: -83.39 }, categories: [{ id: "600-6300-0066", name: "Grocery", primary: true }] },
        { id: "kroger", title: "Kroger", distance: 2500, position: { lat: 33.97, lng: -83.40 }, categories: [{ id: "600-6300-0066", name: "Grocery", primary: true }] },
        { id: "jalisco", title: "La Jalisco of Athens", distance: 500, position: { lat: 33.951, lng: -83.381 }, categories: [{ id: "600-6300-0066", name: "Grocery", primary: true }] },
        { id: "nursery", title: "Andrew's Farm & Nursery", distance: 1200, position: { lat: 33.955, lng: -83.385 }, categories: [{ id: "600-6600-0082", name: "Garden Center", primary: true }] },
      ] });
    }
    if (url.hostname === "router.hereapi.com") {
      const destination = url.searchParams.get("destination") || "";
      const meters = destination.includes("33.96") ? 3218.688 : 6437.376;
      return json({ routes: [{ sections: [{ summary: { length: meters, duration: 600 } }] }] });
    }
    throw new Error(`Unexpected URL: ${url.hostname}`);
  };
  const service = new HereMapsService("here-test-key", mockFetch);
  const constraint = { name: "supermarket or large grocery store", category: "grocery" as const, maxMiles: 3 };
  const enriched = await service.enrichProperty(athensProperty(), [constraint]);
  const match = assessProperty(enriched, { ...defaultSearchCriteria(), distanceConstraints: [constraint] });

  assert.equal(enriched.coordinateSource, "here-geocoding");
  assert.equal(enriched.nearbyPlaces?.[0]?.name, "Publix Super Market");
  assert.equal(enriched.nearbyPlaces?.[0]?.distanceMiles, 2);
  assert.equal(enriched.distanceEvaluations?.[0]?.source, "here");
  assert.ok(enriched.evidenceDiagnostics?.some((item) => item.stage === "geocoding" && item.status === "success"));
  assert.ok(enriched.evidenceDiagnostics?.some((item) => item.stage === "poi-search" && item.status === "success"));
  assert.equal(match.overall, "verified");
  const browseCall = calls.find((url) => url.includes("browse.search.hereapi.com"));
  assert.ok(browseCall);
  assert.equal(new URL(browseCall).searchParams.get("categories"), "600-6300-0066");
});

test("HERE coordinates support evidence-based UGA radius checks", async () => {
  const service = new HereMapsService("here-test-key", async () => json({ items: [{ position: { lat: 33.95, lng: -83.38 } }] }));
  const constraint = { name: "UGA", category: "university" as const, maxMiles: 30, lat: 33.948, lng: -83.3773 };
  const enriched = await service.enrichProperty(athensProperty(), [constraint]);
  const match = assessProperty(enriched, { ...defaultSearchCriteria(), distanceConstraints: [constraint] });
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /straight-line distance/i);
});

test("HERE verifies driving distance to the first legal GA-316 access", async () => {
  const calls: URL[] = [];
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "geocode.search.hereapi.com") {
      return json({ items: [{ position: { lat: 33.93, lng: -83.50 } }] });
    }
    if (url.hostname === "router.hereapi.com") {
      const westboundAnchor = (url.searchParams.get("destination") || "").includes("-84.1065900256");
      const localLength = westboundAnchor ? 1609.344 : 4828.032;
      return json({ routes: [{ sections: [{ spans: [
        { offset: 0, length: localLength, names: [{ value: westboundAnchor ? "Epps Bridge Parkway" : "Atlanta Highway" }] },
        { offset: 8, length: 804.672, names: [{ value: "Ramp" }] },
        { offset: 12, length: 10000, names: [{ value: "University Parkway" }], routeNumbers: [{ value: "GA-316" }] },
      ] }] }] });
    }
    throw new Error(`Unexpected URL: ${url.hostname}`);
  };
  const service = new HereMapsService("here-test-key", mockFetch);
  const highwayAccess = { highwayName: "GA-316", maxMiles: 3 };
  const enriched = await service.enrichProperty(athensProperty(), [], highwayAccess);
  const match = assessProperty(enriched, { ...defaultSearchCriteria(), highwayAccess });

  assert.equal(enriched.highwayAccessEvaluation?.status, "verified");
  assert.equal(enriched.highwayAccessEvaluation?.distanceMiles, 1.5);
  assert.equal(enriched.highwayAccessEvaluation?.accessName, "Epps Bridge Parkway");
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /1\.5 driving miles/);
  assert.equal(calls.filter((url) => url.hostname === "router.hereapi.com").length, 2);
  assert.ok(calls.filter((url) => url.hostname === "router.hereapi.com")
    .every((url) => url.searchParams.get("spans") === "names,routeNumbers,length"));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
