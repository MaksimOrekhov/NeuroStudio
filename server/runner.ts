import { randomInt } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexSelection } from "../src/codexModels.ts";
import { MODELS, applyParams, type ComfyClient, type Graph } from "../src/comfy.ts";
import type { BatchOptions, BatchResult } from "../src/codex.ts";
import { resolveComposition, type Composition } from "../src/composition.ts";
import { buildJobs, runCollection, slugify, type FrameDepth, type Generation, type Manifest } from "../src/collection.ts";
import { parseDepthChoice, type DepthChoice, type DepthMode } from "../src/depth.ts";
import { DEPTH_DIR, MapIdentityError, adapterInstructions, appliedRecord, decideFrame, depthEnvironment, loadDepthLibrary, textRecord, uploadMap, type DepthEnvironment, type LibraryResult } from "../src/depthLibrary.ts";
import type { PromptPlan } from "../src/promptPlan.ts";
import { MAX_FRAMES, autoMix, type ImageModelAssignment, type ImageModelId } from "../src/imageModels.ts";
import { runErrorCode, type ErrorCode } from "../src/errors.ts";
import { listCollections } from "./collections.ts";
import { buildPreferenceContext } from "./promptEvolution.ts";
import { loadVisualHistory } from "../src/visualHistory.ts";
import { writeAtomic } from "../src/persistence.ts";
import { RegenError, loadSource, parseFrame, parsePositive, parseVariant, frameCountOf, prepareRegenDepth, reserve, runRegeneration } from "../src/regenerate.ts";
import { anatomyCaution, countPoseUses, framePoseIds, listedIds, loadPoseCatalog, selectPoses, type PoseMode, type PoseSelection } from "../src/poses.ts";
import { VIEW_HISTORY_COLLECTIONS, viewHistory, viewNote } from "./poseHistory.ts";

/** NS-026: newest collections whose saved poseIds lower a pose's priority in the next sample. */
export const RECENT_POSE_COLLECTIONS = 12;

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
  /** NS-026: pose selection mode of this run (absent = free, as before). */
  poseSelection?: PoseMode;
  /** NS-027: Depth requested for this run (absent = off, as before); warning = why no frame can get a map right now. */
  depth?: { mode: "auto"; warning?: string };
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
  /** objectInfo / uploadImage are needed only for Depth (NS-027); without them Depth falls back to text-only. */
  client: Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download"> & Partial<Pick<ComfyClient, "objectInfo" | "uploadImage">>;
  /** ONE call for the whole batch. */
  plan: (o: BatchOptions) => Promise<BatchResult>;
  baseGraph: Graph;
  /** For tests: replaces the local Preference Memory builder. */
  preferenceContext?: typeof buildPreferenceContext;
  /** For tests: fixes the pose sample seed (default: random per run, always saved in batch-plan.json). */
  poseSeed?: () => number;
  /** For tests: another pose catalog file. */
  poseCatalogPath?: string;
  /** NS-027: local Depth library folder (default local/depth or NEUROSTUDIO_DEPTH_DIR). */
  depthDir?: string;
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
  /** NS-026: "auto" = Codex picks per frame from a catalog sample in the same request; "free" = exactly the pre-NS-026 request. */
  poseSelection: PoseMode;
  /** NS-027: "auto" = a verified depth map is added to frames that clearly fit it (needs poseSelection "auto"); "off" = as before. */
  depth: DepthMode;
}

