// NS-027 Stage B: local Depth library, per-frame decision, graph insertion/removal, metadata, regeneration, Crimson Oath v0.3.
// Codex and ComfyUI are mocked: no real Codex call, no GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../server/app.ts";
import { readCollection } from "../server/collections.ts";
import { poseStats } from "../server/promptEvolution.ts";
import { AutopilotRunner, RunError, type RunnerDeps } from "../server/runner.ts";
import { batchSchema, planSchema } from "../src/codex.ts";
import { DEPTH_NODES, FIELDS, MODELS, applyDepth, applyParams, boosterOff, depthOf, graphImageSize, loadWorkflow, removeDepth, type Graph } from "../src/comfy.ts";
import { DEPTH_REASONS, parseDepthMode, promptMismatch, readConditioning, readPrompt, type DepthReason, type DepthSpec } from "../src/depth.ts";
import { COMFY_SUBFOLDER, comfyName, decideFrame, loadDepthLibrary, pngSize, safeMapPath, type DepthEnvironment, type LibraryResult } from "../src/depthLibrary.ts";
import { AUTO_MIX_MODELS, IMAGE_MODELS, MODEL_IDS, autoMix, resolveImageModels } from "../src/imageModels.ts";
import { loadPoseCatalog } from "../src/poses.ts";
import { validatePlan, type PromptPlan } from "../src/promptPlan.ts";
import { assignModels, modelName } from "../web/src/models.ts";
import { buildStartRequest, defaultForm } from "../web/src/request.ts";
import { H } from "./fixtures/reliability.ts";

const catalog = loadPoseCatalog();
const tmp = () => mkdtemp(join(tmpdir(), "ns27-"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const base: Graph = await loadWorkflow(fileURLToPath(new URL("../workflows/anima-crimson-oath.api.json", import.meta.url)));
const V02 = "crimson-oath";
const V03 = "crimson-oath-v03";

/** A PNG header with the given size (the library reads only the header; the bytes make the hash unique). */
function png(w: number, h: number, salt = "map"): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(salt)]);
}

/** The Stage A prompt (Creative Director house format, ND-P25, front three-quarter, head to mid-thigh). */
const GOOD = [
  "realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, intricate details, cinematic dramatic lighting, strong chiaroscuro,",
  "solo female, adult woman, 32 years old, original character, mature face, adult body, huge breast,",
  "heart-shaped face, warm beige skin, dark brown eyes, softly arched brows, glossy black hair in a sleek chin-length bob with a deep side part, calm confident expression, glossy semi-realistic illustration, natural anatomy,",
  "standing in a relaxed contrapposto with her weight on one leg, hips and shoulders at gentle opposite angles, her right hand resting flat on her hip with the fingers together and the elbow out, a clear gap between the bent elbow and her waist, her left arm hanging loosely at her side with soft relaxed fingers, head level, looking at the viewer,",
  "deep burgundy velvet wrap dress with long fitted sleeves and a modest V neckline, thin gold belt at the waist, small gold hoop earrings,",
  "art deco hotel bar at night, brass-framed mirrors and a dark walnut counter softly blurred behind her, amber globe lamps,",
  "front three-quarter view from head to mid-thigh, eye level, warm amber lamp light across her face and the velvet folds, cool teal reflections in the mirrors behind her",
].join("\n\n");
const blocks = (i: number, text: string) => GOOD.split("\n\n").map((b, j) => (j === i ? text : b)).join("\n\n");
const withPose = (text: string) => blocks(3, text);
const withView = (text: string) => blocks(6, text);

const SPEC: DepthSpec = { views: ["front_three_quarter_view"], crops: ["head_to_mid_thigh"], viewpoints: ["eye_level"], poses: ["standing_with_weight_on_one_leg", "standing_naturally"], posture: "standing", handOnHip: { anatomical: "right", image: "left" } };

function entry(over: Record<string, unknown> = {}) {
  return {
    id: "nd-p25-fq-h2mt-01", poseId: "ND-P25", file: "maps/nd-p25.png", sha256: "", size: [1440, 2176],
    views: ["front_three_quarter_view"], crops: ["head_to_mid_thigh"], viewpoints: ["eye_level"], poses: ["standing_with_weight_on_one_leg", "standing_naturally"],
    posture: "standing", handOnHip: { anatomical: "right", image: "left" }, models: [V02, "duskrose", "illustrijn"],
    depth: { strength: 1, startPercent: 0, endPercent: 1 }, smoothBooster: false, status: "verified", evidence: "NS-027 Stage A",
    provenance: { database: "test", terms: "local only" },
    ...over,
  };
}
const ADAPTER = { file: "anima-lllite-depth-1.safetensors", sha256: "81357e51cd59874b4fbdda1eb3117aa73eafe36cc7efb9cf80a152d6bc8d0602", localCopy: "E:/x/anima-lllite-depth-1.safetensors" };

/** A library folder with the given maps (files written from `files`: path -> buffer). */
async function library(maps: Record<string, unknown>[], files: Record<string, Buffer> = {}, adapter: unknown = ADAPTER) {
  const dir = await tmp();
  await mkdir(join(dir, "maps"), { recursive: true });
  for (const [p, b] of Object.entries(files)) await writeFile(join(dir, p), b);
  await writeFile(join(dir, "library.json"), JSON.stringify({ version: 1, adapter, maps }));
  return dir;
}
const MAP = png(1440, 2176);
async function goodLibrary(over: Record<string, unknown> = {}) {
  return library([entry({ sha256: sha(MAP), ...over })], { "maps/nd-p25.png": MAP });
}
const ENV_OK: DepthEnvironment = { nodes: true, adapter: true };
const frame = (o: Partial<Parameters<typeof decideFrame>[0]> = {}) => ({ poseId: "ND-P25", model: V02, positive: GOOD, requirements: {}, graph: applyParams(base, { positive: GOOD, seed: 1 }), ...o });

