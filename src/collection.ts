import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODELS, applyParams, type ComfyClient, type Graph, type ImageRef } from "./comfy.ts";
import type { PromptPlan } from "./promptPlan.ts";

const SEED_MAX = 2 ** 48 - 1;

export interface Job {
  frame: number;
  model: keyof typeof MODELS;
  seed: number;
  summary: string;
  graph: Graph;
}

/**
 * Builds the four jobs. Execution order groups frames by model (fewer checkpoint reloads);
 * frame numbers stay those of the plan.
 */
export function buildJobs(plan: PromptPlan, base: Graph, slug: string, seeds?: number[]): Job[] {
  const used = new Set<number>();
  const jobs = plan.frames.map((f, i) => {
    let seed = seeds?.[i] ?? randomInt(0, SEED_MAX);
    while (used.has(seed)) seed = randomInt(0, SEED_MAX);
    used.add(seed);
    const graph = applyParams(base, {
      positive: f.positive,
      negative: f.negative,
      seed,
      unet: MODELS[f.model],
      filenamePrefix: `NeuroStudio/${slug}/scene-${String(f.frame).padStart(2, "0")}`,
    });
    return { frame: f.frame, model: f.model, seed, summary: f.summary, graph };
  });
  return jobs.sort((a, b) => (a.model === b.model ? a.frame - b.frame : a.model === "crimson-oath" ? -1 : 1));
}

export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, 40) || "collection";
}

export interface FrameRecord {
  frame: number;
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
  frames: FrameRecord[];
}

type Client = Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download">;

const scene = (n: number) => `scene-${String(n).padStart(2, "0")}`;

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
    frames: jobs.map((j) => ({ frame: j.frame, model: j.model, seed: j.seed, status: "pending" })),
  };
  const save = () => writeFile(join(dir, "collection.json"), JSON.stringify(m, null, 2));
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
      const name = scene(job.frame);
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
        rec.status = /timed out/i.test((e as Error).message) ? "timeout" : "failed";
        throw e;
      }
      const png = await client.download(images[0]);
      rec.png = `${name}.png`;
      rec.seconds = (Date.now() - tj) / 1000;
      rec.status = "done";
      await writeFile(join(dir, rec.png), png);
      await writeFile(
        join(dir, `${name}.json`),
        JSON.stringify({ frame: job.frame, model: job.model, summary: job.summary, seed: job.seed, promptId: rec.promptId, seconds: rec.seconds, image: images[0], graph: job.graph, history }, null, 2),
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
