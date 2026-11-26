// NS-026: Adaptive Pose Selection v1. Local only: mock Codex (a node script) and mock ComfyUI, no GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner, type RunnerDeps } from "../server/runner.ts";
import { poseStats } from "../server/promptEvolution.ts";
import { readCollection } from "../server/collections.ts";
import { batchSchema, generateBatch, loadInstructions, planPrompt, planSchema } from "../src/codex.ts";
import { loadWorkflow } from "../src/comfy.ts";
import { autoMix } from "../src/imageModels.ts";
import { BANNED, FREE_POSE, validatePlan, type PromptPlan } from "../src/promptPlan.ts";
import { loadSource, reserve } from "../src/regenerate.ts";
import { resolveComposition } from "../src/composition.ts";
import {
  PER_SCENE, POSE_PROMPT_MAX, SAMPLE_MAX, SAMPLE_MIN, anatomyCaution, catalogProblems, codexText, compatible, countPoseUses, listedIds,
  loadPoseCatalog, parsePoseMode, posePrompt, sampleSize, selectPoses, type PoseCatalog,
} from "../src/poses.ts";
import { buildStartRequest, defaultForm } from "../web/src/request.ts";
import { planV3 } from "./fixtures/strictPlan.ts";

const H = { host: "127.0.0.1:8787" };
const catalog = loadPoseCatalog();
const tmp = () => mkdtemp(join(tmpdir(), "ns26-"));
const ids = (c: PoseCatalog = catalog) => c.poses.map((p) => p.id);
const select = (o: Partial<Parameters<typeof selectPoses>[0]> = {}) => selectPoses({ catalog, resolved: [], frames: 4, collections: 1, seed: 7, ...o });

// ---------- catalog ----------

test("catalog: valid, 30-40 unique ids, every NS-025 id kept with the same meaning", async () => {
  assert.deepEqual(catalogProblems(catalog), []);
  assert.ok(catalog.poses.length >= 30 && catalog.poses.length <= 40, `size ${catalog.poses.length}`);
  assert.equal(new Set(ids()).size, catalog.poses.length);
  const old = JSON.parse(await readFile(fileURLToPath(new URL("../prompts/experiments/ns-025-pose-catalog.json", import.meta.url)), "utf8")) as { id: string; difficulty: string }[];
  for (const o of old) {
    const p = catalog.poses.find((x) => x.id === o.id);
    assert.ok(p, `${o.id} kept`);
    assert.equal(p.difficulty, o.difficulty, `${o.id} keeps its difficulty`);
  }
  // Not a catalog of props: most poses stand on their own feet or a seat, not on a wall, rail, table or window ledge.
  const propped = catalog.poses.filter((p) => /wall|rail|table|ledge|sill|counter|jamb|doorway/i.test(`${p.support} ${p.hands}`));
  assert.ok(propped.length < catalog.poses.length / 2, `${propped.length} prop-dependent poses`);
  for (const f of ["standing", "seated", "walking", "reclining", "portrait", "rear"]) assert.ok(catalog.poses.some((p) => p.family === f), f);
});

test("catalog: no banned or avoided wording reaches Codex; problems are reported, not ignored", () => {
  for (const p of catalog.poses) {
    const text = codexText(p).toLowerCase();
    for (const w of [...BANNED, "crossed legs", "tilted head", "one leg forward"]) assert.ok(!text.includes(w), `${p.id}: ${w}`);
  }
  const bad = structuredClone(catalog);
  bad.poses[0].hands = "Hand near the camera.";
  bad.poses[1].id = bad.poses[0].id;
  bad.poses[2].views = ["sideways"];
  const errs = catalogProblems(bad).join("\n");
  assert.match(errs, /forbidden phrase "camera"/);
  assert.match(errs, /duplicate id/);
  assert.match(errs, /unknown views id "sideways"/);
});

// ---------- selection ----------

