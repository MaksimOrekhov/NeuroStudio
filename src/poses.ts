// NS-026: Adaptive Pose Selection v1. The curated NeuroStudio pose catalog, a compact reproducible sample of it for the single
// Codex planning request, and the per-image pose record. Local and deterministic: no extra Codex call, no network.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMPOSITION_OPTIONS, type Resolved, type Settings } from "./composition.ts";
import { BANNED, FREE_POSE } from "./promptPlan.ts";

export { FREE_POSE };

export const POSE_CATALOG_PATH = resolve(import.meta.dirname, "../prompts/pose-catalog.json");

/** "free": Codex invents poses as before NS-026 (the default). "auto": Codex picks per frame from a catalog sample. */
export const POSE_MODES = ["free", "auto"] as const;
export type PoseMode = (typeof POSE_MODES)[number];

export const POSE_FAMILIES = ["standing", "leaning", "walking", "seated", "reclining", "portrait", "rear"] as const;
export type PoseFamily = (typeof POSE_FAMILIES)[number];

export interface PoseEntry {
  id: string;
  family: PoseFamily;
  /** Short Russian name shown in the UI (never the id). */
  nameRu: string;
  description: string;
  body: string;
  hands: string;
  legs?: string;
  support: string;
  /** Composition orientation option ids the pose works with. */
  views: string[];
  /** Composition framing (shot size) option ids. */
  crops: string[];
  /** Composition pose option ids the pose satisfies. */
  poses: string[];
  difficulty: "easy" | "moderate";
  risks: string;
}

export interface PoseCatalog {
  version: number;
  poses: PoseEntry[];
}

/** Pose fact of one generated image (FrameRecord and its sidecar). `verified: false` = the prompt was edited, so the image may no longer show this pose. */
export interface FramePose {
  id: string;
  catalogVersion: number;
  verified: boolean;
}

/** What a run in auto mode offered Codex (batch-plan.json), for diagnosis. */
export interface PoseSelection {
  mode: "auto";
  catalogVersion: number;
  seed: number;
  /** Ids passed to Codex, in the order they were listed. */
  sample: string[];
  /** Catalog uses per pose in the recent collections that lowered its priority. */
  recent: Record<string, number>;
  /** True when Preference Memory reports stable anatomy problems: moderate poses get a lower priority. */
  cautious: boolean;
}

export class PoseError extends Error {}

/** Words the Creative Director must never see and phrases it is told to avoid (crossed legs, tilted head...). */
const AVOID = ["crossed legs", "crossed hips", "one leg forward", "tilted head", "hands in hair", "high kick"];
const ID = /^ND-P\d{2}$/;
const field = (o: Record<string, unknown>, k: string) => typeof o[k] === "string" && (o[k] as string).trim().length > 0;

/** All problems of a catalog (empty = valid). Ids unique and well-formed, ids of composition options known, no banned wording. */
export function catalogProblems(c: unknown): string[] {
  const errs: string[] = [];
  const cat = c as PoseCatalog;
  if (!cat || typeof cat !== "object" || !Number.isInteger(cat.version) || cat.version < 1) return ["catalog.version must be a positive integer"];
  if (!Array.isArray(cat.poses) || !cat.poses.length) return ["catalog.poses must be a non-empty array"];
  const ids = new Set<string>();
  const known = { views: COMPOSITION_OPTIONS.orientation, crops: COMPOSITION_OPTIONS.framing, poses: COMPOSITION_OPTIONS.pose };
  cat.poses.forEach((p, i) => {
    const o = p as unknown as Record<string, unknown>;
    const at = `poses[${i}]${typeof p?.id === "string" ? ` ${p.id}` : ""}`;
    if (typeof p?.id !== "string" || !ID.test(p.id)) errs.push(`${at}: id must look like ND-P01`);
    else if (ids.has(p.id)) errs.push(`${at}: duplicate id`);
    else ids.add(p.id);
    if (!(POSE_FAMILIES as readonly string[]).includes(p?.family)) errs.push(`${at}: unknown family`);
    if (p?.difficulty !== "easy" && p?.difficulty !== "moderate") errs.push(`${at}: difficulty must be easy or moderate`);
    for (const k of ["nameRu", "description", "body", "hands", "support", "risks"]) if (!field(o, k)) errs.push(`${at}: ${k} missing`);
    if (o.legs !== undefined && !field(o, "legs")) errs.push(`${at}: legs must be a non-empty string when present`);
    if (field(o, "nameRu") && !/[а-яё]/i.test(p.nameRu)) errs.push(`${at}: nameRu must be Russian`);
    for (const k of ["views", "crops", "poses"] as const) {
      const list = o[k];
      if (!Array.isArray(list) || !list.length) errs.push(`${at}: ${k} must be a non-empty array`);
      else for (const v of list) if (!known[k].some((x) => x.id === v)) errs.push(`${at}: unknown ${k} id ${JSON.stringify(v)}`);
    }
    const text = codexText(p).toLowerCase();
    for (const w of [...BANNED, ...AVOID]) if (text.includes(w)) errs.push(`${at}: contains forbidden phrase "${w}"`);
  });
  return errs;
}

