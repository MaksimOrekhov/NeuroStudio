// NS-013 prototype: shared reactive state and the simulated (demo) run. No network calls.
import { computed, reactive } from "vue";
import { AUTO, COMPOSITION_FIELDS, INHERIT, resolveComposition, type CompositionField, type Settings } from "../../../src/composition";
import { makeCollection, mockCollections, mockRuns, type RunRecord } from "./mock";
import { type ProtoCollection } from "./library";
import { MAX_FRAMES, assignModels, autoMix, totalImages, type ModelMode } from "./models";

export type Fields = Record<CompositionField, string>;
export const blank = (v: string): Fields => ({ pose: v, orientation: v, framing: v, viewpoint: v });

export type View = "create" | "library" | "activity";

export const ui = reactive({
  view: "create" as View,
  advancedOpen: false,
  /** Scene whose composition editor is expanded (0-based), or null. */
  openScene: null as number | null,
  /** Collection id open in Library detail, or null for the grid. */
  openCollection: null as string | null,
  comfy: "ok" as "ok" | "down",
  toast: "",
});

let toastTimer: number | undefined;
export function toast(text: string) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast = ""), 3200);
}

export function go(view: View, collectionId: string | null = null) {
  ui.view = view;
  if (view === "library") ui.openCollection = collectionId;
  window.scrollTo({ top: 0 });
}

// ---------- Create form ----------

export const form = reactive({
  theme: "",
  collections: 2,
  frames: 4,
  variations: 2,
  modelMode: "auto" as ModelMode,
  /** Custom per-scene picks for all MAX_FRAMES scenes (kept while scenes are hidden). */
  custom: autoMix(MAX_FRAMES),
  codexModel: "",
  codexEffort: "",
  global: blank(AUTO),
  /** Per-scene settings for all MAX_FRAMES scenes; hidden scenes keep theirs but are not sent. */
  scenes: Array.from({ length: MAX_FRAMES }, () => blank(INHERIT)),
});

export const assigned = computed(() => assignModels(form.modelMode, form.frames, form.custom));
export const resolved = computed(() => resolveComposition({ global: form.global, scenes: form.scenes }).slice(0, form.frames));
export const guided = computed(() => resolved.value.filter((s) => Object.keys(s).length > 0).length);
export const total = computed(() => totalImages(form.collections, form.frames, form.variations));

export function setModelMode(mode: ModelMode) {
  // Entering Custom starts from what the user currently sees, so nothing jumps.
  if (mode === "custom" && form.modelMode !== "custom") form.custom = [...assigned.value, ...autoMix(MAX_FRAMES).slice(form.frames)];
  form.modelMode = mode;
}

export const sceneOverrides = (i: number) => COMPOSITION_FIELDS.filter((f) => form.scenes[i][f] !== INHERIT).length;

export function resetScene(i: number) {
  Object.assign(form.scenes[i], blank(INHERIT));
}
export function copySceneToAll(i: number) {
  for (let j = 0; j < form.frames; j++) if (j !== i) Object.assign(form.scenes[j], { ...form.scenes[i] });
  const others = form.frames - 1;
  toast(`Настройки кадра ${String(i + 1).padStart(2, "0")} скопированы ${others === 1 ? "во второй кадр" : `в остальные кадры (${others})`}.`);
}
export function resetComposition() {
  Object.assign(form.global, blank(AUTO));
  for (const s of form.scenes) Object.assign(s, blank(INHERIT));
  toast("Композиция сброшена: во всех кадрах «Авто».");
}