test("selection: 8-12 poses, reproducible for the same seed and history, different seeds differ", () => {
  for (const [frames, collections] of [[1, 1], [4, 1], [4, 2], [4, 3]]) {
    const n = select({ frames, collections }).length;
    assert.equal(n, sampleSize(frames, collections));
    assert.ok(n >= SAMPLE_MIN && n <= SAMPLE_MAX);
  }
  assert.deepEqual(ids({ version: 1, poses: select() }), ids({ version: 1, poses: select() }));
  const seen = new Set([1, 2, 3, 4, 5].map((seed) => ids({ version: 1, poses: select({ seed }) }).join()));
  assert.ok(seen.size > 1);
});

test("selection: a free theme gets several pose families, not one", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const families = new Set(select({ seed }).map((p) => p.family));
    assert.ok(families.size >= 4, `seed ${seed}: ${[...families]}`);
  }
});

test("selection: explicit composition is respected; incompatible poses are never offered", () => {
  const resolved = resolveComposition({ scenes: [{ orientation: "rear_three_quarter_view" }, { pose: "sitting_on_a_chair", framing: "full_body" }, {}, {}] }, 4);
  const s = select({ resolved });
  for (const [i, req] of resolved.slice(0, 2).entries()) {
    const fit = s.filter((p) => compatible(p, req)).length;
    const available = catalog.poses.filter((p) => compatible(p, req)).length;
    assert.ok(fit >= Math.min(PER_SCENE, available), `scene ${i + 1}: ${fit}`);
  }
  // Every frame constrained: a pose that fits none of them is left out.
  const all = resolveComposition({ global: { orientation: "direct_front_view", framing: "head_and_shoulders" } }, 2);
  const only = select({ frames: 2, resolved: all });
  assert.ok(only.length > 0);
  assert.ok(only.every((p) => compatible(p, all[0])));
  // A requirement nothing in the catalog satisfies: the sample is empty and the frame falls back to free invention.
  assert.deepEqual(select({ frames: 1, resolved: resolveComposition({ global: { pose: "crouching" } }, 1) }), []);
});

test("selection: recent use and stable anatomy problems lower priority softly, never ban", () => {
  const appearances = (o: Partial<Parameters<typeof selectPoses>[0]>, id: string) =>
    Array.from({ length: 200 }, (_, seed) => select({ seed, ...o })).filter((s) => s.some((p) => p.id === id)).length;
  const target = "ND-P27";
  const fresh = appearances({}, target);
  const used = appearances({ recent: { [target]: 4 } }, target);
  assert.ok(used < fresh, `${used} < ${fresh}`);
  assert.ok(used > 0, "a recently used pose is still offered sometimes");
  const moderate = catalog.poses.filter((p) => p.difficulty === "moderate").map((p) => p.id);
  const count = (cautious: boolean) => Array.from({ length: 100 }, (_, seed) => select({ seed, cautious })).flat().filter((p) => moderate.includes(p.id)).length;
  assert.ok(count(true) < count(false));
  assert.ok(count(true) > 0);
  assert.equal(anatomyCaution({ negative: [{ tag: "bad_hands", confidence: "low" }] }), false, "one or few dislikes are not a pattern");
  assert.equal(anatomyCaution({ negative: [{ tag: "bad_legs", confidence: "stable" }] }), true);
  assert.equal(anatomyCaution(null), false);
  assert.deepEqual(countPoseUses([{ frames: [{ poseId: "ND-P02" }, { poseId: "free" }, { poseId: "ND-P02" }] }, { frames: [{}] }, null, "junk"]), { "ND-P02": 2 });
});

