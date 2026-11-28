// NS-031 test helpers: a textured source image, painted masks and a fake ComfyUI that executes the repair graph's composite in JS.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { buildApp } from "../../server/app.ts";
import { AutopilotRunner } from "../../server/runner.ts";
import { FIELDS, MODELS, applyParams, loadWorkflow, type Graph } from "../../src/comfy.ts";
import { REPAIR_ADAPTER, RN } from "../../src/repair.ts";

const root = resolve(import.meta.dirname, "../..");
export const H = { host: "127.0.0.1:8787" };
export const W = 1200, HT = 1400;
export const POSITIVE = "realistic, masterpiece, best quality, ultra detailed,\n\nsolo female, adult woman, 30 years old,\n\nsitting on a rug, barefoot,\n\nglossy semi-realistic illustration, front view, warm light";

/** A deterministic, textured RGB image (every pixel distinct enough to catch any change). */
export async function photo(w = W, h = HT, seed = 1): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = (x * 7 + y * 3 + seed * 11) & 255;
    raw[i + 1] = (x * 3 + y * 5 + seed * 29) & 255;
    raw[i + 2] = (x ^ y ^ seed) & 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** A painted mask: white disc(s) on black at the image size. */
export async function maskPng(discs: [number, number, number][], w = W, h = HT): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#000"/>${discs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`).join("")}</svg>`;
  return `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64")}`;
}

export const raw = async (png: Buffer) => sharp(png).raw().toBuffer({ resolveWithObject: true });

export interface FakeOpts { adapter?: boolean; tamper?: boolean; gate?: Promise<void> }

