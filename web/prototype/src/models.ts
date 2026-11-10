// NS-013 prototype: image-model registry and per-scene assignment rules.
import { W, nPlural } from "./ru";

// Pure TypeScript (no Vue) so the rules can be unit-tested and later moved to src/ in NS-014.

export interface ImageModel {
  /** Id used in Prompt Plans and manifests ("crimson-oath", "duskrose"). */
  id: string;
  name: string;
  /** Accent used for the model dot/chip in the UI. */
  color: string;
}

/**
 * Ordered registry. The order defines the Auto Mix order. A third model is added here (one entry);
 * the mode picker, Auto Mix and the per-scene selects pick it up without other UI changes.
 * Checkpoint discovery from ComfyUI is intentionally out of scope.
 */
export const IMAGE_MODELS: ImageModel[] = [
  { id: "crimson-oath", name: "Crimson Oath", color: "#f0607a" },
  { id: "duskrose", name: "Duskrose", color: "#b48cff" },
];

export const modelById = (id: string, list = IMAGE_MODELS) => list.find((m) => m.id === id);
export const modelName = (id: string, list = IMAGE_MODELS) => modelById(id, list)?.name ?? id;

/** "auto" | "custom" | "only:<model id>" */
export type ModelMode = "auto" | "custom" | `only:${string}`;

export const MAX_FRAMES = 4;
export const FRAME_CHOICES = [1, 2, 3, 4] as const;
export const COLLECTION_CHOICES = [1, 2, 3] as const;
export const VARIATION_CHOICES = [1, 2, 4] as const;

/**
 * Auto Mix: contiguous blocks in registry order; the first models get the remainder.
 *   2 models: 1 → C · 2 → C D · 3 → C C D · 4 → C C D D (the familiar 2 + 2)
 *   3 models: 4 → A A B C
 * With fewer frames than models, the last models are simply not used.
 */
export function autoMix(frames: number, models: readonly string[] = IMAGE_MODELS.map((m) => m.id)): string[] {
  if (!models.length) return [];
  const base = Math.floor(frames / models.length);
  const extra = frames % models.length;
  const out: string[] = [];
  models.forEach((m, i) => {
    for (let k = 0; k < base + (i < extra ? 1 : 0); k++) out.push(m);
  });
  return out;
}

/** Model per scene (index 0 = Scene 01) for the chosen mode. `custom` holds the user's per-scene picks. */
export function assignModels(mode: ModelMode, frames: number, custom: readonly string[] = [], models = IMAGE_MODELS): string[] {
  const ids = models.map((m) => m.id);
  const auto = autoMix(frames, ids);
  if (mode === "auto") return auto;
  if (mode.startsWith("only:")) {
    const id = mode.slice(5);
    return Array.from({ length: frames }, () => (ids.includes(id) ? id : auto[0]));
  }
  // custom: unknown or missing picks fall back to what Auto Mix would choose for that scene
  return Array.from({ length: frames }, (_, i) => (custom[i] && ids.includes(custom[i]) ? custom[i] : auto[i]));
}

/** "Кадры 1–2", "Кадр 3", "Кадры 1, 3" */
export function sceneList(nums: number[]): string {
  if (!nums.length) return "";
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const body = nums.length === 1 ? String(nums[0]) : contiguous ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(", ");
  return `${nums.length === 1 ? "Кадр" : "Кадры"} ${body}`;
}

/** Per-model usage for the summary, in registry order; models with no scenes are omitted. */
export function modelUsage(assigned: readonly string[], models = IMAGE_MODELS): { model: ImageModel; scenes: number[] }[] {
  return models
    .map((model) => ({ model, scenes: assigned.flatMap((id, i) => (id === model.id ? [i + 1] : [])) }))
    .filter((u) => u.scenes.length > 0);
}

export const totalImages = (collections: number, frames: number, variations: number) => collections * frames * variations;

/** "2 коллекции × 3 кадра × 2 варианта = 12 изображений" */
export function formula(collections: number, frames: number, variations: number): string {
  const total = totalImages(collections, frames, variations);
  return `${nPlural(collections, W.collection)} × ${nPlural(frames, W.frame)} × ${nPlural(variations, W.variant)} = ${nPlural(total, W.image)}`;
}
