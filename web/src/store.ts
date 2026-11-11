// Shared reactive state of the production UI: navigation, the Create form, the server-owned run state,
// the library and the history. The server is the source of truth for a run: nothing here simulates progress.
import { computed, reactive, watch } from "vue";
import { AUTO, COMPOSITION_FIELDS, INHERIT, resolveComposition } from "../../src/composition";
import {
  ApiError,
  getCodexModels,
  getCollection,
  getCollections,
  getEvolutionPreview,
  getComparisons,
  saveComparison,
  getRuns,
  getStatus,
  getVariantPrompt,
  startRegeneration,
  saveFeedback,
  saveImageFeedback,
  selectBest as apiSelectBest,
  startRun,
  type ApiStatus,
  type CodexModels,
  type Collection,
  type Comparison,
  type EvolutionPreview,
  type Feedback,
  type ImageFeedback,
  type RunRecord,
} from "./api";
import { describeError, type UiError } from "./errors";
import { pairKey } from "./arena";
import { needsSelection } from "./lib";
import { MAX_FRAMES, assignModels, autoMix, totalImages, type ModelMode } from "./models";
import { blank, buildStartRequest, compositionGuided, defaultForm } from "./request";

export type View = "create" | "library" | "activity";

export const ui = reactive({
  view: "create" as View,
  advancedOpen: false,
  /** Scene whose composition editor is expanded (0-based), or null. */
  openScene: null as number | null,
  /** Collection id open in Library detail, or null for the grid. */
  openCollection: null as string | null,
  toast: "",
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  ui.toast = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = ""), 3200);
}

export function go(view: View, collectionId: string | null = null, scroll = true) {
  ui.view = view;
  if (view === "library") {
    ui.openCollection = collectionId;
    if (collectionId) void ensureCollection(collectionId);
    void loadCollections();
  }
  if (view === "activity") void loadRuns();
  if (scroll && typeof window !== "undefined") window.scrollTo({ top: 0 });
}

// The current screen lives in the URL hash (#create, #library, #library/<id>, #activity): a reload or a shared link
// opens the same screen, and the browser's Back button works. Data always comes from the API, never from the hash.
const VIEWS: View[] = ["create", "library", "activity"];
export function parseHash(hash: string): { view: View; id: string | null } {
  const [v, id] = hash.replace(/^#\/?/, "").split("/");
  const view = VIEWS.includes(v as View) ? (v as View) : "create";
  return { view, id: view === "library" && id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null };
}
function applyHash() {
  const { view, id } = parseHash(location.hash);
  if (view === ui.view && id === ui.openCollection) return;
  go(view, id, false);
}
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", applyHash);
  watch(
    () => [ui.view, ui.openCollection],
    () => {
      const want = `#${ui.view}${ui.view === "library" && ui.openCollection ? `/${ui.openCollection}` : ""}`;
      if (location.hash !== want) location.hash = want;
    },
  );
}

// ---------- Server state ----------

export const app = reactive({
  status: null as ApiStatus | null,
  /** "lost" = the last status request failed; the last known run state stays on screen, it is NOT treated as finished. */
  connection: "connecting" as "connecting" | "ok" | "lost",
  collections: [] as Collection[],
  collectionsLoaded: false,
  collectionsError: null as UiError | null,
  /** A collection opened from the history that is older than the list limit. */
  extra: null as Collection | null,
  runs: [] as RunRecord[],
  runsLoaded: false,
  runsError: null as UiError | null,
  codex: null as CodexModels | null,
  starting: false,
  startError: null as UiError | null,
});

export const run = computed(() => app.status?.run);
export const running = computed(() => run.value?.status === "planning" || run.value?.status === "generating");
export const comfyOk = computed(() => app.status?.comfy.ok === true);
export const canStart = computed(() => !app.starting && !running.value && comfyOk.value && app.connection === "ok");
export const pendingSelection = computed(() => app.collections.filter(needsSelection).length);

/** Library shows what the API returned; the API caps the list, so the UI must not claim it is the whole history. */
/** Polling replaces the list objects; results of slow requests are written to the CURRENT object of that collection. */
const live = (c: Collection): Collection => app.collections.find((x) => x.id === c.id) ?? (app.extra?.id === c.id ? app.extra : c);

