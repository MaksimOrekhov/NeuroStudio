// Single catalog of image models (ComfyUI checkpoints) and the per-frame assignment rules (NS-014).
// No imports: it is used by the server, the CLI and (type/rule-wise) by the UI prototype.

/**
 * Every model a frame can use (single-model and Custom modes, old collections). An id is stable forever: it is stored in Prompt Plans,
 * manifests, sidecars, ratings and Prompt Evolution statistics, so a new checkpoint version gets a NEW id and an old id is never
 * re-pointed at another file (NS-027: "crimson-oath" stays v0.2, v0.3 is "crimson-oath-v03").
 */
export const IMAGE_MODELS = [
  { id: "crimson-oath", name: "Crimson Oath v0.2", checkpoint: "vetehineCrimsonOathILL_v02ANM.safetensors", color: "#f0607a" },
  { id: "crimson-oath-v03", name: "Crimson Oath v0.3", checkpoint: "v.0.3 ANM Vetehine Crimson Oath.safetensors", color: "#ff9b6a" },
  { id: "duskrose", name: "Duskrose v4", checkpoint: "Duskrose v4 ANM.safetensors", color: "#b48cff" },
  { id: "illustrijn", name: "IllustrijN", checkpoint: "IllustrijN.safetensors", color: "#54c9b0" },
] as const;

export type ImageModelId = (typeof IMAGE_MODELS)[number]["id"];
export const MODEL_IDS: ImageModelId[] = IMAGE_MODELS.map((m) => m.id);
export const isModelId = (x: unknown): x is ImageModelId => typeof x === "string" && (MODEL_IDS as string[]).includes(x);

/**
 * The models Auto Mix distributes frames over, in order: a subset of IMAGE_MODELS. Crimson Oath v0.2 stays selectable (single model,
 * Custom, old collections) but is no longer part of Auto Mix (NS-027). Server, CLI and UI all read this one list.
 */
export const AUTO_MIX_MODELS: readonly ImageModelId[] = ["crimson-oath-v03", "duskrose", "illustrijn"];

/** NS-031: models local repair (Anima LLLite Inpainting v2) was verified on in NS-030. Others are not declared compatible until checked. */
export const REPAIR_MODELS: readonly ImageModelId[] = ["crimson-oath-v03"];
/** Position in the catalog; used to group jobs by model. */
export const modelIndex = (id: string) => MODEL_IDS.indexOf(id as ImageModelId);

export const MAX_FRAMES = 4;

/**
 * Auto Mix: contiguous blocks in AUTO_MIX_MODELS order; the first models get the remainder.
 * With the current list: 1 -> C3, 2 -> C3 D, 3 -> C3 D I, 4 -> C3 C3 D I (C3 = Crimson Oath v0.3; the split is the pre-NS-027 one).
 */
export function autoMix(frames: number, models: readonly string[] = AUTO_MIX_MODELS): string[] {
  if (!models.length) return [];
  const base = Math.floor(frames / models.length);
  const extra = frames % models.length;
  return models.flatMap((m, i) => Array.from({ length: base + (i < extra ? 1 : 0) }, () => m));
}

export type ImageModelMode = "auto" | "only" | "custom";

/** What is stored in batch-plan.json / collection.json and returned to clients. */
export interface ImageModelAssignment {
  mode: ImageModelMode;
  /** Model per frame, index 0 = frame 1. */
  models: ImageModelId[];
}

export class ImageModelsError extends Error {}

/** Request shape of `imageModels`. */
export interface ImageModelsRequest {
  mode: ImageModelMode;
  /** mode "only" */
  model?: string;
  /** mode "custom": exactly one id per frame */
  perScene?: string[];
}

/**
 * Validates the untrusted `imageModels` request field for `frames` frames. undefined/null = Auto Mix.
 * Strict by design: a wrong setting is rejected, never silently replaced by Auto Mix.
 */
export function resolveImageModels(input: unknown, frames: number): ImageModelAssignment {
  if (input === undefined || input === null) return { mode: "auto", models: autoMix(frames) as ImageModelId[] };
  if (typeof input !== "object" || Array.isArray(input)) throw new ImageModelsError("imageModels must be an object");
  const { mode, model, perScene, ...rest } = input as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra) throw new ImageModelsError(`imageModels: unknown key "${extra}"`);
  if (mode === "auto") {
    if (model !== undefined || perScene !== undefined) throw new ImageModelsError('imageModels: mode "auto" takes no model or perScene');
    return { mode, models: autoMix(frames) as ImageModelId[] };
  }
  if (mode === "only") {
    if (perScene !== undefined) throw new ImageModelsError('imageModels: mode "only" takes no perScene');
    if (!isModelId(model)) throw new ImageModelsError(`imageModels.model: unknown image model ${JSON.stringify(model)}`);
    return { mode, models: Array.from({ length: frames }, () => model) };
  }
  if (mode === "custom") {
    if (model !== undefined) throw new ImageModelsError('imageModels: mode "custom" takes no model');
    if (!Array.isArray(perScene) || perScene.length !== frames) throw new ImageModelsError(`imageModels.perScene must list exactly ${frames} model ids (one per frame)`);
    perScene.forEach((id, i) => {
      if (!isModelId(id)) throw new ImageModelsError(`imageModels.perScene[${i}]: unknown image model ${JSON.stringify(id)}`);
    });
    return { mode, models: [...perScene] as ImageModelId[] };
  }
  throw new ImageModelsError('imageModels.mode must be "auto", "only" or "custom"');
}
