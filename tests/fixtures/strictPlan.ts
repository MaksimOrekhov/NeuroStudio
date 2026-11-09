import type { PromptPlan } from "../../src/promptPlan.ts";

const heroine = "solo female, adult woman, 29 years old, original character, mature face, adult body, huge breast, short chestnut bob, green eyes, freckles, mustard knit top";

/** A plan in the Creative Director v2 format: frames 1-2 crimson-oath, 3-4 duskrose, no negative prompts. */
export function strictPlan(title = "Test Concept"): PromptPlan {
  const models = ["crimson-oath", "crimson-oath", "duskrose", "duskrose"] as const;
  const views = ["front view, waist-up composition", "rear three-quarter view, head-to-mid-thigh composition", "side view, seated on a low wall", "slightly elevated view, walking"];
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