// ---------- library ----------

test("library: the verified entry loads; every bad entry is excluded on its own with the reason", async () => {
  const small = png(896, 1152, "small");
  const dir = await library(
    [
      entry({ sha256: sha(MAP) }),
      entry({ id: "bad-hash", sha256: "0".repeat(64) }),
      entry({ id: "bad-size", file: "maps/small.png", sha256: sha(small) }),
      entry({ id: "traversal", file: "../outside.png", sha256: sha(MAP) }),
      entry({ id: "absolute", file: "C:/maps/nd-p25.png", sha256: sha(MAP) }),
      entry({ id: "backslash", file: "maps\\nd-p25.png", sha256: sha(MAP) }),
      entry({ id: "no-file", file: "maps/missing.png", sha256: sha(MAP) }),
      entry({ id: "unknown-pose", poseId: "ND-P99", sha256: sha(MAP) }),
      entry({ id: "rear-view", views: ["rear_three_quarter_view"], sha256: sha(MAP) }),
      entry({ id: "unknown-model", models: ["nope"], sha256: sha(MAP) }),
      entry({ id: "strength", depth: { strength: 0, startPercent: 0, endPercent: 1 }, sha256: sha(MAP) }),
      entry({ id: "range", depth: { strength: 1, startPercent: 0.8, endPercent: 0.2 }, sha256: sha(MAP) }),
      entry({ id: "booster", smoothBooster: true, sha256: sha(MAP) }),
      entry({ id: "status", status: "approved", sha256: sha(MAP) }),
      entry({ id: "hand", handOnHip: { anatomical: "right" }, sha256: sha(MAP) }),
      entry({ id: "Bad ID", sha256: sha(MAP) }),
      entry({ id: "dup", sha256: sha(MAP) }),
      entry({ id: "dup", sha256: sha(MAP) }),
    ],
    { "maps/nd-p25.png": MAP, "maps/small.png": small },
  );
  const r = loadDepthLibrary(dir, catalog);
  assert.ok(r.ok);
  assert.deepEqual(r.library.maps.map((m) => m.id), ["nd-p25-fq-h2mt-01"]);
  const why = (id: string) => r.library.excluded.filter((x) => x.id === id).map((x) => x.problem).join(" | ");
  assert.match(why("bad-hash"), /sha256 does not match/);
  assert.match(why("bad-size"), /PNG is 896x1152/);
  for (const id of ["traversal", "absolute", "backslash"]) assert.match(why(id), /inside the library folder/, id);
  assert.match(why("no-file"), /file not found/);
  assert.match(why("unknown-pose"), /unknown poseId/);
  assert.match(why("rear-view"), /views must be a subset/);
  assert.match(why("unknown-model"), /known image model/);
  assert.match(why("strength"), /out of range/);
  assert.match(why("range"), /out of range/);
  assert.match(why("booster"), /smoothBooster/);
  assert.match(why("status"), /status/);
  assert.match(why("hand"), /handOnHip/);
  assert.match(why("Bad ID"), /id must be/);
  assert.equal(r.library.excluded.filter((x) => x.id === "dup").length, 2, "both duplicates excluded");
});

test("library: missing library.json or a bad adapter record makes the whole library unavailable", async () => {
  assert.equal(loadDepthLibrary(join(await tmp(), "none"), catalog).ok, false);
  for (const adapter of [{ file: "../x.safetensors", sha256: ADAPTER.sha256 }, { file: ADAPTER.file, sha256: "abc" }, null]) {
    const r = loadDepthLibrary(await library([], {}, adapter), catalog);
    assert.equal(r.ok, false, JSON.stringify(adapter));
  }
});

test("library paths: nothing resolves outside the library folder (.., absolute, backslash, odd names, symlinks)", async () => {
  const dir = await goodLibrary();
  assert.ok(safeMapPath(dir, "maps/nd-p25.png"));
  for (const p of ["../x.png", "maps/../../x.png", "/etc/x.png", "C:/x.png", "maps\\x.png", "maps/x.jpg", "maps/./x.png", "", 5, null]) assert.equal(safeMapPath(dir, p), null, String(p));
  const outside = await tmp();
  await writeFile(join(outside, "evil.png"), MAP);
  try {
    await symlink(join(outside, "evil.png"), join(dir, "maps", "link.png"));
  } catch {
    return; // creating symlinks needs extra rights on Windows: the lstat check is still covered when it can be created
  }
  assert.equal(safeMapPath(dir, "maps/link.png"), null);
});

test("pngSize reads the IHDR size and rejects non-PNG data", () => {
  assert.deepEqual(pngSize(png(1440, 2176)), [1440, 2176]);
  assert.equal(pngSize(Buffer.from("not a png at all, really not")), null);
});

// ---------- per-frame decision ----------

test("decision: the approved map fits the Stage A frame on Crimson Oath v0.2, Duskrose and IllustrijN; v0.3 does not inherit it", async () => {
  const lib = loadDepthLibrary(await goodLibrary(), catalog);
  for (const model of [V02, "duskrose", "illustrijn"]) {
    const d = decideFrame(frame({ model, graph: applyParams(base, { positive: GOOD, seed: 1, unet: MODELS[model as keyof typeof MODELS] }) }), lib, ENV_OK);
    assert.ok(d.ok, model);
  }
  const v03 = decideFrame(frame({ model: V03 }), lib, ENV_OK);
  assert.deepEqual(v03.ok ? null : v03.reason, "model-not-compatible");
});

