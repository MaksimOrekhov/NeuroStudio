// NS-026 review fix: compact view-order history of recent collections for the auto pose mode.
// Read from the saved Prompt Plans with the Prompt Evolution feature extractor, so frames planned with a catalog pose and frames with
// a free pose count alike. A view that cannot be read unambiguously is "?", never a guess. Data and soft hints only: no fixed order,
// no ban on any view, and an explicit view requirement for the last frame always wins.
import { extractPromptFeatures } from "./promptFeatures.ts";
import { compatible, viewGroup, type PoseEntry } from "../src/poses.ts";
import type { Settings } from "../src/composition.ts";

export type Direction = "front" | "side" | "rear";

/** extractPromptFeatures angle values that name a view direction ("three-quarter view" is reported only when it is NOT rear). */
const DIRECTION: Record<string, Direction> = {
  "front view": "front",
  "three-quarter view": "front",
  "side view": "side",
  "rear three-quarter view": "rear",
  "rear view": "rear",
};

/** Newest collections whose view order is summarised. */
export const VIEW_HISTORY_COLLECTIONS = 6;
/** Poses suggested for the last frame when recent collections keep ending on a rear view. */
export const FINAL_SUGGESTIONS = 3;

/** The one view direction a positive prompt states, or null when it states none or several. */
export function frameDirection(positive: unknown): Direction | null {
  if (typeof positive !== "string") return null;
  const dirs = [...new Set((extractPromptFeatures(positive).angle ?? []).filter((a) => a in DIRECTION).map((a) => DIRECTION[a]))];
  return dirs.length === 1 ? dirs[0] : null;
}

export interface ViewHistory {
  /** Newest first; one entry per multi-frame collection, frame order, null = not identifiable. */
  sequences: (Direction | null)[][];
  /** Last frames: how many were rear among those whose view could be read. */
  finals: { rear: number; identified: number; collections: number };
  /** Recent collections keep ending on a rear view (at least 2, and at least half of the identifiable last frames). */
  rearHeavy: boolean;
}

/** View history from saved plans (newest first). Single-frame collections have no order and are skipped. Never throws. */
export function viewHistory(plans: readonly unknown[], limit = VIEW_HISTORY_COLLECTIONS): ViewHistory {
  const sequences: (Direction | null)[][] = [];
  for (const plan of plans) {
    if (sequences.length >= limit) break;
    const frames = (plan as { frames?: Array<{ positive?: unknown }> })?.frames;
    if (!Array.isArray(frames) || frames.length < 2) continue;
    sequences.push(frames.map((f) => frameDirection(f?.positive)));
  }
  const last = sequences.map((s) => s[s.length - 1]);
  const identified = last.filter((d) => d !== null).length;
  const rear = last.filter((d) => d === "rear").length;
  return { sequences, finals: { rear, identified, collections: sequences.length }, rearHeavy: rear >= 2 && rear * 2 >= identified };
}

export interface ViewNote {
  text: string;
  /** Listed poses suggested for the last frame (seeded sample order), [] when no hint was given. */
  finalSuggestions: string[];
}

/**
 * The soft hint appended to the pose block. `sample` is the listed sample in its seeded order; `lastFrame` the resolved composition of
 * the last frame. The final-view hint is skipped when the user set the last frame's orientation or when the history does not show the
 * habit; nothing is said when no view could be read at all.
 */
export function viewNote(h: ViewHistory, sample: readonly PoseEntry[], lastFrame: Settings = {}): ViewNote {
  const readable = h.sequences.filter((s) => s.some((d) => d !== null));
  if (!readable.length) return { text: "", finalSuggestions: [] };
  const lines = [
    `View order of recent collections, newest first ("?" = not identifiable). Data only, not a rule: ${readable.map((s) => s.map((d) => d ?? "?").join(" > ")).join("; ")}.`,
  ];
  let finalSuggestions: string[] = [];
  if (h.rearHeavy && !lastFrame.orientation) {
    finalSuggestions = sample
      .filter((p) => p.family !== "rear" && compatible(p, lastFrame) && p.views.some((v) => viewGroup(v) !== "rear"))
      .slice(0, FINAL_SUGGESTIONS)
      .map((p) => p.id);
    lines.push(
      `${h.finals.rear} of the ${h.finals.identified} recent collections whose last view is identifiable ended on a rear view. Do not end this collection on a rear view by habit: choose the last frame's view from the concept${finalSuggestions.length ? `; for example ${finalSuggestions.join(", ")} suit a front or side view there` : ""}. A rear last frame is still right when the idea needs it.`,
    );
  }
  return { text: lines.join("\n"), finalSuggestions };
}
