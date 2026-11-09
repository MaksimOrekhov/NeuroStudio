import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Manifest } from "../src/collection.ts";
import type { PromptPlan } from "../src/promptPlan.ts";

export interface FrameView {
  frame: number;
  /** 1 for collections created before seed variations existed. */
  variant: number;
  model: string;
  summary?: string;
  status: string;
  seed: number;
  promptId?: string;
  image?: string; // file name, served by /api/collections/:id/images/:file
  error?: string;
}

export interface CollectionView {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  /** "running" on disk but not in this process => "interrupted" (never shown as completed) */
  status: "running" | "done" | "failed" | "interrupted";
  doneFrames: number;
  /** Every image slot: frame x variant. */
  frames: FrameView[];
  variations: number;
  /** Selected best variant per frame number (from selections.json). */
  selections: Record<string, number>;
  codex?: Manifest["codex"];
  comfySeconds?: number;
}

const ID = /^[A-Za-z0-9._-]+$/;
const IMAGE = /^scene-\d{2}(-v\d{2})?\.png$/;

async function readSelections(dir: string, id: string): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await readFile(join(dir, id, "selections.json"), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => /^[1-4]$/.test(k) && Number.isInteger(v))) as Record<string, number>;
  } catch {
    return {};
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
        status: f.status,
        seed: f.seed,
        promptId: f.promptId,
        image: f.status === "done" ? f.png : undefined,
        error: f.error,
      }))
      .sort((a, b) => a.frame - b.frame || a.variant - b.variant);
    const status = m.status === "running" && id !== activeId ? "interrupted" : m.status;
    return {
      id,
      title: m.title,
      description: plan?.concept.description,
      createdAt: m.createdAt,
      status,
      doneFrames: frames.filter((f) => f.status === "done").length,
      frames,
      variations: m.variations ?? 1,
      selections: await readSelections(dir, id),
      codex: m.codex,
      comfySeconds: m.comfySeconds,
    };
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
  if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 1 || frame > 4) throw new SelectionError("frame must be 1-4");
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