test("decision: every reason for text-only generation is reachable and reported", async () => {
  const lib = loadDepthLibrary(await goodLibrary(), catalog);
  const candidate = loadDepthLibrary(await goodLibrary({ status: "candidate" }), catalog);
  const experimental = loadDepthLibrary(await goodLibrary({ poseId: "ND-P26", status: "experimental", views: ["rear_three_quarter_view"], id: "nd-p26-x" }), catalog);
  const broken = loadDepthLibrary(await library([entry({ sha256: "1".repeat(64) })], { "maps/nd-p25.png": MAP }), catalog);
  const unavailable: LibraryResult = { ok: false, error: "no library" };
  const booster = applyParams(base, { positive: GOOD, seed: 1 });
  booster["90:89"].inputs.value = true;
  const small = applyParams(base, { positive: GOOD, seed: 1, megapixels: 1 });
  const cases: [string, ReturnType<typeof decideFrame>, DepthReason][] = [
    ["free", decideFrame(frame({ poseId: "free" }), lib, ENV_OK), "free-pose"],
    ["no pose", decideFrame(frame({ poseId: undefined }), lib, ENV_OK), "no-pose"],
    ["library", decideFrame(frame(), unavailable, null), "library-unavailable"],
    ["no map", decideFrame(frame({ poseId: "ND-P01" }), lib, ENV_OK), "no-map"],
    ["invalid", decideFrame(frame(), broken, ENV_OK), "map-invalid"],
    ["candidate", decideFrame(frame(), candidate, ENV_OK), "map-not-verified"],
    ["experimental ND-P26", decideFrame(frame({ poseId: "ND-P26" }), experimental, ENV_OK), "map-not-verified"],
    ["model", decideFrame(frame({ model: V03 }), lib, ENV_OK), "model-not-compatible"],
    ["booster", decideFrame(frame({ graph: booster }), lib, ENV_OK), "booster-untested"],
    ["size", decideFrame(frame({ graph: small }), lib, ENV_OK), "size-mismatch"],
    ["unstructured", decideFrame(frame({ positive: "standing woman, front three-quarter view, head to mid-thigh" }), lib, ENV_OK), "prompt-unstructured"],
    ["required pose", decideFrame(frame({ requirements: { pose: "sitting_on_a_chair" } }), lib, ENV_OK), "pose-mismatch"],
    ["seated prompt", decideFrame(frame({ positive: withPose("sitting on a velvet stool, one hand resting on her knee, looking at the viewer,") }), lib, ENV_OK), "pose-mismatch"],
    ["no posture", decideFrame(frame({ positive: withPose("her right hand resting flat on her hip, looking at the viewer,") }), lib, ENV_OK), "pose-unclear"],
    ["direct front", decideFrame(frame({ positive: withView("direct front view from head to mid-thigh, eye level, warm light") }), lib, ENV_OK), "view-mismatch"],
    ["required rear", decideFrame(frame({ requirements: { orientation: "rear_three_quarter_view" } }), lib, ENV_OK), "view-mismatch"],
    ["3/4 + glance back", decideFrame(frame({ positive: withPose("standing with her weight on one leg, glancing back over her shoulder, right hand on her hip,") .replace("front three-quarter view", "three-quarter view") }), lib, ENV_OK), "view-unclear"],
    ["full body", decideFrame(frame({ positive: withView("front three-quarter view, full body, eye level, warm light") }), lib, ENV_OK), "crop-mismatch"],
    ["required knee-up", decideFrame(frame({ requirements: { framing: "knee_up" } }), lib, ENV_OK), "crop-mismatch"],
    ["no shot size", decideFrame(frame({ positive: withView("front three-quarter view, eye level, warm light") }), lib, ENV_OK), "crop-unclear"],
    ["elevated", decideFrame(frame({ positive: withView("slightly elevated front three-quarter view, head-to-mid-thigh composition, warm light") }), lib, ENV_OK), "viewpoint-mismatch"],
    ["required high angle", decideFrame(frame({ requirements: { viewpoint: "high_angle" } }), lib, ENV_OK), "viewpoint-mismatch"],
    ["left hand", decideFrame(frame({ positive: GOOD.replace("her right hand resting", "her left hand resting").replace("her left arm hanging", "her right arm hanging") }), lib, ENV_OK), "hand-side-conflict"],
    ["both sides", decideFrame(frame({ positive: GOOD.replace("her left arm hanging loosely at her side", "her left hand also resting on her hip") }), lib, ENV_OK), "hand-side-ambiguous"],
    ["nodes", decideFrame(frame(), lib, { nodes: false, adapter: false }), "nodes-unavailable"],
    ["adapter", decideFrame(frame(), lib, { nodes: true, adapter: false }), "adapter-unavailable"],
  ];
  for (const [name, d, reason] of cases) assert.deepEqual(d.ok ? "applied" : d.reason, reason, name);
  // composition-conflict needs a map that allows two values: the user picked one, the prompt says the other.
  const wide: DepthSpec = { ...SPEC, crops: ["head_to_mid_thigh", "knee_up"] };
  assert.equal(promptMismatch(wide, GOOD, { framing: "knee_up" })?.reason, "composition-conflict");
  assert.equal(promptMismatch(wide, GOOD, { framing: "head_to_mid_thigh" }), null);
  const seen = new Set<string>([...cases.map((c) => c[2]), "composition-conflict", "upload-failed" /* runner test below */]);
  assert.deepEqual(DEPTH_REASONS.filter((r) => !seen.has(r)), []);
});

test("prompt reading: an ambiguous three-quarter view is not taken as the front view when other cues point elsewhere", () => {
  assert.equal(readPrompt(GOOD).view, "front_three_quarter_view");
  assert.equal(readPrompt(withView("three-quarter view from head to mid-thigh, warm light")).view, "front_three_quarter_view", "a bare three-quarter view with no other cue");
  assert.equal(readPrompt(withView("rear three-quarter view from head to mid-thigh, warm light")).view, "rear_three_quarter_view");
  for (const cue of ["her back turned to the viewer", "looking back over her shoulder", "facing away toward the city", "seen in profile"]) {
    const p = withPose(`standing with her weight on one leg, ${cue}, right hand on her hip,`).replace("front three-quarter view", "three-quarter view");
    assert.equal(readPrompt(p).view, null, cue);
  }
  // clothing and light that only sound like composition do not count
  assert.equal(readPrompt(GOOD.replace("small gold hoop earrings", "a skirt ending mid-thigh, full-length silk gloves")).crop, "head_to_mid_thigh");
  assert.equal(readPrompt(GOOD.replace("sleek chin-length bob", "long waves falling over one shoulder")).view, "front_three_quarter_view");
  assert.equal(readPrompt(withView("front three-quarter view from slightly above, head to mid-thigh")).viewpoint, "other");
  assert.equal(readPrompt(withView("front three-quarter view from head to mid-thigh, knee-up framing")).crop, null, "two shot sizes");
});

