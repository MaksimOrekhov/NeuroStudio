import { randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { modelIndex, type ImageModelAssignment } from "./imageModels.ts";
import type { Resolved } from "./composition.ts";
import { ComfyUnavailableError, MODELS, applyDepth, applyParams, type ComfyClient, type DepthParams, type Graph, type ImageRef } from "./comfy.ts";
import type { Conditioning } from "./depth.ts";
import type { PromptPlan } from "./promptPlan.ts";
import { writeAtomic } from "./persistence.ts";
import { framePose, type FramePose } from "./poses.ts";

const SEED_MAX = 2 ** 48 - 1;

export interface Job {
  frame: number;
  /** 1-based seed variant of the frame; same prompt and settings, only the seed differs. */
  variant: number;
  /** File base name: scene-01 (single variation, legacy) or scene-01-v02. */
  file: string;
  model: PromptPlan["frames"][number]["model"];
  seed: number;
  summary: string;
  graph: Graph;
  /** NS-026: catalog pose of the plan frame (auto pose mode); every seed variant of the frame inherits it. */
  pose?: FramePose;
  /** NS-027: what was actually put into this job's graph when Depth was requested (absent when Depth is off). */
  conditioning?: Conditioning;
}

/** NS-027: per plan frame, the conditioning record and (when the map is applied) the Depth node parameters. */
export type FrameDepth = Map<number, { conditioning: Conditioning; params?: DepthParams }>;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Builds frames x variations jobs (variations = 1 keeps the legacy scene-NN names). Every variant of a frame uses
 * the same prompts and settings; only the seed differs, and all seeds are unique. Execution order groups
 * frames by model (fewer checkpoint reloads); frame numbers stay those of the plan.
 */
export function buildJobs(plan: PromptPlan, base: Graph, slug: string, variations = 1, poseCatalogVersion?: number, depth?: FrameDepth): Job[] {
  const used = new Set<number>();
  const jobs: Job[] = [];
  for (const f of plan.frames) {
    for (let variant = 1; variant <= variations; variant++) {
      let seed = randomInt(0, SEED_MAX);
      while (used.has(seed)) seed = randomInt(0, SEED_MAX);
      used.add(seed);
      const file = variations === 1 ? `scene-${pad(f.frame)}` : `scene-${pad(f.frame)}-v${pad(variant)}`;
      const params = applyParams(base, {
        positive: f.positive,
        negative: f.negative,
        seed,
        unet: MODELS[f.model],
        filenamePrefix: `NeuroStudio/${slug}/${file}`,
      });
      // NS-027: every seed variant of a frame gets the same decision; the map is added to this job's own copy only.
      const d = depth?.get(f.frame);
      const graph = d?.params ? applyDepth(params, d.params) : params;
      const pose = framePose(f.poseId, poseCatalogVersion);
      jobs.push({ frame: f.frame, variant, file, model: f.model, seed, summary: f.summary, graph, ...(pose ? { pose } : {}), ...(d ? { conditioning: structuredClone(d.conditioning) } : {}) });
    }
  }
  return jobs.sort((a, b) => (a.model === b.model ? a.frame - b.frame || a.variant - b.variant : modelIndex(a.model) - modelIndex(b.model)));
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
  /** NS-017: set only on variants made by targeted regeneration: the variant this one was created from. */
  sourceVariant?: number;
  /** NS-017: true when the positive prompt was edited before regenerating (absent otherwise). */
  promptEdited?: boolean;
  /** NS-026: the pose this image's prompt was PLANNED with (auto pose mode only); not a check of the image. promptAsPlanned=false after a prompt edit. */
  pose?: FramePose;
  /** NS-027: conditioning actually used (Depth map or text-only with the reason). Absent when Depth was not requested. */
  conditioning?: Conditioning;
  /** NS-031: set only on variants made by local repair (Inpainting v2) of `sourceVariant`. The full record is in the variant's sidecar. */
  repair?: RepairSummary;
}

/** NS-031: what the gallery needs to know about a repaired variant (no graph, no base parameters). */
export interface RepairSummary {
  method: "inpainting-v2";
  preset: "remove" | "fix" | "custom";
  denoise: number;
  strength: number;
  /** Processing area side in source pixels (512 is scaled x2 to the 1024 working size). */
  region: 512 | 1024;
  /** [x0, y0, x1, y1] of the processing area in the source image. */
  crop: [number, number, number, number];
  /** The repair description the user typed (English). */
  text: string;
  /** Files of this repair, relative to the collection folder. */
  files: { mask: string; blend: string; raw: string };
}

export interface Generation {
  theme: string | null;
  imageModels: ImageModelAssignment;
  /** Final per-frame composition requirements after inheritance (Auto fields absent); null = none given. */
  composition: Resolved | null;
  /** NS-026: present only when the run used the pose catalog. */
  pose?: { mode: "auto"; catalogVersion: number };
  /** NS-027: present only when Depth was requested; libraryVersion null = the library was unavailable. */
  depth?: { mode: "auto"; libraryVersion: number | null };
}

export interface Manifest {
  title: string;
  createdAt: string;
  status: "running" | "done" | "failed";
  dir: string;
  /** model / reasoningEffort: the user's explicit choice, null = Codex default. The effective model is not known to us. */
  codex?: { seconds: number; tokens: unknown; model?: string | null; reasoningEffort?: string | null };
  comfySeconds?: number;
  /** Seed variants per frame (absent in older collections: 1). */
  variations?: number;
  /** Frames in the collection (absent in collections made before NS-014: 4). */
  frameCount?: number;
  /** What this collection was generated with (NS-014). Absent in older collections. The Prompt Plan itself is not duplicated here. */
  generation?: Generation;
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
  generation?: Generation;
  frameTimeoutMs?: number;
  log?: (s: string) => void;
  /** Called after every manifest save (progress for UIs). */
  onProgress?: (m: Manifest) => void;
}): Promise<Manifest> {
  const { plan, jobs, dir, client } = opts;
  const log = opts.log ?? (() => {});
  const frameTimeoutMs = opts.frameTimeoutMs ?? 20 * 60_000;
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "prompt-plan.json"), JSON.stringify(plan, null, 2));

  const m: Manifest = {
    title: plan.concept.title,
    createdAt: new Date().toISOString(),
    status: "running",
    dir,
    codex: opts.codex,
    variations: Math.max(1, ...jobs.map((j) => j.variant)),
    frameCount: plan.frames.length,
    generation: opts.generation,
    frames: jobs.map((j) => ({ frame: j.frame, variant: j.variant, model: j.model, seed: j.seed, status: "pending", ...(j.pose ? { pose: j.pose } : {}), ...(j.conditioning ? { conditioning: j.conditioning } : {}) })),
  };
  const save = async () => {
    await writeAtomic(join(dir, "collection.json"), JSON.stringify(m, null, 2));
    opts.onProgress?.(m);
  };
  const t0 = Date.now();
  let current: FrameRecord | undefined;
  let failure: unknown;

  try {
    await client.systemStats();
    // One check per model, plus one per Depth map and model (NS-027): a Depth job uses nodes and files a plain job does not.
    const checked = new Set<string>();
    for (const job of jobs) {
      const key = job.conditioning?.mode === "depth" ? `${job.model} ${job.conditioning.comfyImage}` : job.model;
      if (checked.has(key)) continue;
      checked.add(key);
      const problems = await client.checkDependencies(job.graph);
      if (problems.length) throw new Error(`Missing dependencies for ${job.model}${job.conditioning?.mode === "depth" ? " with Depth" : ""}:\n  ${problems.join("\n  ")}`);
    }
    await save();

    for (const [i, job] of jobs.entries()) {
      const rec = m.frames[i];
      current = rec;
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
      const seconds = (Date.now() - tj) / 1000;
      await writeAtomic(join(dir, `${name}.png`), png);
      await writeAtomic(
        join(dir, `${name}.json`),
        JSON.stringify({ frame: job.frame, model: job.model, summary: job.summary, variant: job.variant, seed: job.seed, ...(job.pose ? { pose: job.pose } : {}), ...(job.conditioning ? { conditioning: job.conditioning } : {}), promptId: rec.promptId, seconds, image: images[0], graph: job.graph, history }, null, 2),
      );
      rec.png = `${name}.png`;
      rec.seconds = seconds;
      rec.status = "done";
      await save();
      log(`    done in ${rec.seconds.toFixed(1)}s -> ${rec.png}`);
      current = undefined;
    }
    m.status = "done";
  } catch (e) {
    failure = e;
    m.status = "failed";
    if (current) {
      current.error = (e as Error).message;
      if (current.status !== "timeout") current.status = "failed";
    }
    throw Object.assign(e as Error, { manifest: m });
  } finally {
    m.comfySeconds = (Date.now() - t0) / 1000;
    try {
      await save();
    } catch (e) {
      if (!failure) throw e;
      log(`Could not save collection status: ${(e as Error).message}`);
    }
  }
  return m;
}