let cached: { path: string; catalog: PoseCatalog } | null = null;

/** The catalog (read once per path). A missing or invalid catalog is an error, never silently replaced. */
export function loadPoseCatalog(path = POSE_CATALOG_PATH): PoseCatalog {
  if (cached?.path === path) return cached.catalog;
  let c: unknown;
  try {
    c = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PoseError(`Pose catalog cannot be read at ${path}: ${(e as Error).message}`);
  }
  const errs = catalogProblems(c);
  if (errs.length) throw new PoseError(`Invalid pose catalog ${path}:\n  ${errs.join("\n  ")}`);
  const raw = c as PoseCatalog;
  const catalog: PoseCatalog = { version: raw.version, poses: raw.poses };
  cached = { path, catalog };
  return catalog;
}

export function poseById(id: string, catalog = loadPoseCatalog()): PoseEntry | undefined {
  return catalog.poses.find((p) => p.id === id);
}

/** undefined/null = "free" (the pre-NS-026 behaviour). */
export function parsePoseMode(x: unknown): PoseMode {
  if (x === undefined || x === null) return "free";
  if (typeof x !== "string" || !(POSE_MODES as readonly string[]).includes(x)) throw new PoseError(`poseSelection must be one of ${POSE_MODES.join(", ")}`);
  return x as PoseMode;
}

/** Does the pose fit one frame's explicit composition requirements (pose, orientation, shot size)? View height is not constrained. */
export function compatible(p: PoseEntry, req: Settings = {}): boolean {
  return (!req.pose || p.poses.includes(req.pose)) && (!req.orientation || p.views.includes(req.orientation)) && (!req.framing || p.crops.includes(req.framing));
}

const constrained = (s: Settings) => Boolean(s.pose || s.orientation || s.framing);

/** Deterministic pseudo-random number in [0, 1) from the seed and a key (FNV-1a + a final avalanche). */
function rand(seed: number, key: string): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const SAMPLE_MIN = 8;
export const SAMPLE_MAX = 12;
/** Compatible poses guaranteed in the sample for every frame with explicit requirements (when the catalog has them). */
export const PER_SCENE = 3;
/** How strongly one recent use lowers a pose's priority: weight / (1 + RECENT_FACTOR * uses). Never zero. */
export const RECENT_FACTOR = 0.5;

export interface SelectOptions {
  catalog: PoseCatalog;
  /** Resolved composition per frame (index 0 = frame 1); [] or Auto-only = no requirements. */
  resolved: Resolved;
  frames: number;
  collections: number;
  seed: number;
  /** Uses per pose id in recent collections. */
  recent?: Record<string, number>;
  /** Lower the priority of moderate poses (Preference Memory reports stable anatomy problems). */
  cautious?: boolean;
}

/** Sample size: room for every frame of the batch plus alternatives, within 8-12. */
export const sampleSize = (frames: number, collections: number) => Math.min(SAMPLE_MAX, Math.max(SAMPLE_MIN, frames * collections + 4));

/**
 * The compact, reproducible sample for one Codex request (same inputs and seed = same sample, same order).
 * Weighted random order (Efraimidis-Spirakis keys): recent use and, when cautious, moderate difficulty only LOWER a pose's chance;
 * nothing is banned. Every constrained frame first gets up to PER_SCENE compatible poses; poses compatible with no frame are left
 * out. The rest is filled family by family (at most a quarter of the sample per family before the cap is relaxed), so a free theme
 * receives standing, seated, walking, portrait, rear and reclining options rather than one family.
 */
export function selectPoses(o: SelectOptions): PoseEntry[] {
  const scenes = Array.from({ length: o.frames }, (_, i) => o.resolved[i] ?? {});
  const size = sampleSize(o.frames, o.collections);
  const weight = (p: PoseEntry) => (p.difficulty === "moderate" ? (o.cautious ? 0.4 : 0.75) : 1) / (1 + RECENT_FACTOR * (o.recent?.[p.id] ?? 0));
  const key = (p: PoseEntry) => rand(o.seed, p.id) ** (1 / weight(p));
  const ranked = o.catalog.poses
    .filter((p) => scenes.some((s) => compatible(p, s)))
    .map((p) => ({ p, k: key(p) }))
    .sort((a, b) => b.k - a.k || a.p.id.localeCompare(b.p.id))
    .map((x) => x.p);
  const picked: PoseEntry[] = [];
  for (const s of scenes) {
    if (!constrained(s)) continue;
    for (const p of ranked) {
      if (picked.filter((x) => compatible(x, s)).length >= PER_SCENE || picked.length >= size) break;
      if (compatible(p, s) && !picked.includes(p)) picked.push(p);
    }
  }
  const cap = Math.max(2, Math.ceil(size / 4));
  for (const limit of [cap, Infinity]) {
    for (const p of ranked) {
      if (picked.length >= size) break;
      if (!picked.includes(p) && picked.filter((x) => x.family === p.family).length < limit) picked.push(p);
    }
  }
  return picked;
}

