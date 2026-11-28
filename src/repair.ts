// NS-031: manual local repair of ONE finished image with Anima LLLite Inpainting v2 (the pipeline verified in NS-030).
// The user paints a mask; the area around it is repaired in a 512 or 1024 px crop and composited back over the untouched source.
// Every pixel outside the feathered repair zone is checked to be byte-identical to the source before the result is saved as a NEW
// variant of the frame. The source PNG, its sidecar, ratings, comparisons and Best are never touched. No Codex. One submission, never
// resubmitted.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { FIELDS, ComfyUnavailableError, boosterOff, type ComfyClient, type Graph, type ImageRef } from "./comfy.ts";
import { IMAGE_MODELS, REPAIR_MODELS } from "./imageModels.ts";
import type { FrameRecord, Manifest, RepairSummary } from "./collection.ts";
import { RegenError, collectionDir, freshSeed, nextVariant, parseVariant, readManifest, saveManifest, writeSidecar } from "./regenerate.ts";
import { io } from "./persistence.ts";

// ---------- Verified settings (NS-030) ----------

export const REPAIR_ADAPTER = {
  file: "anima-lllite-inpainting-v2.safetensors",
  sha256: "5242e677d2be34ee70ca7c97c3b14ff5ee49838c03fc1e60ac4852a180db6ef5",
  bytes: 65_772_872,
} as const;
/** The copy downloaded and verified in NS-030 (never downloaded again by NeuroStudio). */
export const REPAIR_ADAPTER_LOCAL_COPY = resolve(import.meta.dirname, "..", "output/ns-030/repair-pilot/comfy/models/model_patches", REPAIR_ADAPTER.file);
export { REPAIR_MODELS };
export const GROW_PX = 16;
export const BLUR_SIGMA = 6;
export const WORK_SIZE = 1024;
export const REGIONS = [512, 1024] as const;
export type Region = (typeof REGIONS)[number];
export const PRESETS = { remove: { denoise: 1.0 }, fix: { denoise: 0.65 } } as const;
export type Preset = keyof typeof PRESETS | "custom";
export const STRENGTH = 1.0;
export const DENOISE_MIN = 0.3;
export const DENOISE_MAX = 1.0;
export const TEXT_MIN = 3;
export const TEXT_MAX = 400;
/** The painted mask may cover at most this share of the image: a larger repair is a regeneration, not a repair. */
export const MASK_MAX_FRACTION = 0.25;
export const MASK_MIN_PX = 64;
export const MASK_MAX_BYTES = 8 * 1024 * 1024;
/** Style phrase kept from the source prompt when present (as in NS-030). */
const STYLE = "glossy semi-realistic illustration";
const BLUR_RADIUS = Math.ceil(3 * BLUR_SIGMA);
const MARGIN = GROW_PX + BLUR_RADIUS + 1;

const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");
const invalidMask = (m: string) => new RegenError("INVALID_MASK", m, 400);
const invalid = (m: string) => new RegenError("INVALID_REQUEST", m, 400);

// ---------- Request ----------

export interface RepairRequest {
  sourceVariant: number;
  mask: Buffer;
  text: string;
  denoise: number;
  region: Region;
  preset: Preset;
}

