import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { listRuns } from "../server/runs.ts";
import { MODELS, loadWorkflow } from "../src/comfy.ts";
import { ComfyUnavailableError } from "../src/comfy.ts";
import { buildJobs } from "../src/collection.ts";
import { CodexError, framesPrompt, planPrompt, planSchema, batchSchema, generateBatch } from "../src/codex.ts";
import { PlanError, parseFrames, validateBatch, validatePlan } from "../src/promptPlan.ts";
import { IMAGE_MODELS, ImageModelsError, autoMix, resolveImageModels } from "../src/imageModels.ts";
import { CompositionError, compositionPrompt, parseComposition, resolveComposition } from "../src/composition.ts";
import { planV3, strictPlan } from "./fixtures/strictPlan.ts";

const root = resolve(import.meta.dirname, "..");
const PORT = 8787;
const H = { host: `127.0.0.1:${PORT}` };
const C = "crimson-oath";
const D = "duskrose";
const I = "illustrijn";
const wait = async (r: AutopilotRunner) => {
  while (r.active) await new Promise((res) => setTimeout(res, 5));
};

// ---------- image models ----------

test("catalog: supported models have id, name, checkpoint and colour; MODELS is derived from it", () => {
  assert.deepEqual(IMAGE_MODELS.map((m) => [m.id, m.checkpoint]), [
    [C, "vetehineCrimsonOathILL_v02ANM.safetensors"],
    [D, "Duskrose v4 ANM.safetensors"],
    [I, "IllustrijN.safetensors"],
  ]);
  assert.ok(IMAGE_MODELS.every((m) => m.name && /^#[0-9a-f]{6}$/.test(m.color)));
  assert.deepEqual(MODELS, Object.fromEntries(IMAGE_MODELS.map((m) => [m.id, m.checkpoint])));
});

test("Auto Mix for 1-4 frames; Only; Custom incl. four frames of one model", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => autoMix(n)), [[C], [C, D], [C, D, I], [C, C, D, I]]);
  assert.deepEqual(resolveImageModels(undefined, 4), { mode: "auto", models: [C, C, D, I] });
  assert.deepEqual(resolveImageModels({ mode: "auto" }, 3).models, [C, D, I]);
  assert.deepEqual(resolveImageModels({ mode: "only", model: D }, 3), { mode: "only", models: [D, D, D] });
  assert.deepEqual(resolveImageModels({ mode: "custom", perScene: [D, C, D] }, 3).models, [D, C, D]);
  assert.deepEqual(resolveImageModels({ mode: "custom", perScene: [C, C, C, C] }, 4).models, [C, C, C, C]);
});

test("invalid imageModels are rejected, never replaced by Auto Mix", () => {
  const bad: [unknown, number][] = [
    ["auto", 4],
    [[], 4],
    [{}, 4],
    [{ mode: "mix" }, 4],
    [{ mode: "only" }, 4],
    [{ mode: "only", model: "gone" }, 4],
    [{ mode: "only", model: C, perScene: [C] }, 1],
    [{ mode: "auto", model: C }, 4],
    [{ mode: "custom" }, 2],
    [{ mode: "custom", perScene: [C] }, 2], // too short
    [{ mode: "custom", perScene: [C, D, C] }, 2], // too long
    [{ mode: "custom", perScene: [C, "gone"] }, 2],
    [{ mode: "custom", perScene: [C, D], model: C }, 2],
    [{ mode: "auto", extra: 1 }, 4],
  ];
  for (const [input, frames] of bad) assert.throws(() => resolveImageModels(input, frames), ImageModelsError, JSON.stringify(input));
});

// ---------- Plan v3 ----------

test("planSchema is built for the exact frame count and models; the file schema requires the Russian fields", async () => {
  for (const models of [[C], [C, D], [C, C, D], [C, C, D, D], [D, D]]) {
    const s = (await planSchema(models)) as any;
    assert.equal(s.properties.frames.minItems, models.length);
    assert.equal(s.properties.frames.maxItems, models.length);
    assert.equal(s.properties.frames.items.properties.frame.maximum, models.length);
    assert.deepEqual(s.properties.frames.items.properties.model.enum, IMAGE_MODELS.map((m) => m.id).filter((id) => models.includes(id)));
    assert.deepEqual(s.properties.concept.required, ["title", "titleRu", "description", "descriptionRu", "heroine"]);
    assert.ok(s.properties.frames.items.required.includes("summaryRu"));
  }
  const b = (await batchSchema(2, undefined, [C])) as any;
  assert.equal(b.properties.collections.items.properties.frames.maxItems, 1);
});

