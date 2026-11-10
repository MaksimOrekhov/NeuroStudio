import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode } from "../src/errors.ts";
import type { ImageModelAssignment } from "../src/imageModels.ts";

export interface RunView {
  /** Name of the folder in output/batches. */
  id: string;
  createdAt: string;
  /** "running" on disk but not in this process => "interrupted". */
  status: "running" | "completed" | "failed" | "interrupted";
  theme: string | null;
  collections: number;
  /** Frames per collection; 4 for batches written before NS-014. */
  frames: number;
  variations: number;
  /** collections x frames x variations */
  totalImages: number;
  /** Null for batches written before NS-014. */
  imageModels: ImageModelAssignment | null;
  collectionIds: string[];
  error?: string;
  errorCode?: ErrorCode;
  codex?: { model?: string | null; reasoningEffort?: string | null; seconds?: number };
}

const ID = /^[A-Za-z0-9._-]+$/;

/** Reads one output/batches/<id>/batch-plan.json. Tolerates every older shape; returns null for unreadable files. */
export async function readRun(dir: string, id: string, activeRunId?: string): Promise<RunView | null> {
  if (!ID.test(id)) return null;
  try {
    const b = JSON.parse(await readFile(join(dir, id, "batch-plan.json"), "utf8")) as Record<string, any>;
    const collections = Number.isInteger(b.count) ? b.count : (b.plans?.length ?? 1);
    const frames = Number.isInteger(b.frames) ? b.frames : (b.plans?.[0]?.frames?.length ?? 4);
    const variations = Number.isInteger(b.variations) ? b.variations : 1;
    const status = b.status === "done" ? "completed" : b.status === "failed" ? "failed" : id === activeRunId ? "running" : "interrupted";
    return {
      id,
      createdAt: typeof b.createdAt === "string" ? b.createdAt : "",
      status,
      theme: typeof b.theme === "string" ? b.theme : null,
      collections,
      frames,
      variations,
      totalImages: collections * frames * variations,
      imageModels: b.imageModels ?? null,
      collectionIds: Array.isArray(b.collectionIds) ? b.collectionIds : [],
      error: typeof b.error === "string" ? b.error : undefined,
      errorCode: typeof b.errorCode === "string" ? (b.errorCode as ErrorCode) : undefined,
      codex: b.codex ? { model: b.codex.model, reasoningEffort: b.codex.reasoningEffort, seconds: b.codex.seconds } : undefined,
    };
  } catch {
    return null;
  }
}

/** Newest first, at most `limit` records. Folders are read newest first (names start with the date) until the limit is reached. */
export async function listRuns(dir: string, limit = 20, activeRunId?: string): Promise<RunView[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs: RunView[] = [];
  for (const n of names.filter((n) => ID.test(n)).sort().reverse()) {
    if (runs.length >= limit) break;
    const r = await readRun(dir, n, activeRunId); // unreadable folders are skipped and do not use up the limit
    if (r) runs.push(r);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