interface DepthRun {
  lib: LibraryResult;
  env: DepthEnvironment | null;
  /** Map id -> LoadImage value, or the upload error (one attempt per run). */
  uploads: Map<string, string | Error>;
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
    poseSelection: PoseMode = "free",
    depth: DepthMode = "off",
  ): Promise<RunState> {
    if (depth === "auto" && poseSelection !== "auto") throw new RunError("INVALID_GENERATION_SETTINGS", 'depth conditioning needs poseSelection "auto"', 400);
    if (this.busy) throw new RunError("ALREADY_RUNNING", "An Autopilot run is already in progress", 409);
    this.busy = true; // synchronous lock: a concurrent second call cannot pass this line
    const imageModels: ImageModelAssignment = images ?? { mode: "auto", models: autoMix(MAX_FRAMES) as ImageModelId[] };
    const settings: RunSettings = deepFreeze(
      structuredClone({ theme, collections: count, frames: imageModels.models.length, variations, imageModels, composition, codex, promptEvolution, poseSelection, depth }),
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
      ...(poseSelection === "auto" ? { poseSelection } : {}),
      ...(depth === "auto" ? { depth: { mode: "auto" as const } } : {}),
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
  async startRegeneration(req: { collectionId: string; frame: unknown; sourceVariant: unknown; positive?: unknown; depth?: unknown }): Promise<RunState> {
    if (this.busy) throw new RunError("ALREADY_RUNNING", "A generation is already in progress", 409);
    this.busy = true; // synchronous lock, shared with start()
    try {
      const { collectionsDir, log } = this.deps;
      const id = req.collectionId;
      const frame = parseFrame(req.frame, await frameCountOf(collectionsDir, id));
      const sourceVariant = parseVariant(req.sourceVariant, "sourceVariant");
      const positive = parsePositive(req.positive);
      let choice: DepthChoice | undefined;
      try {
        choice = parseDepthChoice(req.depth);
      } catch (e) {
        throw new RegenError("INVALID_REQUEST", (e as Error).message, 400);
      }
      const src = await loadSource(collectionsDir, id, frame, sourceVariant);
      try {
        await this.deps.client.systemStats();
      } catch (e) {
        throw new RunError("COMFY_UNREACHABLE", `ComfyUI is not reachable: ${(e as Error).message}. Start ComfyUI and try again.`, 503);
      }
      // NS-027: keep/drop the source's depth map is settled BEFORE the new slot is reserved (a conflict reserves nothing).
      const depth = await prepareRegenDepth({ src, positive, choice, client: this.deps.client, depthDir: this.deps.depthDir ?? DEPTH_DIR, poseCatalogPath: this.deps.poseCatalogPath });
      const r = await reserve(collectionsDir, id, src, positive, depth);
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

  /** NS-027: loads the library and asks ComfyUI (once) whether the Depth nodes and the adapter are there. Never throws. */
  private async prepareDepth(generation: Generation, batch: { depth: unknown }): Promise<DepthRun> {
    let lib: LibraryResult;
    try {
      lib = loadDepthLibrary(this.deps.depthDir ?? DEPTH_DIR, loadPoseCatalog(this.deps.poseCatalogPath));
    } catch (e) {
      lib = { ok: false, error: (e as Error).message };
    }
    const env = lib.ok ? await depthEnvironment(this.deps.client, lib.library.adapter.file) : null;
    generation.depth = { mode: "auto", libraryVersion: lib.ok ? lib.library.version : null };
    const warning = !lib.ok ? lib.error : !env?.nodes ? `ComfyUI has no Anima LLLite nodes${env?.error ? `: ${env.error}` : ""}` : !env.adapter ? adapterInstructions(lib.library) : undefined;
    batch.depth = {
      mode: "auto",
      library: lib.ok
        ? { available: true, version: lib.library.version, adapter: lib.library.adapter.file, maps: lib.library.maps.map((m) => ({ id: m.id, poseId: m.poseId, status: m.status, sha256: m.sha256 })), excluded: lib.library.excluded }
        : { available: false, error: lib.error },
      environment: env && { ...env, check: "listed-by-comfyui" },
      collections: [],
    };
    this.state = { ...this.state, depth: { mode: "auto", ...(warning ? { warning } : {}) } };
    return { lib, env, uploads: new Map() };
  }

  /**
   * NS-027: one decision per plan frame (shared by its seed variants). A map is uploaded once per run, before any job that uses it is
   * submitted; any problem up to that point means text-only generation for that frame, with the reason recorded.
   */
  private async decideDepth(plan: PromptPlan, composition: Composition | undefined, frames: number, run: DepthRun): Promise<FrameDepth> {
    const req = resolveComposition(composition, frames);
    const out: FrameDepth = new Map();
    for (const f of plan.frames) {
      const probe = applyParams(this.deps.baseGraph, { positive: f.positive, negative: f.negative, seed: 0, unet: MODELS[f.model] });
      const d = decideFrame({ poseId: f.poseId, model: f.model, positive: f.positive, requirements: req[f.frame - 1] ?? {}, graph: probe }, run.lib, run.env);
      if (!d.ok || !run.lib.ok) {
        out.set(f.frame, { conditioning: d.ok ? textRecord("library-unavailable") : textRecord(d.reason, d.detail) });
        continue;
      }
      const lib = run.lib.library;
      let image = run.uploads.get(d.entry.id);
      if (image === undefined) {
        try {
          image = await uploadMap(this.deps.client, lib, d.entry);
        } catch (e) {
          image = e as Error;
        }
        run.uploads.set(d.entry.id, image);
      }
      if (image instanceof Error) {
        out.set(f.frame, { conditioning: textRecord(image instanceof MapIdentityError ? "map-unverified" : "upload-failed", image.message) });
        continue;
      }
      out.set(f.frame, {
        conditioning: appliedRecord(lib, d.entry, f.poseId!, f.model, image),
        params: { image, adapter: lib.adapter.file, strength: d.entry.depth.strength, startPercent: d.entry.depth.startPercent, endPercent: d.entry.depth.endPercent },
      });
    }
    return out;
  }

  private async execute(cfg: RunSettings) {
    const { theme, collections: count, frames, variations, imageModels, composition, codex: sel, promptEvolution, poseSelection, depth } = cfg;
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
      poseSelection: undefined as PoseSelection | undefined,
      depth: undefined as unknown,
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

      // NS-026: the pose sample is chosen locally and goes into the SAME single Codex request. Free mode skips all of this.
      let poses: { catalogVersion: number; sample: ReturnType<typeof selectPoses>; note?: string } | undefined;
      if (poseSelection === "auto") {
        const catalog = loadPoseCatalog(this.deps.poseCatalogPath);
        const plans: unknown[] = [];
        for (const c of recent.slice(0, RECENT_POSE_COLLECTIONS)) {
          try {
            plans.push(JSON.parse(await readFile(join(collectionsDir, c.id, "prompt-plan.json"), "utf8")));
          } catch {
            /* no readable plan: it counts for nothing */
          }
        }
        const seed = this.deps.poseSeed?.() ?? randomInt(0, 2 ** 31);
        const used = countPoseUses(plans);
        const cautious = anatomyCaution(ctx?.memory);
        const req = resolveComposition(composition, frames);
        const sample = selectPoses({ catalog, resolved: req, frames, collections: count, seed, recent: used, cautious });
        const ids = listedIds(sample, catalog.version);
        const listed = sample.filter((p) => ids.includes(p.id));
        // View order of recent collections (catalog AND free frames) -> a soft hint; an explicit last-frame view requirement wins.
        const views = viewHistory(plans, VIEW_HISTORY_COLLECTIONS);
        const note = viewNote(views, listed, req[frames - 1]);
        poses = { catalogVersion: catalog.version, sample, ...(note.text ? { note: note.text } : {}) };
        batch.poseSelection = {
          mode: "auto", catalogVersion: catalog.version, seed, sample: ids, recent: used, cautious,
          frames: framePoseIds(listed, req, frames),
          views: { ...views, finalSuggestions: note.finalSuggestions },
        };
        generation.pose = { mode: "auto", catalogVersion: catalog.version };
        await saveBatch(); // the sample is on disk before Codex sees it
      }
      // NS-027: the library and ComfyUI's Depth support are checked before Codex (and recorded), but change nothing in its request.
      const depthRun = depth === "auto" ? await this.prepareDepth(generation, batch) : undefined;
      if (depthRun) await saveBatch();

      const r = await this.deps.plan({ theme, avoid, count, composition, models: imageModels.models, model: sel.model, reasoningEffort: sel.reasoningEffort, ...(preferences ? { preferences } : {}), ...(history ? { history } : {}), ...(poses ? { poses } : {}) }); // all plans are validated before any GPU work
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
        const frameDepth = depthRun ? await this.decideDepth(plan, composition, frames, depthRun) : undefined;
        if (frameDepth) {
          (batch.depth as { collections: unknown[] }).collections.push({ collectionId: id, frames: [...frameDepth].map(([frame, d]) => ({ frame, ...d.conditioning })) });
          await saveBatch(); // the decisions are on disk before the first job of this collection is submitted
        }
        await runCollection({
          plan,
          jobs: buildJobs(plan, this.deps.baseGraph, slug, variations, poses?.catalogVersion, frameDepth),
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
