import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PlanError, validatePlan } from "../src/promptPlan.ts";

const sample = resolve(import.meta.dirname, "../docs/examples/prompt-plan.sample.json");

test("real Codex plan sample passes validation", async () => {
  validatePlan(JSON.parse(await readFile(sample, "utf8")));
});

test("validatePlan rejects banned phrases, wrong model split and wrong frame count", async () => {
  const p = JSON.parse(await readFile(sample, "utf8"));
  const banned = structuredClone(p);
  banned.frames[0].positive += ", parted lips";
  assert.throws(() => validatePlan(banned), PlanError);
  const split = structuredClone(p);
  split.frames[1].model = "crimson-oath";
  assert.throws(() => validatePlan(split), PlanError);
  const short = structuredClone(p);
  short.frames.pop();
  assert.throws(() => validatePlan(short), PlanError);
});
