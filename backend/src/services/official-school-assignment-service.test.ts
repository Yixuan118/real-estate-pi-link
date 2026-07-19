import assert from "node:assert/strict";
import test from "node:test";
import { extractClarkeStreetAssignment, OfficialSchoolAssignmentService, OfficialSchoolLocatorConfig } from "./official-school-assignment-service";
import { Property } from "../core/types";

test("resolves a Census district and official ArcGIS elementary/middle/high assignments", async () => {
  const locator: OfficialSchoolLocatorConfig = {
    districtGeoid: "1301170",
    districtName: "Clarke County School District",
    sourceUrl: "https://district.example/school-locator",
    layers: [
      { type: "elementary", queryUrl: "https://gis.example/elementary/FeatureServer/0", nameField: "SCHOOL" },
      { type: "middle", queryUrl: "https://gis.example/middle/FeatureServer/0", nameField: "SCHOOL" },
      { type: "high", queryUrl: "https://gis.example/high/FeatureServer/0", nameField: "SCHOOL" },
    ],
  };
  const mockFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("census.gov")) {
      return jsonResponse({ result: { geographies: { "Unified School Districts": [{
        NAME: "Clarke County School District", GEOID: "1301170", LOGRADE: "PK", HIGRADE: "12",
      }] } } });
    }
    const name = url.includes("elementary") ? "Timothy Road Elementary School"
      : url.includes("middle") ? "Clarke Middle School" : "Clarke Central High School";
    return jsonResponse({ features: [{ attributes: { SCHOOL: name } }] });
  }) as typeof fetch;
  const service = new OfficialSchoolAssignmentService(mockFetch, [locator], "");
  const input = baseProperty();
  input.schools = [{
    name: "Timothy Elementary School", rating: 7, scale: 10, type: "elementary",
    ratingSource: "GreatSchools", evidenceSource: "realtor-listing", sourceUrl: input.url,
    relationship: "nearby", checkedAt: new Date().toISOString(),
  }];
  const property = await service.enrichProperty(input);

  assert.equal(property.schoolDistricts?.[0].geoid, "1301170");
  assert.deepEqual(property.schools?.map((school) => [school.name, school.type, school.relationship]), [
    ["Timothy Road Elementary School", "elementary", "assigned"],
    ["Clarke Middle School", "middle", "assigned"],
    ["Clarke Central High School", "high", "assigned"],
  ]);
  assert.equal(property.schools?.[0].rating, 7);
});

test("built-in Clarke locator remains unknown when the official index has no matching row", async () => {
  const mockFetch = (async () => jsonResponse({ result: { geographies: { "Unified School Districts": [{
    NAME: "Clarke County School District", GEOID: "1301170", LOGRADE: "PK", HIGRADE: "12",
  }] } } })) as typeof fetch;
  const property = await new OfficialSchoolAssignmentService(mockFetch, [], "", "", false, async () => "").enrichProperty(baseProperty());
  assert.equal(property.schoolDistricts?.[0].name, "Clarke County School District");
  assert.equal(property.schools?.length || 0, 0);
  assert.match(property.evidenceDiagnostics?.at(-1)?.detail || "", /configured official locator returned no/i);
});

test("uses Firecrawl as a Census proxy when Node cannot connect to the government host", async () => {
  let firecrawlCalls = 0;
  const censusPayload = { result: { geographies: { "Unified School Districts": [{
    NAME: "Clarke County School District", GEOID: "1301170", LOGRADE: "PK", HIGRADE: "12",
  }] } } };
  const mockFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("geocoding.geo.census.gov")) {
      const error = new TypeError("fetch failed") as TypeError & { cause?: { code: string; message: string } };
      error.cause = { code: "UND_ERR_CONNECT_TIMEOUT", message: "Connect Timeout Error" };
      throw error;
    }
    if (url.includes("api.firecrawl.dev/v2/scrape")) {
      const requestedUrl = JSON.parse(String(init?.body || "{}")).url || "";
      if (requestedUrl.includes("geocoding.geo.census.gov")) {
        firecrawlCalls += 1;
        return jsonResponse({ data: { rawHtml: `<pre>${JSON.stringify(censusPayload).replace(/"/g, "&quot;")}</pre>` } });
      }
      return jsonResponse({ data: { markdown: "" } });
    }
    if (url.includes("api.firecrawl.dev/v2/search")) return jsonResponse({ data: { web: [] } });
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const property = await new OfficialSchoolAssignmentService(mockFetch, [], "firecrawl-key", "", true).enrichProperty(baseProperty());
  assert.equal(property.schoolDistricts?.[0].geoid, "1301170");
  assert.equal(firecrawlCalls, 1);
  assert.doesNotMatch(property.evidenceDiagnostics?.map((item) => item.detail).join(" ") || "", /fetch failed/);
});

