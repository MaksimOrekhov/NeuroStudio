// NS-031: manual local repair (Inpainting v2). No GPU, no Codex: ComfyUI is a fake that executes the repair graph's composite in JS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { io } from "../src/persistence.ts";
import { join, resolve } from "node:path";
import { FIELDS, MODELS, applyParams, loadWorkflow } from "../src/comfy.ts";
import {
  BLUR_SIGMA, GROW_PX, REPAIR_ADAPTER, REPAIR_MODELS, RN, baseFromGraph, buildMasks, buildRepairGraph, parseRepairRequest, planCrop, repairPositive, squaredDistance,
} from "../src/repair.ts";
import { REPAIR_MODELS as WEB_REPAIR_MODELS } from "../web/src/models.ts";
import { H, HT, POSITIVE, W, body, maskPng, raw, setup } from "./fixtures/repair.ts";

const root = resolve(import.meta.dirname, "..");

// ---------- pure parts ----------

test("masks: grow is the exact Euclidean disc dilation; blend is 0 beyond grow + kernel and 255 deep inside", () => {
  const w = 160, h = 140;
  const core = new Uint8Array(w * h);
  for (const [cx, cy, r] of [[50, 60, 9], [100, 70, 4], [80, 40, 6]]) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) core[y * w + x] = 1;
  const m = buildMasks(core, w, h);
  const radius = Math.ceil(3 * BLUR_SIGMA);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = Infinity;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (core[yy * w + xx]) best = Math.min(best, (x - xx) ** 2 + (y - yy) ** 2);
    const p = y * w + x;
    assert.equal(m.grow[p], best <= GROW_PX * GROW_PX ? 1 : 0, `grow at ${x},${y}`);
    if (Math.sqrt(best) > GROW_PX + radius + 1) assert.equal(m.blend[p], 0, `blend tail at ${x},${y}`);
    if (Math.sqrt(best) <= GROW_PX - radius - 1) assert.equal(m.blend[p], 255, `blend core at ${x},${y}`);
  }
  assert.deepEqual(Array.from(squaredDistance(Uint8Array.from([0, 1, 0, 0]), 4, 1)), [1, 0, 1, 4]);
});

test("masks: empty, too small and too large masks are refused with INVALID_MASK", () => {
  assert.throws(() => buildMasks(new Uint8Array(100 * 100), 100, 100), (e: any) => e.code === "INVALID_MASK" && /empty/.test(e.message));
  const big = new Uint8Array(100 * 100).fill(1);
  assert.throws(() => buildMasks(big, 100, 100), (e: any) => e.code === "INVALID_MASK" && /regenerate/.test(e.message));
});

test("crop: centred on the zone, inside the image, aligned to 16 px where possible; a zone larger than the area is refused", () => {
  const c = planCrop([290, 430, 410, 560], W, HT, 512);
  assert.deepEqual([c[2] - c[0], c[3] - c[1]], [512, 512]);
  assert.ok(c[0] <= 290 && c[2] >= 410 && c[1] <= 430 && c[3] >= 560);
  assert.equal(c[0] % 16, 0);
  assert.equal(c[1] % 16, 0);
  const edge = planCrop([1150, 1350, 1200, 1400], W, HT, 1024);
  assert.deepEqual(edge, [W - 1024, HT - 1024, W, HT]);
  assert.throws(() => planCrop([0, 0, 600, 300], W, HT, 512), (e: any) => e.code === "INVALID_MASK" && /1024/.test(e.message));
  assert.throws(() => planCrop([0, 0, 10, 10], 800, 900, 1024), (e: any) => e.code === "INVALID_MASK" && /smaller/.test(e.message));
});

