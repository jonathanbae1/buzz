import assert from "node:assert/strict";
import test from "node:test";

import { resolveLaneModel } from "./laneAlias.ts";

const lanes = [
  { key: "deep", model: "anthropic/claude-opus-5-5" },
  { key: "orchestrator", model: "@deep" },
  { key: "planner", model: "@orchestrator" },
  { key: "loopA", model: "@loopB" },
  { key: "loopB", model: "@loopA" },
];

test("an alias lane resolves to the concrete model that carries its effort choices", () => {
  assert.equal(resolveLaneModel("@deep", lanes), "anthropic/claude-opus-5-5");
});

test("chained aliases resolve through every hop", () => {
  assert.equal(
    resolveLaneModel("@orchestrator", lanes),
    "anthropic/claude-opus-5-5",
  );
});

test("an unknown alias and an alias cycle are unresolved instead of looping", () => {
  assert.equal(resolveLaneModel("@missing", lanes), undefined);
  assert.equal(resolveLaneModel("@loopA", lanes), undefined);
});
