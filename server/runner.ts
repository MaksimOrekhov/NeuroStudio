import { join } from "node:path";
import type { ComfyClient, Graph } from "../src/comfy.ts";
import type { CodexOptions, CodexResult } from "../src/codex.ts";
import { buildJobs, runCollection, slugify, type Manifest } from "../src/collection.ts";
import { listCollections } from "./collections.ts";

export type RunStatus = "idle" | "planning" | "generating" | "completed" | "failed";

export interface RunState {
  status: RunStatus;
  theme?: string;
  collectionId?: string;
  title?: string;
  done: number;
  total: number;
  currentFrame?: number;
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
  plan: (o: CodexOptions) => Promise<CodexResult>;
  baseGraph: Graph;
  collectionsDir: string;
  log?: (s: string) => void;
}

/** Runs at most one Autopilot at a time, in the background. Nothing is ever resumed or resubmitted automatically. */
export class AutopilotRunner {
  private busy = false;
  state: RunState = { status: "idle", done: 0, total: 4 };

  constructor(private readonly deps: RunnerDeps) {}

  get active(): boolean {
    return this.busy;
  }

  async start(theme?: string): Promise<RunState> {
    if (this.busy) throw new RunError("already_running", "An Autopilot run is already in progress", 409);
    this.busy = true; // synchronous lock: a concurrent second call cannot pass this line
    try {
      await this.deps.client.systemStats();
    } catch (e) {
      this.busy = false;
      throw new RunError("comfy_unavailable", `ComfyUI is not reachable: ${(e as Error).message}. Start ComfyUI and try again.`, 503);
    }
    this.state = { status: "planning", theme, done: 0, total: 4, startedAt: new Date().toISOString() };
    void this.execute(theme)
      .catch((e) => {
        this.state = { ...this.state, status: "failed", error: (e as Error).message, finishedAt: new Date().toISOString() };
      })
      .finally(() => {
        this.busy = false;
      });
    return this.state;
  }

  private async execute(theme?: string) {
    const { collectionsDir, log } = this.deps;
    const avoid = (await listCollections(collectionsDir, 20)).map((c) => c.title);
    const r = await this.deps.plan({ theme, avoid });
    const plan = r.plan;
    const slug = slugify(plan.concept.title);
    const id = `${new Date().toISOString().slice(0, 10)}-${slug}-${Date.now().toString(36)}`;
    const jobs = buildJobs(plan, this.deps.baseGraph, slug);
    this.state = { ...this.state, status: "generating", collectionId: id, title: plan.concept.title };
    await runCollection({
      plan,
      jobs,
      dir: join(collectionsDir, id),
      client: this.deps.client,
      codex: { seconds: r.ms / 1000, tokens: r.tokens },
      log,
      onProgress: (m: Manifest) => {
        const cur = m.frames.find((f) => f.status === "submitted");
        this.state = { ...this.state, done: m.frames.filter((f) => f.status === "done").length, currentFrame: cur?.frame };
      },
    });
    this.state = { ...this.state, status: "completed", currentFrame: undefined, done: 4, finishedAt: new Date().toISOString() };
  }
}
