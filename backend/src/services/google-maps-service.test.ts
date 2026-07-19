import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "../core/types";
import { assessProperty } from "../core/property-matcher";
import { GoogleMapsService } from "./google-maps-service";

function property(): Property {
  return {
    id: "athens-1", title: "320 Kings Rd", price: 375000, bedrooms: 4, bathrooms: 2, sqft: 1985,
    location: "Athens, GA 30606", features: [], url: "", listedAt: new Date().toISOString(), source: "test",
  };
}

test("geocodes a property and verifies the nearest grocery by driving distance", async () => {
  const requests: Array<{ url: string; body?: any }> = [];
  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/geocode/")) {
      return json({ status: "OK", results: [{ geometry: { location: { lat: 33.95, lng: -83.38 } } }] });
    }
    if (url.includes("places:searchNearby")) {
      return json({ places: [
        { id: "publix", displayName: { text: "Publix Super Market" }, primaryType: "supermarket", location: { latitude: 33.96, longitude: -83.39 } },
        { id: "kroger", displayName: { text: "Kroger" }, primaryType: "grocery_store", location: { latitude: 33.97, longitude: -83.40 } },
      ] });
    }
    if (url.includes("computeRouteMatrix")) {
      return json([
        { originIndex: 0, destinationIndex: 0, distanceMeters: 3218.688, condition: "ROUTE_EXISTS" },
        { originIndex: 0, destinationIndex: 1, distanceMeters: 6437.376, condition: "ROUTE_EXISTS" },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const service = new GoogleMapsService("test-key", mockFetch);
  const criteria = {
    ...defaultSearchCriteria(),
    distanceConstraints: [{ name: "supermarket or large grocery store", category: "grocery" as const, maxMiles: 3 }],
  };
  const enriched = await service.enrichProperty(property(), criteria.distanceConstraints);
  const match = assessProperty(enriched, criteria);

  assert.equal(enriched.coordinateSource, "google-geocoding");
  assert.equal(enriched.nearbyPlaces?.[0]?.name, "Publix Super Market");
  assert.equal(enriched.nearbyPlaces?.[0]?.distanceMiles, 2);
  assert.equal(match.overall, "verified");
  const placesRequest = requests.find((request) => request.url.includes("places:searchNearby"));
  assert.ok(placesRequest?.body.includedTypes.includes("supermarket"));
  assert.equal(Math.round(placesRequest?.body.locationRestriction.circle.radius), 4828);
});

test("marks grocery requirement failed when Places finds no matching store", async () => {
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/geocode/")) return json({ status: "OK", results: [{ geometry: { location: { lat: 33.95, lng: -83.38 } } }] });
    if (url.includes("places:searchNearby")) return json({ places: [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const service = new GoogleMapsService("test-key", mockFetch);
  const constraint = { name: "supermarket", category: "grocery" as const, maxMiles: 3 };
  const enriched = await service.enrichProperty(property(), [constraint]);
  const match = assessProperty(enriched, { ...defaultSearchCriteria(), distanceConstraints: [constraint] });
  assert.equal(match.overall, "failed");
  assert.match(match.checks[0].detail, /found no supermarket/i);
});

test("geocodes each Athens address before evaluating the UGA radius", async () => {
  let calls = 0;
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    calls++;
    assert.match(String(input), /\/geocode\//);
    return json({ status: "OK", results: [{ geometry: { location: { lat: 33.95, lng: -83.38 } } }] });
  };
  const service = new GoogleMapsService("test-key", mockFetch);
  const constraint = { name: "UGA", category: "university" as const, maxMiles: 30, lat: 33.948, lng: -83.3773 };
  const enriched = await service.enrichProperty(property(), [constraint]);
  const match = assessProperty(enriched, { ...defaultSearchCriteria(), distanceConstraints: [constraint] });
  assert.equal(calls, 1);
  assert.equal(match.overall, "verified");
  assert.match(match.checks[0].detail, /straight-line distance/i);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
