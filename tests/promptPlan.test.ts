import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexError, loadInstructions, planPrompt } from "../src/codex.ts";
import { buildJobs } from "../src/collection.ts";
import { loadWorkflow } from "../src/comfy.ts";
import { PlanError, validatePlan } from "../src/promptPlan.ts";
import { strictPlan } from "./fixtures/strictPlan.ts";

const root = resolve(import.meta.dirname, "..");
const legacy = async () => JSON.parse(await readFile(join(root, "tests/fixtures/prompt-plan.legacy.json"), "utf8"));

test("instructions load from prompts/CREATIVE_DIRECTOR.md; a missing file is an error, not a silent fallback", async () => {
  const text = await loadInstructions();
  for (const part of ["## A. Hard constraints", "## B. Artistic preferences", "## C. Creative freedom", "huge breast"]) assert.ok(text.includes(part), part);
  await assert.rejects(loadInstructions(join(tmpdir(), "no-such-dir", "CREATIVE_DIRECTOR.md")), CodexError);
  const empty = join(await mkdtemp(join(tmpdir(), "ns-instr-")), "x.md");
  await writeFile(empty, "  \n");
  await assert.rejects(loadInstructions(empty), /empty/);
});

test("request = instructions + theme + history + batch size (single request wording for 1, batch wording for n)", () => {
  const one = planPrompt("INSTR", undefined, [], 1);
  assert.ok(one.startsWith("INSTR"));
  assert.match(one, /invent ONE original concept/);
  assert.doesNotMatch(one, /Batch Plan/);
  const many = planPrompt("INSTR", "rainy market", ["Old One", "Old Two"], 3);
  assert.match(many, /"rainy market"/);
  assert.match(many, /exactly 3 Prompt Plans/);
  assert.match(many, /do NOT repeat[^\n]*"Old One", "Old Two"/);
  assert.match(many, /substantially different from each other/);
});

test("model order: frames 1-2 crimson-oath, 3-4 duskrose for new plans; the old 1/3 + 2/4 order still loads as legacy", async () => {
  validatePlan(strictPlan());
  const alt = strictPlan();
  alt.frames.forEach((f, i) => (f.model = i % 2 === 0 ? "crimson-oath" : "duskrose"));
  assert.throws(() => validatePlan(alt), /frames 1-2 must use crimson-oath/);
  assert.equal(validatePlan(alt, { legacy: true }).frames.length, 4);
  const old = await legacy();
  assert.throws(() => validatePlan(old), PlanError); // old plans lack the new wording rules
  assert.equal(validatePlan(old, { legacy: true }).frames[2].model, "crimson-oath");
});

test("lexical hard constraints: banned words, adult age, exactly one literal 'huge breast'", () => {
  const bad = (mutate: (p: ReturnType<typeof strictPlan>) => void, re: RegExp) => {
    const p = strictPlan();
    mutate(p);
    assert.throws(() => validatePlan(p), re);
  };
  for (const w of ["brushing", "camera", "framing", "twisted torso", "wide hips", "parted lips"]) {
    bad((p) => (p.frames[1].positive += `, ${w}`), /banned phrase/);
  }
  bad((p) => (p.frames[0].positive += ", huge breast"), /exactly once \(found 2\)/);
  bad((p) => (p.frames[0].positive = p.frames[0].positive.replace("huge breast", "")), /exactly once \(found 0\)/);
  bad((p) => (p.frames[0].positive = p.frames[0].positive.replace("huge breast", "huge breasts")), /exactly once/);
  bad((p) => (p.frames[2].positive = p.frames[2].positive.replace("29 years old", "19 years old")), /adult age/);
  bad((p) => (p.frames[2].positive = p.frames[2].positive.replace("adult woman, 29 years old", "young woman")), /adult woman/);
  const ok = strictPlan();
  ok.frames[0].positive = ok.frames[0].positive.replace("29 years old", "25-35 years old");
  validatePlan(ok); // an age range of adults is fine
});

test("new plans need no negative; legacy negatives still work; the workflow's own negative is the default", async () => {
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const fresh = strictPlan();
  assert.ok(fresh.frames.every((f) => f.negative === undefined));
  const jobs = buildJobs(validatePlan(fresh), base, "demo");
  assert.ok(jobs.every((j) => j.graph["90:75"].inputs.text === base["90:75"].inputs.text));
  const old = validatePlan(await legacy(), { legacy: true });
  const oldJobs = buildJobs(old, base, "demo");
  const f1 = old.frames[0];
  assert.equal(oldJobs.find((j) => j.frame === 1)!.graph["90:75"].inputs.text, f1.negative);
  assert.notEqual(f1.negative, base["90:75"].inputs.text);
});
