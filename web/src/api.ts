import type { Composition } from "../../src/composition";
import type { ErrorCode } from "./errorCodes";
import type { ImageModelAssignment } from "../../src/imageModels";
import type { Conditioning, DepthSpec } from "../../src/depth";
import type { Settings } from "../../src/composition";

// Types mirror server/collections.ts (CollectionView), server/runner.ts (RunState) and server/runs.ts (RunView).

export interface Frame {
  frame: number;
  variant: number;
  model: string;
  summary?: string;
  /** Russian shot brief (Plan v3); older collections only have `summary`. */
  summaryRu?: string;
  status: string;
  seed: number;
  promptId?: string;
  image?: string;
  error?: string;
  /** Set on variants made by targeted regeneration (NS-017): the variant they were created from. */
  sourceVariant?: number;
  /** The prompt was edited before regenerating. */
  promptEdited?: boolean;
  /** NS-026: pose from the library (auto pose mode). label = human-readable name; absent when Codex invented the pose. */
  pose?: { id: string; label?: string; description?: string; promptAsPlanned: boolean };
  /** NS-027: conditioning actually used (depth map or text-only with the reason). Absent when Depth was not requested. */
  conditioning?: Conditioning;
  /** NS-031: set on variants made by local repair (Inpainting v2) of `sourceVariant`. Such a variant cannot be regenerated. */
  repair?: RepairSummary;
}

/** NS-031: mirror of RepairSummary in src/collection.ts. */
export interface RepairSummary {
  method: "inpainting-v2";
  preset: "remove" | "fix" | "custom";
  denoise: number;
  strength: number;
  region: 512 | 1024;
  crop: [number, number, number, number];
  text: string;
  files: { mask: string; blend: string; raw: string };
}

export interface Feedback {
  version: 1;
  rating: number | null;
  tags: string[];
  note: string;
  updatedAt: string;
}

export interface ImageFeedback {
  verdict: "like" | "dislike";
  tags: string[];
  note?: string;
  updatedAt: string;
}

/** NS-019: the verdict between two variants of one frame; variantA < variantB, winnerVariant null = equal. */
export interface Comparison {
  frame: number;
  variantA: number;
  variantB: number;
  winnerVariant: number | null;
  updatedAt: string;
}

export interface ExportStatus {
  ready: boolean;
  resolved: number;
  message?: string;
}

export interface GenerationMeta {
  theme: string | null;
  imageModels: ImageModelAssignment;
  /** Resolved composition per frame (after inheritance); {} = Auto. */
  composition: Record<string, string>[] | null;
}

export interface Collection {
  id: string;
  title: string;
  titleRu?: string;
  description?: string;
  descriptionRu?: string;
  createdAt: string;
  status: "running" | "done" | "failed" | "interrupted";
  doneFrames: number;
  frames: Frame[];
  variations: number;
  /** 1-4; the server answers 4 for collections created before NS-014. */
  frameCount: number;
  generation?: GenerationMeta;
  selections: Record<string, number>;
  feedback: Feedback | null;
  /** Quality verdict and reasons per image, keyed "frame-variant". */
  imageFeedback: Record<string, ImageFeedback>;
  /** Set when image-feedback.json cannot be read: ratings cannot be saved. */
  imageFeedbackError?: string;
  export: ExportStatus;
  codex?: { seconds?: number; tokens?: unknown; model?: string | null; reasoningEffort?: string | null };
  comfySeconds?: number;
}

export interface RunState {
  status: "idle" | "planning" | "generating" | "completed" | "failed";
  theme?: string;
  collectionId?: string;
  title?: string;
  done: number;
  total: number;
  collection: number;
  collections: number;
  frames: number;
  variations: number;
  imageModels?: ImageModelAssignment;
  runId?: string;
  currentFrame?: number;
  /** NS-020: what Prompt Evolution did for this run. */
  evolution?: { enabled: boolean; applied: boolean; reason?: string; error?: string };
  /** NS-026: pose selection mode (absent = free). */
  poseSelection?: "free" | "auto";
  /** NS-027: Depth requested for this run; warning = why no frame can get a map right now. */
  depth?: { mode: "auto"; warning?: string };
  /** Present while/after a targeted regeneration of one image (same lock and state as a run). */
  regeneration?: { collectionId: string; frame: number; variant: number; sourceVariant: number; repair?: true };
  finished: string[];
  error?: string;
  errorCode?: ErrorCode;
  startedAt?: string;
  finishedAt?: string;
}