test("hand side: unspecified lets the map decide; the same side passes; an opposite or contradictory side means text-only", () => {
  const pose = (t: string) => withPose(`standing in a relaxed contrapposto, ${t}, looking at the viewer,`);
  const r = (t: string) => promptMismatch(SPEC, pose(t))?.reason ?? null;
  assert.equal(r("one hand on her hip with the elbow out, the other arm loose"), null, "no side: the map decides");
  assert.equal(r("her right hand on her hip"), null);
  assert.equal(r("her left arm hanging loosely at her side, one hand on her hip"), null, "the hanging left arm implies the right hand");
  assert.equal(r("hand on hip on the left side of the image"), null, "picture side matches the map");
  assert.equal(r("her left hand on her hip"), "hand-side-conflict");
  assert.equal(r("her right arm hanging loosely by her side, one hand on her hip"), "hand-side-conflict");
  assert.equal(r("hand on hip on the right side of the image"), "hand-side-conflict");
  assert.equal(r("both hands on her hips"), "hand-side-conflict");
  assert.equal(r("her right hand on her hip, her left hand on her waist"), "hand-side-ambiguous");
});

// ---------- graph ----------

test("graph: Depth nodes go into a copy between the model switch and KSampler; removing them restores the original link", () => {
  const job = applyParams(base, { positive: GOOD, seed: 7 });
  const before = structuredClone(job);
  const baseBefore = JSON.stringify(base);
  const g = applyDepth(job, { image: `${COMFY_SUBFOLDER}/m.png`, adapter: ADAPTER.file, strength: 1, startPercent: 0, endPercent: 1 });
  assert.deepEqual(job, before, "input graph untouched");
  assert.equal(JSON.stringify(base), baseBefore, "base workflow untouched");
  assert.deepEqual(g[FIELDS.seed.node].inputs.model, [DEPTH_NODES.apply, 0]);
  assert.deepEqual(g[DEPTH_NODES.apply], {
    class_type: "AnimaLLLiteApply",
    inputs: { model: ["90:84", 0], model_patch: [DEPTH_NODES.patch, 0], image: [DEPTH_NODES.image, 0], strength: 1, start_percent: 0, end_percent: 1 },
  });
  assert.deepEqual(g[DEPTH_NODES.image], { class_type: "LoadImage", inputs: { image: `${COMFY_SUBFOLDER}/m.png` } });
  assert.deepEqual(g[DEPTH_NODES.patch], { class_type: "ModelPatchLoader", inputs: { name: ADAPTER.file } });
  assert.equal(Object.keys(g).length, Object.keys(job).length + 3);
  assert.deepEqual(depthOf(g), { apply: DEPTH_NODES.apply, image: DEPTH_NODES.image, imageName: `${COMFY_SUBFOLDER}/m.png`, patch: DEPTH_NODES.patch, adapter: ADAPTER.file });
  assert.deepEqual(removeDepth(g), job, "drop restores exactly the original graph");
  assert.throws(() => applyDepth(g, { image: "x", adapter: "y", strength: 1, startPercent: 0, endPercent: 1 }), /already has Depth/);
  assert.throws(() => removeDepth(job), /no Depth nodes/);
  assert.equal(depthOf(job), null);
  assert.deepEqual(graphImageSize(base), [1440, 2176], "production size: 2:3, 3 MP, multiple 20");
  assert.equal(boosterOff(base), true);
});

test("graph: removing Depth also works on a graph saved with other node ids (Stage A layout)", () => {
  const job = applyParams(base, { positive: GOOD, seed: 7 });
  const g = structuredClone(job);
  g["92"] = { class_type: "LoadImage", inputs: { image: "map.png" } };
  g["93"] = { class_type: "ModelPatchLoader", inputs: { name: ADAPTER.file } };
  g["94"] = { class_type: "AnimaLLLiteApply", inputs: { model: ["90:84", 0], model_patch: ["93", 0], image: ["92", 0], strength: 1, start_percent: 0, end_percent: 1 } };
  g["90:76"].inputs.model = ["94", 0];
  assert.deepEqual(removeDepth(g), job);
});

// ---------- runner end to end (mock Codex, mock ComfyUI) ----------

function planWith(frames: { model: string; poseId?: string; positive: string }[]): PromptPlan {
  return {
    concept: { title: "Velvet Bar", titleRu: "Бархатный бар", description: "A test.", descriptionRu: "Тест.", heroine: "test" },
    frames: frames.map((f, i) => ({ frame: i + 1, model: f.model as never, summary: `Shot ${i + 1}`, summaryRu: `Кадр ${i + 1}`, positive: f.positive, ...(f.poseId ? { poseId: f.poseId } : {}) })),
  };
}

