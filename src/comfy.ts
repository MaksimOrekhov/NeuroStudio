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