test("request: sourceVariant, PNG mask, English text, denoise range, region and preset label", async () => {
  const ok = parseRepairRequest(await body({ denoise: 0.65, preset: "fix", region: 512 }));
  assert.equal(ok.preset, "fix");
  assert.equal(parseRepairRequest(await body({ denoise: 0.7, preset: "fix" })).preset, "custom");
  const bad = async (o: Record<string, unknown>, code: string, re: RegExp) => assert.throws(() => parseRepairRequest({ ...(o.base as object), ...o }), (e: any) => e.code === code && re.test(e.message));
  const b = await body();
  await bad({ base: b, mask: "data:image/jpeg;base64,AAAA" }, "INVALID_MASK", /png/i);
  await bad({ base: b, mask: `data:image/png;base64,${Buffer.from("not a png").toString("base64")}` }, "INVALID_MASK", /not a PNG/);
  await bad({ base: b, text: "ковёр между ступнями" }, "INVALID_REQUEST", /English/);
  await bad({ base: b, text: "  " }, "INVALID_REQUEST", /describe/);
  await bad({ base: b, denoise: 0.1 }, "INVALID_REQUEST", /denoise/);
  await bad({ base: b, denoise: "1" }, "INVALID_REQUEST", /denoise/);
  await bad({ base: b, region: 768 }, "INVALID_REQUEST", /region/);
  await bad({ base: b, preset: "magic" }, "INVALID_REQUEST", /preset/);
  await bad({ base: b, sourceVariant: 0 }, "INVALID_REQUEST", /sourceVariant/);
});

test("graph: the NS-030 pipeline with the source's model, sampler and negative; the mask limits the latent AND feeds the adapter", async () => {
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const g0 = applyParams(base, { positive: POSITIVE, seed: 1, unet: MODELS["crimson-oath-v03"] });
  const b = baseFromGraph(g0);
  assert.deepEqual([b.unet, b.steps, b.cfg, b.sampler, b.scheduler, b.vae, b.clip.clip_name], [MODELS["crimson-oath-v03"], 35, 4, "er_sde", "simple", "qwen_image_vae.safetensors", "animij_s1_txt.safetensors"]);
  assert.equal(b.negative, g0[FIELDS.negative.node].inputs.text);
  assert.equal(repairPositive(b, "rug"), "realistic, masterpiece, best quality, ultra detailed,\n\nglossy semi-realistic illustration, rug");
  const names = { source: "s.png", crop: "c.png", grow: "g.png", blend: "b.png" };
  const g = buildRepairGraph({ base: b, text: "rug", seed: 7, denoise: 0.65, crop: [96, 400, 1120, 1424], names, prefix: "NeuroStudio/x/scene-01-v02" });
  const ks = g[RN.sampler].inputs;
  assert.deepEqual([ks.seed, ks.steps, ks.cfg, ks.sampler_name, ks.scheduler, ks.denoise, ks.latent_image, ks.model], [7, 35, 4, "er_sde", "simple", 0.65, [RN.noise, 0], [RN.apply, 0]]);
  assert.deepEqual(g[RN.noise].inputs.mask, [RN.grow, 0]);
  assert.deepEqual(g[RN.apply].inputs, { model: [RN.unet, 0], model_patch: [RN.patch, 0], image: [RN.crop, 0], mask: [RN.grow, 0], strength: 1, start_percent: 0, end_percent: 1 });
  assert.equal(g[RN.patch].inputs.name, REPAIR_ADAPTER.file);
  assert.deepEqual(g[RN.composite].inputs, { destination: [RN.source, 0], source: [RN.decode, 0], x: 96, y: 400, resize_source: false, mask: [RN.blend, 0] });
  assert.equal(g[RN.grow].inputs.channel, "red");
  assert.ok(!g[RN.up] && !g[RN.down], "a 1024 area is processed 1:1");
  assert.ok(!g[FIELDS.positive.node], "no generation node ids: Prompt Evolution never reads a repair prompt");
  const z = buildRepairGraph({ base: b, text: "rug", seed: 7, denoise: 1, crop: [96, 400, 608, 912], names, prefix: "p" });
  assert.deepEqual(z[RN.up].inputs, { image: [RN.crop, 0], upscale_method: "lanczos", width: 1024, height: 1024, crop: "disabled" });
  assert.deepEqual(z[RN.down].inputs, { image: [RN.decode, 0], upscale_method: "area", width: 512, height: 512, crop: "disabled" });
  assert.deepEqual([z[RN.encode].inputs.pixels, z[RN.apply].inputs.image, z[RN.composite].inputs.source, z[RN.raw].inputs.images], [[RN.up, 0], [RN.up, 0], [RN.down, 0], [RN.down, 0]]);
  assert.throws(() => baseFromGraph({ ...g0, "90:89": { class_type: "PrimitiveBoolean", inputs: { value: true } } }), /Smooth Booster/);
});

