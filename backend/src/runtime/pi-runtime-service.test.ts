import assert from "node:assert/strict";
import test from "node:test";
import { defaultSearchCriteria, Property } from "../core/types";
import { piRuntimeService, PiRuntimeResult } from "./pi-runtime-service";

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

function candidate(id: string, price: number, overall: "verified" | "unknown" | "failed", score: number): Property {
  return {
    id, title: id, price, bedrooms: 3, bathrooms: 2, sqft: 1500, location: "Athens, GA", features: [], url: "",
    listedAt: new Date().toISOString(), source: "test",
    criteriaMatch: { overall, score, checks: [{ criterion: "all-sides brick exterior", status: "unknown", detail: "missing" }] },
  };
}
