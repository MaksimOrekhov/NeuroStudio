// Single catalog of image models (ComfyUI checkpoints) and the per-frame assignment rules (NS-014).
// No imports: it is used by the server, the CLI and (type/rule-wise) by the UI prototype.

export const IMAGE_MODELS = [
  { id: "crimson-oath", name: "Crimson Oath", checkpoint: "vetehineCrimsonOathILL_v02ANM.safetensors", color: "#f0607a" },
  { id: "duskrose", name: "Duskrose", checkpoint: "Duskrose v4 ANM.safetensors", color: "#b48cff" },
] as const;

export type ImageModelId = (typeof IMAGE_MODELS)[number]["id"];
export const MODEL_IDS: ImageModelId[] = IMAGE_MODELS.map((m) => m.id);
export const isModelId = (x: unknown): x is ImageModelId => typeof x === "string" && (MODEL_IDS as string[]).includes(x);
/** Position in the catalog; used to group jobs by model. */
export const modelIndex = (id: string) => MODEL_IDS.indexOf(id as ImageModelId);

export const MAX_FRAMES = 4;

/**
 * Auto Mix: contiguous blocks in catalog order; the first models get the remainder.
 * 1 -> C, 2 -> C D, 3 -> C C D, 4 -> C C D D. With a third model it generalises (4 -> A A B C).
 */
export function autoMix(frames: number, models: readonly string[] = MODEL_IDS): string[] {
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