test("pose block: bounded size, lists exactly the sample, sets the priorities, never asks for ids in prompts", () => {
  const s = select({ frames: 4, collections: 3 });
  const text = posePrompt(s, catalog.version);
  assert.ok(text.length <= POSE_PROMPT_MAX, `${text.length}`);
  assert.deepEqual(listedIds(s, catalog.version), s.map((p) => p.id));
  for (const p of s) assert.ok(text.includes(`- ${p.id}: `));
  assert.match(text, /"free"/);
  assert.match(text, /never write the id/);
  assert.match(text, /hard constraints, then the user's theme and composition requirements, then relevant feedback/);
  assert.match(text, /not tied to frame numbers/);
  for (const w of BANNED) assert.ok(!text.toLowerCase().includes(w), w);
  assert.equal(posePrompt([], 1), "");
  // Worst case: the 12 longest catalog entries still fit completely.
  const longest = [...catalog.poses].sort((a, b) => codexText(b).length - codexText(a).length).slice(0, SAMPLE_MAX);
  assert.deepEqual(listedIds(longest, catalog.version), longest.map((p) => p.id));
});

// ---------- plan contract ----------

const withPoses = (poseIds: (string | undefined)[], models = autoMix(2)): PromptPlan => {
  const p = planV3("Pose Plan", models);
  p.frames.forEach((f, i) => {
    if (poseIds[i] !== undefined) f.poseId = poseIds[i];
  });
  return p;
};

test("plan: poseId must be one of the offered ids or free; unknown ids and ids in prompt text are refused", () => {
  const models = autoMix(2);
  const offered = ["ND-P25", "ND-P02"];
  validatePlan(withPoses(["ND-P25", FREE_POSE]), { models, poseIds: offered });
  validatePlan(withPoses([FREE_POSE, FREE_POSE]), { models, poseIds: offered }); // free fallback
  assert.throws(() => validatePlan(withPoses(["ND-P26", "ND-P02"]), { models, poseIds: offered }), /poseId must be one of the offered/); // real id, not offered
  assert.throws(() => validatePlan(withPoses(["ND-P99", "ND-P02"]), { models, poseIds: offered }), /poseId/);
  assert.throws(() => validatePlan(withPoses([undefined, "ND-P02"]), { models, poseIds: offered }), /poseId/); // missing in auto mode
  const leak = withPoses(["ND-P25", "ND-P02"]);
  leak.frames[0].positive += ", pose ND-P25";
  assert.throws(() => validatePlan(leak, { models, poseIds: offered }), /must not mention a pose id/);
  // Free mode: no poseId (or the explicit free value) only; old plans without it still validate.
  validatePlan(withPoses([]), { models });
  validatePlan(withPoses([FREE_POSE]), { models });
  assert.throws(() => validatePlan(withPoses(["ND-P25"]), { models }), /was not requested/);
});

test("free mode: the Codex request and schema are exactly the pre-NS-026 ones; auto adds the block and a required enum", async () => {
  const instructions = await loadInstructions();
  const models = autoMix(4);
  const before = planPrompt(instructions, "t", [], 1, undefined, models, true, "PREFS", "HIST");
  assert.equal(planPrompt(instructions, "t", [], 1, undefined, models, true, "PREFS", "HIST", ""), before);
  const block = posePrompt(select(), catalog.version);
  const auto = planPrompt(instructions, "t", [], 1, undefined, models, true, "PREFS", "HIST", block);
  assert.ok(auto.indexOf(block) > 0 && auto.indexOf(block) < auto.indexOf("PREFS"), "library before the (higher priority) preferences");
  assert.equal(auto.replace(`\n\n${block}`, ""), before);
  const free = (await planSchema(models)) as { properties: { frames: { items: { properties: Record<string, unknown>; required: string[] } } } };
  assert.equal("poseId" in free.properties.frames.items.properties, false);
  const ok = (await batchSchema(1, undefined, models, ["ND-P01"])) as { properties: { collections: { items: { properties: { frames: { items: { properties: { poseId: { enum: string[] } }; required: string[] } } } } } } };
  const items = ok.properties.collections.items.properties.frames.items;
  assert.deepEqual(items.properties.poseId.enum, ["ND-P01", FREE_POSE]);
  assert.ok(items.required.includes("poseId"));
});

test("API and form: pose mode is explicit; free sends nothing new; unknown values are refused before anything starts", async () => {
  assert.equal(parsePoseMode(undefined), "free");
  assert.equal(parsePoseMode("auto"), "auto");
  assert.throws(() => parsePoseMode("random"));
  const f = defaultForm();
  assert.equal(f.poseMode, "free");
  assert.equal("poseSelection" in buildStartRequest(f), false);
  assert.equal(buildStartRequest({ ...f, poseMode: "auto" }).poseSelection, "auto");
  const e = await env();
  assert.equal((await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { poseSelection: "random" } })).statusCode, 400);
  assert.equal(e.calls.length, 0);
  await e.app.close();
});

