import { MAX_FRAMES, isModelId, type ImageModelId } from "./imageModels.ts";

export interface Frame {
  frame: number;
  model: ImageModelId;
  /** English shot brief. */
  summary: string;
  /** Russian shot brief for the UI. Required in new (v3) plans, absent in older ones. */
  summaryRu?: string;
  positive: string;
  /** Present only in plans made before Creative Director v2; absent means "use the workflow's own negative". */
  negative?: string;
}
export interface PromptPlan {
  /** title/description are English (kept for compatibility); the *Ru fields are for the UI and exist in v3 plans only. */
  concept: { title: string; titleRu?: string; description: string; descriptionRu?: string; heroine: string };
  frames: Frame[];
}

export const BANNED = ["brushing", "camera", "framing", "twisted", "parted lips", "wide hips"];

export class PlanError extends Error {}

export interface ValidateOptions {
  /**
   * Accept plans saved before Creative Director v2 (any 2+2 model order, no "huge breast" / adult-age wording rules).
   * New Codex output is always validated strictly.
   */
  legacy?: boolean;
  /**
   * Plan v3 (NS-014): the model the server assigned to each frame (index 0 = frame 1). Fixes the frame count to
   * `models.length` (1-4), requires every frame to use exactly its assigned model and requires the Russian metadata.
   * Without it a plan is validated the old way: exactly 4 frames, 2 + 2 models, Russian fields optional.
   */
  models?: readonly string[];
}

// Adult ages stated as "29 years old" or "25-35 years old"; every stated age must be >= 21.
function ages(text: string): number[] {
  return [...text.matchAll(/(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*years?[ -]old/gi)].flatMap((m) => [Number(m[1])].concat(m[2] ? [Number(m[2])] : []));
}

/**
 * Validates structure and the hard NeuroDreams rules that can be checked reliably.
 * Taste (beauty, originality, light, coherence) is deliberately not checked here.
 */
export function validatePlan(x: unknown, opts: ValidateOptions = {}): PromptPlan {
  const errs: string[] = [];
  const p = x as PromptPlan;
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const v3 = opts.models !== undefined;
  const n = v3 ? opts.models!.length : 4;
  if (!p || typeof p !== "object") throw new PlanError("plan is not an object");
  if (v3 && (n < 1 || n > MAX_FRAMES || !opts.models!.every(isModelId))) throw new PlanError(`invalid model assignment: ${JSON.stringify(opts.models)}`);
  for (const k of ["title", "description", "heroine"] as const) {
    if (!str(p.concept?.[k])) errs.push(`concept.${k} missing`);
  }
  // Russian metadata: required in v3, optional (but well-formed) in older plans.
  const ru = (v: unknown, where: string) => {
    if (v === undefined && !v3) return;
    if (!str(v)) errs.push(`${where} missing`);
    else if (v3 && !/[а-яё]/i.test(v as string)) errs.push(`${where} must be Russian text`);
  };
  ru(p.concept?.titleRu, "concept.titleRu");
  ru(p.concept?.descriptionRu, "concept.descriptionRu");
  if (!Array.isArray(p.frames) || p.frames.length !== n) {
    errs.push(`frames must be an array of exactly ${n}`);
  } else {
    p.frames.forEach((f, i) => {
      if (f.frame !== i + 1) errs.push(`frames[${i}].frame must be ${i + 1}`);
      if (v3) {
        if (f.model !== opts.models![i]) errs.push(`frames[${i}].model must be ${opts.models![i]} (assigned), got ${JSON.stringify(f.model)}`);
      } else if (!isModelId(f.model)) errs.push(`frames[${i}].model invalid`);
      for (const k of ["summary", "positive"] as const) if (!str(f[k])) errs.push(`frames[${i}].${k} missing`);
      ru(f.summaryRu, `frames[${i}].summaryRu`);
      if (f.negative !== undefined && typeof f.negative !== "string") errs.push(`frames[${i}].negative must be a string`);
      const text = `${f.positive} ${f.negative ?? ""}`.toLowerCase();
      for (const w of BANNED) if (text.includes(w)) errs.push(`frames[${i}] contains banned phrase "${w}"`);
      if (!opts.legacy && str(f.positive)) {
        const pos = f.positive;
        if (!/adult woman/i.test(pos)) errs.push(`frames[${i}] must say "adult woman"`);
        const a = ages(pos);
        if (!a.length || a.some((n) => n < 21)) errs.push(`frames[${i}] must state a concrete adult age (21+) like "29 years old"`);
        const hb = (pos.match(/\bhuge breast\b/gi) ?? []).length;
        if (hb !== 1 || /huge breasts/i.test(pos)) errs.push(`frames[${i}] must contain the exact phrase "huge breast" exactly once (found ${hb})`);
      }
    });
    if (!v3) {
      for (const m of ["crimson-oath", "duskrose"]) {
        if (p.frames.filter((f) => f.model === m).length !== 2) errs.push(`expected exactly 2 frames for ${m}`);
      }
      if (!opts.legacy && !(p.frames[0]?.model === "crimson-oath" && p.frames[1]?.model === "crimson-oath" && p.frames[2]?.model === "duskrose" && p.frames[3]?.model === "duskrose")) {
        errs.push("frames 1-2 must use crimson-oath and frames 3-4 duskrose");
      }
    }
    if (new Set(p.frames.map((f) => f.positive)).size !== n) errs.push("frame prompts must be distinct");
  }
  if (errs.length) throw new PlanError("Invalid prompt plan:\n  " + errs.join("\n  "));
  return p;
}

export function summarize(p: PromptPlan): string {
  const lines = [`Concept: ${p.concept.title}${p.concept.titleRu ? ` / ${p.concept.titleRu}` : ""}`, p.concept.description, `Heroine: ${p.concept.heroine}`];
  for (const f of p.frames) lines.push(`  #${f.frame} [${f.model}] ${f.summary}`);
  return lines.join("\n");
}

export const MAX_COLLECTIONS = 3;

/** Accepts 1..MAX_COLLECTIONS (integer); undefined means 1. */
export function parseCount(x: unknown): number {
  if (x === undefined || x === null) return 1;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > MAX_COLLECTIONS) {
    throw new PlanError(`collections must be an integer from 1 to ${MAX_COLLECTIONS}`);
  }
  return x;
}