/** Fake ComfyUI that lists the repair nodes and "executes" the composite of a repair graph exactly as ImageCompositeMasked would. */
export function fakeComfy(o: FakeOpts = {}) {
  const uploads = new Map<string, Buffer>();
  const outputs = new Map<string, Buffer>();
  const submits: Graph[] = [];
  const opt = (list: unknown[]) => [list];
  const info = () => ({
    UNETLoader: { input: { required: { unet_name: opt(Object.values(MODELS)) } } },
    CLIPLoader: { input: { required: { clip_name: opt(["animij_s1_txt.safetensors"]) } } },
    VAELoader: { input: { required: { vae_name: opt(["qwen_image_vae.safetensors"]) } } },
    CLIPTextEncode: { input: { required: {} } },
    LoadImage: { input: { required: { image: opt([...uploads.keys()]) } } },
    LoadImageMask: { input: { required: { image: opt([...uploads.keys()]), channel: opt(["alpha", "red", "green", "blue"]) } } },
    ImageScale: { input: { required: { upscale_method: opt(["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]) } } },
    VAEEncode: { input: { required: {} } },
    SetLatentNoiseMask: { input: { required: {} } },
    ModelPatchLoader: { input: { required: { name: opt(["anima-lllite-depth-1.safetensors", ...(o.adapter === false ? [] : [REPAIR_ADAPTER.file])]) } } },
    AnimaLLLiteApply: { input: { required: {}, optional: { mask: ["MASK"] } } },
    KSampler: { input: { required: { sampler_name: opt(["euler", "er_sde"]), scheduler: opt(["simple"]) } } },
    VAEDecode: { input: { required: {} } },
    ImageCompositeMasked: { input: { required: {} } },
    SaveImage: { input: { required: {} } },
  });
  const client = {
    systemStats: async () => ({}) as never,
    objectInfo: async () => info(),
    checkDependencies: async (g: Graph) => {
      const missing: string[] = [];
      for (const [id, n] of Object.entries(g)) if ((n.class_type === "LoadImage" || n.class_type === "LoadImageMask") && !uploads.has(String(n.inputs.image))) missing.push(`${id}: ${n.inputs.image}`);
      return missing;
    },
    uploadImage: async (buf: Buffer, name: string) => {
      uploads.set(name, buf);
      return { name, subfolder: "", type: "input" };
    },
    submit: async (g: Graph) => {
      submits.push(structuredClone(g));
      return `pid-${submits.length}`;
    },
    waitForImages: async (pid: string) => {
      if (o.gate) await o.gate;
      const g = submits[Number(pid.slice(4)) - 1];
      const src = await raw(uploads.get(String(g[RN.source].inputs.image))!);
      const blend = await raw(uploads.get(String(g[RN.blend].inputs.image))!);
      const { x, y } = g[RN.composite].inputs as { x: number; y: number };
      const cw = blend.info.width, ch = blend.info.height;
      // "generated" content: a flat colour over the whole crop (what the sampler would return outside the mask is irrelevant here)
      const gen = Buffer.alloc(cw * ch * 3, 0);
      for (let i = 0; i < cw * ch; i++) gen.set([200, 40, 90], i * 3);
      const out = Buffer.from(src.data);
      for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
        const m = blend.data[(yy * cw + xx) * blend.info.channels] / 255;
        const p = ((y + yy) * src.info.width + x + xx) * src.info.channels;
        for (let c = 0; c < 3; c++) out[p + c] = Math.round(src.data[p + c] * (1 - m) + gen[(yy * cw + xx) * 3 + c] * m);
      }
      if (o.tamper) out[0] = out[0] ^ 1; // one pixel far outside the repair area
      outputs.set("final.png", await sharp(out, { raw: { width: src.info.width, height: src.info.height, channels: src.info.channels } }).png().toBuffer());
      outputs.set("raw.png", await sharp(gen, { raw: { width: cw, height: ch, channels: 3 } }).png().toBuffer());
      const ref = (filename: string) => ({ images: [{ filename, subfolder: "", type: "output" }] });
      return { images: [{ filename: "final.png", subfolder: "", type: "output" }], history: { outputs: { [RN.save]: ref("final.png"), [RN.raw]: ref("raw.png") } } };
    },
    download: async (ref: { filename: string }) => outputs.get(ref.filename)!,
  };
  return { client, uploads, submits };
}

export async function setup(o: FakeOpts & { model?: string; booster?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns31-"));
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const fake = fakeComfy(o);
  const runner = new AutopilotRunner({ client: fake.client as never, plan: (async () => { throw new Error("Codex must not be called"); }) as never, baseGraph: base, collectionsDir: dir, batchesDir: join(dir, "_b") });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787, repairClient: fake.client });
  const id = "2026-11-28-rug";
  const cdir = join(dir, id);
  await mkdir(cdir, { recursive: true });
  const model = o.model ?? "crimson-oath-v03";
  const png = await photo();
  const graph = applyParams(base, { positive: POSITIVE, seed: 280202, unet: MODELS[model as keyof typeof MODELS], filenamePrefix: `NeuroStudio/${id}/scene-01` });
  if (o.booster) graph[FIELDS.seed.node] && (graph["90:89"].inputs.value = true);
  await writeFile(join(cdir, "scene-01.png"), png);
  await writeFile(join(cdir, "scene-01.json"), JSON.stringify({ frame: 1, model, variant: 1, seed: 280202, graph }));
  await writeFile(join(cdir, "collection.json"), JSON.stringify({ title: "Rug", createdAt: "2026-11-28T10:00:00Z", status: "done", frameCount: 1, frames: [{ frame: 1, model, seed: 280202, status: "done", png: "scene-01.png", promptId: "p1" }] }));
  await writeFile(join(cdir, "selections.json"), JSON.stringify({ "1": 1 }));
  await writeFile(join(cdir, "image-feedback.json"), JSON.stringify({ version: 1, images: { "1-1": { verdict: "dislike", tags: ["anatomy"], updatedAt: "2026-11-28T10:00:00Z" } } }));
  const settle = async () => {
    while (runner.active) await new Promise((r) => setTimeout(r, 5));
  };
  const post = (body: unknown, frame = 1) => app.inject({ method: "POST", url: `/api/collections/${id}/frames/${frame}/repair`, headers: H, payload: body as never });
  const get = async () => (await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: H })).json();
  const snapshot = async () => Object.fromEntries(await Promise.all(["scene-01.png", "scene-01.json", "collection.json", "selections.json", "image-feedback.json"].map(async (f) => [f, await readFile(join(cdir, f))])));
  return { dir, id, cdir, fake, runner, app, settle, post, get, snapshot, png, graph };
}

export const body = async (o: Partial<{ discs: [number, number, number][]; text: string; denoise: number; region: number; preset: string; sourceVariant: number; mask: string }> = {}) => ({
  sourceVariant: o.sourceVariant ?? 1,
  mask: o.mask ?? (await maskPng(o.discs ?? [[300, 500, 60]])),
  text: o.text ?? "the patterned woven rug continuing between her feet",
  denoise: o.denoise ?? 1,
  region: o.region ?? 1024,
  preset: o.preset ?? "remove",
});