test("validatePlan v3: 1-4 frames, assigned models, numbering, Russian metadata, distinct prompts", () => {
  for (const models of [[C], [C, D], [D, C, D], [C, C, D, D], [D, D, D, D]]) {
    assert.equal(validatePlan(planV3("T", models), { models }).frames.length, models.length);
  }
  const m3 = [C, D, C];
  const bad = (mutate: (p: ReturnType<typeof planV3>) => void, re: RegExp, models: string[] = m3) => {
    const p = planV3("T", models);
    mutate(p);
    assert.throws(() => validatePlan(p, { models }), re);
  };
  bad((p) => (p.frames[1].model = C), /frames\[1\]\.model must be duskrose/);
  bad((p) => p.frames.pop(), /exactly 3/);
  bad((p) => p.frames.push({ ...p.frames[0], frame: 4, positive: "x" }), /exactly 3/);
  bad((p) => (p.frames[2].frame = 5), /frame must be 3/);
  bad((p) => (p.frames[2].positive = p.frames[0].positive), /distinct/);
  bad((p) => delete p.concept.titleRu, /titleRu missing/);
  bad((p) => delete p.concept.descriptionRu, /descriptionRu missing/);
  bad((p) => delete p.frames[1].summaryRu, /summaryRu missing/);
  bad((p) => (p.frames[0].summaryRu = "only english here"), /summaryRu must be Russian/);
  bad((p) => (p.concept.title = ""), /concept\.title missing/);
  // existing hard constraints still apply
  bad((p) => (p.frames[0].positive += ", camera"), /banned phrase/);
  bad((p) => (p.frames[0].positive = p.frames[0].positive.replace("huge breast", "")), /huge breast/);
  bad((p) => (p.frames[1].positive = p.frames[1].positive.replace("29 years old", "17 years old")), /adult age/);
  bad((p) => (p.frames[2].positive = p.frames[2].positive.replace("adult woman", "woman")), /adult woman/);
  assert.throws(() => validatePlan(planV3("T"), { models: [] }), PlanError);
  assert.throws(() => validatePlan(planV3("T"), { models: [C, C, C, C, C] }), PlanError);
  assert.throws(() => validatePlan(planV3("T"), { models: ["gone"] }), PlanError);
});

test("older plans: no Russian fields needed, 4 frames with 2 + 2, legacy mode kept", async () => {
  const old = validatePlan(strictPlan("Old"));
  assert.equal(old.concept.titleRu, undefined);
  validatePlan(planV3("New", [C, C, D, D])); // a 2+2 plan also passes the old-style check (Russian fields are optional there)
  const legacy = JSON.parse(await readFile(join(root, "tests/fixtures/prompt-plan.legacy.json"), "utf8"));
  assert.equal(validatePlan(legacy, { legacy: true }).frames.length, 4);
  const oneFrame = planV3("One", [C]);
  assert.throws(() => validatePlan(oneFrame), /exactly 4/); // without the assignment a plan is still a 4-frame plan
  // present-but-empty Russian fields are an error even in old-style validation
  const p = strictPlan("X");
  (p.concept as { titleRu?: string }).titleRu = "";
  assert.throws(() => validatePlan(p), /titleRu/);
});

test("validateBatch passes the assignment to every plan", () => {
  const a = planV3("A", [C, D]);
  const b = planV3("B", [C, D]);
  assert.equal(validateBatch({ collections: [a, b] }, 2, { models: [C, D] }).length, 2);
  assert.throws(() => validateBatch({ collections: [a, b] }, 2, { models: [D, C] }), /Collection 1.*must be duskrose/s);
  assert.throws(() => validateBatch({ collections: [a, a] }, 2, { models: [C, D] }), /distinct/);
});

test("parseFrames: 1-4, default 4", () => {
  assert.equal(parseFrames(undefined), 4);
  for (const n of [1, 2, 3, 4]) assert.equal(parseFrames(n), n);
  for (const bad of [0, 5, 2.5, "2", -1, NaN]) assert.throws(() => parseFrames(bad), PlanError);
});

test("Codex request: frame count, assigned models, Russian fields; without models it is the old request", () => {
  assert.equal(planPrompt("I", "t", [], 2), planPrompt("I", "t", [], 2, undefined, undefined));
  const p = planPrompt("I", "t", [], 2, undefined, [D, C, D]);
  assert.match(p, /exactly 3 frames/);
  assert.match(p, /- Frame 1: duskrose\n- Frame 2: crimson-oath\n- Frame 3: duskrose/);
  assert.match(p, /titleRu/);
  assert.doesNotMatch(p, /single-frame/);
  assert.match(framesPrompt([C]), /exactly 1 frame\./);
  assert.match(framesPrompt([C]), /single-frame collection.*not the first shot of a series/s);
});

