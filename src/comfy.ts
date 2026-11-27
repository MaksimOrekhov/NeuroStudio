import { readFile } from "node:fs/promises";
import { IMAGE_MODELS, type ImageModelId } from "./imageModels.ts";

// ---------- Types ----------

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface GenParams {
  positive: string;
  negative?: string;
  seed: number;
  steps?: number;
  cfg?: number;
  aspectRatio?: string;
  megapixels?: number;
  filenamePrefix?: string;
  unet?: string;
}

export interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export class ComfyUnavailableError extends Error {}
export class WorkflowError extends Error {}
export class GenerationError extends Error {}

// ---------- Workflow field mapping (Anima / Crimson Oath, see docs/comfyui-integration.md) ----------

interface Field {
  node: string;
  cls: string;
  input: string;
}

export const FIELDS: Record<keyof GenParams, Field> = {
  positive: { node: "90:77", cls: "CLIPTextEncode", input: "text" },
  negative: { node: "90:75", cls: "CLIPTextEncode", input: "text" },
  seed: { node: "90:76", cls: "KSampler", input: "seed" },
  steps: { node: "90:79", cls: "PrimitiveInt", input: "value" },
  cfg: { node: "90:86", cls: "PrimitiveFloat", input: "value" },
  aspectRatio: { node: "91", cls: "ResolutionSelector", input: "aspect_ratio" },
  megapixels: { node: "91", cls: "ResolutionSelector", input: "megapixels" },
  filenamePrefix: { node: "46", cls: "SaveImage", input: "filename_prefix" },
  unet: { node: "90:78", cls: "UNETLoader", input: "unet_name" },
};

/** Smooth Booster switch of the production graph (true = LoRA, 8 steps, CFG 1). Not a request parameter: always off today. */
export const BOOSTER: Field = { node: "90:89", cls: "PrimitiveBoolean", input: "value" };

/** True only when the graph has the Smooth Booster switch and it is off. */
export function boosterOff(graph: Graph): boolean {
  const n = graph[BOOSTER.node];
  return n?.class_type === BOOSTER.cls && n.inputs[BOOSTER.input] === false;
}