interface Fake {
  uploads: { name: string; subfolder: string; bytes: number }[];
  submits: Graph[];
  infoCalls: number;
  images: string[];
  adapter: boolean;
  uploadFails: boolean;
}
function fakeClient(f: Fake) {
  let n = 0;
  return {
    systemStats: async () => ({ system: { comfyui_version: "mock" }, devices: [] }),
    checkDependencies: async () => [],
    submit: async (g: Graph) => {
      f.submits.push(structuredClone(g));
      return `p-${++n}`;
    },
    waitForImages: async () => ({ images: [{ filename: "x.png", subfolder: "", type: "output" }], history: {} }),
    download: async () => Buffer.from("png"),
    objectInfo: async () => {
      f.infoCalls++;
      return {
        LoadImage: { input: { required: { image: [f.images] } } },
        ModelPatchLoader: { input: { required: { name: [f.adapter ? [ADAPTER.file] : []] } } },
        AnimaLLLiteApply: { input: { required: {} } },
      };
    },
    uploadImage: async (buf: Buffer, name: string, subfolder: string) => {
      if (f.uploadFails) throw new Error("upload refused");
      f.uploads.push({ name, subfolder, bytes: buf.length });
      f.images.push(`${subfolder}/${name}`);
      return { name, subfolder, type: "input" };
    },
  };
}

async function env(o: { depthDir?: string; plan?: PromptPlan; adapter?: boolean; uploadFails?: boolean } = {}) {
  const dir = await tmp();
  const batchesDir = join(dir, "_batches");
  const depthDir = o.depthDir ?? (await goodLibrary());
  const f: Fake = { uploads: [], submits: [], infoCalls: 0, images: [], adapter: o.adapter ?? true, uploadFails: o.uploadFails ?? false };
  const plan =
    o.plan ??
    planWith([
      { model: V02, poseId: "ND-P25", positive: GOOD },
      { model: "duskrose", poseId: "ND-P25", positive: withView("direct front view, waist-up, eye level, warm light") },
    ]);
  const calls: unknown[] = [];
  const baseBefore = JSON.stringify(base);
  const deps: RunnerDeps = {
    baseGraph: base,
    plan: async (opts) => {
      calls.push(opts);
      return { plans: [structuredClone(plan)], raw: "", ms: 5, tokens: null as never };
    },
    client: fakeClient(f),
    collectionsDir: dir,
    batchesDir,
    poseSeed: () => 7,
    depthDir,
  };
  const runner = new AutopilotRunner(deps);
  const app = buildApp({ runner, collectionsDir: dir, batchesDir, comfyUrl: "http://x", port: 8787, depthDir, depthClient: fakeClient(f) });
  const settle = async () => {
    while (runner.active) await new Promise((r) => setTimeout(r, 5));
  };
  const collection = async () => (await readdir(dir)).find((n) => !n.startsWith("_"))!;
  const batch = async () => JSON.parse(await readFile(join(batchesDir, (await readdir(batchesDir))[0], "batch-plan.json"), "utf8"));
  return { dir, depthDir, app, runner, f, calls, settle, collection, batch, baseUnchanged: () => JSON.stringify(base) === baseBefore };
}
const start = (e: Awaited<ReturnType<typeof env>>, payload: Record<string, unknown>) => e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload });

test("Depth on: one Codex call; the matching frame and all its seed variants get the map, the other frame is text-only with the reason", async () => {
  const e = await env();
  const res = await start(e, { frames: 2, variations: 2, poseSelection: "auto", depthConditioning: "auto", imageModels: { mode: "custom", perScene: [V02, "duskrose"] } });
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(res.json().depth, { mode: "auto" });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  assert.equal(e.calls.length, 1, "exactly one planning call");
  assert.equal(JSON.stringify(e.calls[0]).includes("depth"), false, "nothing about Depth goes to Codex");
  assert.ok(e.baseUnchanged(), "the base workflow is never mutated");
  const name = comfyName({ id: "nd-p25-fq-h2mt-01", sha256: sha(MAP) });
  assert.deepEqual(e.f.uploads, [{ name, subfolder: COMFY_SUBFOLDER, bytes: MAP.length }], "the map is uploaded once per run");
  assert.equal(e.f.submits.length, 4);

  const id = await e.collection();
  const m = JSON.parse(await readFile(join(e.dir, id, "collection.json"), "utf8"));
  assert.deepEqual(m.generation.depth, { mode: "auto", libraryVersion: 1 });
  for (const fr of m.frames) {
    const side = JSON.parse(await readFile(join(e.dir, id, fr.png.replace(".png", ".json")), "utf8"));
    assert.deepEqual(side.conditioning, fr.conditioning, "sidecar = manifest");
    assert.deepEqual(fr.pose, { id: "ND-P25", catalogVersion: catalog.version, promptAsPlanned: true }, "planned pose kept apart from conditioning");
    if (fr.frame === 1) {
      assert.deepEqual(readConditioning(fr.conditioning), fr.conditioning);
      assert.equal(fr.conditioning.mode, "depth");
      assert.equal(fr.conditioning.mapId, "nd-p25-fq-h2mt-01");
      assert.equal(fr.conditioning.mapSha256, sha(MAP));
      assert.equal(fr.conditioning.model, V02);
      assert.deepEqual(fr.conditioning.adapter, { file: ADAPTER.file, expectedSha256: ADAPTER.sha256, check: "listed-by-comfyui" });
      assert.deepEqual([fr.conditioning.strength, fr.conditioning.startPercent, fr.conditioning.endPercent], [1, 0, 1]);
      assert.equal(fr.conditioning.comfyImage, `${COMFY_SUBFOLDER}/${name}`);
      assert.equal(side.graph[DEPTH_NODES.image].inputs.image, `${COMFY_SUBFOLDER}/${name}`);
      assert.deepEqual(side.graph[FIELDS.seed.node].inputs.model, [DEPTH_NODES.apply, 0]);
    } else {
      assert.deepEqual(fr.conditioning, { mode: "text", depthRequested: true, reason: "view-mismatch", detail: "prompt view direct_front_view" });
      assert.equal(depthOf(side.graph), null);
    }
  }
  const f1 = m.frames.filter((f: { frame: number }) => f.frame === 1);
  assert.equal(f1.length, 2);
  assert.deepEqual(f1[0].conditioning, f1[1].conditioning, "seed variants share the decision");
  assert.notEqual(f1[0].seed, f1[1].seed);

  const b = await e.batch();
  assert.equal(b.depth.library.available, true);
  assert.deepEqual(b.depth.environment, { nodes: true, adapter: true, check: "listed-by-comfyui" });
  assert.deepEqual(b.depth.collections[0].frames.map((x: { frame: number; mode: string }) => [x.frame, x.mode]), [[1, "depth"], [2, "text"]]);
  const view = await readCollection(e.dir, id);
  assert.equal(view!.frames.find((f) => f.frame === 1)!.conditioning?.mode, "depth");
  await e.app.close();
});