test("generateBatch: ONE Codex process, v3 schema for the requested frames, validated against the assignment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ns14-codex-"));
  const counter = join(dir, "calls.txt");
  const planFile = join(dir, "plan.json");
  await writeFile(planFile, JSON.stringify(planV3("One Frame", [D])));
  const script = `
    const fs = require("fs");
    fs.appendFileSync(process.env.NS_COUNTER, "x");
    const s = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--output-schema") + 1], "utf8"));
    const f = s.properties.collections.items.properties.frames;
    if (f.minItems !== 1 || f.maxItems !== 1 || f.items.properties.model.enum.join() !== "duskrose") process.exit(3);
    const p = JSON.parse(fs.readFileSync(process.env.NS_PLAN, "utf8"));
    fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ collections: [p] }));
    process.stdin.resume(); process.stdin.on("data", () => {});
  `;
  process.env.NS_COUNTER = counter;
  process.env.NS_PLAN = planFile;
  const launcher = { command: process.execPath, args: ["-e", script, "--"] };
  const r = await generateBatch({ count: 1, models: [D], launcher, timeoutMs: 10_000 });
  assert.equal(r.plans[0].frames.length, 1);
  assert.equal((await readFile(counter, "utf8")).length, 1);
  // Codex answering with the wrong model is rejected (no silent fix)
  await writeFile(planFile, JSON.stringify(planV3("One Frame", [C])));
  await assert.rejects(generateBatch({ count: 1, models: [D], launcher: { command: process.execPath, args: ["-e", script.replace("process.exit(3)", "0"), "--"] }, timeoutMs: 10_000 }), /must be duskrose/);
});

// ---------- composition ----------

test("composition follows the real frame count", () => {
  assert.equal(resolveComposition({ global: { pose: "walking" } }, 2).length, 2);
  assert.equal(resolveComposition({}).length, 4); // old calls: 4
  assert.throws(() => parseComposition({ scenes: [{}, {}, {}] }, 2), /3 entries but the collection has only 2 frames/);
  assert.throws(() => parseComposition({ scenes: [{}, {}] }, 1), CompositionError);
  assert.deepEqual(parseComposition({ scenes: [{ pose: "walking" }] }, 1), { scenes: [{ pose: "walking" }] });
  assert.equal(parseComposition({ scenes: [{}, {}, {}, {}] })?.scenes?.length, 4); // frames not given -> 4
  const c = { global: { framing: "waist_up" }, scenes: [{ pose: "kneeling" }, { pose: "walking" }, { pose: "sitting_on_a_chair" }] };
  const text = compositionPrompt(c, 2);
  assert.match(text, /Scene 01/);
  assert.match(text, /Scene 02/);
  assert.doesNotMatch(text, /Scene 03|Scene 04/); // hidden scenes never reach Codex
  assert.doesNotMatch(text, /sitting on a chair/);
  assert.equal(planPrompt("I", "t", [], 1, c, [C]).includes("Scene 02"), false);
});

// ---------- jobs ----------

test("jobs: frames x variations, grouped by model, unique seeds, one prompt per frame, checkpoint per frame", async () => {
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  for (const [models, v] of [[[C], 1], [[C, D], 2], [[D, C, D], 4], [[C, C, D, D], 4]] as [string[], number][]) {
    const plan = planV3("J", models);
    const jobs = buildJobs(plan, base, "j", v);
    assert.equal(jobs.length, models.length * v);
    assert.equal(new Set(jobs.map((j) => j.seed)).size, jobs.length);
    for (const j of jobs) {
      assert.equal(j.graph["90:78"].inputs.unet_name, MODELS[j.model]);
      assert.equal(j.model, models[j.frame - 1]);
      assert.equal(j.graph["90:77"].inputs.text, plan.frames[j.frame - 1].positive);
    }
    // all Crimson Oath jobs run before any Duskrose job (fewer checkpoint switches)
    const order = jobs.map((j) => j.model);
    assert.deepEqual(order, [...order].sort((a, b) => IMAGE_MODELS.findIndex((m) => m.id === a) - IMAGE_MODELS.findIndex((m) => m.id === b)));
  }
  assert.deepEqual(buildJobs(planV3("J", [D, C, D]), base, "j", 1).map((j) => j.frame), [2, 1, 3]);
});

// ---------- API / runner ----------

async function setup(over: { plan?: (o: any) => Promise<any>; wait?: (n: number) => Promise<unknown>; stats?: () => Promise<unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns14-"));
  const batchesDir = await mkdtemp(join(tmpdir(), "ns14-b-"));
  const seen = { plan: [] as any[], submit: [] as { unet: unknown; text: unknown }[], stats: 0 };
  const client = {
    systemStats: async () => {
      seen.stats++;
      return over.stats ? over.stats() : {};
    },
    checkDependencies: async () => [] as string[],
    submit: async (g: any) => {
      seen.submit.push({ unet: g["90:78"].inputs.unet_name, text: g["90:77"].inputs.text });
      return `pid-${seen.submit.length}`;
    },
    waitForImages: async () => {
      if (over.wait) await over.wait(seen.submit.length);
      return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: { note: "h" } };
    },
    download: async () => Buffer.from("png-bytes"),
  };
  const runner = new AutopilotRunner({
    client: client as never,
    plan:
      over.plan ??
      (async (o) => {
        seen.plan.push(o);
        return { plans: Array.from({ length: o.count }, (_, i) => planV3(`Concept ${seen.plan.length}-${i + 1}`, o.models)), raw: "", ms: 1200, tokens: null };
      }),
    baseGraph: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
    collectionsDir: dir,
    batchesDir,
  });
  const app = buildApp({
    runner,
    collectionsDir: dir,
    batchesDir,
    comfyUrl: "http://x",
    port: PORT,
    statusClient: { systemStats: async () => ({ system: { comfyui_version: "9" } }) as never, queue: async () => ({ queue_running: [], queue_pending: [] }) },
  });
  const start = (payload: unknown) => app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: payload as never });
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: H })).json();
  return { dir, batchesDir, app, runner, seen, start, get };
}

