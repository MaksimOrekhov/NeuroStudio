// NS-013 prototype: collection view model and the N-frame export rule proposed for NS-014.
import type { Collection, Frame } from "../../src/api";
import type { Settings } from "../../../src/composition";
import { W, nPlural } from "./ru";

/** Generation metadata the Library shows. Mirrors what batch-plan.json / collection.json already store. */
export interface CollectionMeta {
  theme: string | null;
  codexModel: string | null;
  codexEffort: string | null;
  codexSeconds?: number;
  comfySeconds?: number;
  /** Resolved composition per scene (after inheritance); {} = Auto. */
  composition: Settings[];
}

/** The existing API Collection plus what the prototype needs: an explicit frame count and metadata. */
export interface ProtoCollection extends Collection {
  frameCount: number;
  meta: CollectionMeta;
  /** Palette seed for the placeholder artwork. */
  hue: number;
  /** Created by the demo Generate button. */
  demo?: boolean;
}

export interface Scene {
  frame: number;
  model: string;
  summary?: string;
  variants: Frame[];
}

export function scenesOf(c: ProtoCollection): Scene[] {
  return Array.from({ length: c.frameCount }, (_, i) => {
    const variants = c.frames.filter((f) => f.frame === i + 1).sort((a, b) => a.variant - b.variant);
    return { frame: i + 1, model: variants[0]?.model ?? "", summary: variants[0]?.summary, variants };
  });
}

/** Final image of a scene: the selected Best, or the only finished variant. Never substitutes another variant. */
export function finalOf(c: ProtoCollection, s: Scene): Frame | undefined {
  const sel = c.selections[String(s.frame)];
  if (sel !== undefined) return s.variants.find((v) => v.variant === sel && v.image);
  return s.variants.length === 1 && s.variants[0].image ? s.variants[0] : undefined;
}

/** Same rule as server/collections.ts exportStatus, generalised from "4" to the collection's own frame count. */
export function exportState(c: ProtoCollection): { ready: boolean; resolved: number; total: number; message: string } {
  const scenes = scenesOf(c);
  const resolved = scenes.filter((s) => finalOf(c, s)).length;
  const total = scenes.length;
  if (resolved === total) return { ready: true, resolved, total, message: `${nPlural(total, W.frame)} · исходные PNG` };
  const missing = scenes.filter((s) => !s.variants.some((v) => v.image)).length;
  if (missing) return { ready: false, resolved, total, message: `Нет готового изображения: ${nPlural(missing, W.frame)}` };
  return { ready: false, resolved, total, message: `Выберите лучшие: ${resolved}/${total}` };
}

export type Badge = { text: string; cls: "ok" | "run" | "warn" | "bad" };

export function badgeOf(c: ProtoCollection): Badge {
  const total = c.frames.length;
  if (c.status === "done") return { text: "Готово", cls: "ok" };
  if (c.status === "running") return { text: `Генерация ${c.doneFrames}/${total}`, cls: "run" };
  if (c.status === "interrupted") return { text: `Прервано · ${c.doneFrames}/${total}`, cls: "warn" };
  return { text: `Ошибка · ${c.doneFrames}/${total}`, cls: "bad" };
}

/** Variants whose state is unknown (submitted or timed out when the run stopped). */
export const unknownFrames = (c: ProtoCollection) => (c.status === "running" ? [] : c.frames.filter((f) => f.status === "submitted" || f.status === "timeout"));

export const needsSelection = (c: ProtoCollection) => c.status === "done" && !exportState(c).ready;
export const hasIssues = (c: ProtoCollection) => c.status === "failed" || c.status === "interrupted";

export const pad2 = (n: number) => String(n).padStart(2, "0");