export const currentCollection = computed(() => app.collections.find((c) => c.id === ui.openCollection) ?? (app.extra?.id === ui.openCollection ? app.extra : undefined));

// -- status polling: one request at a time, stale answers dropped --

const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 5000;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let stopped = true;
let statusSeq = 0;

export async function refreshStatus(): Promise<void> {
  if (polling) return; // never two status requests at once
  polling = true;
  const seq = ++statusSeq;
  const before = app.status?.run;
  try {
    const s = await getStatus();
    if (seq !== statusSeq) return; // an older answer must not overwrite a newer state (e.g. the 202 of a start)
    app.status = s;
    app.connection = "ok";
    const was = before?.status === "planning" || before?.status === "generating";
    const now = s.run.status === "planning" || s.run.status === "generating";
    if (now) {
      void loadCollections();
      if (ui.view === "activity") void loadRuns(); // the run record is written just after the 202
    }
    if (was !== now || before?.runId !== s.run.runId) {
      void loadCollections();
      void loadRuns();
    }
  } catch {
    if (seq === statusSeq) app.connection = "lost"; // keep app.status: a poll failure never ends a run
  } finally {
    polling = false;
  }
}

function schedule() {
  clearTimeout(pollTimer);
  if (stopped) return;
  pollTimer = setTimeout(async () => {
    await refreshStatus();
    schedule();
  }, running.value || app.connection !== "ok" ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

export function startPolling() {
  stopped = false;
  if (typeof location !== "undefined" && location.hash) applyHash();
  void refreshStatus().then(schedule);
  void loadCollections();
  void loadRuns();
  void loadCodex();
}
export function stopPolling() {
  stopped = true;
  clearTimeout(pollTimer);
}

/**
 * One request at a time. A refresh asked for while one is running is repeated once afterwards, and the caller
 * waits for it, so the data is never older than the moment it was asked for.
 */
function coalesced(fn: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let again = false;
  return () => {
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        current = null;
      }
    })();
    return current;
  };
}

export const loadCollections = coalesced(async () => {
  try {
    app.collections = await getCollections();
    app.collectionsLoaded = true;
    app.collectionsError = null;
  } catch (e) {
    app.collectionsError = describeError(e);
  }
});

export const loadRuns = coalesced(async () => {
  try {
    app.runs = await getRuns();
    app.runsLoaded = true;
    app.runsError = null;
  } catch (e) {
    app.runsError = describeError(e);
  }
});

export async function ensureCollection(id: string): Promise<void> {
  if (app.collections.some((c) => c.id === id) || app.extra?.id === id) return;
  try {
    app.extra = await getCollection(id);
  } catch (e) {
    toast(describeError(e).message);
  }
}

// ---------- Codex catalog (real: GET /api/codex/models) ----------

const CODEX_KEY = "neurostudio.codex";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* no storage: the choice just is not remembered */
    }
  },
};

export const form = reactive(defaultForm());

function restoreCodexChoice() {
  try {
    const s = JSON.parse(store.get(CODEX_KEY) ?? "{}");
    form.codexModel = typeof s.model === "string" ? s.model : "";
    form.codexEffort = typeof s.effort === "string" ? s.effort : "";
  } catch {
    /* defaults */
  }
}
restoreCodexChoice();

// Prompt Evolution switch (NS-020): off until the user turns it on; the choice is remembered locally.
const EVOLUTION_KEY = "neurostudio.promptEvolution";
form.promptEvolution = store.get(EVOLUTION_KEY) === "1";
watch(
  () => form.promptEvolution,
  (on) => store.set(EVOLUTION_KEY, on ? "1" : "0"),
);

/** Read-only look at what would be sent to Codex (GET /api/prompt-evolution/preview; no Codex is started). */
export const evolution = reactive({ open: false, loading: false, data: null as EvolutionPreview | null, error: null as UiError | null });
let evolutionSeq = 0;
export async function loadEvolutionPreview(): Promise<void> {
  const seq = ++evolutionSeq;
  evolution.loading = true;
  evolution.error = null;
  try {
    const d = await getEvolutionPreview();
    if (seq === evolutionSeq) evolution.data = d;
  } catch (e) {
    if (seq === evolutionSeq) evolution.error = describeError(e);
  } finally {
    if (seq === evolutionSeq) evolution.loading = false;
  }
}
export function toggleEvolutionPreview() {
  evolution.open = !evolution.open;
  if (evolution.open) void loadEvolutionPreview();
}