const linkOf = (v: unknown): [string, number] | null => (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" ? [v[0], v[1]] : null);

/**
 * The pixel size the graph renders (the latent size x 8), or null when it cannot be read. Follows KSampler.latent_image to its
 * EmptyLatentImage; width/height are either numbers or outputs of ResolutionSelector (same formula as ComfyUI 0.46).
 */
export function graphImageSize(graph: Graph): [number, number] | null {
  const ks = graph[FIELDS.seed.node];
  const lat = linkOf(ks?.inputs?.latent_image);
  const latent = lat && graph[lat[0]];
  if (!latent || latent.class_type !== "EmptyLatentImage") return null;
  const dim = (v: unknown): number | null => {
    if (typeof v === "number") return v;
    const l = linkOf(v);
    const n = l && graph[l[0]];
    if (!n || n.class_type !== "ResolutionSelector") return null;
    const m = String(n.inputs.aspect_ratio).match(/^(\d+):(\d+)/);
    const mp = n.inputs.megapixels;
    const mult = n.inputs.multiple ?? 8;
    if (!m || typeof mp !== "number" || typeof mult !== "number") return null;
    const [w, h] = [Number(m[1]), Number(m[2])];
    const scale = Math.sqrt((mp * 1024 * 1024) / (w * h));
    return Math.round(((l[1] === 0 ? w : h) * scale) / mult) * mult;
  };
  const w = dim(latent.inputs.width);
  const h = dim(latent.inputs.height);
  return w && h ? [Math.floor(w / 8) * 8, Math.floor(h / 8) * 8] : null;
}

// ---------- NS-027: Depth nodes in ONE job's graph ----------

/** Reserved node ids of the three Depth nodes added to a job graph. */
export const DEPTH_NODES = { image: "ns-depth:image", patch: "ns-depth:patch", apply: "ns-depth:apply" } as const;

export interface DepthParams {
  /** LoadImage value: subfolder/name in ComfyUI's input folder. */
  image: string;
  adapter: string;
  strength: number;
  startPercent: number;
  endPercent: number;
}

/**
 * Returns a copy of `graph` with LoadImage -> ModelPatchLoader -> AnimaLLLiteApply between the model that KSampler used and KSampler
 * (exactly the NS-027 Stage A graphs). The input graph is never mutated.
 */
export function applyDepth(graph: Graph, p: DepthParams): Graph {
  const g = structuredClone(graph);
  const ks = g[FIELDS.seed.node];
  if (ks?.class_type !== FIELDS.seed.cls) throw new WorkflowError(`Node ${FIELDS.seed.node} is not a KSampler`);
  const model = linkOf(ks.inputs.model);
  if (!model) throw new WorkflowError("KSampler.model is not a link");
  if (Object.values(DEPTH_NODES).some((id) => g[id]) || depthOf(g)) throw new WorkflowError("the graph already has Depth nodes");
  g[DEPTH_NODES.image] = { class_type: "LoadImage", inputs: { image: p.image } };
  g[DEPTH_NODES.patch] = { class_type: "ModelPatchLoader", inputs: { name: p.adapter } };
  g[DEPTH_NODES.apply] = {
    class_type: "AnimaLLLiteApply",
    inputs: { model, model_patch: [DEPTH_NODES.patch, 0], image: [DEPTH_NODES.image, 0], strength: p.strength, start_percent: p.startPercent, end_percent: p.endPercent },
  };
  ks.inputs.model = [DEPTH_NODES.apply, 0];
  return g;
}

/** The Depth nodes feeding KSampler.model, or null. Works on any node ids (old saved graphs included). */
export function depthOf(graph: Graph): { apply: string; image?: string; patch?: string; imageName?: string; adapter?: string } | null {
  const ks = graph[FIELDS.seed.node];
  const l = linkOf(ks?.inputs?.model);
  const apply = l && graph[l[0]];
  if (!l || apply?.class_type !== "AnimaLLLiteApply") return null;
  const img = linkOf(apply.inputs.image);
  const patch = linkOf(apply.inputs.model_patch);
  const imgNode = img && graph[img[0]];
  const patchNode = patch && graph[patch[0]];
  return {
    apply: l[0],
    ...(img && imgNode?.class_type === "LoadImage" ? { image: img[0], imageName: String(imgNode.inputs.image) } : {}),
    ...(patch && patchNode?.class_type === "ModelPatchLoader" ? { patch: patch[0], adapter: String(patchNode.inputs.name) } : {}),
  };
}

/** A copy whose Depth LoadImage points to `image` (used only for a file verified to have the same SHA-256 as before). */
export function setDepthImage(graph: Graph, image: string): Graph {
  const g = structuredClone(graph);
  const d = depthOf(g);
  if (!d?.image) throw new WorkflowError("the graph has no Depth LoadImage node");
  g[d.image].inputs.image = image;
  return g;
}

/**
 * Returns a copy without the Depth nodes: KSampler.model is linked back to the model AnimaLLLiteApply received (the original link).
 * The LoadImage / ModelPatchLoader nodes are removed only when nothing else uses them.
 */
export function removeDepth(graph: Graph): Graph {
  const g = structuredClone(graph);
  const d = depthOf(g);
  if (!d) throw new WorkflowError("the graph has no Depth nodes");
  const original = linkOf(g[d.apply].inputs.model);
  if (!original) throw new WorkflowError("AnimaLLLiteApply.model is not a link");
  g[FIELDS.seed.node].inputs.model = original;
  delete g[d.apply];
  const used = (id: string) => Object.values(g).some((n) => Object.values(n.inputs).some((v) => linkOf(v)?.[0] === id));
  for (const id of [d.image, d.patch]) if (id && !used(id)) delete g[id];
  return g;
}

/** Plan model id -> checkpoint file (from the shared catalog). All use the Anima graph; only the UNET differs. */
export const MODELS = Object.fromEntries(IMAGE_MODELS.map((m) => [m.id, m.checkpoint])) as Record<ImageModelId, string>;

export async function loadWorkflow(path: string): Promise<Graph> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    throw new WorkflowError(`Cannot read workflow ${path}: ${(e as Error).message}`);
  }
  let g: unknown;
  try {
    g = JSON.parse(raw);
  } catch {
    throw new WorkflowError(`Workflow ${path} is not valid JSON`);
  }
  if (typeof g !== "object" || g === null || Array.isArray(g)) {
    throw new WorkflowError("Workflow must be an API-format object {nodeId: {class_type, inputs}}");
  }
  return g as Graph;
}