test("invalid settings: 400 + INVALID_GENERATION_SETTINGS before ComfyUI and Codex are touched", async () => {
  const { start, seen, runner } = await setup();
  const bad = [
    { frames: 0 },
    { frames: 5 },
    { frames: "3" },
    { frames: 2.5 },
    { collections: 4 },
    { variations: 3 },
    { frames: 2, imageModels: { mode: "custom", perScene: [C] } },
    { frames: 2, imageModels: { mode: "custom", perScene: [C, "gone"] } },
    { imageModels: { mode: "only", model: "gone" } },
    { imageModels: "auto" },
    { frames: 2, composition: { scenes: [{}, {}, {}] } },
    { frames: 1, composition: { scenes: [{}, { pose: "walking" }] } },
    { composition: { global: { pose: "nope" } } },
  ];
  for (const payload of bad) {
    const r = await start(payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.equal(r.json().code, "INVALID_GENERATION_SETTINGS");
    assert.ok(typeof r.json().error === "string" && r.json().error.length > 0);
  }
  assert.equal(seen.stats, 0);
  assert.equal(seen.plan.length, 0);
  assert.equal(runner.active, false);
});

test("old request without new fields: 4 frames with current Auto Mix, Plan v3 requested from Codex", async () => {
  const { start, runner, seen, get, dir, batchesDir } = await setup();
  assert.equal((await start({ theme: "old", collections: 1, variations: 1 })).statusCode, 202);
  await wait(runner);
  assert.deepEqual(seen.plan[0].models, [C, C, D, I]);
  assert.equal(seen.submit.length, 4);
  assert.deepEqual(seen.submit.map((s) => s.unet), [MODELS[C], MODELS[C], MODELS[D], MODELS[I]]);
  assert.equal(runner.state.total, 4);
  const [c] = await get("/api/collections");
  assert.equal(c.frameCount, 4);
  assert.deepEqual(c.generation.imageModels, { mode: "auto", models: [C, C, D, I] });
  const run = (await get("/api/runs"))[0];
  assert.equal(run.frames, 4);
  assert.equal(run.status, "completed");
  assert.equal((await readFile(join(dir, c.id, "scene-04.png"))).toString(), "png-bytes");
  assert.ok((await readFile(join(batchesDir, run.id, "batch-plan.json"), "utf8")).includes('"frames": 4'));
});

test("examples: 1, 2 and 4 frames; counts, models, metadata, CollectionView fields", async () => {
  const cases: { body: any; models: string[]; jobs: number }[] = [
    { body: { collections: 1, frames: 1, variations: 1 }, models: [C], jobs: 1 },
    { body: { collections: 2, frames: 2, variations: 2, imageModels: { mode: "only", model: D } }, models: [D, D], jobs: 8 },
    { body: { collections: 3, frames: 4, variations: 4, imageModels: { mode: "custom", perScene: [C, D, D, C] } }, models: [C, D, D, C], jobs: 48 },
    { body: { collections: 3, frames: 2, variations: 4 }, models: [C, D], jobs: 24 },
  ];
  for (const { body, models, jobs } of cases) {
    const { start, runner, seen, get, batchesDir } = await setup();
    const res = await start({ theme: "garden", ...body, codexModel: undefined });
    assert.equal(res.statusCode, 202);
    assert.equal(res.json().total, jobs);
    await wait(runner);
    assert.equal(runner.state.status, "completed");
    assert.equal(runner.state.done, jobs);
    assert.equal(seen.plan.length, 1); // one Codex call per batch
    assert.deepEqual(seen.plan[0].models, models);
    assert.equal(seen.submit.length, jobs);
    const list = await get("/api/collections");
    assert.equal(list.length, body.collections);
    for (const c of list) {
      assert.equal(c.frameCount, body.frames);
      assert.equal(c.variations, body.variations);
      assert.equal(c.frames.length, body.frames * body.variations);
      assert.ok(c.titleRu.startsWith("Тест"));
      assert.ok(c.descriptionRu);
      assert.ok(c.frames.every((f: any) => f.summaryRu?.startsWith("Кадр") && f.summary));
      assert.deepEqual(c.frames.map((f: any) => f.frame), [...c.frames.map((f: any) => f.frame)].sort((a, b) => a - b)); // gallery order = frame order
      assert.deepEqual(c.frames.filter((f: any) => f.variant === 1).map((f: any) => f.model), models);
      assert.deepEqual(c.generation, { theme: "garden", imageModels: { mode: body.imageModels?.mode ?? "auto", models }, composition: null });
    }
    const batch = JSON.parse(await readFile(join(batchesDir, runner.state.runId!, "batch-plan.json"), "utf8"));
    assert.deepEqual([batch.count, batch.frames, batch.variations], [body.collections, body.frames, body.variations]);
    assert.deepEqual(batch.imageModels.models, models);
    assert.equal(batch.status, "done");
    assert.deepEqual(batch.codex, { seconds: 1.2, tokens: null, model: null, reasoningEffort: null });
  }
});

test("composition: only active frames reach the plan call and the metadata; explicit Codex choice is stored", async () => {
  const { start, runner, seen, batchesDir } = await setup();
  const composition = { global: { framing: "waist_up" }, scenes: [{ pose: "kneeling" }] };
  const r = await start({ frames: 2, composition });
  assert.equal(r.statusCode, 202);
  await wait(runner);
  assert.deepEqual(seen.plan[0].composition, composition);
  const batch = JSON.parse(await readFile(join(batchesDir, runner.state.runId!, "batch-plan.json"), "utf8"));
  assert.deepEqual(batch.composition, [{ framing: "waist_up", pose: "kneeling" }, { framing: "waist_up" }]);
});

test("a run uses an immutable snapshot of its settings", async () => {
  const { runner, seen } = await setup();
  const composition = { global: { pose: "walking" } };
  const images = { mode: "custom" as const, models: [C, D] as ("crimson-oath" | "duskrose")[] };
  await runner.start("t", 1, 1, composition, {}, images);
  composition.global.pose = "kneeling";
  images.models[0] = D;
  await wait(runner);
  assert.deepEqual(seen.plan[0].models, [C, D]);
  assert.deepEqual(seen.plan[0].composition, { global: { pose: "walking" } });
  assert.deepEqual(runner.state.imageModels?.models, [C, D]);
  assert.deepEqual(seen.submit.map((s) => s.unet), [MODELS[C], MODELS[D]]);
});

test("a failed image stops the batch: files kept, prompt_id kept, nothing resubmitted, stable error code, original message", async () => {
  const { start, runner, seen, get, dir, batchesDir } = await setup({
    wait: async (n) => {
      if (n === 3) throw new Error("Generation failed: CUDA out of memory (KSampler)");
    },
  });
  await start({ collections: 2, frames: 2, variations: 2 });
  await wait(runner);
  assert.equal(runner.state.status, "failed");
  assert.equal(runner.state.errorCode, "GENERATION_FAILED");
  assert.equal(runner.state.error, "Generation failed: CUDA out of memory (KSampler)");
  assert.equal(seen.submit.length, 3); // 4th and the whole 2nd collection never sent; the 3rd never repeated
  const [c] = await get("/api/collections");
  assert.equal(c.status, "failed");
  assert.equal(c.doneFrames, 2);
  assert.equal(c.frames.find((f: any) => f.promptId === "pid-3").status, "failed");
  assert.equal((await readFile(join(dir, c.id, "scene-01-v01.png"))).toString(), "png-bytes"); // created files stay
  const run = (await get("/api/runs"))[0];
  assert.deepEqual([run.status, run.errorCode], ["failed", "GENERATION_FAILED"]);
  assert.match(run.error, /CUDA out of memory/);
  assert.equal(run.collectionIds.length, 1);
  assert.equal(JSON.parse(await readFile(join(batchesDir, run.id, "batch-plan.json"), "utf8")).errorCode, "GENERATION_FAILED");
});

test("error codes: Codex, plan validation, ComfyUI unreachable, already running", async () => {
  const codes = async (e: Error) => {
    const { start, runner } = await setup({ plan: async () => Promise.reject(e) });
    await start({});
    await wait(runner);
    return [runner.state.errorCode, runner.state.error];
  };
  assert.deepEqual(await codes(new CodexError("Codex timed out after 5 ms")), ["CODEX_FAILED", "Codex timed out after 5 ms"]);
  assert.deepEqual(await codes(new PlanError("Invalid prompt plan: x")), ["PLAN_INVALID", "Invalid prompt plan: x"]);
  const gone = await setup({ stats: async () => Promise.reject(new Error("ECONNREFUSED")) });
  const r = await gone.start({});
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "COMFY_UNREACHABLE");
  assert.match(r.json().error, /ECONNREFUSED/); // original detail preserved
  const mid = await setup({
    wait: async () => {
      throw new ComfyUnavailableError("ComfyUI not reachable at http://x: fetch failed");
    },
  });
  await mid.start({ frames: 1 });
  await wait(mid.runner);
  assert.equal(mid.runner.state.errorCode, "COMFY_UNREACHABLE");
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const busy = await setup({ wait: () => gate });
  assert.equal((await busy.start({})).statusCode, 202);
  const second = await busy.start({});
  assert.deepEqual([second.statusCode, second.json().code], [409, "ALREADY_RUNNING"]);
  release();
  await wait(busy.runner);
});

