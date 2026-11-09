import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComfyClient, Graph } from "../src/comfy.ts";
import type { BatchOptions, BatchResult } from "../src/codex.ts";
import { buildJobs, runCollection, slugify, type Manifest } from "../src/collection.ts";
import { listCollections } from "./collections.ts";

export type RunStatus = "idle" | "planning" | "generating" | "completed" | "failed";

const FRAMES = 4; // scenes per collection

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
  /** Seed variants per scene. */
  variations: number;
  currentFrame?: number;
  /** Ids of collections already saved by this batch. */
  finished: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export class RunError extends Error {
  constructor(
    readonly code: "already_running" | "comfy_unavailable",
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

const idle = (): RunState => ({ status: "idle", done: 0, total: FRAMES, collection: 0, collections: 1, variations: 1, finished: [] });

/** Runs at most one batch at a time, in the background. Nothing is ever resumed or resubmitted automatically. */
export class AutopilotRunner {
  private busy = false;
  state: RunState = idle();

  constructor(private readonly deps: RunnerDeps) {}

  get active(): boolean {
    return this.busy;
  }

  async start(theme: string | undefined, count = 1, variations = 1): Promise<RunState> {
    if (this.busy) throw new RunError("already_running", "An Autopilot run is already in progress", 409);
    this.busy = true; // synchronous lock: a concurrent second call cannot pass this line
    try {
      await this.deps.client.systemStats();
    } catch (e) {
      this.busy = false;
      throw new RunError("comfy_unavailable", `ComfyUI is not reachable: ${(e as Error).message}. Start ComfyUI and try again.`, 503);
    }
    this.state = { ...idle(), status: "planning", theme, total: FRAMES * variations * count, collections: count, variations, startedAt: new Date().toISOString() };
    void this.execute(theme, count, variations)
      .catch((e) => {
        this.state = { ...this.state, status: "failed", error: (e as Error).message, finishedAt: new Date().toISOString() };
      })
      .finally(() => {
        this.busy = false;
      });
    return this.state;
  }

  private async execute(theme: string | undefined, count: number, variations: number) {
    const { collectionsDir, batchesDir, log } = this.deps;
    const avoid = (await listCollections(collectionsDir, 20)).map((c) => c.title);
    const r = await this.deps.plan({ theme, avoid, count }); // all plans are validated before any GPU work
    const batchDir = join(batchesDir, `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`);
    await mkdir(batchDir, { recursive: true });
    const batch = {
      createdAt: new Date().toISOString(),
      theme: theme ?? null,
      count,
      variations,
      status: "running" as "running" | "done" | "failed",
      codex: { seconds: r.ms / 1000, tokens: r.tokens },
      collectionIds: [] as string[],
      error: undefined as string | undefined,
      plans: r.plans,
    };
    const saveBatch = () => writeFile(join(batchDir, "batch-plan.json"), JSON.stringify(batch, null, 2));
    await saveBatch();

    try {
      for (const [i, plan] of r.plans.entries()) {
        const slug = slugify(plan.concept.title);
        const id = `${new Date().toISOString().slice(0, 10)}-${slug}-${Date.now().toString(36)}`;
        const base = i * FRAMES * variations;
        this.state = { ...this.state, status: "generating", collectionId: id, title: plan.concept.title, collection: i + 1, currentFrame: undefined };
        batch.collectionIds.push(id);
        await saveBatch();
        await runCollection({
          plan,
          jobs: buildJobs(plan, this.deps.baseGraph, slug, variations),
          dir: join(collectionsDir, id),
          client: this.deps.client,
          codex: { seconds: r.ms / 1000, tokens: r.tokens },
          log,
          onProgress: (m: Manifest) => {
            const cur = m.frames.find((f) => f.status === "submitted");
            this.state = { ...this.state, done: base + m.frames.filter((f) => f.status === "done").length, currentFrame: cur?.frame };
          },
        });
        this.state = { ...this.state, finished: [...this.state.finished, id] };
      }
      batch.status = "done";
      this.state = { ...this.state, status: "completed", currentFrame: undefined, done: FRAMES * variations * count, finishedAt: new Date().toISOString() };
    } catch (e) {
      batch.status = "failed";
      batch.error = (e as Error).message;
      throw e; // stops the batch: no further collections, nothing resubmitted
    } finally {
      await saveBatch();
    }
  }
}
