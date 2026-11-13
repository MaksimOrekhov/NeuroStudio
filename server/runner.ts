import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexSelection } from "../src/codexModels.ts";
import type { ComfyClient, Graph } from "../src/comfy.ts";
import type { BatchOptions, BatchResult } from "../src/codex.ts";
import { resolveComposition, type Composition } from "../src/composition.ts";
import { buildJobs, runCollection, slugify, type Generation, type Manifest } from "../src/collection.ts";
import { MAX_FRAMES, autoMix, type ImageModelAssignment, type ImageModelId } from "../src/imageModels.ts";
import { runErrorCode, type ErrorCode } from "../src/errors.ts";
import { listCollections } from "./collections.ts";
import { buildPreferenceContext } from "./promptEvolution.ts";
import { loadVisualHistory } from "../src/visualHistory.ts";
import { writeAtomic } from "../src/persistence.ts";
import { loadSource, parseFrame, parsePositive, parseVariant, frameCountOf, reserve, runRegeneration } from "../src/regenerate.ts";

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
  /** Set only while/after a targeted regeneration (NS-017) of one image: the same lock and state as a normal run. */
  regeneration?: { collectionId: string; frame: number; variant: number; sourceVariant: number };
  /** NS-020: what Prompt Evolution did for this run (set once the memory has been built). */
  evolution?: { enabled: boolean; applied: boolean; reason?: string; error?: string };
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
  /** For tests: replaces the local Preference Memory builder. */
  preferenceContext?: typeof buildPreferenceContext;
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
  /** NS-020: add Preference Memory to the (single) Codex request. */
  promptEvolution: boolean;
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

  /** `images` defaults to 4 frames, assigned by the shared Auto Mix catalog. */
  async start(
    theme: string | undefined,
    count = 1,
    variations = 1,
    composition?: Composition,
    codex: CodexSelection = {},
    images?: ImageModelAssignment,
    promptEvolution = false,
  ): Promise<RunState> {
    if (this.busy) throw new RunError("ALREADY_RUNNING", "An Autopilot run is already in progress", 409);
    this.busy = true; // synchronous lock: a concurrent second call cannot pass this line
    const imageModels: ImageModelAssignment = images ?? { mode: "auto", models: autoMix(MAX_FRAMES) as ImageModelId[] };
    const settings: RunSettings = deepFreeze(
      structuredClone({ theme, collections: count, frames: imageModels.models.length, variations, imageModels, composition, codex, promptEvolution }),
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

  /**
   * NS-017: creates ONE new variant of one frame from the saved graph of `sourceVariant`. Uses the same lock as start(): while a
   * batch or another regeneration runs this throws ALREADY_RUNNING (409). No Codex. Validation and the reservation of the new
   * slot in collection.json finish before this returns; the generation itself runs in the background.
   */
  async startRegeneration(req: { collectionId: string; frame: unknown; sourceVariant: unknown; positive?: unknown }): Promise<RunState> {
    if (this.busy) throw new RunError("ALREADY_RUNNING", "A generation is already in progress", 409);
    this.busy = true; // synchronous lock, shared with start()
    try {
      const { collectionsDir, log } = this.deps;
      const id = req.collectionId;
      const frame = parseFrame(req.frame, await frameCountOf(collectionsDir, id));
      const sourceVariant = parseVariant(req.sourceVariant, "sourceVariant");
      const positive = parsePositive(req.positive);
      const src = await loadSource(collectionsDir, id, frame, sourceVariant);
      try {
        await this.deps.client.systemStats();
      } catch (e) {
        throw new RunError("COMFY_UNREACHABLE", `ComfyUI is not reachable: ${(e as Error).message}. Start ComfyUI and try again.`, 503);
      }
      const r = await reserve(collectionsDir, id, src, positive);
      this.state = {
        ...idle(),
        status: "generating",
        collectionId: id,
        collection: 1,
        collections: 1,
        frames: 1,
        variations: 1,
        total: 1,
        currentFrame: frame,
        regeneration: { collectionId: id, frame, variant: r.variant, sourceVariant },
        startedAt: new Date().toISOString(),
      };
      void runRegeneration({ r, client: this.deps.client, log })
        .then(() => {
          this.state = { ...this.state, status: "completed", done: 1, currentFrame: undefined, finishedAt: new Date().toISOString() };
        })
        .catch((e) => {
          this.state = { ...this.state, status: "failed", error: (e as Error).message, errorCode: runErrorCode(e), currentFrame: undefined, finishedAt: new Date().toISOString() };
        })
        .finally(() => {
          this.busy = false;
        });
      return this.state;
    } catch (e) {
      this.busy = false;
      throw e;
    }
  }

  private async execute(cfg: RunSettings) {
    const { theme, collections: count, frames, variations, imageModels, composition, codex: sel, promptEvolution } = cfg;
    const { collectionsDir, batchesDir, log } = this.deps;
    const resolved = composition ? resolveComposition(composition, frames) : null;
    const generation: Generation = { theme: theme ?? null, imageModels, composition: resolved };
    // The run record exists BEFORE Codex is called, so a failed planning step is still in the history.
    const batchDir = join(batchesDir, `${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`);
    await mkdir(batchDir, { recursive: true });
    const codexMeta: { seconds?: number; tokens: unknown; model: string | null; reasoningEffort: string | null } = {
      tokens: null,
      model: sel.model ?? null,
      reasoningEffort: sel.reasoningEffort ?? null,
    };
    const batch = {
      createdAt: new Date().toISOString(),
      theme: theme ?? null,
      count,
      frames,
      variations,
      imageModels,
      composition: resolved, // what was requested per frame (after inheritance)
      promptEvolution: { enabled: promptEvolution, applied: false },
      status: "running" as "running" | "done" | "failed",
      codex: codexMeta,
      collectionIds: [] as string[],
      error: undefined as string | undefined,
      errorCode: undefined as ErrorCode | undefined,
      plans: [] as unknown[],
    };
    const saveBatch = () => writeAtomic(join(batchDir, "batch-plan.json"), JSON.stringify(batch, null, 2));
    try {
      await saveBatch();
      this.state = { ...this.state, runId: basename(batchDir) };

      // NS-020: Preference Memory is built by local code only (no Codex). If that fails the run goes on WITHOUT it and says so
      // (state.evolution + the snapshot); it never pretends to have been applied.
      const evo: { enabled: boolean; applied: boolean; reason?: string; error?: string } = { enabled: promptEvolution, applied: false };
      let preferences = "";
      let ctx: Awaited<ReturnType<typeof buildPreferenceContext>> | null = null;
      if (promptEvolution) {
        try {
          ctx = await (this.deps.preferenceContext ?? buildPreferenceContext)(collectionsDir);
          preferences = ctx.text;
          evo.applied = preferences.length > 0;
          if (!evo.applied) evo.reason = ctx.memory.status === "empty" ? "no ratings yet" : "not enough consistent data yet";
        } catch (e) {
          evo.error = (e as Error).message;
          evo.reason = "the preference memory could not be built; generation continues without it";
        }
      }
      batch.promptEvolution = { enabled: evo.enabled, applied: evo.applied };
      this.state = { ...this.state, evolution: evo };
      // The snapshot of what this run used. Written once, before Codex is called, and never changed afterwards.
      await writeAtomic(
        join(batchDir, "preference-context.json"),
        JSON.stringify({ version: 1, createdAt: new Date().toISOString(), enabled: evo.enabled, applied: evo.applied, reason: evo.reason, error: evo.error, memory: ctx?.memory ?? null, text: preferences }, null, 2),
      );
      await saveBatch();

      const recent = await listCollections(collectionsDir, 20);
      const avoid = recent.map((c) => c.title);
      const history = await loadVisualHistory(collectionsDir, recent); // NS-023: "" when nothing can be extracted reliably
      const r = await this.deps.plan({ theme, avoid, count, composition, models: imageModels.models, model: sel.model, reasoningEffort: sel.reasoningEffort, ...(preferences ? { preferences } : {}), ...(history ? { history } : {}) }); // all plans are validated before any GPU work
      codexMeta.seconds = r.ms / 1000;
      codexMeta.tokens = r.tokens;
      batch.plans = r.plans;
      await saveBatch();

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
          codex: { ...codexMeta, seconds: r.ms / 1000 },
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
      await saveBatch();
      this.state = { ...this.state, status: "completed", currentFrame: undefined, done: frames * variations * count, finishedAt: new Date().toISOString() };
    } catch (e) {
      batch.status = "failed";
      batch.error = (e as Error).message;
      batch.errorCode = runErrorCode(e);
      // Persist failures from preparation, snapshot, planning AND generation. Preserve the original error if this also fails.
      try {
        await saveBatch();
      } catch (saveError) {
        log?.(`Could not save failed run status: ${(saveError as Error).message}`);
      }
      throw e; // stops the batch: no further collections, nothing resubmitted
    }
  }
}