// ---------- pipeline (mock Codex + mock ComfyUI) ----------

/** Fake Codex: reads the offered pose ids from the output schema it is given and answers with them (frame 2 = free). */
const FAKE_CODEX = `
  const fs = require("node:fs");
  const [capture, planText, ...args] = process.argv.slice(1);
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
  const pose = schema.properties.collections.items.properties.frames.items.properties.poseId;
  let request = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (request += c));
  process.stdin.on("end", () => {
    fs.appendFileSync(capture, JSON.stringify(request) + "\\n");
    const plan = JSON.parse(planText);
    for (const c of plan.collections) c.frames.forEach((f, i) => { if (pose) f.poseId = i === 1 ? "free" : pose.enum[i]; });
    fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(plan));
  });
`;

async function env(deps: Partial<RunnerDeps> = {}) {
  const dir = await tmp();
  const batchesDir = join(dir, "_batches");
  const capture = join(dir, "requests.jsonl");
  const calls: Record<string, unknown>[] = [];
  const baseGraph = await loadWorkflow(fileURLToPath(new URL("../workflows/anima-crimson-oath.api.json", import.meta.url)));
  const plan = JSON.stringify({ collections: [planV3("Riverside Dusk", autoMix(2))] });
  const launcher = { command: process.execPath, args: ["-e", FAKE_CODEX, "--", capture, plan] };
  let submits = 0;
  const runner = new AutopilotRunner({
    baseGraph,
    plan: async (o) => {
      calls.push(o as unknown as Record<string, unknown>);
      return generateBatch({ ...o, launcher, timeoutMs: 10_000 });
    },
    client: {
      systemStats: async () => ({ system: { comfyui_version: "mock" }, devices: [] }),
      checkDependencies: async () => [],
      submit: async () => `mock-${++submits}`,
      waitForImages: async () => ({ images: [{ filename: "x.png", subfolder: "", type: "output" }], history: {} }),
      download: async () => Buffer.from("png"),
    } as never,
    collectionsDir: dir,
    batchesDir,
    poseSeed: () => 42,
    ...deps,
  });
  const app = buildApp({ runner, collectionsDir: dir, batchesDir, comfyUrl: "http://x", port: 8787 });
  const settle = async () => {
    while (runner.active) await new Promise((r) => setTimeout(r, 5));
  };
  const requests = async () => (await readFile(capture, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);
  const batch = async () => JSON.parse(await readFile(join(batchesDir, (await readdir(batchesDir))[0], "batch-plan.json"), "utf8"));
  const collection = async () => (await readdir(dir)).find((n) => !n.startsWith("_") && n !== "requests.jsonl")!;
  return { dir, app, runner, calls, settle, requests, batch, collection, submits: () => submits };
}

test("auto mode end to end: ONE Codex call, the sample and seed in batch-plan.json, poseId on frames, variants and sidecars", async () => {
  const e = await env();
  const res = await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 2, variations: 2, poseSelection: "auto" } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().poseSelection, "auto");
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  const reqs = await e.requests();
  assert.equal(reqs.length, 1, "one planning request for the batch");
  assert.equal(e.calls.length, 1);
  const b = await e.batch();
  assert.equal(b.poseSelection.mode, "auto");
  assert.equal(b.poseSelection.seed, 42);
  assert.equal(b.poseSelection.catalogVersion, catalog.version);
  assert.ok(b.poseSelection.sample.length >= SAMPLE_MIN);
  for (const id of b.poseSelection.sample) assert.ok(reqs[0].includes(`- ${id}: `), `${id} listed in the request`);
  const id = await e.collection();
  const manifest = JSON.parse(await readFile(join(e.dir, id, "collection.json"), "utf8"));
  assert.deepEqual(manifest.generation.pose, { mode: "auto", catalogVersion: catalog.version });
  const plan = JSON.parse(await readFile(join(e.dir, id, "prompt-plan.json"), "utf8")) as PromptPlan;
  assert.equal(plan.frames[0].poseId, b.poseSelection.sample[0]);
  assert.equal(plan.frames[1].poseId, FREE_POSE);
  for (const f of manifest.frames) {
    assert.deepEqual(f.pose, { id: plan.frames[f.frame - 1].poseId, catalogVersion: catalog.version, verified: true }, `frame ${f.frame} v${f.variant} inherits`);
    const side = JSON.parse(await readFile(join(e.dir, id, f.png.replace(".png", ".json")), "utf8"));
    assert.deepEqual(side.pose, f.pose);
  }
  // The gallery shows a human-readable name, never the bare id.
  const view = (await e.app.inject({ method: "GET", url: `/api/collections/${id}`, headers: H })).json();
  const first = view.frames.find((f: { frame: number }) => f.frame === 1);
  assert.equal(first.pose.label, catalog.poses.find((p) => p.id === plan.frames[0].poseId)!.nameRu);
  assert.equal(view.frames.find((f: { frame: number }) => f.frame === 2).pose.label, undefined);
  assert.equal(e.submits(), 4);

  // Targeted regeneration: same prompt keeps the verified pose; an edited prompt keeps provenance but is no longer verified.
  const same = await reserve(e.dir, id, await loadSource(e.dir, id, 1, 1), undefined);
  assert.deepEqual(same.record.pose, { id: plan.frames[0].poseId, catalogVersion: catalog.version, verified: true });
  const src = await loadSource(e.dir, id, 1, 1);
  const edited = await reserve(e.dir, id, src, `${src.positive}, holding a red umbrella`);
  assert.deepEqual(edited.record.pose, { id: plan.frames[0].poseId, catalogVersion: catalog.version, verified: false });
  const side = JSON.parse(await readFile(join(e.dir, id, `${edited.name}.json`), "utf8"));
  assert.equal(side.pose.verified, false);
  await e.app.close();
});