export function openSceneComposition(i: number) {
  ui.advancedOpen = true;
  ui.openScene = i;
  requestAnimationFrame(() => document.getElementById(`scene-comp-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// ---------- Library ----------

export const library = reactive({ items: mockCollections() as ProtoCollection[], runs: mockRuns() as RunRecord[] });

export function selectBest(c: ProtoCollection, frame: number, variant: number) {
  const key = String(frame);
  if (c.selections[key] === variant) delete c.selections[key];
  else c.selections[key] = variant;
}

// ---------- Simulated run ----------

export type RunStatus = "idle" | "planning" | "generating" | "completed" | "failed";
export interface RunItem {
  title: string;
  id?: string;
  status: "waiting" | "generating" | "done" | "failed" | "not_started";
  done: number;
  total: number;
}
export interface RunSnapshot {
  theme: string;
  collections: number;
  frames: number;
  variations: number;
  models: string[];
  codexModel: string;
  codexEffort: string;
  composition: Settings[];
}

export const run = reactive({
  status: "idle" as RunStatus,
  startedAt: "",
  finishedAt: "",
  snapshot: null as RunSnapshot | null,
  done: 0,
  total: 0,
  current: 0,
  currentScene: 0,
  currentVariant: 0,
  items: [] as RunItem[],
  error: "",
});

export const running = computed(() => run.status === "planning" || run.status === "generating");

const TITLES = ["Morning Ferry", "Orchard Ladder", "Blue Hour Laundry", "Salt Flat Picnic", "Library Ladder Noon", "Greenhouse Rain"];
let timer: number | undefined;
let titleOffset = 0;
/** Demo presets fast-forward the simulation synchronously up to `stopAt` finished images. */
let instant = false;
let stopAt = Infinity;
function later(fn: () => void, ms: number) {
  if (instant) fn();
  else timer = window.setTimeout(fn, ms);
}

export function startDemoRun() {
  if (running.value) return;
  if (ui.comfy === "down") return toast("ComfyUI недоступен — генерация отключена.");
  clearTimeout(timer);
  const snap: RunSnapshot = {
    theme: form.theme.trim(),
    collections: form.collections,
    frames: form.frames,
    variations: form.variations,
    models: [...assigned.value],
    codexModel: form.codexModel,
    codexEffort: form.codexEffort,
    composition: resolved.value.map((s) => ({ ...s })),
  };
  Object.assign(run, {
    status: "planning",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    snapshot: snap,
    done: 0,
    total: totalImages(snap.collections, snap.frames, snap.variations),
    current: 0,
    currentScene: 0,
    currentVariant: 0,
    error: "",
    items: Array.from({ length: snap.collections }, (_, i) => ({ title: `Коллекция ${i + 1}`, status: "waiting", done: 0, total: snap.frames * snap.variations })),
  });
  later(planned, 2600);
}

function planned() {
  const snap = run.snapshot!;
  run.items.forEach((it, i) => (it.title = TITLES[(titleOffset + i) % TITLES.length]));
  titleOffset += snap.collections;
  run.status = "generating";
  beginCollection(0);
}

function beginCollection(i: number) {
  const snap = run.snapshot!;
  const it = run.items[i];
  const c = makeCollection({
    id: `demo-${Date.now().toString(36)}-${i + 1}`,
    title: it.title,
    description: "Demo collection from the simulated run (placeholder artwork).",
    daysAgo: 0,
    hue: (titleOffset * 47 + i * 83) % 360,
    frames: snap.frames,
    variations: snap.variations,
    models: snap.models,
    summaries: Array.from({ length: snap.frames }, (_, k) => `Shot brief for scene ${k + 1} (demo).`),
    status: "running",
    states: Array.from({ length: snap.frames * snap.variations }, () => "pending"),
    theme: snap.theme || null,
    codex: [snap.codexModel || null, snap.codexEffort || null],
    composition: snap.composition,
  });
  c.createdAt = new Date().toISOString();
  c.demo = true;
  library.items.unshift(c);
  it.id = c.id;
  it.status = "generating";
  run.current = i;
  tick();
}

const currentCollection = () => library.items.find((c) => c.id === run.items[run.current]?.id);

function tick() {
  const c = currentCollection();
  const it = run.items[run.current];
  if (!c || !it) return;
  const next = c.frames.find((f) => f.status === "pending");
  if (next) {
    next.status = "submitted";
    run.currentScene = next.frame;
    run.currentVariant = next.variant;
  }
  later(() => {
    const f = c.frames.find((x) => x.status === "submitted");
    if (f) {
      f.status = "done";
      f.image = `${f.frame}-${f.variant}.png`;
      c.doneFrames++;
      it.done++;
      run.done++;
      if (instant && run.done >= stopAt) instant = false;
    }
    if (c.frames.some((x) => x.status === "pending")) return tick();
    c.status = "done";
    it.status = "done";
    if (run.current + 1 < run.items.length) return beginCollection(run.current + 1);
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    recordRun();
  }, 650);
}

/** Stops the simulated run the way a real failure does: nothing is resubmitted or resumed. */
export function failDemoRun(reason: "error" | "comfy") {
  if (!running.value) return;
  clearTimeout(timer);
  if (run.status === "planning") {
    run.error = reason === "comfy" ? "ComfyUI недоступен." : "Codex вернул некорректный план промптов (frames[2].positive missing).";
    run.items.forEach((it) => (it.status = "not_started"));
  } else {
    const c = currentCollection();
    const f = c?.frames.find((x) => x.status === "submitted");
    if (c && f) {
      // A frame that ComfyUI already accepted has an unknown outcome when ComfyUI disappears.
      f.status = reason === "comfy" ? "timeout" : "failed";
      f.error = reason === "comfy" ? undefined : "Ошибка выполнения в ComfyUI: CUDA out of memory (KSampler, узел 3)";
      c.status = "failed";
    }
    run.items.forEach((it, i) => {
      if (i === run.current) it.status = "failed";
      else if (i > run.current) it.status = "not_started";
    });
    run.error = reason === "comfy" ? "ComfyUI отключился во время генерации изображения." : "Ошибка выполнения в ComfyUI: CUDA out of memory (KSampler, узел 3)";
  }
  run.status = "failed";
  run.finishedAt = new Date().toISOString();
  recordRun();
}

function recordRun() {
  const s = run.snapshot!;
  library.runs.unshift({
    id: `run-${Date.now().toString(36)}`,
    startedAt: run.startedAt,
    theme: s.theme || null,
    collections: s.collections,
    frames: s.frames,
    variations: s.variations,
    status: run.status === "completed" ? "completed" : "failed",
    collectionIds: run.items.filter((it) => it.id).map((it) => it.id!),
    error: run.error || undefined,
  });
}

export function resetDemo(silent = false) {
  clearTimeout(timer);
  instant = false;
  Object.assign(run, { status: "idle", snapshot: null, items: [], done: 0, total: 0, error: "" });
  library.items = mockCollections();
  library.runs = mockRuns();
  ui.comfy = "ok";
  ui.openCollection = null;
  if (!silent) toast("Демо-данные восстановлены.");
}

export function setComfy(state: "ok" | "down") {
  ui.comfy = state;
  if (state === "down" && running.value) failDemoRun("comfy");
}

/** Review presets: a run in progress (9 of 16 images) or a run stopped by a ComfyUI disconnect at that point. */
export function showRunPreset(kind: "generating" | "failed") {
  resetDemo(true);
  instant = true;
  stopAt = 9;
  startDemoRun();
  instant = false;
  stopAt = Infinity;
  if (kind === "failed") setComfy("down");
  go("activity");
}

const SAMPLE_THEME = "тихий приморский городок ранней осенью";

/**
 * Opens a fixed review state from the URL hash (used for screenshots and quick review links):
 * #create, #advanced, #custom, #library, #collection, #activity-generating, #activity-failed.
 */
export function applyPreset(name: string) {
  if (name === "create" || name === "advanced" || name === "custom") {
    form.theme = SAMPLE_THEME;
    form.frames = name === "create" ? 3 : 4;
  }
  if (name === "advanced") {
    form.codexModel = "codex-model-a";
    form.codexEffort = "high";
    Object.assign(form.global, { framing: "full_body", viewpoint: "eye_level" });
    Object.assign(form.scenes[0], { pose: "sitting_on_a_bench_or_ledge", framing: "waist_up" });
    ui.advancedOpen = true;
    ui.openScene = 0;
  }
  if (name === "custom") {
    setModelMode("custom");
    form.custom[1] = "duskrose";
    form.custom[3] = "crimson-oath";
  }
  if (name === "library") go("library");
  if (name === "collection") go("library", "2026-11-10-lemon-grove-siesta");
  if (name === "activity-generating") showRunPreset("generating");
  if (name === "activity-failed") showRunPreset("failed");
}
