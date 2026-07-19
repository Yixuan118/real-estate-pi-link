import assert from "node:assert/strict";
import test from "node:test";
import { firecrawlRequestBudget } from "./firecrawl-request-budget";

test("hard-stops Firecrawl calls when the per-search budget is exhausted", async () => {
  await firecrawlRequestBudget.run(async () => {
    firecrawlRequestBudget.consume("first");
    firecrawlRequestBudget.consume("second");
    assert.equal(firecrawlRequestBudget.snapshot()?.used, 2);
    assert.throws(() => firecrawlRequestBudget.consume("third"), /budget 2 reached/i);
  }, 2);
});
