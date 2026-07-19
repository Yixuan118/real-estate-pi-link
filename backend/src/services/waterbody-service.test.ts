import assert from "node:assert/strict";
import test from "node:test";
import { assessProperty } from "../core/property-matcher";
import { defaultSearchCriteria, Property } from "../core/types";
import { WaterbodyService } from "./waterbody-service";

function property(): Property {
  return {
    id: "water-1", title: "100 Lake Test Dr", price: 300000, bedrooms: 3, bathrooms: 2, sqft: 1500,
    location: "Athens, GA", latitude: 33.98, longitude: -83.44, features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
  };
}

test("USGS mapped waterbody supports proximity evidence but not a community-lake claim", async () => {
  const service = new WaterbodyService(async () => new Response(JSON.stringify({ features: [{
    type: "Feature",
    properties: { gnis_name: "Test Lake", ftype: "LakePond", areasqkm: 0.04 },
    geometry: { type: "Polygon", coordinates: [[
      [-83.435, 33.979], [-83.434, 33.979], [-83.434, 33.981], [-83.435, 33.981], [-83.435, 33.979],
    ]] },
  }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const criteria = { ...defaultSearchCriteria(), communityFeatures: ["lake"] };
  const enriched = await service.enrichProperty(property());
  const match = assessProperty(enriched, criteria);

  assert.equal(enriched.nearbyWaterBodies?.[0]?.name, "Test Lake");
  assert.equal(enriched.nearbyWaterBodies?.[0]?.source, "USGS 3D Hydrography Program");
  assert.equal(match.overall, "unknown");
  assert.match(match.checks[0].detail, /does not prove/i);
  assert.ok(enriched.evidenceDiagnostics?.some((item) => item.stage === "waterbody-search" && item.status === "success"));
});

test("explicit subdivision lake evidence remains verified when map evidence is also present", () => {
  const candidate = { ...property(), communityFeatures: ["lake"], nearbyWaterBodies: [{
    name: "Test Lake", type: "lake-pond" as const, distanceMiles: 0.2, source: "USGS 3D Hydrography Program" as const,
    sourceUrl: "https://api.water.usgs.gov/", checkedAt: new Date().toISOString(),
  }] };
  const match = assessProperty(candidate, { ...defaultSearchCriteria(), communityFeatures: ["lake"] });
  assert.equal(match.overall, "verified");
});
