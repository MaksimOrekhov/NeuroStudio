import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Generation, Manifest } from "../src/collection.ts";
import type { PromptPlan } from "../src/promptPlan.ts";

export interface FrameView {
  frame: number;
  /** 1 for collections created before seed variations existed. */
  variant: number;
  model: string;
  summary?: string;
  /** Russian shot brief (plans made with Plan v3); absent in older collections: show `summary`. */
  summaryRu?: string;
  status: string;
  seed: number;
  promptId?: string;
  image?: string; // file name, served by /api/collections/:id/images/:file
  error?: string;
}

export interface CollectionView {
  id: string;
  title: string;
  /** Russian title/description (Plan v3); absent in older collections: show `title`/`description`. */
  titleRu?: string;
  description?: string;
  descriptionRu?: string;
  createdAt: string;
  /** "running" on disk but not in this process => "interrupted" (never shown as completed) */
  status: "running" | "done" | "failed" | "interrupted";
  doneFrames: number;
  /** Every image slot: frame x variant. */
  frames: FrameView[];
  variations: number;
  /** Frames in the collection: 1-4. Collections made before NS-014 have no such field and always had 4. */
  frameCount: number;
  /** Theme, image models per frame and final composition used for this collection; absent in older collections. */
  generation?: Generation;
  /** Selected best variant per frame number (from selections.json). */
  selections: Record<string, number>;
  /** Subjective quality feedback for the whole collection (feedback.json); null when none was given. */
  feedback: Feedback | null;
  /** Whether the final images (one per frame) can be exported as a ZIP (see export.ts). */
  export: ExportStatus;
  codex?: Manifest["codex"];
  comfySeconds?: number;
}

export const FEEDBACK_TAGS = [
  "beautiful_heroine",
  "great_outfit",
  "good_composition",
  "beautiful_lighting",
  "original_concept",
  "bad_anatomy",
  "inconsistent_heroine",
  "poor_outfit",
  "repetitive_composition",
  "weak_concept",
] as const;
export const FEEDBACK_NOTE_MAX = 500;

/**
 * Stored in <collection>/feedback.json. Linked to the Prompt Plan and the Best picks only through the collection id
 * (no prompts or PNG paths are duplicated here). A rating is a subjective verdict on the whole collection,
 * unlike Best, which is a relative comparison of seed variants of one prompt.
 */
export interface Feedback {
  version: 1;
  rating: number | null;
  tags: string[];
  note: string;
  updatedAt: string;
}

const ID = /^[A-Za-z0-9._-]+$/;
const IMAGE = /^scene-\d{2}(-v\d{2})?\.png$/;

export interface ExportStatus {
  ready: boolean;
  /** Number of explicitly selected Best images that can be exported (0 when nothing is selected). */
  resolved: number;
  /** Human-readable reason when not ready. */
  message?: string;
}

interface Choice {
  frame: number;
  image?: string;
  problem?: string;
}

/**
 * The explicitly selected Best image of each scene, in frame order. Scenes without a selection are not included
 * (a single-variant scene is not auto-selected either). Never substitutes another variant for a missing selected one.
 */
export function chooseScenes(c: CollectionView): Choice[] {
  const out: Choice[] = [];
  for (let frame = 1; frame <= c.frameCount; frame++) {
    const sel = c.selections[String(frame)];
    if (sel === undefined) continue;
    const v = c.frames.find((f) => f.frame === frame && f.variant === sel);
    out.push(v?.image ? { frame, image: v.image } : { frame, problem: `scene ${frame}: the selected image (v${sel}) is not available` });
  }
  return out;
}

export function exportStatus(c: CollectionView): ExportStatus {
  const choices = chooseScenes(c);
  const resolved = choices.filter((x) => x.image).length;
  const problems = choices.filter((x) => x.problem).map((x) => x.problem!);
  if (problems.length) return { ready: false, resolved, message: problems.join("; ") };
  if (!resolved) return { ready: false, resolved: 0, message: "Select at least one image" };
  return { ready: true, resolved };
}

async function readSelections(dir: string, id: string): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await readFile(join(dir, id, "selections.json"), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => /^[1-4]$/.test(k) && Number.isInteger(v))) as Record<string, number>;
  } catch {
    return {};
  }
}

async function readFeedback(dir: string, id: string): Promise<Feedback | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, id, "feedback.json"), "utf8")) as Partial<Feedback>;
    const rating = Number.isInteger(raw.rating) && raw.rating! >= 1 && raw.rating! <= 5 ? raw.rating! : null;
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => (FEEDBACK_TAGS as readonly string[]).includes(t as string)) : [];
    const note = typeof raw.note === "string" ? raw.note.slice(0, FEEDBACK_NOTE_MAX) : "";
    return { version: 1, rating, tags, note, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
  } catch {
    return null; // missing (old collection) or unreadable: behaves as "no feedback"
  }
}