/** Batch Plan = { collections: PromptPlan[] }. Exactly `count` valid plans with distinct titles. */
export function validateBatch(x: unknown, count: number, opts: ValidateOptions = {}): PromptPlan[] {
  const list = (x as { collections?: unknown })?.collections;
  if (!Array.isArray(list) || list.length !== count) {
    throw new PlanError(`Batch plan must contain exactly ${count} collections, got ${Array.isArray(list) ? list.length : "none"}`);
  }
  const plans = list.map((p, i) => {
    try {
      return validatePlan(p, opts);
    } catch (e) {
      throw new PlanError(`Collection ${i + 1}: ${(e as Error).message}`);
    }
  });
  const titles = new Set(plans.map((p) => p.concept.title.trim().toLowerCase()));
  if (titles.size !== plans.length) throw new PlanError("Collections in a batch must have distinct concepts (duplicate title)");
  return plans;
}

export const VARIATION_CHOICES = [1, 2, 4];

/** Seed variations per frame: 1, 2 or 4; undefined means 1. */
export function parseVariations(x: unknown): number {
  if (x === undefined || x === null) return 1;
  if (typeof x !== "number" || !VARIATION_CHOICES.includes(x)) throw new PlanError("variations must be 1, 2 or 4");
  return x;
}

export const FRAME_CHOICES = [1, 2, 3, 4];

/** Frames per collection: 1..MAX_FRAMES (integer); undefined means 4 (the pre-NS-014 behaviour). */
export function parseFrames(x: unknown): number {
  if (x === undefined || x === null) return MAX_FRAMES;
  if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > MAX_FRAMES) throw new PlanError(`frames must be an integer from 1 to ${MAX_FRAMES}`);
  return x;
}