test("Depth on: adapter missing or upload refused -> text-only before anything is submitted, with the reason and install steps", async () => {
  const a = await env({ adapter: false });
  await start(a, { frames: 2, poseSelection: "auto", depthConditioning: "auto", imageModels: { mode: "custom", perScene: [V02, "duskrose"] } });
  await a.settle();
  assert.equal(a.runner.state.status, "completed", a.runner.state.error);
  assert.equal(a.f.uploads.length, 0);
  assert.match(a.runner.state.depth?.warning ?? "", /не найден в ComfyUI[\s\S]*Get-FileHash[\s\S]*81357E51/);
  let m = JSON.parse(await readFile(join(a.dir, await a.collection(), "collection.json"), "utf8"));
  assert.equal(m.frames[0].conditioning.reason, "adapter-unavailable");
  assert.ok(a.f.submits.every((g) => !depthOf(g)));
  const status = (await a.app.inject({ method: "GET", url: "/api/depth/status", headers: H })).json();
  assert.equal(status.comfy.adapter, false);
  assert.match(status.instructions, /anima-lllite-depth-1\.safetensors/);

  const u = await env({ uploadFails: true });
  await start(u, { frames: 2, poseSelection: "auto", depthConditioning: "auto", imageModels: { mode: "custom", perScene: [V02, "duskrose"] } });
  await u.settle();
  assert.equal(u.runner.state.status, "completed", u.runner.state.error);
  m = JSON.parse(await readFile(join(u.dir, await u.collection(), "collection.json"), "utf8"));
  assert.deepEqual([m.frames[0].conditioning.reason, m.frames[0].conditioning.detail], ["upload-failed", "upload refused"]);
  assert.ok(u.f.submits.every((g) => !depthOf(g)), "never submitted with a map that is not in ComfyUI");
  await a.app.close();
  await u.app.close();
});

test("Depth off (default): no library read, no ComfyUI probe, no upload, and nothing new in requests, graphs or records", async () => {
  const e = await env();
  await start(e, { frames: 2, poseSelection: "auto", imageModels: { mode: "custom", perScene: [V02, "duskrose"] } });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  assert.equal(e.runner.state.depth, undefined);
  assert.equal(e.f.infoCalls, 0);
  assert.equal(e.f.uploads.length, 0);
  assert.equal(e.calls.length, 1);
  const id = await e.collection();
  const raw = await readFile(join(e.dir, id, "collection.json"), "utf8");
  assert.equal(raw.includes("conditioning"), false);
  assert.equal(JSON.parse(raw).generation.depth, undefined);
  assert.equal(Object.hasOwn(await e.batch(), "depth"), false);
  const plan = planWith([{ model: V02, poseId: "ND-P25", positive: GOOD }]);
  for (const g of e.f.submits) assert.equal(depthOf(g), null);
  // the jobs are exactly what applyParams makes from the base workflow (only positive, seed, model and prefix differ)
  const side = JSON.parse(await readFile(join(e.dir, id, "scene-01.json"), "utf8"));
  const expected = applyParams(base, { positive: plan.frames[0].positive, seed: side.seed, unet: MODELS[V02], filenamePrefix: side.graph["46"].inputs.filename_prefix });
  assert.deepEqual(side.graph, expected);
  await e.app.close();
});

test("settings: depthConditioning needs the pose library; bad values are rejected before anything starts", async () => {
  const e = await env();
  for (const payload of [{ depthConditioning: "auto" }, { poseSelection: "auto", depthConditioning: "on" }, { poseSelection: "auto", depthConditioning: true }]) {
    const r = await start(e, { frames: 1, ...payload });
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.equal(r.json().code, "INVALID_GENERATION_SETTINGS");
  }
  assert.equal(e.calls.length, 0);
  await assert.rejects(e.runner.start(undefined, 1, 1, undefined, {}, undefined, false, "free", "auto"), (x: unknown) => x instanceof RunError && x.httpStatus === 400);
  assert.equal(parseDepthMode(undefined, "free"), "off");
  assert.equal(parseDepthMode("off", "free"), "off");
  // UI request: sent only with the pose library and the switch on
  assert.equal(buildStartRequest({ ...defaultForm(), poseMode: "free", depthMode: "auto" }).depthConditioning, undefined);
  assert.equal(buildStartRequest({ ...defaultForm(), poseMode: "auto", depthMode: "off" }).depthConditioning, undefined);
  assert.equal(buildStartRequest({ ...defaultForm(), poseMode: "auto", depthMode: "auto" }).depthConditioning, "auto");
  assert.equal(defaultForm().depthMode, "off");
  await e.app.close();
});

// ---------- regeneration ----------