// ---------- runs ----------

test("GET /api/runs: newest first, limited, old batch files without new metadata are readable", async () => {
  const { app, batchesDir, runner } = await setup();
  const old = {
    createdAt: "2026-01-02T10:00:00.000Z",
    theme: "legacy",
    count: 2,
    variations: 2,
    composition: null,
    status: "done",
    codex: { seconds: 80, tokens: null, model: null, reasoningEffort: null },
    collectionIds: ["a", "b"],
    plans: [strictPlan("A"), strictPlan("B")],
  };
  await mkdir(join(batchesDir, "2026-01-02-aaa"), { recursive: true });
  await writeFile(join(batchesDir, "2026-01-02-aaa", "batch-plan.json"), JSON.stringify(old));
  await mkdir(join(batchesDir, "2026-01-03-bbb"), { recursive: true });
  await writeFile(join(batchesDir, "2026-01-03-bbb", "batch-plan.json"), JSON.stringify({ ...old, createdAt: "2026-01-03T10:00:00.000Z", status: "running", collectionIds: ["c"] }));
  await mkdir(join(batchesDir, "2026-01-04-broken"), { recursive: true });
  await writeFile(join(batchesDir, "2026-01-04-broken", "batch-plan.json"), "{nope");
  const list = (await app.inject({ method: "GET", url: "/api/runs", headers: H })).json();
  assert.deepEqual(list.map((r: any) => r.id), ["2026-01-03-bbb", "2026-01-02-aaa"]);
  assert.deepEqual(list[1], {
    id: "2026-01-02-aaa",
    createdAt: old.createdAt,
    status: "completed",
    theme: "legacy",
    collections: 2,
    frames: 4,
    variations: 2,
    totalImages: 16,
    imageModels: null,
    collectionIds: ["a", "b"],
    codex: { model: null, reasoningEffort: null, seconds: 80 },
  });
  assert.equal(list[0].status, "interrupted"); // "running" on disk but no run in this process
  assert.equal((await listRuns(batchesDir, 1)).length, 1);
  assert.equal((await app.inject({ method: "GET", url: "/api/runs?limit=1", headers: H })).json().length, 1);
  assert.deepEqual(await listRuns(join(batchesDir, "missing")), []);
  assert.equal(runner.active, false);
});

