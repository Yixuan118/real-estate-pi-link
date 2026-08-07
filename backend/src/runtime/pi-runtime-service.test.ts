import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "../core/types";
import { formatListingRetrievalError, parsePiRuntimeJson, piRuntimeService, PiRuntimeResult, PiRuntimeService } from "./pi-runtime-service";

test("Pi activity and ranking are replaced with deterministic evidence results", () => {
  const result: PiRuntimeResult = {
    assistant_message: "hallucinated", agent_activity: [{ agent: "LLM", action: "wrong", detail: "11 properties" }],
    ranked_property_ids: ["wrong"], warnings: [],
  };
  const properties: Property[] = [
    candidate("expensive", 500000, "unknown", 50),
    candidate("cheap", 300000, "unknown", 50),
  ];
  (piRuntimeService as any).applyDeterministicCollaboration(result, properties, {
    ...defaultSearchCriteria(), exteriorMaterials: ["brick"],
  });
  assert.deepEqual(result.ranked_property_ids, ["cheap", "expensive"]);
  assert.equal(result.agent_activity.length, 4);
  assert.match(result.agent_activity[0].detail, /exactly 2 properties/);
  assert.doesNotMatch(result.agent_activity.map((item) => item.detail).join(" "), /11 properties/);
});

test("location errors do not tell the user to troubleshoot Firecrawl", () => {
  const message = formatListingRetrievalError(
    "location-error",
    'Location "Athens, Greece" is not a supported US City, ST market.',
  );
  assert.match(message, /US housing markets only/i);
  assert.match(message, /City, ST/i);
  assert.doesNotMatch(message, /Firecrawl|API key|quota/i);
});

test("malformed collaborator JSON falls back to deterministic property analysis", () => {
  const malformed = '{"assistant_message":"partial","ranked_property_ids":["one" "two"],"warnings":[]}';
  assert.throws(() => parsePiRuntimeJson(malformed), /Expected ',' or ']'/);

  const result = (piRuntimeService as any).parseJsonOrFallback(malformed) as PiRuntimeResult;
  (piRuntimeService as any).applyDeterministicCollaboration(result, [
    candidate("boston-home", 900000, "verified", 100),
  ], {
    ...defaultSearchCriteria(), location: "Boston, MA", maxPrice: 1000000, minBedrooms: 3,
  });

  assert.equal(result.assistant_message, "Analyzed 1 properties: 1 verified, 0 unknown, 0 failed.");
  assert.deepEqual(result.ranked_property_ids, ["boston-home"]);
  assert.equal(result.agent_activity.length, 4);
});

test("an empty or unavailable collaborator response cannot fail a completed basic search", async () => {
  const service = new PiRuntimeService();
  (service as any).callLLM = async () => { throw new Error("DeepSeek returned an empty response"); };
  const previous = process.env.PI_RUNTIME_ENABLED;
  process.env.PI_RUNTIME_ENABLED = "true";
  try {
    const property = candidate("three-bed", 600000, "verified", 100);
    property.location = "Seattle, WA";
    property.criteriaMatch = {
      overall: "verified", score: 100,
      checks: [{ criterion: "bedrooms exactly 3", status: "verified", detail: "Listing has exactly 3 bedrooms." }],
    };
    const result = await service.analyze({
      userMessage: "Find 3-bedroom homes in Seattle, WA.",
      criteria: { ...defaultSearchCriteria(), location: "Seattle, WA", exactBedrooms: 3 },
      properties: [property],
    });
    assert.equal(result.assistant_message, "Analyzed 1 properties: 1 verified, 0 unknown, 0 failed.");
    assert.deepEqual(result.ranked_property_ids, ["three-bed"]);
  } finally {
    if (previous == null) delete process.env.PI_RUNTIME_ENABLED;
    else process.env.PI_RUNTIME_ENABLED = previous;
  }
});

function candidate(id: string, price: number, overall: "verified" | "unknown" | "failed", score: number): Property {
  return {
    id, title: id, price, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
    criteriaMatch: { overall, score, checks: [{ criterion: "all-sides brick exterior", status: "unknown", detail: "missing" }] },
  };
}
