import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexSelection } from "../src/codexModels.ts";
import type { ComfyClient, Graph } from "../src/comfy.ts";
import type { BatchOptions, BatchResult } from "../src/codex.ts";
import { resolveComposition, type Composition } from "../src/composition.ts";
import { buildJobs, runCollection, slugify, type Generation, type Manifest } from "../src/collection.ts";
import { MAX_FRAMES, autoMix, type ImageModelAssignment, type ImageModelId } from "../src/imageModels.ts";
import { runErrorCode, type ErrorCode } from "../src/errors.ts";
import { listCollections } from "./collections.ts";

export type RunStatus = "idle" | "planning" | "generating" | "completed" | "failed";

export interface RunState {
  status: RunStatus;
  theme?: string;
  /** Collection currently being generated (the one the gallery marks as running). */
  collectionId?: string;
  title?: string;
  /** Images completed / total across the whole batch. */
  done: number;
  total: number;
  /** 1-based index of the current collection and number of collections in the batch. */
  collection: number;
  collections: number;
  /** Frames per collection and seed variants per frame. */
  frames: number;
  variations: number;
  /** Image model per frame for this run (set at start, never changes). */
  imageModels?: ImageModelAssignment;
  /** Id of the batch folder in output/batches (= run id in GET /api/runs); set once the plan is saved. */
  runId?: string;
  currentFrame?: number;
  /** Ids of collections already saved by this batch. */
  finished: string[];
  /** Original technical message. */
  error?: string;
  /** Stable code of `error` (see src/errors.ts). */
  errorCode?: ErrorCode;
  startedAt?: string;
  finishedAt?: string;
}

export class RunError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface RunnerDeps {
  client: Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download">;
  /** ONE call for the whole batch. */
  plan: (o: BatchOptions) => Promise<BatchResult>;
  baseGraph: Graph;
  collectionsDir: string;
  batchesDir: string;
  log?: (s: string) => void;
}

const idle = (): RunState => ({ status: "idle", done: 0, total: MAX_FRAMES, collection: 0, collections: 1, frames: MAX_FRAMES, variations: 1, finished: [] });

/** Everything a run needs, validated once at start and frozen: later changes to the request or the UI form cannot affect it. */
export interface RunSettings {
  theme?: string;
  collections: number;
  frames: number;
  variations: number;
  imageModels: ImageModelAssignment;
  composition?: Composition;
  codex: CodexSelection;
}

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") Object.values(o).forEach(deepFreeze);
  return Object.freeze(o);
};

/** Runs at most one batch at a time, in the background. Nothing is ever resumed or resubmitted automatically. */
export class AutopilotRunner {
  private busy = false;
  state: RunState = idle();

  constructor(private readonly deps: RunnerDeps) {}

  get active(): boolean {
    return this.busy;
  }

  /** `images` defaults to the pre-NS-014 behaviour: 4 frames, Auto Mix (2 Crimson Oath + 2 Duskrose). */
  async start(
    theme: string | undefined,
    count = 1,
    variations = 1,
    composition?: Composition,
    codex: CodexSelection = {},
    images?: ImageModelAssignment,
  ): Promise<RunState> {
    if (this.busy) throw new RunError("ALREADY_RUNNING", "An Autopilot run is already in progress", 409);
    this.busy = true; // synchronous lock: a concurrent second call cannot pass this line
    const imageModels: ImageModelAssignment = images ?? { mode: "auto", models: autoMix(MAX_FRAMES) as ImageModelId[] };
    const settings: RunSettings = deepFreeze(
      structuredClone({ theme, collections: count, frames: imageModels.models.length, variations, imageModels, composition, codex }),
    );
    try {
      await this.deps.client.systemStats();
    } catch (e) {
      this.busy = false;
      throw new RunError("COMFY_UNREACHABLE", `ComfyUI is not reachable: ${(e as Error).message}. Start ComfyUI and try again.`, 503);
    }
    this.state = {
      ...idle(),
      status: "planning",
      theme,
      total: settings.frames * variations * count,
      collections: count,
      frames: settings.frames,
      variations,
      imageModels: settings.imageModels,
      startedAt: new Date().toISOString(),
    };
    void this.execute(settings)
      .catch((e) => {
        this.state = { ...this.state, status: "failed", error: (e as Error).message, errorCode: runErrorCode(e), finishedAt: new Date().toISOString() };
      })
      .finally(() => {
        this.busy = false;
      });
    return this.state;
  }

  private async execute(cfg: RunSettings) {
    const { theme, collections: count, frames, variations, imageModels, composition, codex: sel } = cfg;
    const { collectionsDir, batchesDir, log } = this.deps;
    const avoid = (await listCollections(collectionsDir, 20)).map((c) => c.title);
    const r = await this.deps.plan({ theme, avoid, count, composition, models: imageModels.models, model: sel.model, reasoningEffort: sel.reasoningEffort }); // all plans are validated before any GPU work
    const resolved = composition ? resolveComposition(composition, frames) : null;
    const generation: Generation = { theme: theme ?? null, imageModels, composition: resolved };
    const batchDir = join(batchesDir, `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`);
    await mkdir(batchDir, { recursive: true });
    const codexMeta = { seconds: r.ms / 1000, tokens: r.tokens, model: sel.model ?? null, reasoningEffort: sel.reasoningEffort ?? null };
    const batch = {
      createdAt: new Date().toISOString(),
      theme: theme ?? null,
      count,
      frames,
      variations,
      imageModels,
      composition: resolved, // what was requested per frame (after inheritance)
      status: "running" as "running" | "done" | "failed",
      codex: codexMeta,
      collectionIds: [] as string[],
      error: undefined as string | undefined,
      errorCode: undefined as ErrorCode | undefined,
      plans: r.plans,
    };
    const saveBatch = () => writeFile(join(batchDir, "batch-plan.json"), JSON.stringify(batch, null, 2));
    await saveBatch();
    this.state = { ...this.state, runId: basename(batchDir) };

    try {
      for (const [i, plan] of r.plans.entries()) {
        const slug = slugify(plan.concept.title);
        const id = `${new Date().toISOString().slice(0, 10)}-${slug}-${Date.now().toString(36)}`;
        const base = i * frames * variations;
        this.state = { ...this.state, status: "generating", collectionId: id, title: plan.concept.title, collection: i + 1, currentFrame: undefined };
        batch.collectionIds.push(id);
        await saveBatch();
        await runCollection({
          plan,
          jobs: buildJobs(plan, this.deps.baseGraph, slug, variations),
          dir: join(collectionsDir, id),
          client: this.deps.client,
          codex: codexMeta,
          generation,
          log,
          onProgress: (m: Manifest) => {
            const cur = m.frames.find((f) => f.status === "submitted");
            this.state = { ...this.state, done: base + m.frames.filter((f) => f.status === "done").length, currentFrame: cur?.frame };
          },
        });
        this.state = { ...this.state, finished: [...this.state.finished, id] };
      }
      batch.status = "done";
      this.state = { ...this.state, status: "completed", currentFrame: undefined, done: frames * variations * count, finishedAt: new Date().toISOString() };
    } catch (e) {
      batch.status = "failed";
      batch.error = (e as Error).message;
      batch.errorCode = runErrorCode(e);
      throw e; // stops the batch: no further collections, nothing resubmitted
    } finally {
      await saveBatch();
    }
  }
}