test("parses an exact Clarke County official Street Index row", () => {
  const schools = extractClarkeStreetAssignment(
    "KENNINGTON DR Timothy Clarke Middle Clarke Central | KINGS RD Timothy Clarke Middle Clarke Central | KINGS PL Timothy Clarke Middle Clarke Central",
    "KINGS RD",
    320,
  );
  assert.deepEqual(schools.map((school) => [school.name, school.type, school.relationship]), [
    ["Timothy Road Elementary School", "elementary", "assigned"],
    ["Clarke Middle School", "middle", "assigned"],
    ["Clarke Central High School", "high", "assigned"],
  ]);
});

test("honors house-number conditions in the official Street Index", () => {
  const content = "E BROAD ST 1040 AND BELOW Barrow Clarke Middle Clarke Central";
  assert.equal(extractClarkeStreetAssignment(content, "E BROAD ST", 1040).length, 3);
  assert.equal(extractClarkeStreetAssignment(content, "E BROAD ST", 1185).length, 0);
});

test("accepts the CCSD Oak Meadows plural spelling for a postal Oak Meadow address", () => {
  const schools = extractClarkeStreetAssignment(
    "| OAK MEADOWS DR | Whit Davis | Hilsman | Cedar Shoals |",
    "OAK MEADOW DR",
    183,
  );
  assert.deepEqual(schools.map((school) => school.name), [
    "Whit Davis Elementary School", "Hilsman Middle School", "Cedar Shoals High School",
  ]);
});

test("treats non-four-digit Oak Grove addresses as Clarke County assignments", () => {
  const content = "OAK GROVE RD 4 digit addresses Jackson Co. Elementary C B-H-L Clarke Central";
  assert.deepEqual(extractClarkeStreetAssignment(content, "OAK GROVE RD", 3).map((school) => school.name), [
    "Cleveland Road Elementary School", "Oglethorpe Avenue Elementary School", "Whitehead Road Elementary School",
    "Burney-Harris-Lyons Middle School", "Clarke Central High School",
  ], "Elementary C options and the two exact assignments should all be preserved");
  assert.equal(extractClarkeStreetAssignment(content, "OAK GROVE RD", 3000).length, 0);
});

test("preserves partial assignments when Elementary C is not a unique school", () => {
  const schools = extractClarkeStreetAssignment(
    "ALICE WALKER DR Elementary C B-H-L Clarke Central",
    "ALICE WALKER DR",
    108,
  );
  assert.deepEqual(schools.map((school) => [school.name, school.type]), [
    ["Cleveland Road Elementary School", "elementary"],
    ["Oglethorpe Avenue Elementary School", "elementary"],
    ["Whitehead Road Elementary School", "elementary"],
    ["Burney-Harris-Lyons Middle School", "middle"],
    ["Clarke Central High School", "high"],
  ]);
  assert.ok(schools.slice(0, 3).every((school) => school.relationship === "assignment-option"));
});

test("parses and caches the official Clarke Street Index PDF instead of relying on per-address searches", async () => {
  let pdfCalls = 0;
  const mockFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("census.gov")) {
      return jsonResponse({ result: { geographies: { "Unified School Districts": [{
        NAME: "Clarke County School District", GEOID: "1301170", LOGRADE: "PK", HIGRADE: "12",
      }] } } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
  const service = new OfficialSchoolAssignmentService(mockFetch, [], "firecrawl-key", "", false, async () => {
    pdfCalls += 1;
    return "KINGS RD Timothy Clarke Middle Clarke Central";
  });
  const first = await service.enrichProperty(baseProperty());
  const second = await service.enrichProperty({ ...baseProperty(), id: "p2", latitude: 33.951, title: "321 Kings Rd, Athens, GA 30606" });

  assert.equal(first.schools?.length, 3);
  assert.equal(second.schools?.length, 3);
  assert.equal(pdfCalls, 1);
});

function baseProperty(): Property {
  return {
    id: "p1", title: "320 Kings Rd, Athens, GA 30606", price: 375000, bedrooms: 4, bathrooms: 2,
    sqft: 1985, location: "Athens, GA", features: [], url: "", listedAt: new Date().toISOString(),
    source: "test", latitude: 33.95, longitude: -83.38,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