const label = (group: "orientation" | "framing", id: string) => (COMPOSITION_OPTIONS[group].find((x) => x.id === id)?.label ?? id).toLowerCase();

/** The text of one pose as Codex sees it (also what the banned-word check covers). */
export function codexText(p: PoseEntry): string {
  const parts = [
    p.description,
    `Body: ${p.body}`,
    `Hands: ${p.hands}`,
    ...(p.legs ? [`Legs: ${p.legs}`] : []),
    `Support: ${p.support}`,
    `Views: ${(p.views ?? []).map((v) => label("orientation", v)).join(", ")}.`,
    `Shot sizes: ${(p.crops ?? []).map((v) => label("framing", v)).join(", ")}.`,
    `Watch: ${p.risks}`,
  ];
  return parts.join(" ");
}

/** Hard cap on the pose block in the Codex request (characters). */
export const POSE_PROMPT_MAX = 8000;

/** The block appended to the single planning request in auto mode. */
export function posePrompt(sample: readonly PoseEntry[], version: number): string {
  if (!sample.length) return "";
  const head = `Pose library (NeuroStudio catalog v${version}; an optional helper, not a template). For EVERY frame set "poseId": the id of the ONE listed pose you build that frame on, or "${FREE_POSE}" when none of them fits the frame naturally (then invent a simple pose yourself). Never use an id that is not listed below.
Priorities: the hard constraints, then the user's theme and composition requirements, then relevant feedback from the preference notes (if any), then this library, then your own taste. Never change the concept, the place or the outfit just to use a listed pose.
- Describe the chosen pose in the positive prompt in your own plain English words, adapted to the place, the outfit and the shot size; never write the id or the word "library" in any prompt or summary.
- A listed support (a wall, a rail, a seat, a table) is used only where the setting naturally has it; never add an object just to hold a pose.
- Describe only what is visible at the chosen shot size, and keep the view consistent with the pose.
- Inside a collection do not repeat the same pose or nearly the same gesture unless the request asks for it. Views and poses are not tied to frame numbers: any frame may be front, side, three-quarter or rear, standing or seated, and the last frame does not need a rear view.
- Beauty and expression matter as much as simplicity: pick the pose that makes the strongest picture of the idea.`;
  const lines = sample.map((p) => `- ${p.id}: ${codexText(p)}`);
  let text = head;
  for (const l of lines) {
    if (text.length + l.length + 1 > POSE_PROMPT_MAX) break;
    text += `\n${l}`;
  }
  return text;
}

/** Ids actually listed by posePrompt (it stops before the cap). */
export function listedIds(sample: readonly PoseEntry[], version: number): string[] {
  const text = posePrompt(sample, version);
  return sample.filter((p) => text.includes(`\n- ${p.id}: `)).map((p) => p.id);
}

/** Catalog pose uses in saved Prompt Plans (newest collections). Unreadable plans or plans without poseId count for nothing. */
export function countPoseUses(plans: readonly unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const plan of plans) {
    const frames = (plan as { frames?: Array<{ poseId?: unknown }> })?.frames;
    if (!Array.isArray(frames)) continue;
    for (const f of frames) if (typeof f?.poseId === "string" && ID.test(f.poseId)) out[f.poseId] = (out[f.poseId] ?? 0) + 1;
  }
  return out;
}

/** Preference Memory tags about rendered anatomy. Only a STABLE pattern (several images, several collections) counts, never one Dislike. */
const ANATOMY_TAGS = new Set(["anatomy", "bad_hands", "bad_legs", "awkward_pose", "body_proportions"]);
export function anatomyCaution(memory?: { negative?: ReadonlyArray<{ tag: string; confidence: string }> } | null): boolean {
  return Boolean(memory?.negative?.some((t) => t.confidence === "stable" && ANATOMY_TAGS.has(t.tag)));
}

/** The pose of the frames built from a plan frame: none when the plan has no poseId (free mode, older plans). */
export function framePose(poseId: string | undefined, catalogVersion: number | undefined): FramePose | undefined {
  if (typeof poseId !== "string" || catalogVersion === undefined) return undefined;
  return { id: poseId, catalogVersion, verified: true };
}

/** A pose record read from disk (sidecar / manifest), or undefined when absent or malformed. Never throws. */
export function readFramePose(x: unknown): FramePose | undefined {
  const p = x as FramePose;
  if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || !Number.isInteger(p.catalogVersion) || typeof p.verified !== "boolean") return undefined;
  return { id: p.id, catalogVersion: p.catalogVersion, verified: p.verified };
}