// ---------- old collections, selection, export ----------

const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`fake-${tag}-` + "x".repeat(200))]);

function readZip(buf: Buffer): { name: string; data: Buffer; method: number }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    out.push({ name, method, data: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Writes a collection folder by hand. frameCount undefined = how collections looked before NS-014. */
async function disk(dir: string, id: string, frames: number, variations: number, frameCount?: number, selections?: Record<string, number>) {
  await mkdir(join(dir, id), { recursive: true });
  const recs = [];
  // execution order is deliberately not frame order
  for (let f = frames; f >= 1; f--) {
    for (let v = 1; v <= variations; v++) {
      const name = variations === 1 ? `scene-0${f}` : `scene-0${f}-v0${v}`;
      recs.push({ frame: f, variant: variations === 1 ? undefined : v, model: D, seed: 1, status: "done", png: `${name}.png` });
      await writeFile(join(dir, id, `${name}.png`), png(name));
    }
  }
  await writeFile(join(dir, id, "collection.json"), JSON.stringify({ title: id, createdAt: "2026-01-01T00:00:00Z", status: "done", dir, variations: variations === 1 ? undefined : variations, frameCount, frames: recs }));
  if (selections) await writeFile(join(dir, id, "selections.json"), JSON.stringify(selections));
}

test("export ZIP for 1, 2, 3 and 4 frames: one original PNG per frame, frame order, exact bytes", async () => {
  const { app, dir } = await setup();
  for (const n of [1, 2, 3, 4]) {
    const id = `z${n}`;
    await disk(dir, id, n, 2, n, Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 2])));
    const res = await app.inject({ method: "GET", url: `/api/collections/${id}/export`, headers: H });
    assert.equal(res.statusCode, 200, id);
    const zip = readZip(res.rawPayload);
    assert.deepEqual(zip.map((z) => z.name), Array.from({ length: n }, (_, i) => `scene-0${i + 1}.png`));
    zip.forEach((z, i) => {
      assert.equal(z.method, 0);
      assert.deepEqual(z.data, png(`scene-0${i + 1}-v02`));
    });
  }
});