test("the verified model list is the same in the server and the UI", () => {
  assert.deepEqual([...WEB_REPAIR_MODELS], [...REPAIR_MODELS]);
  assert.deepEqual([...REPAIR_MODELS], ["crimson-oath-v03"]);
});

// ---------- end to end over the API ----------

test("repair: one submission; a new variant; pixels outside the feathered zone byte-identical; source, Best and ratings untouched", async () => {
  const e = await setup();
  const before = await e.snapshot();
  const r = await e.post(await body({ discs: [[300, 500, 60]], region: 512, denoise: 0.65, preset: "fix" }));
  assert.equal(r.statusCode, 202, r.body);
  assert.deepEqual(r.json().regeneration, { collectionId: e.id, frame: 1, variant: 2, sourceVariant: 1, repair: true });
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  assert.equal(e.fake.submits.length, 1);
  assert.equal(e.fake.uploads.size, 4);
  const c = await e.get();
  const v2 = c.frames.find((f: any) => f.variant === 2);
  assert.equal(v2.status, "done");
  assert.equal(v2.image, "scene-01-v02.png");
  assert.equal(v2.sourceVariant, 1);
  assert.equal(v2.repair.method, "inpainting-v2");
  assert.deepEqual([v2.repair.preset, v2.repair.denoise, v2.repair.region, v2.repair.strength], ["fix", 0.65, 512, 1]);
  assert.equal(c.selections["1"], 1, "Best unchanged");
  assert.equal(c.imageFeedback["1-1"].verdict, "dislike");
  assert.equal(c.imageFeedback["1-2"], undefined, "the new variant has no rating");
  // the source files are byte-identical; only collection.json gained the slot
  const after = await e.snapshot();
  for (const f of ["scene-01.png", "scene-01.json", "selections.json", "image-feedback.json"]) assert.ok(before[f].equals(after[f]), f);
  // every pixel with blend = 0 equals the source; the painted area did change
  const side = JSON.parse(await readFile(join(e.cdir, "scene-01-v02.json"), "utf8"));
  const blend = await raw(await readFile(join(e.cdir, side.repair.files.blend)));
  const [a, b2] = [await raw(e.png), await raw(await readFile(join(e.cdir, "scene-01-v02.png")))];
  let outside = 0, inside = 0;
  for (let i = 0; i < W * HT; i++) {
    const same = [0, 1, 2].every((k) => a.data[i * 3 + k] === b2.data[i * b2.info.channels + k]);
    if (!same) blend.data[i * blend.info.channels] === 0 ? outside++ : inside++;
  }
  assert.equal(outside, 0);
  assert.ok(inside > 1000);
  assert.equal(side.repair.verification.outsideBlendChangedPx, 0);
  // the sidecar keeps everything needed to understand and repeat the repair
  assert.equal(side.graph[RN.sampler].inputs.seed, side.seed);
  assert.equal(side.graph[RN.sampler].inputs.denoise, 0.65);
  assert.deepEqual(side.repair.crop, side.graph[RN.up] ? [side.graph[RN.composite].inputs.x, side.graph[RN.composite].inputs.y, side.graph[RN.composite].inputs.x + 512, side.graph[RN.composite].inputs.y + 512] : null);
  assert.equal(side.repair.base.unet, MODELS["crimson-oath-v03"]);
  assert.equal(side.repair.source.sha256.length, 64);
  assert.equal(side.repair.text, "the patterned woven rug continuing between her feet");
  assert.deepEqual(Object.keys(side.repair.uploads).sort(), ["blend", "crop", "grow", "source"]);
  assert.deepEqual((await readdir(join(e.cdir, "repairs/scene-01-v02"))).sort(), ["blend.png", "grow.png", "mask.png", "raw-crop.png"]);
  assert.deepEqual(e.fake.submits[0], side.graph, "the stored graph is exactly the submitted one");
});

test("verification failure: a changed pixel outside the zone fails the variant; nothing is saved as the image; never resubmitted", async () => {
  const e = await setup({ tamper: true });
  assert.equal((await e.post(await body())).statusCode, 202);
  await e.settle();
  assert.equal(e.runner.state.status, "failed");
  assert.match(e.runner.state.error!, /verification failed: 1 pixels outside/);
  assert.equal(e.fake.submits.length, 1);
  const v2 = (await e.get()).frames.find((f: any) => f.variant === 2);
  assert.equal(v2.status, "failed");
  assert.equal(v2.image, undefined);
  const files = await readdir(e.cdir);
  assert.ok(!files.includes("scene-01-v02.png"));
  assert.ok((await readdir(join(e.cdir, "repairs/scene-01-v02"))).includes("rejected-final.png"));
});

