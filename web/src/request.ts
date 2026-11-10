// Pure translation of the Create form into the NS-014 request. No Vue, no network: unit-tested without a browser.
import { AUTO, COMPOSITION_FIELDS, INHERIT, type Composition, type CompositionField } from "../../src/composition";
import type { StartRequest } from "./api";
import { MAX_FRAMES, assignModels, type ModelMode } from "./models";

export type Fields = Record<CompositionField, string>;
export const blank = (v: string): Fields => ({ pose: v, orientation: v, framing: v, viewpoint: v });

export interface FormState {
  theme: string;
  collections: number;
  frames: number;
  variations: number;
  modelMode: ModelMode;
  /** Custom picks for all MAX_FRAMES scenes (hidden scenes keep theirs locally). */
  custom: string[];
  codexModel: string;
  codexEffort: string;
  global: Fields;
  /** Settings of all MAX_FRAMES scenes; only the first `frames` are ever sent. */
  scenes: Fields[];
}

export function defaultForm(): FormState {
  return {
    theme: "",
    collections: 1,
    frames: MAX_FRAMES,
    variations: 1,
    modelMode: "auto",
    custom: assignModels("auto", MAX_FRAMES),
    codexModel: "",
    codexEffort: "",
    global: blank(AUTO),
    scenes: Array.from({ length: MAX_FRAMES }, () => blank(INHERIT)),
  };
}

const freeze = <T>(o: T): T => {
  if (o && typeof o === "object") Object.values(o).forEach(freeze);
  return Object.freeze(o);
};

/** Does the composition of the ACTIVE frames constrain anything? Hidden frames never count. */
export function compositionGuided(f: Pick<FormState, "frames" | "global" | "scenes">): boolean {
  return COMPOSITION_FIELDS.some((k) => f.global[k] !== AUTO) || f.scenes.slice(0, f.frames).some((s) => COMPOSITION_FIELDS.some((k) => s[k] !== INHERIT));
}

/**
 * The immutable snapshot that is sent when the user presses "Сгенерировать": a deep copy, frozen, so later edits
 * of the form cannot change a request that is already built or in flight.
 */
export function buildStartRequest(f: FormState): Readonly<StartRequest> {
  const frames = f.frames;
  const models = assignModels(f.modelMode, frames, f.custom);
  const imageModels: StartRequest["imageModels"] =
    f.modelMode === "auto" ? { mode: "auto" } : f.modelMode === "custom" ? { mode: "custom", perScene: models } : { mode: "only", model: f.modelMode.slice("only:".length) };
  const req: StartRequest = {
    theme: f.theme.trim(),
    collections: f.collections,
    frames,
    variations: f.variations,
    imageModels,
  };
  if (compositionGuided(f)) {
    const composition: Composition = { global: { ...f.global }, scenes: f.scenes.slice(0, frames).map((s) => ({ ...s })) };
    req.composition = composition;
  }
  if (f.codexModel) req.codexModel = f.codexModel;
  if (f.codexEffort) req.codexReasoningEffort = f.codexEffort;
  return freeze(structuredClone(req));
}