test("one frame, one variant needs an explicit Best too; export errors carry EXPORT_INCOMPLETE", async () => {
  const { app, dir, get } = await setup();
  await disk(dir, "single", 1, 1, 1);
  assert.equal((await get("/api/collections/single")).export.ready, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/single/export", headers: H })).statusCode, 409);
  await writeFile(join(dir, "single", "selections.json"), JSON.stringify({ "1": 1 }));
  const one = await get("/api/collections/single");
  assert.deepEqual(one.export, { ready: true, resolved: 1 });
  const ok = await app.inject({ method: "GET", url: "/api/collections/single/export", headers: H });
  assert.deepEqual(readZip(ok.rawPayload).map((z) => z.name), ["scene-01.png"]);
  await disk(dir, "pick", 2, 4, 2, { "1": 3 });
  const pick = await get("/api/collections/pick");
  assert.deepEqual(pick.export, { ready: true, resolved: 1 }); // only the selected frame is exported
  const res = await app.inject({ method: "GET", url: "/api/collections/pick/export", headers: H });
  assert.deepEqual(readZip(res.rawPayload).map((z) => z.name), ["scene-01.png"]);
  await disk(dir, "nopick", 2, 4, 2);
  const np = await app.inject({ method: "GET", url: "/api/collections/nopick/export", headers: H });
  assert.equal(np.statusCode, 409);
  assert.equal(np.json().code, "EXPORT_INCOMPLETE");
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/none/export", headers: H })).json().code, "COLLECTION_NOT_FOUND");
});

test("selection is limited by the collection's frame count; Feedback is untouched", async () => {
  const { app, dir, get } = await setup();
  await disk(dir, "two", 2, 2, 2);
  const put = (url: string, payload: unknown) => app.inject({ method: "PUT", url, headers: H, payload: payload as never });
  assert.equal((await put("/api/collections/two/selection", { frame: 2, variant: 1 })).statusCode, 200);
  const r3 = await put("/api/collections/two/selection", { frame: 3, variant: 1 });
  assert.equal(r3.statusCode, 400);
  assert.equal(r3.json().error, "frame must be 1-2");
  assert.equal(r3.json().code, "INVALID_REQUEST");
  assert.equal((await put("/api/collections/two/feedback", { rating: 4, tags: ["good_composition"], note: "ok" })).statusCode, 200);
  const c = await get("/api/collections/two");
  assert.deepEqual(c.selections, { "2": 1 });
  assert.equal(c.feedback.rating, 4);
});

test("old collections: no frameCount means 4 frames; nothing is rewritten; old four-frame ZIP works as before", async () => {
  const { app, dir, get } = await setup();
  await disk(dir, "legacy", 4, 1, undefined, { "1": 1, "2": 1, "3": 1, "4": 1 });
  const before = await readFile(join(dir, "legacy", "collection.json"), "utf8");
  const c = await get("/api/collections/legacy");
  assert.equal(c.frameCount, 4);
  assert.equal(c.titleRu, undefined);
  assert.equal(c.generation, undefined);
  assert.ok(c.frames.every((f: any) => f.summaryRu === undefined));
  assert.deepEqual(c.frames.map((f: any) => f.frame), [1, 2, 3, 4]); // sorted although stored in another order
  const zip = readZip((await app.inject({ method: "GET", url: "/api/collections/legacy/export", headers: H })).rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-01.png", "scene-02.png", "scene-03.png", "scene-04.png"]);
  await app.inject({ method: "PUT", url: "/api/collections/legacy/feedback", headers: H, payload: { rating: 5 } });
  assert.equal(await readFile(join(dir, "legacy", "collection.json"), "utf8"), before);
});

// ---------- NS-014A: response format and run history ----------

test("planPrompt: Batch Plan format follows generateBatch (also for one collection), Prompt Plan follows generatePlan", async () => {
  // direct builder: default format depends on count, an explicit flag overrides it
  assert.match(planPrompt("I", undefined, [], 1, undefined, [C]), /Return a Prompt Plan/);
  assert.match(planPrompt("I", undefined, [], 2, undefined, [C]), /Return a Batch Plan/);
  assert.match(planPrompt("I", undefined, [], 1, undefined, [C], true), /Return a Batch Plan: JSON \{"collections": \[\.\.\.\]\} with exactly 1 Prompt Plans/);
  assert.doesNotMatch(planPrompt("I", undefined, [], 1, undefined, [C], true), /must be substantially different from each other/);
  // through the real functions: capture the prompt each one sends to Codex (stdin) with a mock launcher
  const dir = await mkdtemp(join(tmpdir(), "ns14a-"));
  const planFile = join(dir, "plan.json");
  const promptFile = join(dir, "prompt.txt");
  await writeFile(planFile, JSON.stringify(planV3("One", [C])));
  const script = `
    const fs = require("fs");
    const a = process.argv, out = a[a.indexOf("-o") + 1];
    const p = JSON.parse(fs.readFileSync(process.env.NS_PLAN, "utf8"));
    const s = JSON.parse(fs.readFileSync(a[a.indexOf("--output-schema") + 1], "utf8"));
    let text = "";
    process.stdin.on("data", (d) => (text += d));
    process.stdin.on("end", () => {
      fs.writeFileSync(process.env.NS_PROMPT, text + " SCHEMA_ROOT_REQUIRED=" + JSON.stringify(s.required));
      fs.writeFileSync(out, JSON.stringify(s.required && s.required[0] === "collections" ? { collections: [p] } : p));
    });
  `;
  process.env.NS_PLAN = planFile;
  process.env.NS_PROMPT = promptFile;
  const launcher = { command: process.execPath, args: ["-e", script, "--"] };
  await generateBatch({ count: 1, models: [C], launcher, timeoutMs: 10_000 });
  const batchPrompt = await readFile(promptFile, "utf8");
  assert.match(batchPrompt, /Return a Batch Plan/);
  assert.match(batchPrompt, /SCHEMA_ROOT_REQUIRED=\["collections"\]/);
  const { generatePlan } = await import("../src/codex.ts");
  await generatePlan({ models: [C], launcher, timeoutMs: 10_000 });
  const planPromptText = await readFile(promptFile, "utf8");
  assert.match(planPromptText, /Return a Prompt Plan/);
  assert.doesNotMatch(planPromptText, /Return a Batch Plan/);
  assert.doesNotMatch(planPromptText, /SCHEMA_ROOT_REQUIRED=\["collections"\]/);
});

for (const [label, err, code] of [
  ["Codex failure", new CodexError("Codex exited with code 1: boom"), "CODEX_FAILED"],
  ["plan validation failure", new PlanError("Invalid prompt plan: frame 2 model must be duskrose"), "PLAN_INVALID"],
] as const) {
  test(`planning failure (${label}): run record exists, status failed, code kept, no ComfyUI jobs, one Codex call`, async () => {
    let calls = 0;
    const s = await setup({
      plan: async () => {
        calls++;
        throw err;
      },
    });
    await s.runner.start("rain", 2, 2, { global: {}, scenes: [] }, { model: "gpt-x" }, { mode: "only", models: [D, D, D] });
    await wait(s.runner);
    assert.equal(calls, 1); // never repeated
    assert.equal(s.seen.submit.length, 0); // nothing reached ComfyUI
    assert.equal(s.runner.state.status, "failed");
    const runs = await s.get("/api/runs");
    assert.equal(runs.length, 1);
    const r = runs[0];
    assert.deepEqual([r.status, r.errorCode, r.error], ["failed", code, err.message]);
    assert.deepEqual([r.theme, r.collections, r.frames, r.variations, r.totalImages], ["rain", 2, 3, 2, 12]);
    assert.deepEqual(r.imageModels, { mode: "only", models: [D, D, D] });
    assert.deepEqual(r.collectionIds, []);
    const file = JSON.parse(await readFile(join(s.batchesDir, r.id, "batch-plan.json"), "utf8"));
    assert.equal(file.status, "failed");
    assert.deepEqual(file.plans, []);
    assert.deepEqual(file.collectionIds, []);
    assert.ok(file.createdAt && "composition" in file);
    assert.equal(file.codex.model, "gpt-x");
    assert.equal(file.codex.seconds, undefined);
    assert.equal(s.runner.state.runId, r.id);
    assert.deepEqual(await s.get("/api/collections"), []); // no collection folders
  });
}

test("planning stage: record is written before Codex is called (status running, empty plans) and completed with plans and metrics afterwards", async () => {
  let seenBefore: any;
  let batchesDir = "";
  const s = await setup({
    plan: async (o) => {
      const [run] = await (await import("../server/runs.ts")).listRuns(batchesDir, 20, s.runner.state.runId);
      seenBefore = { run, file: JSON.parse(await readFile(join(batchesDir, run.id, "batch-plan.json"), "utf8")) };
      return { plans: Array.from({ length: o.count }, (_, i) => planV3(`Done ${i}`, o.models)), raw: "", ms: 2500, tokens: { input: 10, cachedInput: 0, output: 5, total: 15 } };
    },
  });
  batchesDir = s.batchesDir;
  await s.start({ collections: 1, frames: 2, variations: 1 });
  await wait(s.runner);
  assert.equal(seenBefore.run.status, "running");
  assert.equal(seenBefore.file.status, "running");
  assert.deepEqual(seenBefore.file.plans, []);
  assert.deepEqual(seenBefore.file.collectionIds, []);
  assert.deepEqual([seenBefore.file.count, seenBefore.file.frames, seenBefore.file.variations], [1, 2, 1]);
  assert.deepEqual(seenBefore.file.imageModels, { mode: "auto", models: [C, D] });
  assert.equal(seenBefore.file.codex.seconds, undefined);
  // after success: the same record carries plans, metrics and the collection id
  const [run] = await s.get("/api/runs");
  assert.equal(run.id, seenBefore.run.id);
  assert.equal(run.status, "completed");
  assert.equal(run.collectionIds.length, 1);
  assert.equal(run.codex.seconds, 2.5);
  const file = JSON.parse(await readFile(join(s.batchesDir, run.id, "batch-plan.json"), "utf8"));
  assert.equal(file.plans.length, 1);
  assert.equal(file.plans[0].frames.length, 2);
  assert.deepEqual(file.codex.tokens, { input: 10, cachedInput: 0, output: 5, total: 15 });
  assert.equal(s.seen.submit.length, 2);
});