test("free mode end to end: the request, the batch record and the frames are exactly as before NS-026", async () => {
  const e = await env();
  await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 2 } });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  assert.equal("poses" in e.calls[0], false);
  assert.equal(e.runner.state.poseSelection, undefined);
  const [req] = await e.requests();
  assert.doesNotMatch(req, /Pose library|ND-P\d{2}|poseId/);
  const b = await e.batch();
  assert.equal("poseSelection" in b, false);
  const id = await e.collection();
  const manifest = JSON.parse(await readFile(join(e.dir, id, "collection.json"), "utf8"));
  assert.equal("pose" in manifest.generation, false);
  for (const f of manifest.frames) assert.equal("pose" in f, false);
  const plan = JSON.parse(await readFile(join(e.dir, id, "prompt-plan.json"), "utf8"));
  for (const f of plan.frames) assert.equal("poseId" in f, false);
  const src = await loadSource(e.dir, id, 1, 1);
  assert.equal(src.pose, undefined);
  assert.equal("pose" in (await reserve(e.dir, id, src, undefined)).record, false);
  await e.app.close();
});

test("history: recent poseIds from saved plans lower the next sample's priority and are recorded", async () => {
  const e = await env();
  const old = join(e.dir, "2026-01-01-old");
  await (await import("node:fs/promises")).mkdir(old, { recursive: true });
  await writeFile(join(old, "collection.json"), JSON.stringify({ title: "Old", createdAt: "2026-01-01T00:00:00Z", status: "done", dir: old, frames: [], frameCount: 2 }));
  await writeFile(join(old, "prompt-plan.json"), JSON.stringify(withPoses(["ND-P25", "ND-P25"])));
  await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 2, poseSelection: "auto" } });
  await e.settle();
  assert.deepEqual((await e.batch()).poseSelection.recent, { "ND-P25": 2 });
  await e.app.close();
});

