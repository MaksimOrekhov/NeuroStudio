export interface Frame {
  frame: number;
  model: "crimson-oath" | "duskrose";
  summary: string;
  positive: string;
  negative: string;
}
export interface PromptPlan {
  concept: { title: string; description: string; heroine: string };
  frames: Frame[];
}

export const BANNED = ["brushing", "camera", "framing", "twisted", "parted lips", "wide hips"];

export class PlanError extends Error {}

/** Validates structure and NeuroDreams hard rules. Throws PlanError listing all problems. */
export function validatePlan(x: unknown): PromptPlan {
  const errs: string[] = [];
  const p = x as PromptPlan;
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!p || typeof p !== "object") throw new PlanError("plan is not an object");
  for (const k of ["title", "description", "heroine"] as const) {
    if (!str(p.concept?.[k])) errs.push(`concept.${k} missing`);
  }
  if (!Array.isArray(p.frames) || p.frames.length !== 4) {
    errs.push("frames must be an array of exactly 4");
  } else {
    p.frames.forEach((f, i) => {
      if (f.frame !== i + 1) errs.push(`frames[${i}].frame must be ${i + 1}`);
      if (f.model !== "crimson-oath" && f.model !== "duskrose") errs.push(`frames[${i}].model invalid`);
      for (const k of ["summary", "positive", "negative"] as const) if (!str(f[k])) errs.push(`frames[${i}].${k} missing`);
      const text = `${f.positive} ${f.negative}`.toLowerCase();
      for (const w of BANNED) if (text.includes(w)) errs.push(`frames[${i}] contains banned phrase "${w}"`);
    });
    for (const m of ["crimson-oath", "duskrose"]) {
      if (p.frames.filter((f) => f.model === m).length !== 2) errs.push(`expected exactly 2 frames for ${m}`);
    }
    if (new Set(p.frames.map((f) => f.positive)).size !== 4) errs.push("frame prompts must be distinct");
  }
  if (errs.length) throw new PlanError("Invalid prompt plan:\n  " + errs.join("\n  "));
  return p;
}

export function summarize(p: PromptPlan): string {
  const lines = [`Concept: ${p.concept.title}`, p.concept.description, `Heroine: ${p.concept.heroine}`];
  for (const f of p.frames) lines.push(`  #${f.frame} [${f.model}] ${f.summary}`);
  return lines.join("\n");
}
