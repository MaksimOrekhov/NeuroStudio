import { autoMix } from "../../src/imageModels.ts";
import type { PromptPlan } from "../../src/promptPlan.ts";

const heroine = "solo female, adult woman, 29 years old, original character, mature face, adult body, huge breast, short chestnut bob, green eyes, freckles, mustard knit top";
const views = ["front view, waist-up composition", "rear three-quarter view, head-to-mid-thigh composition", "side view, seated on a low wall", "slightly elevated view, walking"];

/** A plan in the Creative Director v2 format: frames 1-2 crimson-oath, 3-4 duskrose, no negative prompts, no Russian fields. */
export function strictPlan(title = "Test Concept"): PromptPlan {
  const models = autoMix(4) as PromptPlan["frames"][number]["model"][];
  return {
    concept: { title, description: `${title}: a quiet test collection.`, heroine },
    frames: models.map((model, i) => ({
      frame: i + 1,
      model,
      summary: `Shot ${i + 1} of ${title}`,
      positive: `realistic, masterpiece, best quality,\n\n${heroine},\n\n${views[i]}, soft window light, ${title} scene ${i + 1}`,
    })),
  };
}

/** A Plan v3: one frame per assigned model (default: Auto Mix of 4), with the Russian metadata. */
export function planV3(title = "Test Concept", models: readonly string[] = autoMix(4)): PromptPlan {
  return {
    concept: { title, titleRu: `Тест ${title}`, description: `${title}: a quiet test collection.`, descriptionRu: `${title}: тихая тестовая коллекция.`, heroine },
    frames: models.map((model, i) => ({
      frame: i + 1,
      model: model as PromptPlan["frames"][number]["model"],
      summary: `Shot ${i + 1} of ${title}`,
      summaryRu: `Кадр ${i + 1}: ${title}`,
      positive: `realistic, masterpiece, best quality,\n\n${heroine},\n\n${views[i % views.length]}, soft window light, ${title} scene ${i + 1}`,
    })),
  };
}