test("old collections: no pose anywhere, nothing breaks, nothing is rewritten", async () => {
  const dir = await tmp();
  const id = "2025-01-01-legacy";
  const d = join(dir, id);
  await (await import("node:fs/promises")).mkdir(d, { recursive: true });
  const manifest = JSON.stringify({ title: "Legacy", createdAt: "2025-01-01T00:00:00Z", status: "done", dir: d, frames: [{ frame: 1, model: "crimson-oath", seed: 1, status: "done", png: "scene-01.png" }] });
  await writeFile(join(d, "collection.json"), manifest);
  await writeFile(join(d, "scene-01.png"), "x");
  const view = await readCollection(dir, id);
  assert.equal(view!.frames[0].pose, undefined);
  assert.equal(await readFile(join(d, "collection.json"), "utf8"), manifest);
  // a malformed pose record is ignored, not trusted
  await writeFile(join(d, "collection.json"), manifest.replace('"png"', '"pose":{"id":5},"png"'));
  assert.equal((await readCollection(dir, id))!.frames[0].pose, undefined);
});

test("Prompt Evolution: per-pose feedback keeps problem kinds apart and ignores unverified links; it is never sent to Codex", () => {
  const c = (id: string) => ({ id }) as never;
  const img = (poseId: string | undefined, collection: string, verdict: "like" | "dislike" | undefined, tags: string[], best = false, net = 0) => ({ poseId, collection: c(collection), verdict, tags, best, net });
  const stats = poseStats([
    img("ND-P25", "a", "dislike", ["bad_hands"]),
    img("ND-P25", "b", "dislike", ["bad_legs", "bad_angle"]),
    img("ND-P25", "b", "like", ["natural_pose"], true, 1),
    img("ND-P25", "c", undefined, [], false, 0), // no signal
    img(undefined, "a", "dislike", ["awkward_pose"]), // unverified (edited prompt) or free: not counted
    img("ND-P02", "a", "dislike", ["composition", "body_proportions"]),
  ]);
  assert.deepEqual(stats.find((s) => s.poseId === "ND-P25"), {
    poseId: "ND-P25", images: 3, collections: 2, likes: 1, dislikes: 2, best: 1, arenaPreferred: 1,
    issues: { hands: 1, legs: 1, body: 0, angle: 1, composition: 0 },
  });
  assert.deepEqual(stats.find((s) => s.poseId === "ND-P02")!.issues, { hands: 0, legs: 0, body: 1, angle: 0, composition: 1 });
  assert.equal(stats.length, 2);
});

test("with Prompt Evolution: one request carries the library and the preferences (preferences rank higher); stable anatomy dislikes make the sample cautious", async () => {
  const memory = { status: "ready", negative: [{ tag: "bad_hands", count: 4, independent: 4, collections: 2, confidence: "stable" }] };
  const e = await env({ preferenceContext: (async () => ({ memory, text: "PERSONAL ARTISTIC PREFERENCES: prefer readable hands." })) as never });
  await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 2, poseSelection: "auto", promptEvolution: true } });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  const reqs = await e.requests();
  assert.equal(reqs.length, 1);
  const lib = reqs[0].indexOf("Pose library");
  const prefs = reqs[0].indexOf("PERSONAL ARTISTIC PREFERENCES");
  assert.ok(lib > 0 && prefs > lib, "both blocks, preferences after the library");
  assert.match(reqs[0], /then relevant feedback from the preference notes/);
  assert.equal((await e.batch()).poseSelection.cautious, true);
  await e.app.close();
});
