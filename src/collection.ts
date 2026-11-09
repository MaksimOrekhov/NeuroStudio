import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComfyUnavailableError, MODELS, applyParams, type ComfyClient, type Graph, type ImageRef } from "./comfy.ts";
import type { PromptPlan } from "./promptPlan.ts";

const SEED_MAX = 2 ** 48 - 1;

export interface Job {
  frame: number;
  /** 1-based seed variant of the frame; same prompt and settings, only the seed differs. */
  variant: number;
  /** File base name: scene-01 (single variation, legacy) or scene-01-v02. */
  file: string;
  model: keyof typeof MODELS;
  seed: number;
  summary: string;
  graph: Graph;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Builds 4 x variations jobs (variations = 1 keeps the legacy scene-NN names). Every variant of a frame uses
 * the same prompts and settings; only the seed differs, and all seeds are unique. Execution order groups
 * frames by model (fewer checkpoint reloads); frame numbers stay those of the plan.
 */
export function buildJobs(plan: PromptPlan, base: Graph, slug: string, variations = 1): Job[] {
  const used = new Set<number>();
  const jobs: Job[] = [];
  for (const f of plan.frames) {
    for (let variant = 1; variant <= variations; variant++) {
      let seed = randomInt(0, SEED_MAX);
      while (used.has(seed)) seed = randomInt(0, SEED_MAX);
      used.add(seed);
      const file = variations === 1 ? `scene-${pad(f.frame)}` : `scene-${pad(f.frame)}-v${pad(variant)}`;
      const graph = applyParams(base, {
        positive: f.positive,
        negative: f.negative,
        seed,
        unet: MODELS[f.model],
        filenamePrefix: `NeuroStudio/${slug}/${file}`,
      });
      jobs.push({ frame: f.frame, variant, file, model: f.model, seed, summary: f.summary, graph });
    }
  }
  return jobs.sort((a, b) => (a.model === b.model ? a.frame - b.frame || a.variant - b.variant : a.model === "crimson-oath" ? -1 : 1));
}

export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, 40) || "collection";
}

export interface FrameRecord {
  frame: number;
  /** Absent in collections made before NS-006: means variant 1. */
  variant?: number;
  model: string;
  seed: number;
  status: "pending" | "submitted" | "done" | "failed" | "timeout";
  promptId?: string;
  png?: string;
  seconds?: number;
  error?: string;
}

export interface Manifest {
  title: string;
  createdAt: string;
  status: "running" | "done" | "failed";
  dir: string;
  codex?: { seconds: number; tokens: unknown };
  comfySeconds?: number;
  /** Seed variants per frame (absent in older collections: 1). */
  variations?: number;
  frames: FrameRecord[];
}

type Client = Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download">;

/**
 * Runs the jobs one at a time. Never resubmits: a failed or timed-out job stops the run,
 * its prompt_id (if accepted) stays in the manifest. Does not touch the ComfyUI queue.
 */
export async function runCollection(opts: {
  plan: PromptPlan;
  jobs: Job[];
  dir: string;
  client: Client;
  codex?: Manifest["codex"];
  frameTimeoutMs?: number;
  log?: (s: string) => void;
  /** Called after every manifest save (progress for UIs). */
  onProgress?: (m: Manifest) => void;
}): Promise<Manifest> {
  const { plan, jobs, dir, client } = opts;
  const log = opts.log ?? (() => {});
  const frameTimeoutMs = opts.frameTimeoutMs ?? 20 * 60_000;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt-plan.json"), JSON.stringify(plan, null, 2));

  const m: Manifest = {
    title: plan.concept.title,
    createdAt: new Date().toISOString(),
    status: "running",
    dir,
    codex: opts.codex,
    variations: Math.max(1, ...jobs.map((j) => j.variant)),
    frames: jobs.map((j) => ({ frame: j.frame, variant: j.variant, model: j.model, seed: j.seed, status: "pending" })),
  };
  const save = async () => {
    await writeFile(join(dir, "collection.json"), JSON.stringify(m, null, 2));
    opts.onProgress?.(m);
  };
  const t0 = Date.now();

  try {
    await client.systemStats();
    for (const model of new Set(jobs.map((j) => j.model))) {
      const job = jobs.find((j) => j.model === model)!;
      const problems = await client.checkDependencies(job.graph);
      if (problems.length) throw new Error(`Missing dependencies for ${model}:\n  ${problems.join("\n  ")}`);
    }
    await save();

    for (const [i, job] of jobs.entries()) {
      const rec = m.frames[i];
      const name = job.file;
      const tj = Date.now();
      log(`[${i + 1}/${jobs.length}] ${name} ${job.model}: submitting`);
      rec.promptId = await client.submit(job.graph, randomUUID()); // failure here: nothing was accepted
      rec.status = "submitted";
      await save();
      let images: ImageRef[];
      let history: unknown;
      try {
        ({ images, history } = await client.waitForImages(rec.promptId, frameTimeoutMs));
      } catch (e) {
        // Indeterminate (timeout or ComfyUI vanished while the accepted job may still run): keep prompt_id, never resubmit.
        rec.status = /timed out/i.test((e as Error).message) || e instanceof ComfyUnavailableError ? "timeout" : "failed";
        throw e;
      }
      const png = await client.download(images[0]);
      rec.png = `${name}.png`;
      rec.seconds = (Date.now() - tj) / 1000;
      rec.status = "done";
      await writeFile(join(dir, rec.png), png);
      await writeFile(
        join(dir, `${name}.json`),
        JSON.stringify({ frame: job.frame, model: job.model, summary: job.summary, variant: job.variant, seed: job.seed, promptId: rec.promptId, seconds: rec.seconds, image: images[0], graph: job.graph, history }, null, 2),
      );
      await save();
      log(`    done in ${rec.seconds.toFixed(1)}s -> ${rec.png}`);
    }
    m.status = "done";
  } catch (e) {
    m.status = "failed";
    const cur = m.frames.find((f) => f.status === "submitted" || f.status === "failed" || f.status === "timeout") ?? m.frames.find((f) => f.status === "pending");
    if (cur) {
      cur.error = (e as Error).message;
      if (cur.status === "pending" || cur.status === "submitted") cur.status = "failed";
    }
    throw Object.assign(e as Error, { manifest: m });
  } finally {
    m.comfySeconds = (Date.now() - t0) / 1000;
    await save();
  }
  return m;
}
