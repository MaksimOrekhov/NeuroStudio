import { test } from "node:test";
import assert from "node:assert/strict";
import { assignModels, autoMix, formula, modelUsage, sceneList } from "../web/prototype/src/models.ts";
import { exportState } from "../web/prototype/src/library.ts";
import { makeCollection } from "../web/prototype/src/mock.ts";

const C = "crimson-oath";
const D = "duskrose";

test("Auto Mix: contiguous split, first model gets the remainder, 4 frames keep 2 + 2", () => {
  assert.deepEqual(autoMix(1), [C]);
  assert.deepEqual(autoMix(2), [C, D]);
  assert.deepEqual(autoMix(3), [C, C, D]);
  assert.deepEqual(autoMix(4), [C, C, D, D]);
});

test("Auto Mix generalises to a third model without UI changes", () => {
  assert.deepEqual(autoMix(4, ["a", "b", "c"]), ["a", "a", "b", "c"]);
  assert.deepEqual(autoMix(2, ["a", "b", "c"]), ["a", "b"]);
});

test("Only / Custom modes", () => {
  assert.deepEqual(assignModels(`only:${D}`, 3), [D, D, D]);
  assert.deepEqual(assignModels("custom", 3, [D, C, D, C]), [D, C, D]);
  // unknown or missing custom picks fall back to the Auto Mix choice for that scene
  assert.deepEqual(assignModels("custom", 4, [D, "gone"]), [D, C, D, D]);
});

test("summary text", () => {
  assert.equal(formula(2, 3, 2), "2 collections × 3 frames × 2 variations = 12 images");
  assert.equal(formula(1, 1, 1), "1 collection × 1 frame × 1 variation = 1 image");
  assert.equal(sceneList([1, 2]), "Scenes 1–2");
  assert.equal(sceneList([3]), "Scene 3");
  assert.equal(sceneList([1, 3]), "Scenes 1, 3");
  assert.deepEqual(modelUsage([C, D, C]).map((u) => [u.model.id, u.scenes]), [[C, [1, 3]], [D, [2]]]);
});

test("export rule uses the collection's own frame count", () => {
  const base = { id: "x", title: "T", description: "", daysAgo: 0, hue: 0, summaries: ["a", "b"], status: "done" as const };
  assert.equal(exportState(makeCollection({ ...base, frames: 2, variations: 1 })).ready, true);
  const two = makeCollection({ ...base, frames: 2, variations: 2, selections: { "1": 2 } });
  assert.deepEqual(exportState(two), { ready: false, resolved: 1, total: 2, message: "Select best images: 1/2" });
  two.selections["2"] = 1;
  assert.equal(exportState(two).ready, true);
});