/** Returns a modified deep copy; the original graph is never mutated. */
export function applyParams(graph: Graph, params: GenParams): Graph {
  const copy = structuredClone(graph);
  for (const key of Object.keys(FIELDS) as (keyof GenParams)[]) {
    const value = params[key];
    if (value === undefined) continue;
    const f = FIELDS[key];
    const node = copy[f.node];
    if (!node) throw new WorkflowError(`Node ${f.node} (${key}) not found in workflow`);
    if (node.class_type !== f.cls) {
      throw new WorkflowError(`Node ${f.node} is ${node.class_type}, expected ${f.cls}`);
    }
    if (!(f.input in node.inputs)) {
      throw new WorkflowError(`Node ${f.node} has no input "${f.input}"`);
    }
    if (typeof node.inputs[f.input] !== typeof value) {
      throw new WorkflowError(`Input ${f.node}.${f.input} expects ${typeof node.inputs[f.input]}, got ${typeof value}`);
    }
    node.inputs[f.input] = value;
  }
  if (!Number.isSafeInteger(params.seed) || params.seed < 0) {
    throw new WorkflowError("seed must be a non-negative safe integer");
  }
  return copy;
}

// ---------- Client ----------

type FetchFn = typeof fetch;

export class ComfyClient {
  constructor(
    readonly baseUrl = "http://127.0.0.1:8188",
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ComfyUnavailableError(`ComfyUI not reachable at ${this.baseUrl}: ${(e as Error).message}`);
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.req(path, init);
    const text = await r.text();
    if (!r.ok) throw new GenerationError(`HTTP ${r.status} on ${path}: ${text.slice(0, 1500)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GenerationError(`Invalid JSON from ${path}: ${text.slice(0, 200)}`);
    }
  }

  systemStats() {
    return this.json<{ system: { comfyui_version: string }; devices: unknown[] }>("/system_stats");
  }

  queue() {
    return this.json<{ queue_running: unknown[]; queue_pending: unknown[] }>("/queue");
  }

  objectInfo() {
    return this.json<Record<string, any>>("/object_info");
  }

  /** Checks node classes and model files used by the graph are installed. Returns a list of problems. */
  async checkDependencies(graph: Graph): Promise<string[]> {
    const info = await this.objectInfo();
    const problems: string[] = [];
    for (const [id, n] of Object.entries(graph)) {
      const def = info[n.class_type];
      if (!def) {
        problems.push(`node ${id}: class ${n.class_type} not installed`);
        continue;
      }
      const req = def.input?.required ?? {};
      for (const [name, spec] of Object.entries<any>(req)) {
        const options = Array.isArray(spec) ? spec[0] : undefined;
        const v = n.inputs[name];
        if (Array.isArray(options) && typeof v === "string" && !options.includes(v)) {
          problems.push(`node ${id}.${name}: "${v}" not in available options`);
        }
      }
    }
    return problems;
  }

  /**
   * NS-027: uploads one image into ComfyUI's input folder (never overwrites: ComfyUI keeps identical content under the same name and
   * renames a different file). Returns what ComfyUI stored.
   */
  async uploadImage(png: Buffer, name: string, subfolder: string): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(png)], { type: "image/png" }), name);
    form.append("subfolder", subfolder);
    form.append("type", "input");
    const r = await this.json<{ name?: string; subfolder?: string; type?: string }>("/upload/image", { method: "POST", body: form });
    if (typeof r.name !== "string") throw new GenerationError(`Upload answered without a file name: ${JSON.stringify(r).slice(0, 300)}`);
    return { name: r.name, subfolder: r.subfolder ?? "", type: r.type ?? "input" };
  }

  async submit(graph: Graph, clientId: string): Promise<string> {
    const body = await this.json<{ prompt_id?: string; node_errors?: unknown }>("/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    if (!body.prompt_id) throw new GenerationError(`No prompt_id in response: ${JSON.stringify(body).slice(0, 500)}`);
    return body.prompt_id;
  }

  /** Polls /history until the prompt finishes. Never touches the queue. */
  async waitForImages(promptId: string, timeoutMs = 600_000, pollMs = 1000): Promise<{ images: ImageRef[]; history: unknown }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const h = await this.json<Record<string, any>>(`/history/${promptId}`);
      const entry = h[promptId];
      if (entry) {
        const st = entry.status;
        if (st?.status_str === "error") {
          const msgs = JSON.stringify(st.messages ?? []).slice(0, 1500);
          throw new GenerationError(`Generation failed: ${msgs}`);
        }
        if (st?.completed) {
          const images: ImageRef[] = Object.values<any>(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
          if (images.length === 0) throw new GenerationError("Prompt completed but produced no images");
          return { images, history: entry };
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new GenerationError(`Timed out after ${timeoutMs} ms waiting for ${promptId}`);
  }

  async download(img: ImageRef): Promise<Buffer> {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const r = await this.req(`/view?${q}`);
    if (!r.ok) throw new GenerationError(`HTTP ${r.status} downloading ${img.filename}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new GenerationError("Downloaded file is not a PNG");
    return buf;
  }
}