export const codexModels = computed(() => app.codex?.models ?? []);
/** With a chosen model: its efforts. With the default model only efforts every listed model supports. */
export const codexEfforts = computed(() => {
  const m = codexModels.value.find((x) => x.id === form.codexModel);
  if (m) return m.efforts.map((e) => e.id);
  const [first, ...rest] = codexModels.value;
  return first ? first.efforts.map((e) => e.id).filter((id) => rest.every((x) => x.efforts.some((y) => y.id === id))) : [];
});

/** Anything the catalog no longer offers falls back to Default. */
function sanitizeCodexChoice() {
  if (form.codexModel && !codexModels.value.some((m) => m.id === form.codexModel)) form.codexModel = "";
  if (form.codexEffort && !codexEfforts.value.includes(form.codexEffort)) form.codexEffort = "";
}
watch(
  () => [form.codexModel, form.codexEffort],
  () => {
    if (!app.codex) return; // do not overwrite the stored choice before the catalog is known
    sanitizeCodexChoice();
    store.set(CODEX_KEY, JSON.stringify({ model: form.codexModel, effort: form.codexEffort }));
  },
);

export async function loadCodex(): Promise<void> {
  try {
    app.codex = await getCodexModels();
  } catch (e) {
    app.codex = { source: "none", error: (e as Error).message, models: [] };
  }
  sanitizeCodexChoice();
}

