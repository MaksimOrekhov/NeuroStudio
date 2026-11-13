// NS-023 pilot 01 (quality prefix): the prepared jobs are reproducible and differ only in the prefix. No ComfyUI, no GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS, loadWorkflow } from "../src/comfy.ts";
import { runCollection } from "../src/collection.ts";
import { loadInstructions } from "../src/codex.ts";
import { validatePlan, type PromptPlan } from "../src/promptPlan.ts";
import {
  CONCEPTS, CRITERIA, MODEL, PREFIX_CANDIDATE, PREFIX_CURRENT, REMOVED_TAGS, SEEDS, WORKFLOW,
  assertPairsIdentical, buildPilot, fixedParameters, positiveOf, scoringSheet,
} from "../scripts/ns023-pilot.ts";

const base = await loadWorkflow(WORKFLOW);

test("pilot: 8 images = 1 model x 2 concepts x 2 seeds x 2 prefixes, on Crimson Oath", () => {
  const { jobs } = buildPilot(base);
  assert.equal(jobs.length, 8);
  assert.equal(new Set(jobs.map((j) => j.pair)).size, 4);
  assert.deepEqual([...new Set(jobs.map((j) => j.seed))].sort((a, b) => a - b), [...SEEDS].sort((a, b) => a - b));
  assert.equal(MODEL, "crimson-oath");
  for (const j of jobs) assert.equal(j.graph["90:78"].inputs.unet_name, MODELS["crimson-oath"]);
});

test("pilot: inside each pair everything is identical except the prefix (checkpoint, seed, sampler, CFG, steps, resolution, negative)", () => {
  const { jobs } = buildPilot(base);
  assertPairsIdentical(jobs);
  for (const pair of new Set(jobs.map((j) => j.pair))) {
    const [a, b] = jobs.filter((j) => j.pair === pair);
    assert.notEqual(a.graph["90:77"].inputs.text, b.graph["90:77"].inputs.text);
    assert.equal(a.seed, b.seed);
    assert.equal(a.graph["90:76"].inputs.seed, b.graph["90:76"].inputs.seed);
  }
  // nothing the pilot does not test is touched relative to the production workflow
  for (const j of jobs) {
    for (const id of ["90:75", "90:76", "90:79", "90:86", "91", "90:71", "90:72"]) {
      const { seed: _a, ...inputs } = j.graph[id].inputs as Record<string, unknown>;
      const { seed: _b, ...orig } = base[id].inputs as Record<string, unknown>;
      assert.deepEqual(inputs, orig, `node ${id}`);
    }
  }
});

test("pilot: the current prefix is the production one; the candidate only removes tags", async () => {
  const instructions = await loadInstructions();
  assert.ok(instructions.includes(PREFIX_CURRENT), "current prefix must be the house-format prefix of section A");
  const cur = PREFIX_CURRENT.split(",").map((t) => t.trim()).filter(Boolean);
  const cand = PREFIX_CANDIDATE.split(",").map((t) => t.trim()).filter(Boolean);
  assert.ok(cand.every((t) => cur.includes(t)), "no tag may be added");
  assert.deepEqual(cur.filter((t) => !cand.includes(t)), REMOVED_TAGS);
  assert.doesNotMatch(PREFIX_CANDIDATE, /chiaroscuro|cinematic|intricate|sharp focus|ultra detailed/);
});

test("pilot: the test prompts obey the hard rules of the house format", () => {
  for (const prefix of [PREFIX_CURRENT, PREFIX_CANDIDATE]) {
    const plan: PromptPlan = {
      concept: { title: "Pilot", titleRu: "Пилот", description: "d", descriptionRu: "д", heroine: "h" },
      frames: CONCEPTS.map((c, i) => ({ frame: i + 1, model: MODEL, summary: c.title, summaryRu: "кадр", positive: positiveOf(c.id, prefix) })),
    };
    validatePlan(plan, { models: [MODEL, MODEL] }); // adult woman, age 21+, exactly one "huge breast", banned words, distinct prompts
  }
  for (const c of CONCEPTS) assert.equal(positiveOf(c.id, PREFIX_CURRENT).split("\n\n").length, 7);
});

test("pilot: labels are blind and balanced; the key maps them back", () => {
  const { jobs, key } = buildPilot(base);
  for (const c of CONCEPTS) {
    const cur = jobs.filter((j) => j.concept === c.id && j.prefix === "current").map((j) => j.label);
    assert.equal(cur.filter((l) => l === "X").length, 1, `${c.id}: current is X in exactly one of two pairs`);
  }
  for (const j of jobs) assert.doesNotMatch(j.file, /current|candidate/);
  assert.equal(Object.keys(key).length, 8);
  assert.equal(key["K1-s101-X"].pair, "K1-s101");
});

test("pilot: the scoring sheet has one row per pair and a column per criterion for X and Y", () => {
  const { jobs } = buildPilot(base);
  const lines = scoringSheet(jobs).trim().split("\n");
  assert.equal(lines.length, 5);
  const cols = lines[0].split(",");
  for (const c of CRITERIA) assert.ok(cols.includes(`${c}_X`) && cols.includes(`${c}_Y`), c);
  assert.ok(lines.every((l) => l.split(",").length === cols.length));
  assert.doesNotMatch(lines.join("\n"), /current|candidate/);
});

test("pilot: fixed parameters are read from the workflow (CFG, steps, sampler, resolution, negative)", () => {
  const f = fixedParameters(base, "sha");
  assert.deepEqual([f.sampler, f.scheduler, f.cfg, f.steps], ["er_sde", "simple", 4, 35]);
  assert.equal(f.resolution.megapixels, 3);
  assert.match(String(f.negative), /worst quality/);
  assert.equal(f.checkpoint, MODELS["crimson-oath"]);
});

test("pilot: the execute path (existing runner, fake client) writes 8 images under blind names", async () => {
  const { jobs } = buildPilot(base);
  const dir = await mkdtemp(join(tmpdir(), "ns23p-"));
  const submitted: string[] = [];
  const client = {
    systemStats: async () => ({}),
    checkDependencies: async () => [],
    submit: async (g: Record<string, { inputs: { text?: string } }>) => {
      submitted.push(g["90:77"].inputs.text ?? "");
      return `p${submitted.length}`;
    },
    waitForImages: async () => ({ images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} }),
    download: async () => Buffer.from("png"),
  };
  const plan: PromptPlan = { concept: { title: "p", description: "d", heroine: "h" }, frames: jobs.map((j) => ({ frame: j.frame, model: MODEL, summary: j.summary, positive: j.positive })) };
  const m = await runCollection({ plan, jobs, dir, client: client as never });
  assert.equal(m.status, "done");
  assert.equal(submitted.length, 8);
  const pngs = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
  assert.equal(pngs.length, 8);
  assert.ok(pngs.every((f) => /^K[12]-s\d+-[XY]\.png$/.test(f)), pngs.join(","));
});
