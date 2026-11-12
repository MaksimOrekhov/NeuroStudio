import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Generation, Manifest } from "../src/collection.ts";
import type { PromptPlan } from "../src/promptPlan.ts";
import { io, writeAtomic } from "../src/persistence.ts";

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
  /** NS-017: variant this one was regenerated from (absent for the original variants). */
  sourceVariant?: number;
  /** NS-017: the prompt was edited before regenerating. */
  promptEdited?: boolean;
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
  /** NS-018: quality verdict and tags per image, keyed "frame-variant" (image-feedback.json); {} when none. */
  imageFeedback: Record<string, ImageFeedback>;
  /** Set when image-feedback.json exists but cannot be understood: it is shown as empty and refused for writing, never overwritten. */
  imageFeedbackError?: string;
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

export const IMAGE_TAGS = {
  like: ["beautiful_look", "great_outfit", "good_composition", "beautiful_lighting", "original_idea"],
  dislike: ["anatomy", "face", "outfit", "composition", "lighting", "concept_mismatch", "repetitive_look"],
} as const;
export type Verdict = keyof typeof IMAGE_TAGS;

/** NS-018. Only the verdict and reasons: prompt, graph, seed and PNG are found through (frame, variant) in the existing files. */
export interface ImageFeedback {
  verdict: Verdict;
  tags: string[];
  updatedAt: string;
}

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

