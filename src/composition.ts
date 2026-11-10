// Single catalog of composition options, shared by the web UI and the server (NS-011).
// No imports: it is bundled by Vite as well as run by Node.

export const COMPOSITION_FIELDS = ["pose", "orientation", "framing", "viewpoint"] as const;
export type CompositionField = (typeof COMPOSITION_FIELDS)[number];

export const FIELD_LABEL: Record<CompositionField, string> = { pose: "Pose", orientation: "Orientation", framing: "Framing", viewpoint: "Viewpoint" };

/** Field names as sent to Codex. "Framing" and "camera" are banned words in prompts, so the request avoids them. */
const FIELD_ASK: Record<CompositionField, string> = { pose: "Pose", orientation: "Body orientation", framing: "Shot size", viewpoint: "View height and direction" };

export interface Option {
  id: string;
  label: string;
}

const o = (label: string): Option => ({ id: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label });

/** Concrete choices per field ("Auto" / "Inherit Global" are handled separately and are not options). */
export const COMPOSITION_OPTIONS: Record<CompositionField, Option[]> = {
  pose: [
    o("Standing naturally"),
    o("Standing with weight on one leg"),
    o("Walking"),
    o("Sitting on a chair"),
    o("Sitting on a bench or ledge"),
    o("Sitting on the floor"),
    o("Leaning against a wall"),
    o("Leaning on a surface"),
    o("Leaning forward"),
    o("Slightly bending forward"),
    o("Reclining with support"),
    o("Lying on the back"),
    o("Lying on the side"),
    o("Kneeling"),
    o("Crouching"),
    o("Turning naturally"),
  ],
  orientation: [
    o("Direct front view"),
    o("Front three-quarter view"),
    o("Left side profile"),
    o("Right side profile"),
    o("Rear three-quarter view"),
    o("Direct rear view"),
    o("Over-the-shoulder view"),
    o("Slightly turned away"),
  ],
  framing: [
    o("Face close-up"),
    o("Head and shoulders"),
    o("Chest-up"),
    o("Waist-up"),
    o("Head-to-mid-thigh"),
    o("Knee-up"),
    o("Full body"),
    o("Wide environmental composition"),
  ],
  viewpoint: [o("Eye level"), o("Slightly elevated"), o("High angle"), o("Directly overhead"), o("Slightly low angle"), o("Low angle"), o("Diagonal perspective")],
};

export const SCENES = 4;
export const AUTO = "auto";
export const INHERIT = "inherit";

export type Settings = Partial<Record<CompositionField, string>>;
/** What the API accepts: option ids, "auto", and (scenes only) "inherit". Everything is optional. */
export interface Composition {
  global?: Settings;
  /** Index 0 = Scene 01. */
  scenes?: Settings[];
}
/** Final per-scene requirements after inheritance: only concrete option ids; Auto fields are absent. */
export type Resolved = Settings[];

export class CompositionError extends Error {}

function checkSettings(s: unknown, where: string, allowInherit: boolean): Settings {
  if (typeof s !== "object" || s === null || Array.isArray(s)) throw new CompositionError(`composition.${where} must be an object`);
  const out: Settings = {};
  for (const [k, v] of Object.entries(s)) {
    if (!(COMPOSITION_FIELDS as readonly string[]).includes(k)) throw new CompositionError(`composition.${where}: unknown field "${k}"`);
    const ok = typeof v === "string" && (v === AUTO || (allowInherit && v === INHERIT) || COMPOSITION_OPTIONS[k as CompositionField].some((x) => x.id === v));
    if (!ok) throw new CompositionError(`composition.${where}.${k}: unknown value ${JSON.stringify(v)}`);
    out[k as CompositionField] = v as string;
  }
  return out;
}

/**
 * Validates the untrusted `composition` request field against the real frame count (default 4, the old behaviour).
 * Settings for a frame that does not exist are an error; there are no hidden scenes. undefined/null = not given.
 */
export function parseComposition(input: unknown, frames = SCENES): Composition | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new CompositionError("composition must be an object");
  const { global, scenes, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length) throw new CompositionError(`composition: unknown key "${Object.keys(rest)[0]}"`);
  const out: Composition = {};
  if (global !== undefined) out.global = checkSettings(global, "global", false);
  if (scenes !== undefined) {
    if (!Array.isArray(scenes)) throw new CompositionError("composition.scenes must be an array");
    if (scenes.length > frames) throw new CompositionError(`composition.scenes has ${scenes.length} entries but the collection has only ${frames} frame${frames === 1 ? "" : "s"}`);
    out.scenes = scenes.map((s, i) => checkSettings(s, `scenes[${i}]`, true));
  }
  return out;
}

/** Scene value > scene Auto > Inherit Global > global Auto. Auto resolves to "no requirement". */
export function resolveComposition(c?: Composition, frames = SCENES): Resolved {
  return Array.from({ length: frames }, (_, i) => {
    const out: Settings = {};
    for (const f of COMPOSITION_FIELDS) {
      const own = c?.scenes?.[i]?.[f] ?? INHERIT;
      const v = own === INHERIT ? (c?.global?.[f] ?? AUTO) : own;
      if (v !== AUTO) out[f] = v;
    }
    return out;
  });
}

const labelOf = (f: CompositionField, id: string) => (COMPOSITION_OPTIONS[f].find((x) => x.id === id)?.label ?? id).toLowerCase();

/** Text block appended to the Codex request, or "" when nothing is constrained (the request is then exactly as before). */
export function compositionPrompt(c?: Composition, frames = SCENES): string {
  const resolved = resolveComposition(c, frames);
  if (!resolved.some((s) => COMPOSITION_FIELDS.some((f) => s[f]))) return "";
  const scenes = resolved.map((s, i) => {
    const lines = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => `- ${FIELD_ASK[f]}: ${labelOf(f, s[f]!)}`);
    return `Scene ${String(i + 1).padStart(2, "0")}:\n${lines.length ? lines.join("\n") : "- Artistic direction is up to you."}`;
  });
  return `

User composition requirements. Each applies to the scene with that number in EVERY collection. They take priority over your usual artistic preferences; everything not listed (outfit, appearance, lighting, setting, mood, remaining composition) stays your own creative decision, separately for each collection. If a combination is awkward anatomically, find a natural way to realize it that keeps the meaning; do not ignore it. Express each requirement in plain natural language inside the prompts; do not copy the labels, and never use the words "camera" or "framing".

${scenes.join("\n\n")}`;
}