test("only Crimson Oath v0.3 is repairable; Smooth Booster sources are refused; nothing is reserved", async () => {
  for (const o of [{ model: "crimson-oath" }, { model: "duskrose" }, { booster: true }]) {
    const e = await setup(o);
    const before = await e.snapshot();
    const info = (await e.app.inject({ method: "GET", url: `/api/collections/${e.id}/frames/1/variants/1/repair`, headers: H })).json();
    assert.equal(info.available, false);
    assert.equal(info.code, "REPAIR_MODEL_UNSUPPORTED");
    const r = await e.post(await body());
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, "REPAIR_MODEL_UNSUPPORTED");
    assert.ok((await e.snapshot())["collection.json"].equals(before["collection.json"]));
    assert.equal(e.fake.uploads.size, 0);
    assert.equal(e.runner.active, false);
  }
});

test("missing adapter in ComfyUI: REPAIR_UNAVAILABLE with install steps (no download); nothing reserved or uploaded", async () => {
  const e = await setup({ adapter: false });
  const before = await e.snapshot();
  const st = (await e.app.inject({ method: "GET", url: "/api/repair/status", headers: H })).json();
  assert.equal(st.ready, false);
  assert.equal(st.adapter, false);
  assert.match(st.instructions, new RegExp(REPAIR_ADAPTER.sha256.toUpperCase()));
  const r = await e.post(await body());
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "REPAIR_UNAVAILABLE");
  assert.match(r.json().error, /not listed by ComfyUI/);
  assert.ok((await e.snapshot())["collection.json"].equals(before["collection.json"]));
  assert.equal(e.fake.uploads.size + e.fake.submits.length, 0);
});

test("mask checks before anything else: wrong size, empty, zone too large for 512 px", async () => {
  const e = await setup();
  const cases: [unknown, RegExp][] = [
    [await body({ mask: await maskPng([[300, 500, 60]], 640, 960) }), /640x960/],
    [await body({ discs: [] }), /empty/],
    [await body({ discs: [[300, 500, 260]], region: 512 }), /1024/],
  ];
  for (const [b, re] of cases) {
    const r = await e.post(b);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().code, "INVALID_MASK");
    assert.match(r.json().error, re);
  }
  assert.equal(e.fake.uploads.size, 0);
  assert.equal((await e.get()).frames.length, 1);
});

test("one operation at a time: a repair holds the lock against regeneration and another repair", async () => {
  let open!: () => void;
  const e = await setup({ gate: new Promise<void>((r) => (open = r)) });
  assert.equal((await e.post(await body())).statusCode, 202);
  const again = await e.post(await body());
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, "ALREADY_RUNNING");
  const regen = await e.app.inject({ method: "POST", url: `/api/collections/${e.id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1 } });
  assert.equal(regen.statusCode, 409);
  assert.equal(regen.json().code, "ALREADY_RUNNING");
  open();
  await e.settle();
  assert.equal(e.fake.submits.length, 1);
});

test("a repaired variant cannot be regenerated (explicit refusal) but can be repaired again from its own pixels", async () => {
  const e = await setup();
  await e.post(await body());
  await e.settle();
  const p = (await e.app.inject({ method: "GET", url: `/api/collections/${e.id}/frames/1/variants/2/prompt`, headers: H })).json();
  assert.equal(p.available, false);
  assert.equal(p.code, "REPAIR_NOT_REGENERABLE");
  const regen = await e.app.inject({ method: "POST", url: `/api/collections/${e.id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 2 } });
  assert.equal(regen.statusCode, 409);
  assert.equal(regen.json().code, "REPAIR_NOT_REGENERABLE");
  assert.equal(e.fake.submits.length, 1, "nothing was submitted for the refused regeneration");
  const r = await e.post(await body({ sourceVariant: 2, discs: [[800, 900, 40]] }));
  assert.equal(r.statusCode, 202, r.body);
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  const side3 = JSON.parse(await readFile(join(e.cdir, "scene-01-v03.json"), "utf8"));
  const side2 = JSON.parse(await readFile(join(e.cdir, "scene-01-v02.json"), "utf8"));
  assert.equal(side3.sourceVariant, 2);
  assert.equal(side3.repair.source.repaired, true);
  assert.deepEqual(side3.repair.base, side2.repair.base, "model and sampler settings are carried over from the first repair");
  // the original source is still regenerable
  assert.equal((await e.app.inject({ method: "GET", url: `/api/collections/${e.id}/frames/1/variants/1/prompt`, headers: H })).json().available, true);
});

