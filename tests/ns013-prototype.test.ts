import { test } from "node:test";
import assert from "node:assert/strict";
import { assignModels, autoMix, formula, modelUsage, sceneList } from "../web/prototype/src/models.ts";
import { exportState } from "../web/prototype/src/library.ts";
import { OPTION_RU, optionRu, ruPlural } from "../web/prototype/src/ru.ts";
import { COMPOSITION_FIELDS, COMPOSITION_OPTIONS } from "../src/composition.ts";
import { makeCollection } from "../web/prototype/src/mock.ts";

const C = "crimson-oath";
const D = "duskrose";
const I = "illustrijn";

test("Auto Mix: contiguous split, first model gets the remainder across the current catalog", () => {
  assert.deepEqual(autoMix(1), [C]);
  assert.deepEqual(autoMix(2), [C, D]);
  assert.deepEqual(autoMix(3), [C, D, I]);
  assert.deepEqual(autoMix(4), [C, C, D, I]);
});

test("Auto Mix generalises to a third model without UI changes", () => {
  assert.deepEqual(autoMix(4, ["a", "b", "c"]), ["a", "a", "b", "c"]);
  assert.deepEqual(autoMix(2, ["a", "b", "c"]), ["a", "b"]);
});

test("Only / Custom modes", () => {
  assert.deepEqual(assignModels(`only:${D}`, 3), [D, D, D]);
  assert.deepEqual(assignModels("custom", 3, [D, C, D, C]), [D, C, D]);
  // unknown or missing custom picks fall back to the Auto Mix choice for that scene
  assert.deepEqual(assignModels("custom", 4, [D, "gone"]), [D, C, D, I]);
});

test("summary text (Russian, with correct plural forms)", () => {
  assert.equal(formula(2, 3, 2), "2 коллекции × 3 кадра × 2 варианта = 12 изображений");
  assert.equal(formula(1, 1, 1), "1 коллекция × 1 кадр × 1 вариант = 1 изображение");
  assert.equal(formula(3, 4, 4), "3 коллекции × 4 кадра × 4 варианта = 48 изображений");
  assert.equal(formula(1, 1, 2), "1 коллекция × 1 кадр × 2 варианта = 2 изображения");
  assert.equal(formula(3, 3, 1), "3 коллекции × 3 кадра × 1 вариант = 9 изображений");
  assert.equal(formula(3, 4, 2), "3 коллекции × 4 кадра × 2 варианта = 24 изображения");
  assert.equal(formula(1, 1, 4), "1 коллекция × 1 кадр × 4 варианта = 4 изображения");
  assert.equal(sceneList([1, 2]), "Кадры 1–2");
  assert.equal(sceneList([3]), "Кадр 3");
  assert.equal(sceneList([1, 3]), "Кадры 1, 3");
  assert.deepEqual(modelUsage([C, D, C]).map((u) => [u.model.id, u.scenes]), [[C, [1, 3]], [D, [2]]]);
});

test("ruPlural edge cases", () => {
  const f = ["кадр", "кадра", "кадров"] as const;
  assert.deepEqual([1, 2, 5, 11, 12, 14, 21, 22, 25, 111].map((n) => ruPlural(n, f)), ["кадр", "кадра", "кадров", "кадров", "кадров", "кадров", "кадр", "кадра", "кадров", "кадров"]);
});

test("every composition option has a Russian label; ids are unchanged", () => {
  for (const f of COMPOSITION_FIELDS) {
    for (const o of COMPOSITION_OPTIONS[f]) assert.ok(OPTION_RU[f][o.id], `${f}.${o.id} has no Russian label`);
    assert.deepEqual(Object.keys(OPTION_RU[f]).sort(), COMPOSITION_OPTIONS[f].map((o) => o.id).sort(), `${f}: no stale labels`);
  }
  assert.equal(optionRu("pose", "sitting_on_a_chair"), "Сидя на стуле");
});

test("export rule uses the collection's own frame count", () => {
  const base = { id: "x", title: "T", description: "", daysAgo: 0, hue: 0, summaries: ["a", "b"], status: "done" as const };
  assert.equal(exportState(makeCollection({ ...base, frames: 2, variations: 1 })).ready, true);
  const two = makeCollection({ ...base, frames: 2, variations: 2, selections: { "1": 2 } });
  assert.deepEqual(exportState(two), { ready: false, resolved: 1, total: 2, message: "Выберите лучшие: 1/2" });
  two.selections["2"] = 1;
  assert.equal(exportState(two).ready, true);
});