// ---------- Create form ----------

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
export const anyComposition = computed(() => compositionGuided({ frames: MAX_FRAMES, global: form.global, scenes: form.scenes }));

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
  if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => document.getElementById(`scene-comp-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// ---------- Start ----------

/**
 * Starts ONE real run. The request is a frozen snapshot of the form taken now; exactly one POST is sent and
 * never repeated automatically. Returns true when the server accepted it (202).
 */
export async function startGeneration(): Promise<boolean> {
  if (app.starting || running.value) return false; // double click / second tab state: no second request
  app.starting = true;
  app.startError = null;
  const req = buildStartRequest(form);
  try {
    const state = await startRun(req);
    statusSeq++; // any status request that was in flight before the 202 is now stale
    app.status = { comfy: app.status?.comfy ?? { ok: true }, run: state };
    app.connection = "ok";
    void loadRuns();
    return true;
  } catch (e) {
    app.startError = describeError(e);
    if (e instanceof ApiError && e.code === "ALREADY_RUNNING") void refreshStatus();
    return false;
  } finally {
    app.starting = false;
  }
}

// ---------- Targeted regeneration (NS-017): one new variant of one frame, same server lock as a normal run ----------

export const regen = reactive({
  /** The variant whose prompt is being edited; null = dialog closed. */
  target: null as { id: string; frame: number; variant: number } | null,
  loading: false,
  available: false,
  model: "",
  /** Prompt the variant was actually generated with / what the user is editing. */
  original: "",
  text: "",
  edited: false,
  submitting: false,
  error: null as UiError | null,
});

let regenSeq = 0; // identifies the latest open request (a reactive object is a proxy, so it cannot be compared by identity)
export async function openRegen(c: Collection, frame: number, variant: number): Promise<void> {
  const seq = ++regenSeq;
  Object.assign(regen, { target: { id: c.id, frame, variant }, loading: true, available: false, model: "", original: "", text: "", edited: false, submitting: false, error: null });
  try {
    const r = await getVariantPrompt(c.id, frame, variant);
    if (seq !== regenSeq || !regen.target) return; // closed or reopened for another variant meanwhile
    if (r.available) Object.assign(regen, { available: true, model: r.model, original: r.positive, text: r.positive, edited: r.promptEdited });
    else regen.error = describeError(new ApiError(r.reason, r.code, 409));
  } catch (e) {
    if (seq === regenSeq && regen.target) regen.error = describeError(e);
  } finally {
    if (seq === regenSeq) regen.loading = false;
  }
}
export function closeRegen() {
  regenSeq++;
  regen.target = null;
}
export const resetRegenText = () => {
  regen.text = regen.original;
};

/** Sends ONE request. Returns true when the server accepted it (202); the result then arrives through status polling. */
export async function submitRegen(): Promise<boolean> {
  const t = regen.target;
  if (!t || regen.submitting || running.value || !regen.available) return false;
  if (!regen.text.trim()) {
    regen.error = { message: "Промпт не может быть пустым." };
    return false;
  }
  regen.submitting = true;
  regen.error = null;
  try {
    const changed = regen.text.trim() !== regen.original.trim();
    const state = await startRegeneration(t.id, t.frame, { sourceVariant: t.variant, ...(changed ? { positive: regen.text } : {}) });
    statusSeq++; // a status request sent before the 202 is stale now
    app.status = { comfy: app.status?.comfy ?? { ok: true }, run: state };
    app.connection = "ok";
    void loadCollections(); // the new slot is already in collection.json
    if (regen.target?.id === t.id && regen.target.frame === t.frame && regen.target.variant === t.variant) regen.target = null;
    return true;
  } catch (e) {
    regen.error = describeError(e);
    if (e instanceof ApiError && e.code === "ALREADY_RUNNING") void refreshStatus();
    return false;
  } finally {
    regen.submitting = false;
  }
}

// ---------- Best selection (confirmed by the server before it is shown as saved) ----------

export const bestBusy = reactive<Record<string, boolean>>({});
export const bestError = reactive<Record<string, string>>({});

/** Selects `variant` as Best of `frame`, or clears it when it already is Best. The UI changes only after the server answers. */
export async function chooseBest(c: Collection, frame: number, variant: number): Promise<void> {
  if (bestBusy[c.id]) return;
  bestBusy[c.id] = true;
  delete bestError[c.id];
  try {
    const isBest = c.selections[String(frame)] === variant;
    const r = await apiSelectBest(c.id, frame, isBest ? null : variant);
    const cur = live(c);
    cur.selections = r.selections;
    if (r.export) cur.export = r.export;
  } catch (e) {
    bestError[c.id] = describeError(e).message + (describeError(e).details ? ` (${describeError(e).details})` : "");
  } finally {
    bestBusy[c.id] = false;
  }
}

// ---------- Feedback (serialised per collection: an old slow answer cannot overwrite a newer rating) ----------

export interface FeedbackDraft {
  rating: number | null;
  tags: string[];
  note: string;
  saving: boolean;
  error: string;
  dirty: boolean;
}
export const drafts = reactive<Record<string, FeedbackDraft>>({});

export function draftOf(c: Collection): FeedbackDraft {
  return (drafts[c.id] ??= { rating: c.feedback?.rating ?? null, tags: [...(c.feedback?.tags ?? [])], note: c.feedback?.note ?? "", saving: false, error: "", dirty: false });
}

/** Sends the latest draft; if it changed while a request was in flight, sends once more afterwards. One request at a time. */
export async function persistFeedback(c: Collection): Promise<void> {
  const d = draftOf(c);
  d.dirty = true;
  if (d.saving) return;
  d.saving = true;
  d.error = "";
  try {
    while (d.dirty) {
      d.dirty = false;
      const sent = { rating: d.rating, tags: [...d.tags], note: d.note };
      try {
        const r = await saveFeedback(c.id, sent);
        live(c).feedback = r.feedback as Feedback | null;
      } catch (e) {
        const u = describeError(e);
        d.error = u.message + (u.details ? ` (${u.details})` : "");
        d.dirty = false; // no automatic retry: the next user change sends the then-current draft again
        break;
      }
    }
  } finally {
    d.saving = false;
  }
}

export function rate(c: Collection, n: number) {
  const d = draftOf(c);
  d.rating = d.rating === n ? null : n; // clicking the current rating clears it
  void persistFeedback(c);
}
export function toggleTag(c: Collection, tag: string) {
  const d = draftOf(c);
  const i = d.tags.indexOf(tag);
  if (i >= 0) d.tags.splice(i, 1);
  else d.tags.push(tag);
  void persistFeedback(c);
}
export function saveNote(c: Collection) {
  const d = draftOf(c);
  if (d.note !== (c.feedback?.note ?? "")) void persistFeedback(c);
}

// ---------- Image feedback (NS-018): like / dislike + reasons for one image; independent of Best ----------

export const imageFbBusy = reactive<Record<string, boolean>>({});
export const imageFbError = reactive<Record<string, string>>({});
const fbQueue = new Map<string, Promise<void>>();

/** Requests of one collection run one at a time, in click order. `decide` runs when the request's turn comes, so quick consecutive
 * clicks build on the server's latest answer; returning null sends nothing. The UI shows the server's answer, never a guess. */
function queueImageFeedback(c: Collection, frame: number, variant: number, decide: (cur: ImageFeedback | undefined) => { verdict: "like" | "dislike" | null; tags: string[] } | null): Promise<void> {
  const next = (fbQueue.get(c.id) ?? Promise.resolve()).then(async () => {
    const body = decide(live(c).imageFeedback?.[`${frame}-${variant}`]);
    if (!body) return;
    imageFbBusy[c.id] = true;
    delete imageFbError[c.id];
    try {
      const r = await saveImageFeedback(c.id, frame, variant, body);
      const cur = live(c);
      cur.imageFeedback = { ...cur.imageFeedback };
      if (r.feedback) cur.imageFeedback[`${frame}-${variant}`] = r.feedback;
      else delete cur.imageFeedback[`${frame}-${variant}`];
    } catch (e) {
      const u = describeError(e);
      imageFbError[c.id] = u.message + (u.details ? ` (${u.details})` : "");
    } finally {
      imageFbBusy[c.id] = false;
    }
  });
  fbQueue.set(c.id, next);
  return next;
}

/** Click on "Нравится"/"Не нравится": the same verdict again removes the rating; switching verdict drops tags of the other kind. */
export const toggleVerdict = (c: Collection, frame: number, variant: number, verdict: "like" | "dislike"): Promise<void> =>
  queueImageFeedback(c, frame, variant, (cur) => ({ verdict: cur?.verdict === verdict ? null : verdict, tags: [] }));
export const toggleImageTag = (c: Collection, frame: number, variant: number, tag: string): Promise<void> =>
  queueImageFeedback(c, frame, variant, (cur) => (cur ? { verdict: cur.verdict, tags: cur.tags.includes(tag) ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag] } : null));

// ---------- Image Arena (NS-019): pairwise comparisons of variants of one frame; independent of Best and image feedback ----------

export const arena = reactive({
  /** Saved verdicts of the open collection, keyed "frame:a-b". */
  history: {} as Record<string, Comparison>,
  loadedFor: null as string | null,
  loading: false,
  error: null as UiError | null,
  saving: false,
});
/** Identifies the current Arena session: every open and every close starts a new one, so answers to older requests are ignored. */
let arenaSeq = 0;

export async function loadArena(id: string): Promise<void> {
  const seq = ++arenaSeq;
  Object.assign(arena, { history: {}, loadedFor: null, loading: true, error: null, saving: false });
  try {
    const r = await getComparisons(id);
    if (seq === arenaSeq) Object.assign(arena, { history: r.comparisons, loadedFor: id });
  } catch (e) {
    if (seq === arenaSeq) arena.error = describeError(e);
  } finally {
    if (seq === arenaSeq) arena.loading = false;
  }
}

/** The Arena was closed: whatever is still in flight belongs to a dead session and changes nothing any more. */
export function closeArena() {
  arenaSeq++;
  Object.assign(arena, { history: {}, loadedFor: null, loading: false, error: null, saving: false });
}

/**
 * Saves one verdict (replacing an earlier one of the same pair). `saving` is set synchronously, before anything is awaited, so a
 * second call while one is in flight is refused (false) and sends nothing. The history changes only after the server confirms, and
 * only if the session that sent the request is still the current one. Returns true when the verdict was saved in this session.
 */
export async function submitComparison(id: string, frame: number, a: number, b: number, winner: number | null): Promise<boolean> {
  if (arena.saving || arena.loadedFor !== id) return false;
  const seq = arenaSeq;
  arena.saving = true;
  arena.error = null;
  try {
    const r = await saveComparison(id, frame, { variantA: Math.min(a, b), variantB: Math.max(a, b), winnerVariant: winner });
    if (seq !== arenaSeq) return false;
    arena.history = { ...arena.history, [pairKey(frame, a, b)]: r.comparison };
    return true;
  } catch (e) {
    if (seq === arenaSeq) arena.error = describeError(e);
    return false;
  } finally {
    if (seq === arenaSeq) arena.saving = false; // a stale request must not release the lock of a newer session
  }
}