async function depthCollection() {
  const e = await env({ plan: planWith([{ model: V02, poseId: "ND-P25", positive: GOOD }]) });
  await start(e, { frames: 1, poseSelection: "auto", depthConditioning: "auto", imageModels: { mode: "only", model: V02 } });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  const id = await e.collection();
  const regen = async (body: Record<string, unknown>) => {
    const r = await e.app.inject({ method: "POST", url: `/api/collections/${id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1, ...body } });
    await e.settle();
    return r;
  };
  const manifest = async () => JSON.parse(await readFile(join(e.dir, id, "collection.json"), "utf8"));
  const sidecar = async (v: number) => JSON.parse(await readFile(join(e.dir, id, `scene-01-v${String(v).padStart(2, "0")}.json`), "utf8"));
  return { e, id, regen, manifest, sidecar };
}

test("regeneration: unchanged prompt keeps the saved graph and its map; drop restores the model link; old files are untouched", async () => {
  const { e, id, regen, manifest, sidecar } = await depthCollection();
  const srcRaw = await readFile(join(e.dir, id, "scene-01.json"), "utf8");
  const src = JSON.parse(srcRaw);
  const prompt = (await e.app.inject({ method: "GET", url: `/api/collections/${id}/frames/1/variants/1/prompt`, headers: H })).json();
  assert.equal(prompt.depth.applied, true);
  assert.equal(prompt.depth.mapId, "nd-p25-fq-h2mt-01");
  assert.deepEqual(prompt.depth.spec, src.conditioning.spec);

  assert.equal((await regen({})).statusCode, 202);
  const kept = await sidecar(2);
  assert.deepEqual(kept.conditioning, src.conditioning, "inherited as is");
  assert.deepEqual(depthOf(kept.graph), depthOf(src.graph));
  assert.equal(kept.graph[DEPTH_NODES.image].inputs.image, src.graph[DEPTH_NODES.image].inputs.image, "the same map, never another one");

  assert.equal((await regen({ depth: "drop" })).statusCode, 202);
  const dropped = await sidecar(3);
  assert.equal(depthOf(dropped.graph), null);
  assert.deepEqual(dropped.graph[FIELDS.seed.node].inputs.model, ["90:84", 0], "original KSampler model link");
  assert.equal(Object.keys(dropped.graph).some((k) => k.startsWith("ns-depth:")), false);
  assert.deepEqual(dropped.conditioning, { mode: "text", userDecision: "drop", droppedFrom: { mapId: "nd-p25-fq-h2mt-01", mapSha256: sha(MAP) } });
  assert.deepEqual(dropped.pose, src.pose, "the planned pose stays (prompt unchanged)");

  assert.equal(await readFile(join(e.dir, id, "scene-01.json"), "utf8"), srcRaw, "source sidecar unchanged");
  assert.equal((await manifest()).frames.length, 3);
  await e.app.close();
});

test("regeneration: an edited prompt that conflicts with the map needs an explicit choice; nothing is reserved without it", async () => {
  const { e, regen, manifest, sidecar } = await depthCollection();
  const seated = withPose("sitting on a velvet bar stool, one hand on her knee, looking at the viewer,");
  const r = await regen({ positive: seated });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "DEPTH_CONFLICT");
  assert.equal((await manifest()).frames.length, 1, "no slot reserved");

  assert.equal((await regen({ positive: seated, depth: "keep" })).statusCode, 202);
  const kept = await sidecar(2);
  assert.equal(kept.conditioning.mode, "depth");
  assert.equal(kept.conditioning.userDecision, "keep");
  assert.equal(kept.conditioning.conflict.reason, "pose-mismatch");
  assert.equal(kept.pose.promptAsPlanned, false);

  assert.equal((await regen({ positive: seated, depth: "drop" })).statusCode, 202);
  assert.equal(depthOf((await sidecar(3)).graph), null);

  // a compatible edit keeps the map without asking
  assert.equal((await regen({ positive: GOOD.replace("calm confident expression", "soft confident smile") })).statusCode, 202);
  const soft = await sidecar(4);
  assert.equal(soft.conditioning.mode, "depth");
  assert.equal(soft.conditioning.conflict, undefined);
  await e.app.close();
});

test("regeneration: a map missing in ComfyUI is uploaded again only from the library entry with the same sha256", async () => {
  const { e, regen, sidecar } = await depthCollection();
  const name = comfyName({ id: "nd-p25-fq-h2mt-01", sha256: sha(MAP) });
  e.f.images.length = 0; // ComfyUI lost its input folder
  e.f.uploads.length = 0;
  assert.equal((await regen({})).statusCode, 202);
  assert.deepEqual(e.f.uploads.map((u) => [u.subfolder, u.name]), [[COMFY_SUBFOLDER, name]], "same name, same content");
  assert.equal((await sidecar(2)).graph[DEPTH_NODES.image].inputs.image, `${COMFY_SUBFOLDER}/${name}`);

  // the library no longer has a map with that hash: refused, never replaced by another map
  const other = png(1440, 2176, "another map");
  await writeFile(join(e.depthDir, "maps", "nd-p25.png"), other);
  await writeFile(join(e.depthDir, "library.json"), JSON.stringify({ version: 1, adapter: ADAPTER, maps: [entry({ sha256: sha(other) })] }));
  e.f.images.length = 0;
  const r = await regen({});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "DEPTH_UNAVAILABLE");
  // the user can still regenerate without the map
  assert.equal((await regen({ depth: "drop" })).statusCode, 202);
  await e.app.close();
});

test("regeneration: keep refuses when the adapter is gone; a keep/drop choice on a text-only source is a 400", async () => {
  const { e, regen } = await depthCollection();
  e.f.adapter = false;
  const r = await regen({});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "DEPTH_UNAVAILABLE");
  assert.equal((await regen({ depth: "bogus" })).statusCode, 400);

  const t = await env();
  await start(t, { frames: 1, imageModels: { mode: "only", model: V02 } });
  await t.settle();
  const tid = await t.collection();
  const bad = await t.app.inject({ method: "POST", url: `/api/collections/${tid}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1, depth: "keep" } });
  assert.equal(bad.statusCode, 400);
  const ok = await t.app.inject({ method: "POST", url: `/api/collections/${tid}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1 } });
  assert.equal(ok.statusCode, 202, "an old-style text-only regeneration works as before");
  await t.settle();
  const side = JSON.parse(await readFile(join(t.dir, tid, "scene-01-v02.json"), "utf8"));
  assert.equal(side.conditioning, undefined);
  await e.app.close();
  await t.app.close();
});

test("conditioning records: malformed records are ignored, never trusted", () => {
  assert.equal(readConditioning({ mode: "depth", mapId: "x" }), undefined);
  assert.equal(readConditioning({ mode: "text", depthRequested: true, reason: "made-up" }), undefined);
  assert.equal(readConditioning("depth"), undefined);
  assert.deepEqual(readConditioning({ mode: "text", depthRequested: true, reason: "no-map" }), { mode: "text", depthRequested: true, reason: "no-map" });
});

// ---------- statistics ----------

test("pose statistics stay apart per model and per conditioning (text-only vs depth); nothing is merged", () => {
  const c = (id: string) => ({ id }) as never;
  const img = (model: string, conditioning: "text" | "depth", verdict: "like" | "dislike") => ({ poseId: "ND-P25", model, conditioning, collection: c("a"), verdict, tags: [], best: false, net: 0 });
  const stats = poseStats([img(V02, "depth", "like"), img(V02, "text", "dislike"), img(V03, "text", "like"), img(V02, "depth", "like")]);
  assert.deepEqual(stats.map((s) => [s.model, s.conditioning, s.images, s.likes, s.dislikes]), [
    [V02, "depth", 2, 2, 0],
    [V02, "text", 1, 0, 1],
    [V03, "text", 1, 1, 0],
  ]);
});

// ---------- Crimson Oath v0.3 ----------

test("models: v0.3 has its own id; crimson-oath stays v0.2; Auto Mix uses v0.3 with the old split; v0.2 stays selectable", async () => {
  assert.deepEqual(IMAGE_MODELS.map((m) => [m.id, m.name, m.checkpoint]), [
    [V02, "Crimson Oath v0.2", "vetehineCrimsonOathILL_v02ANM.safetensors"],
    [V03, "Crimson Oath v0.3", "v.0.3 ANM Vetehine Crimson Oath.safetensors"],
    ["duskrose", "Duskrose v4", "Duskrose v4 ANM.safetensors"],
    ["illustrijn", "IllustrijN", "IllustrijN.safetensors"],
  ]);
  assert.equal(MODELS[V02], "vetehineCrimsonOathILL_v02ANM.safetensors", "the old id is never re-pointed");
  assert.deepEqual([...AUTO_MIX_MODELS], [V03, "duskrose", "illustrijn"]);
  assert.ok(AUTO_MIX_MODELS.every((m) => MODEL_IDS.includes(m)));
  assert.deepEqual([1, 2, 3, 4].map((n) => autoMix(n)), [[V03], [V03, "duskrose"], [V03, "duskrose", "illustrijn"], [V03, V03, "duskrose", "illustrijn"]]);
  assert.deepEqual(resolveImageModels(undefined, 4).models, autoMix(4));
  // the UI uses the same rules
  assert.deepEqual(assignModels("auto", 4), autoMix(4));
  assert.deepEqual(assignModels(`only:${V02}`, 2), [V02, V02]);
  assert.deepEqual(assignModels("custom", 3, [V02, V03, "illustrijn"]), [V02, V03, "illustrijn"]);
  assert.equal(modelName(V02), "Crimson Oath v0.2");
  assert.equal(modelName(V03), "Crimson Oath v0.3");
  assert.deepEqual(resolveImageModels({ mode: "only", model: V02 }, 2).models, [V02, V02]);
  assert.deepEqual(resolveImageModels({ mode: "custom", perScene: [V02, V03] }, 2).models, [V02, V03]);
  // plans, schemas and old plans
  const both = planWith([{ model: V02, positive: GOOD }, { model: V03, positive: GOOD.replace("calm confident", "soft") }]);
  assert.doesNotThrow(() => validatePlan(both, { models: [V02, V03] }));
  assert.deepEqual((await planSchema([V02, V03]) as any).properties.frames.items.properties.model.enum, [V02, V03]);
  assert.ok(((await batchSchema(1)) as any).properties.collections.items.properties.frames.items.properties.model.enum.includes(V03));
  // jobs keep the model's own checkpoint
  const { buildJobs } = await import("../src/collection.ts");
  assert.deepEqual(buildJobs(both, base, "x").map((j) => j.graph["90:78"].inputs.unet_name), [MODELS[V02], MODELS[V03]]);
});

test("models: Depth compatibility is never inherited by Crimson Oath v0.3 (text-only until its own GPU check)", async () => {
  const lib = loadDepthLibrary(await goodLibrary(), catalog);
  const d = decideFrame(frame({ model: V03, graph: applyParams(base, { positive: GOOD, seed: 1, unet: MODELS[V03] }) }), lib, ENV_OK);
  assert.equal(d.ok ? "applied" : d.reason, "model-not-compatible");
  const e = await env({ plan: planWith([{ model: V03, poseId: "ND-P25", positive: GOOD }]) });
  await start(e, { frames: 1, poseSelection: "auto", depthConditioning: "auto" });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  const m = JSON.parse(await readFile(join(e.dir, await e.collection(), "collection.json"), "utf8"));
  assert.equal(m.frames[0].model, V03, "Auto Mix for one frame is v0.3");
  assert.equal(m.frames[0].conditioning.reason, "model-not-compatible");
  assert.equal(e.f.uploads.length, 0);
  await e.app.close();
});

test("old collections made with crimson-oath (v0.2) still read and regenerate with their own checkpoint", async () => {
  const e = await env({ plan: planWith([{ model: V02, positive: GOOD }]) });
  await start(e, { frames: 1, imageModels: { mode: "only", model: V02 } });
  await e.settle();
  const id = await e.collection();
  const r = await e.app.inject({ method: "POST", url: `/api/collections/${id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1 } });
  assert.equal(r.statusCode, 202);
  await e.settle();
  const side = JSON.parse(await readFile(join(e.dir, id, "scene-01-v02.json"), "utf8"));
  assert.equal(side.model, V02);
  assert.equal(side.graph["90:78"].inputs.unet_name, "vetehineCrimsonOathILL_v02ANM.safetensors");
  await e.app.close();
});