async function loadSelections(dir: string, id: string): Promise<Record<string, number>> {
  let text: string;
  try {
    text = await readFile(join(dir, id, "selections.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new SelectionError(`cannot read selections.json: ${(e as Error).message}`);
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.entries(raw).some(([k, v]) => !/^[1-4]$/.test(k) || !Number.isInteger(v) || (v as number) < 1)) throw new Error("unexpected structure");
    return raw;
  } catch (e) {
    throw new SelectionError(`selections.json cannot be used: ${(e as Error).message}`);
  }
}

const readSelections = (dir: string, id: string) => loadSelections(dir, id).catch(() => ({}));

/**
 * Reads image-feedback.json strictly. A missing file (ENOENT) is "no feedback". Anything else that stops the file from being
 * understood (read error, invalid JSON, wrong structure) is reported as `unreadable`, so that nothing ever overwrites it.
 */
async function loadImageFeedback(dir: string, id: string): Promise<{ images: Record<string, ImageFeedback>; unreadable: string | null }> {
  let text: string;
  try {
    text = await readFile(join(dir, id, "image-feedback.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { images: {}, unreadable: null };
    return { images: {}, unreadable: `cannot read image-feedback.json: ${(e as Error).message}` };
  }
  let raw: { images?: unknown };
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { images: {}, unreadable: `image-feedback.json is not valid JSON: ${(e as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof raw.images !== "object" || raw.images === null || Array.isArray(raw.images)) {
    return { images: {}, unreadable: "image-feedback.json has an unexpected structure" };
  }
  const out: Record<string, ImageFeedback> = {};
  for (const [k, v] of Object.entries(raw.images as Record<string, Partial<ImageFeedback>>)) {
    if (!/^[1-4]-\d{1,2}$/.test(k) || !v || (v.verdict !== "like" && v.verdict !== "dislike")) continue; // single unknown entries are ignored
    const allowed = IMAGE_TAGS[v.verdict] as readonly string[];
    out[k] = { verdict: v.verdict, tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => allowed.includes(t as string)) : [], updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "" };
  }
  return { images: out, unreadable: null };
}

async function loadFeedback(dir: string, id: string): Promise<Feedback | null> {
  let text: string;
  try {
    text = await readFile(join(dir, id, "feedback.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FeedbackError(`cannot read feedback.json: ${(e as Error).message}`);
  }
  try {
    const raw = JSON.parse(text) as Partial<Feedback>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw.version !== undefined && raw.version !== 1)
      || (raw.rating !== undefined && raw.rating !== null && (!Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5))
      || (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((t) => !(FEEDBACK_TAGS as readonly string[]).includes(t))))
      || (raw.note !== undefined && typeof raw.note !== "string")
      || (raw.updatedAt !== undefined && typeof raw.updatedAt !== "string")) throw new Error("unexpected structure");
    const rating = Number.isInteger(raw.rating) && raw.rating! >= 1 && raw.rating! <= 5 ? raw.rating! : null;
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => (FEEDBACK_TAGS as readonly string[]).includes(t as string)) : [];
    const note = typeof raw.note === "string" ? raw.note.slice(0, FEEDBACK_NOTE_MAX) : "";
    return { version: 1, rating, tags, note, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
  } catch (e) {
    throw new FeedbackError(`feedback.json cannot be used: ${(e as Error).message}`);
  }
}

// Keep the existing display contract; writes use the strict reader and never replace unreadable data.
const readFeedback = (dir: string, id: string) => loadFeedback(dir, id).catch(() => null);

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
        sourceVariant: f.sourceVariant,
        promptEdited: f.promptEdited,
      }))
      .sort((a, b) => a.frame - b.frame || a.variant - b.variant);
    const status = m.status === "running" && id !== activeId ? "interrupted" : m.status;
    // A regeneration slot of a finished collection that is still pending/submitted while nothing is running for it: the server
    // stopped before the result was saved. It is shown as failed (prompt_id kept) and is never resubmitted.
    if (m.status !== "running" && id !== activeId) {
      for (const f of frames) {
        if (f.sourceVariant !== undefined && (f.status === "pending" || f.status === "submitted")) {
          const name = `scene-${String(f.frame).padStart(2, "0")}-v${String(f.variant).padStart(2, "0")}`;
          // The variant's own sidecar is written before the manifest (prompt_id first), so it may know more than collection.json.
          let side: { status?: string; promptId?: string; error?: string } = {};
          try {
            side = JSON.parse(await readFile(join(dir, id, `${name}.json`), "utf8"));
          } catch {
            /* no sidecar: keep what the manifest says */
          }
          if (typeof side.promptId === "string" && !f.promptId) f.promptId = side.promptId;
          const hasPng = side.status === "done" && (await stat(join(dir, id, `${name}.png`)).then((s) => s.isFile(), () => false));
          if (hasPng) {
            f.status = "done";
            f.image = `${name}.png`;
          } else {
            f.status = f.status === "submitted" || f.promptId ? "timeout" : "failed"; // accepted by ComfyUI: outcome unknown
            f.error = side.error ?? "Regeneration was interrupted before the image was saved; it is not resubmitted automatically";
          }
        }
      }
    }
    const selections = await readSelections(dir, id);
    const imageFb = await loadImageFeedback(dir, id);
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
      imageFeedback: imageFb.images,
      imageFeedbackError: imageFb.unreadable ?? undefined,
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

const selectionLocks = new Map<string, Promise<unknown>>();
const feedbackLocks = new Map<string, Promise<unknown>>();

/** In-process queue; a failed operation cannot poison later saves, and settled keys are released. */
function queued<T>(locks: Map<string, Promise<unknown>>, dir: string, id: string, task: () => Promise<T>): Promise<T> {
  const path = resolve(dir, id);
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  locks.set(key, run);
  const release = () => { if (locks.get(key) === run) locks.delete(key); };
  void run.then(release, release);
  return run;
}

/**
 * Marks `variant` as the best of `frame` (null clears it). Only a finished image can be selected.
 * Writes selections.json inside the collection; PNGs are never touched.
 */
export function setSelection(dir: string, id: string, frame: unknown, variant: unknown): Promise<Record<string, number>> {
  return queued(selectionLocks, dir, id, () => applySelection(dir, id, frame, variant));
}

async function applySelection(dir: string, id: string, frame: unknown, variant: unknown): Promise<Record<string, number>> {
  const c = await readCollection(dir, id);
  if (!c) throw new SelectionError("collection not found");
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1 || frame > c.frameCount) throw new SelectionError(`frame must be 1-${c.frameCount}`);
  const sel = await loadSelections(dir, id);
  if (variant === null) {
    delete sel[String(frame)];
  } else {
    if (typeof variant !== "number" || !Number.isInteger(variant)) throw new SelectionError("variant must be an integer or null");
    if (!c.frames.some((f) => f.frame === frame && f.variant === variant && f.image)) throw new SelectionError("that image does not exist yet");
    sel[String(frame)] = variant;
  }
  const file = join(dir, id, "selections.json");
  await writeAtomic(file, JSON.stringify(sel, null, 2));
  return sel;
}

export class FeedbackError extends Error {}

/**
 * Replaces the feedback of a collection. Everything is optional (rating null = no rating).
 * Entirely empty feedback removes feedback.json. Only feedback.json is written, atomically.
 */
export function setFeedback(dir: string, id: string, input: unknown): Promise<Feedback | null> {
  return queued(feedbackLocks, dir, id, () => applyFeedback(dir, id, input));
}

async function applyFeedback(dir: string, id: string, input: unknown): Promise<Feedback | null> {
  if (!ID.test(id) || !(await readCollection(dir, id))) throw new FeedbackError("collection not found");
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new FeedbackError("body must be an object");
  const { rating = null, tags = [], note = "" } = input as Record<string, unknown>;
  if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)) throw new FeedbackError("rating must be an integer 1-5 or null");
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !(FEEDBACK_TAGS as readonly string[]).includes(t))) throw new FeedbackError("unknown feedback tag");
  if (typeof note !== "string") throw new FeedbackError("note must be a string");
  if (note.length > FEEDBACK_NOTE_MAX) throw new FeedbackError(`note is too long (max ${FEEDBACK_NOTE_MAX} characters)`);
  const uniqueTags = FEEDBACK_TAGS.filter((t) => tags.includes(t));
  const file = join(dir, id, "feedback.json");
  await loadFeedback(dir, id); // refuse both replacement and deletion when the existing data cannot be read
  if (rating === null && !uniqueTags.length && !note.trim()) {
    try {
      await io.unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return null;
  }
  const fb: Feedback = { version: 1, rating, tags: uniqueTags, note: note.trim(), updatedAt: new Date().toISOString() };
  await writeAtomic(file, JSON.stringify(fb, null, 2));
  return fb;
}

export class ImageFeedbackError extends Error {}
/** image-feedback.json exists but is unreadable/corrupt: saving is refused so the file stays byte-identical. */
export class ImageFeedbackFileError extends ImageFeedbackError {}

const imageFeedbackLocks = new Map<string, Promise<unknown>>();

/**
 * Sets (verdict "like"/"dislike" + optional tags of that verdict) or removes (verdict null) the feedback of ONE finished image.
 * Read-modify-write of image-feedback.json is serialised per collection and written atomically; other files are never touched.
 */
export function setImageFeedback(dir: string, id: string, frame: unknown, variant: unknown, input: unknown): Promise<ImageFeedback | null> {
  const key = `${dir}\0${id}`;
  const run = (imageFeedbackLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => apply(dir, id, frame, variant, input));
  imageFeedbackLocks.set(key, run);
  return run;
}

async function apply(dir: string, id: string, frame: unknown, variant: unknown, input: unknown): Promise<ImageFeedback | null> {
  const c = await readCollection(dir, id);
  if (!c) throw new ImageFeedbackError("collection not found");
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1 || frame > c.frameCount) throw new ImageFeedbackError(`frame must be 1-${c.frameCount}`);
  if (typeof variant !== "number" || !Number.isInteger(variant) || variant < 1) throw new ImageFeedbackError("variant must be a positive integer");
  if (!c.frames.some((f) => f.frame === frame && f.variant === variant && f.image)) throw new ImageFeedbackError("that image does not exist yet");
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ImageFeedbackError("body must be an object");
  const { verdict = null, tags = [] } = input as Record<string, unknown>;
  if (verdict !== null && verdict !== "like" && verdict !== "dislike") throw new ImageFeedbackError('verdict must be "like", "dislike" or null');
  if (!Array.isArray(tags)) throw new ImageFeedbackError("tags must be an array");
  const cur = await loadImageFeedback(dir, id); // strict: never write over a file that could not be read
  if (cur.unreadable) throw new ImageFeedbackFileError(cur.unreadable);
  const all = { ...cur.images };
  const k = `${frame}-${variant}`;
  let entry: ImageFeedback | null = null;
  if (verdict === null) {
    delete all[k]; // removing the rating also removes its reasons
  } else {
    const allowed = IMAGE_TAGS[verdict] as readonly string[];
    if (tags.some((t) => typeof t !== "string" || !allowed.includes(t))) throw new ImageFeedbackError(`unknown tag for "${verdict}"`);
    entry = { verdict, tags: (IMAGE_TAGS[verdict] as readonly string[]).filter((t) => tags.includes(t)), updatedAt: new Date().toISOString() };
    all[k] = entry;
  }
  const file = join(dir, id, "image-feedback.json");
  if (!Object.keys(all).length) {
    try {
      await io.unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // anything else: the file is still there, do not report success
    }
  } else await writeAtomic(file, JSON.stringify({ version: 1, images: all }, null, 2));
  return entry;
}
