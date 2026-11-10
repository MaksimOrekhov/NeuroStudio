// Pure helpers over the real API collection (no Vue, no network).
import type { Collection, Frame } from "./api";
import { W, nPlural } from "./ru";

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Russian title if the plan had one, else the original (older collections). */
export const titleOf = (c: Pick<Collection, "title" | "titleRu">) => c.titleRu || c.title;
export const descriptionOf = (c: Pick<Collection, "description" | "descriptionRu">) => c.descriptionRu || c.description;
/** Russian shot brief if present, else the original English one. */
export const summaryOf = (f: Pick<Frame, "summary" | "summaryRu">) => f.summaryRu || f.summary;

export interface Scene {
  frame: number;
  model: string;
  summary?: string;
  variants: Frame[];
}

/** One scene per frame of the collection (1-4); a frame without any slot still appears (empty variants). */
export function scenesOf(c: Collection): Scene[] {
  return Array.from({ length: c.frameCount }, (_, i) => {
    const variants = c.frames.filter((f) => f.frame === i + 1).sort((a, b) => a.variant - b.variant);
    return { frame: i + 1, model: variants[0]?.model ?? "", summary: summaryOf(variants[0] ?? {}), variants };
  });
}

/** Final image of a scene: the selected Best, or the only finished variant. Never substitutes another variant. */
export function finalOf(c: Collection, s: Scene): Frame | undefined {
  const sel = c.selections[String(s.frame)];
  if (sel !== undefined) return s.variants.find((v) => v.variant === sel && v.image);
  return s.variants.length === 1 && s.variants[0].image ? s.variants[0] : undefined;
}

/** Readiness comes from the server (`export.ready`); this only words the reason in Russian. */
export function exportInfo(c: Collection): { ready: boolean; resolved: number; total: number; message: string } {
  const total = c.frameCount;
  const resolved = c.export.resolved;
  if (c.export.ready) return { ready: true, resolved, total, message: `${nPlural(total, W.frame)} · исходные PNG` };
  const missing = scenesOf(c).filter((s) => !s.variants.some((v) => v.image)).length;
  if (missing) return { ready: false, resolved, total, message: `Нет готового изображения: ${nPlural(missing, W.frame)}` };
  return { ready: false, resolved, total, message: `Выберите лучшие: ${resolved}/${total}` };
}

export type Badge = { text: string; cls: "ok" | "run" | "warn" | "bad" };

export function badgeOf(c: Collection): Badge {
  const total = c.frames.length;
  if (c.status === "done") return { text: "Готово", cls: "ok" };
  if (c.status === "running") return { text: `Генерация ${c.doneFrames}/${total}`, cls: "run" };
  if (c.status === "interrupted") return { text: `Прервано · ${c.doneFrames}/${total}`, cls: "warn" };
  return { text: `Ошибка · ${c.doneFrames}/${total}`, cls: "bad" };
}

/** Slots whose state is unknown (submitted or timed out when the run stopped). */
export const unknownFrames = (c: Collection) => (c.status === "running" ? [] : c.frames.filter((f) => f.status === "submitted" || f.status === "timeout"));

export const needsSelection = (c: Collection) => c.status === "done" && !c.export.ready;
export const hasIssues = (c: Collection) => c.status === "failed" || c.status === "interrupted";
