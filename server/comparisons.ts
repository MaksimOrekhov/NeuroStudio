// NS-019: pairwise comparisons of variants of ONE frame (Image Arena). Stored in <collection>/comparisons.json.
// Only the verdict is stored; prompts, graphs, seeds, models and PNGs are found through (frame, variant) in the existing files.
// Reading is strict: a missing file is an empty history, anything unreadable is an error and is never overwritten.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../src/regenerate.ts";
import type { ErrorCode } from "../src/errors.ts";
import { readCollection } from "./collections.ts";

export interface Comparison {
  frame: number;
  /** Always smaller than variantB. */
  variantA: number;
  variantB: number;
  /** The winning variant number; null = the two images are equal. */
  winnerVariant: number | null;
  updatedAt: string;
}
export type Comparisons = Record<string, Comparison>;

export class ComparisonError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export const pairKey = (frame: number, a: number, b: number) => `${frame}:${a}-${b}`;
const unreadable = (why: string) => new ComparisonError(`comparisons.json cannot be used: ${why}`, "COMPARISON_FILE_UNREADABLE", 409);

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/** Missing file (ENOENT) = empty history. A read error, invalid JSON, an unknown version or any invalid entry = ComparisonError. */
export async function loadComparisons(dir: string, id: string): Promise<Comparisons> {
  let text: string;
  try {
    text = await readFile(join(dir, id, "comparisons.json"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw unreadable((e as Error).message);
  }
  let raw: { version?: unknown; comparisons?: unknown };
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw unreadable(`invalid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unreadable("unexpected structure");
  if (raw.version !== 1) throw unreadable(`unknown version ${JSON.stringify(raw.version)}`);
  const c = raw.comparisons;
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw unreadable("unexpected structure");
  const out: Comparisons = {};
  for (const [k, v] of Object.entries(c as Record<string, Partial<Comparison>>)) {
    if (!v || typeof v !== "object" || !isInt(v.frame) || !isInt(v.variantA) || !isInt(v.variantB) || v.variantA >= v.variantB) throw unreadable(`invalid entry "${k}"`);
    if (v.winnerVariant !== null && v.winnerVariant !== v.variantA && v.winnerVariant !== v.variantB) throw unreadable(`invalid winner in "${k}"`);
    if (k !== pairKey(v.frame, v.variantA, v.variantB) || typeof v.updatedAt !== "string") throw unreadable(`invalid entry "${k}"`);
    out[k] = { frame: v.frame, variantA: v.variantA, variantB: v.variantB, winnerVariant: v.winnerVariant as number | null, updatedAt: v.updatedAt };
  }
  return out;
}

export async function readComparisons(dir: string, id: string): Promise<Comparisons> {
  if (!(await readCollection(dir, id))) throw new ComparisonError("collection not found", "COLLECTION_NOT_FOUND", 404);
  return loadComparisons(dir, id);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Stores (or replaces: one entry per unordered pair) the verdict for two finished variants of one frame.
 * Read-modify-write is serialised per collection and atomic; no other file of the collection is touched.
 */
export function setComparison(dir: string, id: string, frame: unknown, input: unknown): Promise<Comparison> {
  const key = `${dir}\0${id}`;
  const run = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => apply(dir, id, frame, input));
  locks.set(key, run);
  return run;
}

const bad = (m: string) => new ComparisonError(m, "INVALID_REQUEST", 400);

async function apply(dir: string, id: string, frame: unknown, input: unknown): Promise<Comparison> {
  const c = await readCollection(dir, id);
  if (!c) throw new ComparisonError("collection not found", "COLLECTION_NOT_FOUND", 404);
  if (!isInt(frame) || frame > c.frameCount) throw bad(`frame must be 1-${c.frameCount}`);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw bad("body must be an object");
  const { variantA, variantB, winnerVariant } = input as Record<string, unknown>;
  if (!isInt(variantA) || !isInt(variantB)) throw bad("variantA and variantB must be positive integers");
  if (variantA === variantB) throw bad("an image cannot be compared with itself");
  if (winnerVariant === undefined || (winnerVariant !== null && winnerVariant !== variantA && winnerVariant !== variantB)) throw bad("winnerVariant must be variantA, variantB or null");
  const [a, b] = variantA < variantB ? [variantA, variantB] : [variantB, variantA];
  for (const v of [a, b]) if (!c.frames.some((f) => f.frame === frame && f.variant === v && f.image)) throw bad(`variant ${v} of frame ${frame} has no finished image`);
  const all = await loadComparisons(dir, id); // strict: never write over a file that could not be read
  const entry: Comparison = { frame, variantA: a, variantB: b, winnerVariant, updatedAt: new Date().toISOString() };
  all[pairKey(frame, a, b)] = entry;
  await writeAtomic(join(dir, id, "comparisons.json"), JSON.stringify({ version: 1, comparisons: all }, null, 2));
  return entry;
}