export async function readCollection(dir: string, id: string, activeId?: string): Promise<CollectionView | null> {
  if (!ID.test(id)) return null;
  try {
    const m = JSON.parse(await readFile(join(dir, id, "collection.json"), "utf8")) as Manifest;
    let plan: PromptPlan | undefined;
    try {
      plan = JSON.parse(await readFile(join(dir, id, "prompt-plan.json"), "utf8"));
    } catch {
      /* plan is optional for display */
    }
    const frames: FrameView[] = m.frames
      .map((f) => ({
        frame: f.frame,
        variant: f.variant ?? 1,
        model: f.model,
        summary: plan?.frames.find((p) => p.frame === f.frame)?.summary,
        summaryRu: plan?.frames.find((p) => p.frame === f.frame)?.summaryRu,
        status: f.status,
        seed: f.seed,
        promptId: f.promptId,
        image: f.status === "done" ? f.png : undefined,
        error: f.error,
      }))
      .sort((a, b) => a.frame - b.frame || a.variant - b.variant);
    const status = m.status === "running" && id !== activeId ? "interrupted" : m.status;
    const selections = await readSelections(dir, id);
    const view: CollectionView = {
      id,
      title: m.title,
      titleRu: plan?.concept.titleRu,
      description: plan?.concept.description,
      descriptionRu: plan?.concept.descriptionRu,
      createdAt: m.createdAt,
      status,
      doneFrames: frames.filter((f) => f.status === "done").length,
      frames,
      variations: m.variations ?? 1,
      frameCount: m.frameCount ?? 4,
      generation: m.generation,
      selections,
      feedback: await readFeedback(dir, id),
      export: { ready: false, resolved: 0 },
      codex: m.codex,
      comfySeconds: m.comfySeconds,
    };
    view.export = exportStatus(view);
    return view;
  } catch {
    return null;
  }
}

/** Newest first. */
export async function listCollections(dir: string, limit = 20, activeId?: string): Promise<CollectionView[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const all = (await Promise.all(names.filter((n) => ID.test(n)).map((n) => readCollection(dir, n, activeId)))).filter(
    (c): c is CollectionView => c !== null,
  );
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Resolves an image path strictly inside <dir>/<id>/; returns null for anything else. */
export function safeImagePath(dir: string, id: string, file: string): string | null {
  if (!ID.test(id) || !IMAGE.test(file)) return null;
  const root = resolve(dir);
  const p = resolve(root, id, file);
  return p.startsWith(root + sep) ? p : null;
}

export class SelectionError extends Error {}

/**
 * Marks `variant` as the best of `frame` (null clears it). Only a finished image can be selected.
 * Writes selections.json inside the collection; PNGs are never touched.
 */
export async function setSelection(dir: string, id: string, frame: unknown, variant: unknown): Promise<Record<string, number>> {
  const c = await readCollection(dir, id);
  if (!c) throw new SelectionError("collection not found");
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1 || frame > c.frameCount) throw new SelectionError(`frame must be 1-${c.frameCount}`);
  const sel = { ...c.selections };
  if (variant === null) {
    delete sel[String(frame)];
  } else {
    if (typeof variant !== "number" || !Number.isInteger(variant)) throw new SelectionError("variant must be an integer or null");
    if (!c.frames.some((f) => f.frame === frame && f.variant === variant && f.image)) throw new SelectionError("that image does not exist yet");
    sel[String(frame)] = variant;
  }
  const file = join(dir, id, "selections.json");
  await writeFile(file + ".tmp", JSON.stringify(sel, null, 2));
  await rename(file + ".tmp", file);
  return sel;
}

export class FeedbackError extends Error {}

/**
 * Replaces the feedback of a collection. Everything is optional (rating null = no rating).
 * Entirely empty feedback removes feedback.json. Only feedback.json is written, atomically.
 */
export async function setFeedback(dir: string, id: string, input: unknown): Promise<Feedback | null> {
  if (!ID.test(id) || !(await readCollection(dir, id))) throw new FeedbackError("collection not found");
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new FeedbackError("body must be an object");
  const { rating = null, tags = [], note = "" } = input as Record<string, unknown>;
  if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)) throw new FeedbackError("rating must be an integer 1-5 or null");
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !(FEEDBACK_TAGS as readonly string[]).includes(t))) throw new FeedbackError("unknown feedback tag");
  if (typeof note !== "string") throw new FeedbackError("note must be a string");
  if (note.length > FEEDBACK_NOTE_MAX) throw new FeedbackError(`note is too long (max ${FEEDBACK_NOTE_MAX} characters)`);
  const uniqueTags = FEEDBACK_TAGS.filter((t) => tags.includes(t));
  const file = join(dir, id, "feedback.json");
  if (rating === null && !uniqueTags.length && !note.trim()) {
    await unlink(file).catch(() => undefined);
    return null;
  }
  const fb: Feedback = { version: 1, rating, tags: uniqueTags, note: note.trim(), updatedAt: new Date().toISOString() };
  await writeFile(file + ".tmp", JSON.stringify(fb, null, 2));
  await rename(file + ".tmp", file);
  return fb;
}