/** Validates the body of POST .../repair. Nothing is read from disk here. */
export function parseRepairRequest(body: unknown): RepairRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("body must be an object");
  const b = body as Record<string, unknown>;
  const sourceVariant = parseVariant(b.sourceVariant, "sourceVariant");
  if (typeof b.mask !== "string") throw invalidMask("mask must be a PNG data URL");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(b.mask);
  if (!m) throw invalidMask("mask must be a data:image/png;base64 URL");
  const mask = Buffer.from(m[1], "base64");
  if (mask.length > MASK_MAX_BYTES) throw invalidMask(`mask is too large (max ${MASK_MAX_BYTES} bytes)`);
  if (mask.length < 8 || mask.readUInt32BE(0) !== 0x89504e47) throw invalidMask("mask is not a PNG");
  if (typeof b.text !== "string") throw invalid("text must be a string");
  const text = b.text.replace(/\s+/g, " ").trim();
  if (text.length < TEXT_MIN) throw invalid("describe what the repaired area should show");
  if (text.length > TEXT_MAX) throw invalid(`text is too long (max ${TEXT_MAX} characters)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) throw invalid("text contains control characters");
  if (/[\u0400-\u04ff]/.test(text)) throw invalid("the repair description must be in English");
  const denoise = typeof b.denoise === "number" ? Math.round(b.denoise * 100) / 100 : NaN;
  if (!Number.isFinite(denoise) || denoise < DENOISE_MIN || denoise > DENOISE_MAX) throw invalid(`denoise must be a number ${DENOISE_MIN}-${DENOISE_MAX}`);
  if (b.region !== 512 && b.region !== 1024) throw invalid("region must be 512 or 1024");
  const asked = b.preset;
  if (asked !== undefined && asked !== "remove" && asked !== "fix" && asked !== "custom") throw invalid('preset must be "remove", "fix" or "custom"');
  // The preset is a label of the parameters actually used: a changed denoise is "custom".
  const preset: Preset = asked === "remove" || asked === "fix" ? (PRESETS[asked].denoise === denoise ? asked : "custom") : "custom";
  return { sourceVariant, mask, text, denoise, region: b.region, preset };
}

// ---------- Source: model, sampler settings and prompt prefix of the image being repaired ----------

/** Everything the repair graph takes from the source image's own generation. */
export interface RepairBase {
  unet: string;
  clip: Record<string, unknown>;
  vae: string;
  negative: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** First paragraph of the source positive (the quality prefix), "" when the prompt has a single paragraph. */
  prefix: string;
  /** The source prompt had the style phrase. */
  style: boolean;
}

const single = (g: Graph, cls: string) => {
  const ids = Object.keys(g).filter((k) => g[k].class_type === cls);
  return ids.length === 1 ? g[ids[0]] : null;
};

/** Reads RepairBase from a production generation graph (workflows/anima-crimson-oath.api.json shape). Throws a reason string. */
export function baseFromGraph(graph: Graph): RepairBase {
  const node = (f: { node: string; cls: string }) => (graph[f.node]?.class_type === f.cls ? graph[f.node] : null);
  if (!boosterOff(graph)) throw new Error("the source was generated with Smooth Booster (or its switch is missing); repair is verified only without it");
  const ks = node(FIELDS.seed);
  const unet = node(FIELDS.unet)?.inputs.unet_name;
  const steps = node(FIELDS.steps)?.inputs.value;
  const cfg = node(FIELDS.cfg)?.inputs.value;
  const negative = node(FIELDS.negative)?.inputs.text;
  const positive = node(FIELDS.positive)?.inputs.text;
  const clip = single(graph, "CLIPLoader");
  const vae = single(graph, "VAELoader")?.inputs.vae_name;
  if (!ks || typeof ks.inputs.sampler_name !== "string" || typeof ks.inputs.scheduler !== "string") throw new Error("the saved graph has no KSampler settings");
  if (typeof unet !== "string" || typeof steps !== "number" || typeof cfg !== "number" || typeof negative !== "string" || typeof positive !== "string") throw new Error("the saved graph is not a known generation graph");
  if (!clip || typeof clip.inputs.clip_name !== "string" || typeof vae !== "string") throw new Error("the saved graph has no single CLIP/VAE loader");
  const paragraphs = positive.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    unet, clip: { ...clip.inputs }, vae, negative, steps, cfg, sampler: ks.inputs.sampler_name, scheduler: ks.inputs.scheduler,
    prefix: paragraphs.length > 1 ? paragraphs[0].replace(/[,\s]+$/, "") : "",
    style: positive.includes(STYLE),
  };
}

function readBase(raw: unknown): RepairBase | null {
  const b = raw as Partial<RepairBase> | null;
  if (!b || typeof b !== "object") return null;
  const ok = typeof b.unet === "string" && !!b.clip && typeof b.clip === "object" && typeof b.vae === "string" && typeof b.negative === "string"
    && typeof b.steps === "number" && typeof b.cfg === "number" && typeof b.sampler === "string" && typeof b.scheduler === "string"
    && typeof b.prefix === "string" && typeof b.style === "boolean";
  return ok ? (b as RepairBase) : null;
}

/** Positive of the repair: the source's quality prefix (+ style phrase) and the user's description. Nothing about the heroine. */
export function repairPositive(base: RepairBase, text: string): string {
  return [base.prefix, `${base.style ? `${STYLE}, ` : ""}${text}`].filter(Boolean).join(",\n\n");
}

export interface RepairSource {
  frame: number;
  variant: number;
  model: string;
  png: string;
  pngPath: string;
  sha256: string;
  width: number;
  height: number;
  base: RepairBase;
  /** The source is itself a repaired variant (its base parameters were carried over). */
  repaired: boolean;
}

const unavailable = (reason: string) => new RegenError("SOURCE_UNAVAILABLE", reason, 409);

/** True when the model is one the repair was verified on AND the graph really uses that model's checkpoint. */
export function repairModelSupported(model: string, unet?: string): boolean {
  const entry = IMAGE_MODELS.find((m) => m.id === model);
  return !!entry && (REPAIR_MODELS as readonly string[]).includes(model) && (unet === undefined || unet === entry.checkpoint);
}

/** The finished variant to repair, with the settings of its own generation. Nothing is guessed. */
export async function loadRepairSource(dir: string, id: string, frame: number, variant: number): Promise<RepairSource> {
  const m = await readManifest(dir, id);
  const rec = m.frames.find((f) => f.frame === frame && (f.variant ?? 1) === variant);
  if (!rec) throw unavailable(`frame ${frame} variant ${variant} does not exist`);
  if (rec.status !== "done" || !rec.png || !/^scene-\d{2}(-v\d{2})?\.png$/.test(rec.png)) throw unavailable(`frame ${frame} variant ${variant} has no finished image`);
  const cdir = collectionDir(dir, id);
  const pngPath = join(cdir, rec.png);
  let png: Buffer;
  try {
    png = await readFile(pngPath);
  } catch {
    throw unavailable(`frame ${frame} variant ${variant}: image file ${rec.png} is missing on disk`);
  }
  let side: { graph?: unknown; repair?: { base?: unknown } };
  try {
    side = JSON.parse(await readFile(join(cdir, rec.png.replace(/\.png$/, ".json")), "utf8"));
  } catch {
    throw unavailable(`frame ${frame} variant ${variant}: the saved generation settings are missing or unreadable`);
  }
  let base: RepairBase | null;
  const repaired = !!(rec.repair || side.repair);
  if (repaired) {
    base = readBase(side.repair?.base);
    if (!base) throw unavailable(`frame ${frame} variant ${variant}: the repair record has no usable base settings`);
  } else {
    const g = side.graph as Graph | undefined;
    if (!g || typeof g !== "object" || Array.isArray(g)) throw unavailable(`frame ${frame} variant ${variant}: the saved ComfyUI graph is missing`);
    try {
      base = baseFromGraph(g);
    } catch (e) {
      // Booster on or an unknown graph: the image cannot be repaired with verified settings.
      throw new RegenError("REPAIR_MODEL_UNSUPPORTED", `frame ${frame} variant ${variant}: ${(e as Error).message}`, 409);
    }
  }
  if (!repairModelSupported(rec.model, base.unet)) {
    const name = IMAGE_MODELS.find((x) => x.id === rec.model)?.name ?? rec.model;
    throw new RegenError("REPAIR_MODEL_UNSUPPORTED", `local repair is verified only for ${REPAIR_MODELS.join(", ")}; this image was made with ${name} (${base.unet})`, 409);
  }
  const meta = await sharp(png).metadata();
  if (!meta.width || !meta.height) throw unavailable(`frame ${frame} variant ${variant}: the image cannot be read`);
  return { frame, variant, model: rec.model, png: rec.png, pngPath, sha256: sha(png), width: meta.width, height: meta.height, base, repaired };
}

// ---------- Masks ----------

/** 1 = repair. The painted PNG must have the source's exact size; a pixel is painted when red x alpha >= 50 %. */
export async function decodeMask(png: Buffer, width: number, height: number): Promise<Uint8Array> {
  let raw: { data: Buffer; info: { width: number; height: number; channels: number } };
  try {
    raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw invalidMask(`mask cannot be decoded: ${(e as Error).message}`);
  }
  if (raw.info.width !== width || raw.info.height !== height) throw invalidMask(`mask is ${raw.info.width}x${raw.info.height}, the image is ${width}x${height}`);
  const ch = raw.info.channels;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += ch) out[i] = raw.data[p] * raw.data[p + ch - 1] >= 128 * 255 ? 1 : 0;
  return out;
}

export interface Masks {
  width: number;
  height: number;
  core: Uint8Array;
  /** core dilated by a disc of GROW_PX (Euclidean): the area the sampler may change. */
  grow: Uint8Array;
  /** grow blurred (Gaussian, BLUR_SIGMA): composite weight 0..255; 0 = the source pixel is kept byte for byte. */
  blend: Uint8Array;
  /** [x0, y0, x1, y1) of blend > 0. */
  bbox: [number, number, number, number];
  corePx: number;
  growPx: number;
  blendPx: number;
}

/** 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[k]] === Infinity) { v[k] = q; continue; }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]] === Infinity) { d.fill(Infinity, 0, n); return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance to the nearest 1 of `bin` (w x h). */
export function squaredDistance(bin: Uint8Array, w: number, h: number): Float64Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const out = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = bin[y * w + x] ? 0 : Infinity;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

function gaussianKernel(sigma: number, radius: number): Float64Array {
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  return k.map((x) => x / sum);
}

/** Grow and blend masks of a painted core. Work is limited to a window around the core; everything outside it is exactly 0. */
export function buildMasks(core: Uint8Array, width: number, height: number): Masks {
  let x0 = width, y0 = height, x1 = -1, y1 = -1, corePx = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!core[row + x]) continue;
      corePx++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (corePx < MASK_MIN_PX) throw invalidMask(corePx ? `the mask is too small (${corePx} px, at least ${MASK_MIN_PX})` : "the mask is empty: paint over the area to repair");
  if (corePx > MASK_MAX_FRACTION * width * height) throw invalidMask(`the mask covers ${((100 * corePx) / (width * height)).toFixed(1)} % of the image (max ${MASK_MAX_FRACTION * 100} %): regenerate the image instead`);
  const wx0 = Math.max(0, x0 - MARGIN), wy0 = Math.max(0, y0 - MARGIN);
  const wx1 = Math.min(width, x1 + 1 + MARGIN), wy1 = Math.min(height, y1 + 1 + MARGIN);
  const ww = wx1 - wx0, wh = wy1 - wy0;
  const win = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) win[y * ww + x] = core[(y + wy0) * width + x + wx0];
  const dist = squaredDistance(win, ww, wh);
  const growWin = new Float64Array(ww * wh);
  for (let i = 0; i < growWin.length; i++) growWin[i] = dist[i] <= GROW_PX * GROW_PX ? 255 : 0;
  // separable Gaussian, zero outside the window (the window margin covers grow + the whole kernel)
  const k = gaussianKernel(BLUR_SIGMA, BLUR_RADIUS);
  const tmp = new Float64Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      let s = 0;
      for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < ww) s += growWin[y * ww + xx] * k[i + BLUR_RADIUS];
      }
      tmp[y * ww + x] = s;
    }
  }
  const grow = new Uint8Array(width * height);
  const blend = new Uint8Array(width * height);
  let bx0 = width, by0 = height, bx1 = -1, by1 = -1, growPx = 0, blendPx = 0;
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      let s = 0;
      for (let i = -BLUR_RADIUS; i <= BLUR_RADIUS; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < wh) s += tmp[yy * ww + x] * k[i + BLUR_RADIUS];
      }
      const p = (y + wy0) * width + x + wx0;
      const g = growWin[y * ww + x] > 0 ? 1 : 0;
      // inside grow the weight never drops below what the blur gives; it is 255 where the whole kernel is inside grow
      const b = Math.min(255, Math.round(s));
      grow[p] = g;
      blend[p] = b;
      growPx += g;
      if (b > 0) {
        blendPx++;
        if (x + wx0 < bx0) bx0 = x + wx0;
        if (x + wx0 > bx1) bx1 = x + wx0;
        if (y + wy0 < by0) by0 = y + wy0;
        if (y + wy0 > by1) by1 = y + wy0;
      }
    }
  }
  return { width, height, core, grow, blend, bbox: [bx0, by0, bx1 + 1, by1 + 1], corePx, growPx, blendPx };
}

/**
 * The processing area: a `region` x `region` square that contains the whole feathered zone, centred on it, inside the image,
 * aligned to 16 px where possible. Throws INVALID_MASK when the zone does not fit.
 */
export function planCrop(bbox: [number, number, number, number], width: number, height: number, region: Region): [number, number, number, number] {
  if (region > width || region > height) throw invalidMask(`the image (${width}x${height}) is smaller than the ${region} px processing area`);
  const [bx0, by0, bx1, by1] = bbox;
  if (bx1 - bx0 > region || by1 - by0 > region) {
    throw invalidMask(`the repair zone (${bx1 - bx0}x${by1 - by0} px with its ${GROW_PX + BLUR_RADIUS} px border) does not fit in the ${region} px area${region === 512 ? ": choose 1024 px" : ""}; paint a smaller mask`);
  }
  const axis = (b0: number, b1: number, size: number) => {
    const lo = Math.max(0, b1 - region), hi = Math.min(b0, size - region);
    const ideal = Math.round((b0 + b1) / 2 - region / 2);
    let v = Math.min(hi, Math.max(lo, Math.round(ideal / 16) * 16));
    if (v % 16) {
      const up = Math.ceil(lo / 16) * 16;
      if (up <= hi) v = Math.min(hi, Math.max(up, Math.round(ideal / 16) * 16));
    }
    return v;
  };
  const x0 = axis(bx0, bx1, width), y0 = axis(by0, by1, height);
  return [x0, y0, x0 + region, y0 + region];
}

const grayPng = (data: Uint8Array, w: number, h: number) => sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();

function cropPlane(plane: Uint8Array, width: number, crop: [number, number, number, number], scale = 1, mul = 1): Uint8Array {
  const [x0, y0, x1, y1] = crop;
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8Array(w * scale * h * scale);
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) out[y * w * scale + x] = plane[(y0 + Math.floor(y / scale)) * width + x0 + Math.floor(x / scale)] * mul;
  }
  return out;
}

/** The four images ComfyUI needs (source, source crop, grow mask at working size, blend mask at crop size) and the full-size masks to keep. */
export async function repairInputs(srcPng: Buffer, masks: Masks, crop: [number, number, number, number]) {
  const [x0, y0, x1, y1] = crop;
  const region = x1 - x0;
  const scale = WORK_SIZE / region;
  return {
    source: srcPng,
    crop: await sharp(srcPng).extract({ left: x0, top: y0, width: region, height: y1 - y0 }).png().toBuffer(),
    growWork: await grayPng(cropPlane(masks.grow, masks.width, crop, scale, 255), WORK_SIZE, WORK_SIZE),
    blendCrop: await grayPng(cropPlane(masks.blend, masks.width, crop), region, y1 - y0),
    maskFull: await grayPng(masks.core.map((v) => v * 255), masks.width, masks.height),
    growFull: await grayPng(masks.grow.map((v) => v * 255), masks.width, masks.height),
    blendFull: await grayPng(masks.blend, masks.width, masks.height),
  };
}

// ---------- Graph ----------

/** Node ids of the repair graph. They never collide with the generation graph's ids (Prompt Evolution reads 90:77 only). */
export const RN = {
  unet: "ns-repair:unet", clip: "ns-repair:clip", vae: "ns-repair:vae", pos: "ns-repair:positive", neg: "ns-repair:negative",
  crop: "ns-repair:crop", grow: "ns-repair:grow", blend: "ns-repair:blend", source: "ns-repair:source", up: "ns-repair:upscale",
  encode: "ns-repair:encode", noise: "ns-repair:noise-mask", patch: "ns-repair:patch", apply: "ns-repair:inpaint", sampler: "ns-repair:sampler",
  decode: "ns-repair:decode", down: "ns-repair:downscale", composite: "ns-repair:composite", save: "ns-repair:save", raw: "ns-repair:save-raw",
} as const;

export interface GraphNames {
  source: string;
  crop: string;
  grow: string;
  blend: string;
}

/**
 * The NS-030 graph: masked latent (SetLatentNoiseMask) + Inpainting v2 with the same mask, 1024 working size (a 512 area is scaled
 * x2 with Lanczos and back with area averaging), final ImageCompositeMasked over the full source with the feathered mask.
 */
export function buildRepairGraph(o: { base: RepairBase; text: string; seed: number; denoise: number; crop: [number, number, number, number]; names: GraphNames; prefix: string }): Graph {
  const [x0, y0, x1] = o.crop;
  const region = x1 - x0;
  const scaled = region !== WORK_SIZE;
  const image = scaled ? RN.up : RN.crop;
  const result = scaled ? RN.down : RN.decode;
  const g: Graph = {
    [RN.unet]: { class_type: "UNETLoader", inputs: { unet_name: o.base.unet, weight_dtype: "default" } },
    [RN.clip]: { class_type: "CLIPLoader", inputs: { ...o.base.clip } },
    [RN.vae]: { class_type: "VAELoader", inputs: { vae_name: o.base.vae } },
    [RN.pos]: { class_type: "CLIPTextEncode", inputs: { text: repairPositive(o.base, o.text), clip: [RN.clip, 0] } },
    [RN.neg]: { class_type: "CLIPTextEncode", inputs: { text: o.base.negative, clip: [RN.clip, 0] } },
    [RN.crop]: { class_type: "LoadImage", inputs: { image: o.names.crop } },
    [RN.grow]: { class_type: "LoadImageMask", inputs: { image: o.names.grow, channel: "red" } },
    [RN.blend]: { class_type: "LoadImageMask", inputs: { image: o.names.blend, channel: "red" } },
    [RN.source]: { class_type: "LoadImage", inputs: { image: o.names.source } },
    [RN.encode]: { class_type: "VAEEncode", inputs: { pixels: [image, 0], vae: [RN.vae, 0] } },
    [RN.noise]: { class_type: "SetLatentNoiseMask", inputs: { samples: [RN.encode, 0], mask: [RN.grow, 0] } },
    [RN.patch]: { class_type: "ModelPatchLoader", inputs: { name: REPAIR_ADAPTER.file } },
    [RN.apply]: { class_type: "AnimaLLLiteApply", inputs: { model: [RN.unet, 0], model_patch: [RN.patch, 0], image: [image, 0], mask: [RN.grow, 0], strength: STRENGTH, start_percent: 0, end_percent: 1 } },
    [RN.sampler]: {
      class_type: "KSampler",
      inputs: { model: [RN.apply, 0], seed: o.seed, steps: o.base.steps, cfg: o.base.cfg, sampler_name: o.base.sampler, scheduler: o.base.scheduler, positive: [RN.pos, 0], negative: [RN.neg, 0], latent_image: [RN.noise, 0], denoise: o.denoise },
    },
    [RN.decode]: { class_type: "VAEDecode", inputs: { samples: [RN.sampler, 0], vae: [RN.vae, 0] } },
    [RN.composite]: { class_type: "ImageCompositeMasked", inputs: { destination: [RN.source, 0], source: [result, 0], x: x0, y: y0, resize_source: false, mask: [RN.blend, 0] } },
    [RN.save]: { class_type: "SaveImage", inputs: { images: [RN.composite, 0], filename_prefix: o.prefix } },
    [RN.raw]: { class_type: "SaveImage", inputs: { images: [result, 0], filename_prefix: `${o.prefix}-raw` } },
  };
  if (scaled) {
    g[RN.up] = { class_type: "ImageScale", inputs: { image: [RN.crop, 0], upscale_method: "lanczos", width: WORK_SIZE, height: WORK_SIZE, crop: "disabled" } };
    g[RN.down] = { class_type: "ImageScale", inputs: { image: [RN.decode, 0], upscale_method: "area", width: region, height: region, crop: "disabled" } };
  }
  return g;
}

// ---------- ComfyUI environment ----------

const NEEDED = ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "LoadImage", "LoadImageMask", "ImageScale", "VAEEncode", "SetLatentNoiseMask", "ModelPatchLoader", "AnimaLLLiteApply", "KSampler", "VAEDecode", "ImageCompositeMasked", "SaveImage"];

export interface RepairEnvironment {
  nodes: boolean;
  /** AnimaLLLiteApply accepts a mask (ComfyUI 0.46+ native). */
  maskInput: boolean;
  /** The adapter is listed by ComfyUI (presence of the name only; the hash of the installed file is not readable through the API). */
  adapter: boolean;
  problems: string[];
  error?: string;
}

/** Asks ComfyUI (once) for the nodes, the mask input, the adapter and, when `base` is given, the model files of the source. */
export async function repairEnvironment(client: Partial<Pick<ComfyClient, "objectInfo">>, base?: RepairBase): Promise<RepairEnvironment> {
  if (!client.objectInfo) return { nodes: false, maskInput: false, adapter: false, problems: ["the ComfyUI client cannot list nodes"], error: "the ComfyUI client cannot list nodes" };
  let info: Record<string, any>;
  try {
    info = await client.objectInfo();
  } catch (e) {
    return { nodes: false, maskInput: false, adapter: false, problems: [(e as Error).message], error: (e as Error).message };
  }
  const problems: string[] = [];
  const missing = NEEDED.filter((c) => !info[c]);
  if (missing.length) problems.push(`ComfyUI has no node ${missing.join(", ")}`);
  const maskInput = !!info.AnimaLLLiteApply?.input?.optional?.mask;
  if (info.AnimaLLLiteApply && !maskInput) problems.push("AnimaLLLiteApply has no mask input (ComfyUI is too old for Inpainting v2)");
  const list = (cls: string, input: string): unknown[] | null => {
    const v = info[cls]?.input?.required?.[input]?.[0];
    return Array.isArray(v) ? v : null;
  };
  const adapter = !!list("ModelPatchLoader", "name")?.includes(REPAIR_ADAPTER.file);
  if (info.ModelPatchLoader && !adapter) problems.push(`the adapter ${REPAIR_ADAPTER.file} is not listed by ComfyUI`);
  const want = (cls: string, input: string, value: unknown) => {
    const l = list(cls, input);
    if (l && !l.includes(value)) problems.push(`${cls}.${input}: "${String(value)}" is not available in ComfyUI`);
  };
  want("ImageScale", "upscale_method", "lanczos");
  want("ImageScale", "upscale_method", "area");
  want("LoadImageMask", "channel", "red");
  if (base) {
    want("UNETLoader", "unet_name", base.unet);
    want("CLIPLoader", "clip_name", base.clip.clip_name);
    want("VAELoader", "vae_name", base.vae);
    want("KSampler", "sampler_name", base.sampler);
    want("KSampler", "scheduler", base.scheduler);
  }
  return { nodes: !missing.length, maskInput, adapter, problems };
}

/** Russian steps to install the already downloaded adapter. NeuroStudio never copies it into Desktop by itself. */
export function repairInstructions(): string {
  const local = existsSync(REPAIR_ADAPTER_LOCAL_COPY) ? REPAIR_ADAPTER_LOCAL_COPY : `<копия ${REPAIR_ADAPTER.file} из NS-030>`;
  return [
    `Адаптер ${REPAIR_ADAPTER.file} не найден в ComfyUI. Скачивать его заново не нужно: используйте проверенную копию из NS-030.`,
    `1. Закройте ComfyUI Desktop.`,
    `2. Скопируйте файл ${local} в папку model_patches общей папки моделей Desktop (по умолчанию E:\\Comfy-Desktop\\ComfyUI-Shared\\models\\model_patches\\).`,
    `3. Проверьте хеш в PowerShell: (Get-FileHash -Algorithm SHA256 "<путь к скопированному файлу>").Hash — должен совпасть с ${REPAIR_ADAPTER.sha256.toUpperCase()} (${REPAIR_ADAPTER.bytes} байт).`,
    `4. Запустите ComfyUI Desktop. NeuroStudio проверяет только наличие файла в списке ComfyUI, хеш установленного файла сервер не проверяет.`,
    `Лицензия адаптера: CircleStone Labs Non-Commercial License v1.0.`,
  ].join("\n");
}

// ---------- Reservation and run ----------

export interface RepairReservation {
  name: string;
  variant: number;
  seed: number;
  src: RepairSource;
  req: RepairRequest;
  masks: Masks;
  crop: [number, number, number, number];
  inputs: Awaited<ReturnType<typeof repairInputs>>;
  record: FrameRecord;
  manifest: Manifest;
  collectionDir: string;
  /** The repair record stored in the sidecar (graph and uploads are added when known). */
  repair: Record<string, unknown>;
  prefix: string;
}

/**
 * Reserves the new variant (number, seed) and writes its masks and its "pending" sidecar BEFORE anything is sent to ComfyUI.
 * The masks are kept in repairs/<name>/ inside the collection; nothing existing is overwritten.
 */
export async function reserveRepair(dir: string, id: string, src: RepairSource, req: RepairRequest, masks: Masks, crop: [number, number, number, number]): Promise<RepairReservation> {
  const cdir = collectionDir(dir, id);
  const m = await readManifest(dir, id);
  const { variant, name } = await nextVariant(cdir, m, src.frame);
  const seed = freshSeed(m);
  const inputs = await repairInputs(await readFile(src.pngPath), masks, crop);
  if (sha(inputs.source) !== src.sha256) throw new RegenError("SOURCE_UNAVAILABLE", `the source image ${src.png} changed while the repair was being prepared`, 409);
  const rel = `repairs/${name}`;
  const files = { mask: `${rel}/mask.png`, grow: `${rel}/grow.png`, blend: `${rel}/blend.png`, raw: `${rel}/raw-crop.png` };
  await mkdir(join(cdir, rel), { recursive: true });
  for (const [k, buf] of [["mask", inputs.maskFull], ["grow", inputs.growFull], ["blend", inputs.blendFull]] as const) await io.writeFile(join(cdir, files[k]), buf, { flag: "wx" });
  const summary: RepairSummary = { method: "inpainting-v2", preset: req.preset, denoise: req.denoise, strength: STRENGTH, region: req.region, crop, text: req.text, files: { mask: files.mask, blend: files.blend, raw: files.raw } };
  const repair = {
    ...summary,
    files,
    source: { variant: src.variant, png: src.png, sha256: src.sha256, size: [src.width, src.height], repaired: src.repaired },
    base: src.base,
    adapter: { file: REPAIR_ADAPTER.file, expectedSha256: REPAIR_ADAPTER.sha256, check: "listed-by-comfyui" },
    workSize: WORK_SIZE,
    scale: WORK_SIZE / req.region,
    growPx: GROW_PX,
    blurSigma: BLUR_SIGMA,
    mask: { corePx: masks.corePx, growPx: masks.growPx, blendPx: masks.blendPx, bbox: masks.bbox, sha256: { mask: sha(inputs.maskFull), grow: sha(inputs.growFull), blend: sha(inputs.blendFull) } },
  };
  const positive = repairPositive(src.base, req.text);
  const record: FrameRecord = { frame: src.frame, variant, model: src.model, seed, status: "pending", sourceVariant: src.variant, repair: summary };
  await writeSidecar(cdir, name, { frame: src.frame, variant, model: src.model, seed, sourceVariant: src.variant, positive, status: "pending", repair });
  m.frames.push(record);
  try {
    await saveManifest(cdir, m);
  } catch (e) {
    m.frames.pop(); // nothing was submitted: the slot does not exist
    await io.unlink(join(cdir, `${name}.json`)).catch(() => {});
    throw e;
  }
  const prevPrefix = `NeuroStudio/${id}`;
  return { name, variant, seed, src, req, masks, crop, inputs, record, manifest: m, collectionDir: cdir, repair, prefix: `${prevPrefix}/${name}` };
}

type RepairClient = Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download" | "uploadImage">;

/** Uploads one input under a content-addressed name (identical content is reused by ComfyUI, a different file is never overwritten). */
async function upload(client: RepairClient, buf: Buffer, kind: string): Promise<string> {
  const name = `neurostudio-repair-${sha(buf).slice(0, 20)}-${kind}.png`;
  const r = await client.uploadImage(buf, name, "");
  return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
}

/** Pixels where `blend` is 0 must be identical in `a` and `b` (raw RGB of the same size). Returns the counts. */
export function compareOutside(a: Buffer, b: Buffer, blend: Uint8Array, chA: number, chB: number): { outsideChanged: number; insideChanged: number } {
  let outsideChanged = 0, insideChanged = 0;
  for (let i = 0; i < blend.length; i++) {
    const pa = i * chA, pb = i * chB;
    const same = a[pa] === b[pb] && a[pa + 1] === b[pb + 1] && a[pa + 2] === b[pb + 2];
    if (same) continue;
    if (blend[i] === 0) outsideChanged++;
    else insideChanged++;
  }
  return { outsideChanged, insideChanged };
}

const outputOf = (history: unknown, node: string): ImageRef | undefined => (history as { outputs?: Record<string, { images?: ImageRef[] }> })?.outputs?.[node]?.images?.[0];

/**
 * Runs the reserved repair once: upload inputs, check every dependency, submit ONCE, download, verify, store. Never resubmits.
 * The result is stored as the variant's PNG only after every pixel outside the feathered zone was found identical to the source.
 */
export async function runRepair(opts: { r: RepairReservation; client: RepairClient; timeoutMs?: number; log?: (s: string) => void; onProgress?: () => void }): Promise<FrameRecord> {
  const { r, client } = opts;
  const rec = r.record;
  const cdir = r.collectionDir;
  const t0 = Date.now();
  const problems: string[] = [];
  let graph: Graph | undefined;
  const base = () => ({ frame: rec.frame, variant: r.variant, model: rec.model, seed: r.seed, sourceVariant: rec.sourceVariant, positive: repairPositive(r.src.base, r.req.text), repair: r.repair, ...(graph ? { graph } : {}) });
  const side = (extra: Record<string, unknown>) => writeSidecar(cdir, r.name, { ...base(), promptId: rec.promptId, ...extra });
  const save = async () => {
    await saveManifest(cdir, r.manifest);
    opts.onProgress?.();
  };
  const trySave = async () => {
    try {
      await save();
    } catch (e) {
      problems.push(`collection.json: ${(e as Error).message}`);
    }
  };
  const tag = () => (rec.promptId ? ` [prompt_id ${rec.promptId}]` : "");
  const fail = async (status: FrameRecord["status"], e: Error) => {
    rec.status = status;
    rec.error = e.message + tag() + (problems.length ? ` (could not be saved: ${problems.join("; ")})` : "");
    rec.seconds = (Date.now() - t0) / 1000;
    await side({ status, seconds: rec.seconds, error: rec.error }).catch(() => {});
    await trySave();
    e.message = rec.error;
  };
  try {
    await client.systemStats();
    const names: GraphNames = {
      source: await upload(client, r.inputs.source, "source"),
      crop: await upload(client, r.inputs.crop, `crop${r.req.region}`),
      grow: await upload(client, r.inputs.growWork, "grow"),
      blend: await upload(client, r.inputs.blendCrop, "blend"),
    };
    r.repair.uploads = names;
    graph = buildRepairGraph({ base: r.src.base, text: r.req.text, seed: r.seed, denoise: r.req.denoise, crop: r.crop, names, prefix: r.prefix });
    const deps = await client.checkDependencies(graph);
    if (deps.length) throw new Error(`Missing dependencies for the repair:\n  ${deps.join("\n  ")}`);
    await side({ status: "pending" });
  } catch (e) {
    await fail("failed", e as Error); // nothing was submitted
    throw e;
  }
  try {
    rec.promptId = await client.submit(graph, randomUUID());
  } catch (e) {
    await fail("failed", e as Error); // rejected: nothing was accepted
    throw e;
  }
  rec.status = "submitted";
  try {
    await side({ status: "submitted" });
  } catch (e) {
    problems.push(`${r.name}.json: ${(e as Error).message}`);
  }
  await trySave();
  let history: unknown;
  try {
    ({ history } = await client.waitForImages(rec.promptId, opts.timeoutMs ?? 20 * 60_000));
  } catch (e) {
    await fail(/timed out/i.test((e as Error).message) || e instanceof ComfyUnavailableError ? "timeout" : "failed", e as Error);
    throw e;
  }
  let finalPng: Buffer;
  try {
    const finalRef = outputOf(history, RN.save);
    const rawRef = outputOf(history, RN.raw);
    if (!finalRef || !rawRef) throw new Error("ComfyUI finished the repair without its two output images");
    finalPng = await client.download(finalRef);
    const rawPng = await client.download(rawRef);
    await io.writeFile(join(cdir, (r.repair.files as Record<string, string>).raw), rawPng, { flag: "wx" });
    // Verification: same size, and every pixel with blend = 0 identical to the source.
    const [a, b] = await Promise.all([sharp(r.inputs.source).raw().toBuffer({ resolveWithObject: true }), sharp(finalPng).raw().toBuffer({ resolveWithObject: true })]);
    if (b.info.width !== a.info.width || b.info.height !== a.info.height) throw new Error(`the repaired image is ${b.info.width}x${b.info.height}, the source is ${a.info.width}x${a.info.height}`);
    const cmp = compareOutside(a.data, b.data, r.masks.blend, a.info.channels, b.info.channels);
    r.repair.verification = { outsideBlendChangedPx: cmp.outsideChanged, insideBlendChangedPx: cmp.insideChanged, finalSha256: sha(finalPng), rawSha256: sha(rawPng) };
    if (cmp.outsideChanged) {
      await io.writeFile(join(cdir, `repairs/${r.name}/rejected-final.png`), finalPng, { flag: "wx" }).catch(() => {});
      throw new Error(`verification failed: ${cmp.outsideChanged} pixels outside the repair area differ from the source; the result was not saved as a variant`);
    }
    await io.writeFile(join(cdir, `${r.name}.png`), finalPng, { flag: "wx" }); // never overwrites
  } catch (e) {
    await fail("failed", e as Error); // the job finished in ComfyUI (prompt_id kept) but its result is not usable or not stored
    throw e;
  }
  rec.png = `${r.name}.png`;
  rec.seconds = (Date.now() - t0) / 1000;
  rec.status = "done";
  try {
    await side({ status: "done", seconds: rec.seconds, history });
  } catch (e) {
    problems.push(`${r.name}.json: ${(e as Error).message}`);
  }
  try {
    await save();
  } catch (e) {
    throw new Error(`The image ${rec.png} was created${tag()} but collection.json could not be updated: ${(e as Error).message}`);
  }
  opts.log?.(`repaired ${r.name} from variant ${r.src.variant} in ${rec.seconds!.toFixed(1)}s`);
  return rec;
}

/** Everything the dialog needs before painting: is this image repairable, its size and the processing areas that fit. */
export async function repairInfo(dir: string, id: string, frame: number, variant: number) {
  try {
    const s = await loadRepairSource(dir, id, frame, variant);
    return {
      frame, variant, available: true as const, model: s.model, width: s.width, height: s.height, repaired: s.repaired,
      regions: REGIONS.filter((r) => r <= s.width && r <= s.height), presets: PRESETS, strength: STRENGTH, growPx: GROW_PX, featherPx: BLUR_RADIUS,
      maxMaskFraction: MASK_MAX_FRACTION, denoiseMin: DENOISE_MIN, denoiseMax: DENOISE_MAX, textMax: TEXT_MAX, adapter: REPAIR_ADAPTER.file,
    };
  } catch (e) {
    if (e instanceof RegenError && (e.code === "SOURCE_UNAVAILABLE" || e.code === "REPAIR_MODEL_UNSUPPORTED")) return { frame, variant, available: false as const, code: e.code, reason: e.message };
    throw e;
  }
}

