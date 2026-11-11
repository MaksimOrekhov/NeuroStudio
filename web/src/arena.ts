// Pure helpers of the Image Arena (NS-019): which pairs exist, which are still open, and the win/loss table.
// Nothing here is stored: everything is computed from the finished variants and the saved comparisons.
import type { Collection, Comparison } from "./api";

/** Finished variant numbers of one frame, ascending. */
export const variantsOfFrame = (c: Pick<Collection, "frames">, frame: number): number[] =>
  c.frames
    .filter((f) => f.frame === frame && f.image)
    .map((f) => f.variant)
    .sort((a, b) => a - b);

export const pairKey = (frame: number, a: number, b: number) => `${frame}:${Math.min(a, b)}-${Math.max(a, b)}`;

/** All N*(N-1)/2 unordered pairs (a < b), in a stable order: v1-v2, v1-v3, ..., v2-v3, ... */
export function pairsOf(variants: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) out.push([variants[i], variants[j]]);
  return out;
}

/** Pairs without a saved verdict: the ones the Arena still offers. A pair that was only skipped has no verdict and stays here. */
export const openPairs = (variants: number[], frame: number, history: Record<string, Comparison>): [number, number][] =>
  pairsOf(variants).filter(([a, b]) => !history[pairKey(frame, a, b)]);

/** Saved verdicts of this frame whose two variants are still finished images, in pair order. */
export function donePairs(variants: number[], frame: number, history: Record<string, Comparison>): Comparison[] {
  return pairsOf(variants).flatMap(([a, b]) => history[pairKey(frame, a, b)] ?? []);
}

export interface Row {
  variant: number;
  wins: number;
  losses: number;
  ties: number;
  /** Completed comparisons of this variant. */
  total: number;
}

/** Wins, losses and ties per variant from the saved comparisons (no ratings, no hidden weights). */
export function statsOf(variants: number[], frame: number, history: Record<string, Comparison>): Row[] {
  const rows = new Map<number, Row>(variants.map((v) => [v, { variant: v, wins: 0, losses: 0, ties: 0, total: 0 }]));
  for (const c of donePairs(variants, frame, history)) {
    const a = rows.get(c.variantA)!;
    const b = rows.get(c.variantB)!;
    a.total++;
    b.total++;
    if (c.winnerVariant === null) {
      a.ties++;
      b.ties++;
    } else {
      const [w, l] = c.winnerVariant === c.variantA ? [a, b] : [b, a];
      w.wins++;
      l.losses++;
    }
  }
  return [...rows.values()];
}
