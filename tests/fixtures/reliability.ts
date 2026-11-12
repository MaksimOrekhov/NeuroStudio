import type { TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../../server/app.ts";
import { AutopilotRunner } from "../../server/runner.ts";
import { applyParams, loadWorkflow } from "../../src/comfy.ts";
import type { BatchOptions } from "../../src/codex.ts";
import { planV3 } from "./strictPlan.ts";

export const H = { host: "127.0.0.1:8787" };
export const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("test image".repeat(10))]);
export const errno = (code: string, detail = "injected") => Object.assign(new Error(`${code}: ${detail}`), { code });

export async function until(cond: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** No CLI, GPU, HTTP listener or paid service. The real app/runner use an in-process ComfyUI stand-in. */
export async function reliabilityEnv(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ns21-"));
  const collectionsDir = join(root, "collections");
  const batchesDir = join(root, "batches");
  const graph = await loadWorkflow(resolve(import.meta.dirname, "../../workflows/anima-crimson-oath.api.json"));
  const fake = { submits: [] as string[], plans: [] as BatchOptions[], gate: null as Promise<void> | null, planError: null as Error | null };
  const client = {
    systemStats: async () => ({ system: { comfyui_version: "test" }, devices: [] }),
    queue: async () => ({ queue_running: [], queue_pending: [] }),
    checkDependencies: async () => [],
    submit: async () => { const id = `pid-${fake.submits.length + 1}`; fake.submits.push(id); return id; },
    waitForImages: async () => { if (fake.gate) await fake.gate; return { images: [{ filename: "test.png", subfolder: "", type: "output" }], history: {} }; },
    download: async () => png,
  };
  const runner = new AutopilotRunner({ client, baseGraph: graph, collectionsDir, batchesDir,
    plan: async (opts) => {
      fake.plans.push(opts);
      if (fake.planError) throw fake.planError;
      return { plans: Array.from({ length: opts.count }, (_, i) => planV3(`Test ${i}`, opts.models)), raw: "{}", ms: 1, tokens: null };
    },
  });
  const app = buildApp({ runner, collectionsDir, batchesDir, comfyUrl: "http://unused", port: 8787, statusClient: client });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: H })).json();
  const put = (url: string, body: unknown) => app.inject({ method: "PUT", url, headers: H, payload: body as never });
  const make = async (id: string, createdAt = "2026-01-01T00:00:00Z") => {
    const dir = join(collectionsDir, id);
    await mkdir(dir, { recursive: true });
    const frames = [1, 2, 3].flatMap((frame) => [1, 2].map((variant) => ({ frame, variant, model: "crimson-oath", seed: frame * 10 + variant, status: "done", png: `scene-0${frame}-v0${variant}.png` })));
    await writeFile(join(dir, "collection.json"), JSON.stringify({ title: id, createdAt, status: "done", frameCount: 3, variations: 2, frames }));
    for (const f of frames) {
      await writeFile(join(dir, f.png), png);
      await writeFile(join(dir, f.png.replace(/\.png$/, ".json")), JSON.stringify({ graph: applyParams(graph, { positive: "silver hair, standing in a garden", seed: f.seed, filenamePrefix: `NeuroStudio/${id}/${f.png}` }) }));
    }
    return dir;
  };
  return { root, collectionsDir, batchesDir, graph, fake, client, runner, app, get, put, make, settle: () => until(() => !runner.active) };
}