test("repair info for the dialog: size, processing areas that fit, presets and limits", async () => {
  const e = await setup();
  const info = (await e.app.inject({ method: "GET", url: `/api/collections/${e.id}/frames/1/variants/1/repair`, headers: H })).json();
  assert.deepEqual([info.available, info.model, info.width, info.height, info.regions], [true, "crimson-oath-v03", W, HT, [512, 1024]]);
  assert.deepEqual(info.presets, { remove: { denoise: 1 }, fix: { denoise: 0.65 } });
  assert.equal(info.strength, 1);
});

// ---------- reservation failures (FS) ----------

const exists = (p: string) => stat(p).then(() => true, () => false);

test("FS: the sidecar or manifest cannot be written when reserving: no leftover folder or files, manifest unchanged, nothing uploaded; the next attempt works", async () => {
  for (const failing of ["scene-01-v02.json", "collection.json"]) {
    const e = await setup();
    const before = await e.snapshot();
    const rename = io.rename;
    io.rename = (async (a: string, b: string) => {
      if (String(b).endsWith(failing)) throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
      return rename(a, b);
    }) as typeof io.rename;
    let r;
    try {
      r = await e.post(await body());
    } finally {
      io.rename = rename;
    }
    assert.equal(r.statusCode, 500, failing);
    assert.ok((await e.snapshot())["collection.json"].equals(before["collection.json"]), failing);
    assert.equal(await exists(join(e.cdir, "repairs", "scene-01-v02")), false, `${failing}: the attempt's own folder is removed`);
    assert.deepEqual((await readdir(e.cdir)).filter((f) => f.startsWith("scene-01-v02")), [], failing);
    assert.equal(e.fake.uploads.size + e.fake.submits.length, 0, failing);
    assert.equal(e.runner.active, false, failing);
    const again = await e.post(await body());
    assert.equal(again.statusCode, 202, again.body);
    assert.equal(again.json().regeneration.variant, 2, "the same number is free again");
    await e.settle();
    assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  }
});

test("FS: when the cleanup fails too, the leftover repairs folder is kept as it is and the next attempt takes the next number (no EEXIST)", async () => {
  const e = await setup();
  const rename = io.rename, unlink = io.unlink;
  io.rename = (async (a: string, b: string) => {
    if (String(b).endsWith("scene-01-v02.json")) throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
    return rename(a, b);
  }) as typeof io.rename;
  io.unlink = (async () => {
    throw Object.assign(new Error("EBUSY: injected"), { code: "EBUSY" });
  }) as typeof io.unlink;
  try {
    assert.equal((await e.post(await body())).statusCode, 500);
  } finally {
    io.rename = rename;
    io.unlink = unlink;
  }
  const left = join(e.cdir, "repairs", "scene-01-v02");
  const leftover = Object.fromEntries(await Promise.all((await readdir(left)).map(async (f) => [f, await readFile(join(left, f))])));
  assert.deepEqual(Object.keys(leftover).sort(), ["blend.png", "grow.png", "mask.png"]);
  const r = await e.post(await body());
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(r.json().regeneration.variant, 3, "the occupied number 2 is skipped, never reused");
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
  for (const [f, buf] of Object.entries(leftover)) assert.ok((await readFile(join(left, f))).equals(buf as Buffer), `${f} left untouched`);
  assert.equal((await e.get()).frames.find((f: any) => f.variant === 3).status, "done");
  // regeneration skips that number as well
  const regen = await e.app.inject({ method: "POST", url: `/api/collections/${e.id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1 } });
  assert.equal(regen.statusCode, 202, regen.body);
  assert.equal(regen.json().regeneration.variant, 4);
  await e.settle();
});