export interface ApiStatus {
  comfy: { ok: boolean; version?: string; queueRunning?: number; queuePending?: number; error?: string };
  run: RunState;
}

/** One record of GET /api/runs (output/batches/<id>/batch-plan.json). */
export interface RunRecord {
  id: string;
  createdAt: string;
  status: "running" | "completed" | "failed" | "interrupted";
  theme: string | null;
  collections: number;
  frames: number;
  variations: number;
  totalImages: number;
  imageModels: ImageModelAssignment | null;
  collectionIds: string[];
  error?: string;
  errorCode?: ErrorCode;
  codex?: { model?: string | null; reasoningEffort?: string | null; seconds?: number };
}

/** An API error: stable machine `code` (may be missing for network/HTTP problems) and the original technical message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: ErrorCode,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new ApiError((e as Error).message || "network error"); // no code: the server could not be reached
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const b = body as { error?: string; code?: ErrorCode };
    throw new ApiError(b.error ?? `HTTP ${r.status}`, b.code, r.status);
  }
  return body as T;
}

const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The server never returns more than 50 collections per request. */
export const COLLECTIONS_LIMIT = 50;
export const RUNS_LIMIT = 50;

export const getStatus = () => json<ApiStatus>("/api/status");
export const getCollections = (limit = COLLECTIONS_LIMIT) => json<Collection[]>(`/api/collections?limit=${limit}`);
export const getCollection = (id: string) => json<Collection>(`/api/collections/${encodeURIComponent(id)}`);
export const getRuns = (limit = RUNS_LIMIT) => json<RunRecord[]>(`/api/runs?limit=${limit}`);

/** Body of POST /api/autopilot/start (NS-014 contract). */
export interface StartRequest {
  theme: string;
  collections: number;
  frames: number;
  variations: number;
  imageModels: { mode: "auto" } | { mode: "only"; model: string } | { mode: "custom"; perScene: string[] };
  composition?: Composition;
  codexModel?: string;
  codexReasoningEffort?: string;
  /** NS-020: add the Preference Memory to the Codex request (sent only when switched on). */
  promptEvolution?: boolean;
  /** NS-026: sent only for the library mode; absent = free. */
  poseSelection?: "auto";
  /** NS-027: sent only when switched on (needs poseSelection "auto"); absent = off. */
  depthConditioning?: "auto";
}

/** GET /api/depth/status (NS-027): is the local library readable and does ComfyUI list the nodes and the adapter (presence only)? */
export interface DepthStatus {
  library: { available: true; version: number; adapter: string; maps: { id: string; poseId: string; status: string; views: string[]; crops: string[]; models: string[] }[]; excluded: { id?: string; poseId?: string; problem: string }[] } | { available: false; error: string };
  comfy: { nodes: boolean; adapter: boolean; error?: string; check: "listed-by-comfyui" } | null;
  instructions?: string;
}
export const getDepthStatus = () => json<DepthStatus>("/api/depth/status");
export const startRun = (req: StartRequest) =>
  json<RunState>("/api/autopilot/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });

export const imageUrl = (id: string, file: string, download = false) => `/api/collections/${encodeURIComponent(id)}/images/${file}${download ? "?download=1" : ""}`;
export const thumbUrl = (id: string, file: string) => `/api/collections/${encodeURIComponent(id)}/thumbs/${file}`;
export const exportUrl = (id: string) => `/api/collections/${encodeURIComponent(id)}/export`;

export const selectBest = (id: string, frame: number, variant: number | null) =>
  json<{ selections: Record<string, number>; export: ExportStatus }>(`/api/collections/${encodeURIComponent(id)}/selection`, put({ frame, variant }));
export const saveFeedback = (id: string, fb: { rating: number | null; tags: string[]; note: string }) =>
  json<{ feedback: Feedback | null }>(`/api/collections/${encodeURIComponent(id)}/feedback`, put(fb));

export type VariantPrompt =
  | { frame: number; variant: number; available: true; model: string; positive: string; promptEdited: boolean; depth?: { applied: true; mapId?: string; spec?: DepthSpec; requirements: Settings } }
  | { frame: number; variant: number; available: false; code: ErrorCode; reason: string };
const base = (id: string) => `/api/collections/${encodeURIComponent(id)}`;
export const getVariantPrompt = (id: string, frame: number, variant: number) => json<VariantPrompt>(`${base(id)}/frames/${frame}/variants/${variant}/prompt`);
/** One new variant of one frame; `positive` only when the user edited the prompt. */
export const startRegeneration = (id: string, frame: number, req: { sourceVariant: number; positive?: string; depth?: "keep" | "drop" }) =>
  json<RunState>(`${base(id)}/frames/${frame}/regenerate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });

/** NS-031: GET .../variants/:variant/repair */
export type RepairInfo =
  | {
      frame: number;
      variant: number;
      available: true;
      model: string;
      width: number;
      height: number;
      repaired: boolean;
      regions: (512 | 1024)[];
      presets: { remove: { denoise: number }; fix: { denoise: number } };
      strength: number;
      growPx: number;
      featherPx: number;
      maxMaskFraction: number;
      denoiseMin: number;
      denoiseMax: number;
      textMax: number;
      adapter: string;
    }
  | { frame: number; variant: number; available: false; code: ErrorCode; reason: string };
/** NS-031: GET /api/repair/status (presence of nodes, mask input and adapter as listed by ComfyUI; the hash is not checked). */
export interface RepairStatus {
  ready: boolean;
  nodes: boolean;
  maskInput: boolean;
  adapter: boolean;
  problems: string[];
  error?: string;
  adapterFile: string;
  adapterSha256: string;
  models: string[];
  instructions?: string;
}
export interface RepairRequest {
  sourceVariant: number;
  /** data:image/png;base64 — the painted mask at the image's own size; white = repair. */
  mask: string;
  text: string;
  denoise: number;
  region: 512 | 1024;
  preset: "remove" | "fix" | "custom";
}
export const getRepairInfo = (id: string, frame: number, variant: number) => json<RepairInfo>(`${base(id)}/frames/${frame}/variants/${variant}/repair`);
export const getRepairStatus = () => json<RepairStatus>("/api/repair/status");
/** One repaired variant of one frame (Inpainting v2). 202 = accepted; the result arrives through status polling. */
export const startRepair = (id: string, frame: number, req: RepairRequest) =>
  json<RunState>(`${base(id)}/frames/${frame}/repair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });

export interface CodexModels {
  source: "cache" | "bundled" | "none";
  error?: string;
  models: { id: string; name: string; defaultEffort?: string; efforts: { id: string; label: string }[] }[];
}
export const getCodexModels = () => json<CodexModels>("/api/codex/models");

export type ImageFeedbackInput = { verdict: "like" | "dislike" | null; tags: string[] } | { note: string };
export const saveImageFeedback = (id: string, frame: number, variant: number, fb: ImageFeedbackInput) =>
  json<{ feedback: ImageFeedback | null }>(`/api/collections/${encodeURIComponent(id)}/frames/${frame}/variants/${variant}/feedback`, put(fb));

export const getComparisons = (id: string) => json<{ comparisons: Record<string, Comparison> }>(`/api/collections/${encodeURIComponent(id)}/comparisons`);
export const saveComparison = (id: string, frame: number, body: { variantA: number; variantB: number; winnerVariant: number | null }) =>
  json<{ comparison: Comparison }>(`/api/collections/${encodeURIComponent(id)}/frames/${frame}/comparisons`, put(body));

/** GET /api/prompt-evolution/preview (NS-020): mirrors server/promptEvolution.ts. */
export interface TagStat {
  tag: string;
  count: number;
  independent: number;
  collections: number;
  confidence: "stable" | "low" | "mixed";
}
export interface EvolutionPreview {
  memory: {
    status: "empty" | "low" | "ready";
    sample: { collections: number; collectionsWithSignals: number; ratedImages: number; bestImages: number; comparisons: number; comparedImages: number; ratedCollections: number };
    evidence: { likes: number; dislikes: number; best: number; arenaPreferred: number; arenaLessPreferred: number };
    positive: TagStat[];
    negative: TagStat[];
    collection: { positive: TagStat[]; negative: TagStat[]; ratings: { positive: number; neutral: number; negative: number; confidence: TagStat["confidence"] } };
    reviews: ({ collectionId: string; note: string } & ({ scope: "collection" } | { scope: "image"; frame: number; variant: number; verdict: ImageFeedback["verdict"] }))[];
    features: { feature: string; value: string; likes: number; dislikes: number; collections: number; confidence: TagStat["confidence"] }[];
    featureCoverage: { sidecars: number; identified: number };
    recommendations: string[];
    models: Record<string, { ratedImages: number; likes: number; dislikes: number; best: number; positive: TagStat[]; negative: TagStat[] }>;
    warnings: { collectionId: string; source: string; message: string }[];
  };
  text: string;
  chars: number;
  applied: boolean;
}
export const getEvolutionPreview = () => json<EvolutionPreview>("/api/prompt-evolution/preview");
