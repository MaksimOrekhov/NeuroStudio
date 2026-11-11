// NS-015: production UI logic (store, request building, error messages, library helpers) against the real API
// over FAKE data: a fake ComfyUI and a fake Codex. No GPU, no Codex process, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COMPOSITION_FIELDS, parseComposition } from "../src/composition.ts";
import { CodexError } from "../src/codex.ts";
import { ERROR_CODES as SERVER_CODES } from "../src/errors.ts";
import { parseFrames } from "../src/promptPlan.ts";
import { resolveImageModels } from "../src/imageModels.ts";
import { PlanError } from "../src/promptPlan.ts";
import { createFakeApp, createFixture, type FakeBehaviour } from "./fixtures/uiFixture.ts";

const root = resolve(import.meta.dirname, "..");
const PORT = 8799;
const HOST = `127.0.0.1:${PORT}`;

// ---- the browser's environment: localStorage and a fetch that talks to the in-process API ----
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

let route: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const calls: { method: string; url: string; body?: any }[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (!route) throw new TypeError("fetch failed");
  return route(url, init);
};

async function useApp(behaviour: FakeBehaviour = {}) {
  const fx = await createFixture();
  const fake = await createFakeApp({ fx, port: PORT, behaviour });
  route = async (url, init) => {
    const r = await fake.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: HOST, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
  };
  calls.length = 0;
  return { fx, ...fake };
}
const until = async (cond: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const S = await import("../web/src/store.ts");
const { buildStartRequest, defaultForm, compositionGuided } = await import("../web/src/request.ts");
const lib = await import("../web/src/lib.ts");
const errors = await import("../web/src/errors.ts");
const { ApiError } = await import("../web/src/api.ts");
const { ERROR_CODES: WEB_CODES } = await import("../web/src/errorCodes.ts");

const reset = () => {
  Object.assign(S.form, defaultForm());
  S.app.starting = false;
  S.app.startError = null;
  S.app.status = null;
  S.app.connection = "connecting";
};

// ---------- request building ----------

test("request: 1-4 frames, Auto Mix / Only / Custom, everything accepted by the real server validators", () => {
  for (const frames of [1, 2, 3, 4]) {
    for (const mode of ["auto", "only:duskrose", "only:crimson-oath", "custom"] as const) {
      const f = { ...defaultForm(), frames, modelMode: mode, custom: ["duskrose", "crimson-oath", "duskrose", "crimson-oath"], collections: 2, variations: 4, theme: "  дождь  " };
      const req = buildStartRequest(f);
      assert.equal(req.frames, frames);
      assert.equal(req.theme, "дождь");
      assert.deepEqual([req.collections, req.variations], [2, 4]);
      if (mode === "auto") assert.deepEqual(req.imageModels, { mode: "auto" });
      else if (mode === "custom") assert.deepEqual(req.imageModels, { mode: "custom", perScene: ["duskrose", "crimson-oath", "duskrose", "crimson-oath"].slice(0, frames) });
      else assert.deepEqual(req.imageModels, { mode: "only", model: mode.slice(5) });
      assert.equal(parseFrames(req.frames), frames);
      const a = resolveImageModels(req.imageModels, frames);
      assert.equal(a.models.length, frames); // Custom sends exactly as many models as active frames
    }
  }
});

test("request: composition of hidden frames is never sent but is kept locally and comes back with more frames", () => {
  const f = defaultForm();
  f.frames = 2;
  Object.assign(f.scenes[0], { pose: "kneeling" });
  Object.assign(f.scenes[2], { framing: "full_body" }); // hidden
  Object.assign(f.scenes[3], { viewpoint: "low_angle" }); // hidden
  const two = buildStartRequest(f);
  assert.equal(two.composition?.scenes?.length, 2);
  assert.doesNotThrow(() => parseComposition(two.composition, 2)); // the server accepts it for 2 frames
  assert.equal(f.scenes[2].framing, "full_body"); // still there
  f.frames = 4;
  const four = buildStartRequest(f);
  assert.equal(four.composition?.scenes?.length, 4);
  assert.equal(four.composition?.scenes?.[2].framing, "full_body");
  // the same hidden values with 4 frames would be rejected by the server for 2 frames: that is what the trimming prevents
  assert.throws(() => parseComposition({ scenes: four.composition!.scenes }, 2));
});

test("request: Auto and Inherit Global keep their meaning; no composition field when nothing is configured; hidden-only settings do not count", () => {
  const f = defaultForm();
  assert.equal("composition" in buildStartRequest(f), false);
  f.frames = 2;
  Object.assign(f.scenes[3], { pose: "kneeling" }); // hidden only
  assert.equal(compositionGuided(f), false);
  assert.equal(buildStartRequest(f).composition, undefined);
  Object.assign(f.global, { framing: "waist_up" });
  Object.assign(f.scenes[1], { framing: "auto" }); // explicit Auto for scene 2 stays "auto"; the others stay "inherit"
  const c = buildStartRequest(f).composition!;
  assert.equal(c.global?.framing, "waist_up");
  assert.equal(c.scenes?.[0].framing, "inherit");
  assert.equal(c.scenes?.[1].framing, "auto");
  assert.deepEqual(Object.keys(c.scenes![0]).sort(), [...COMPOSITION_FIELDS].sort());
  assert.doesNotThrow(() => parseComposition(c, 2));
});

test("request: Codex model and reasoning are passed only when chosen; the snapshot is frozen and independent of the form", () => {
  const f = defaultForm();
  assert.equal("codexModel" in buildStartRequest(f), false);
  assert.equal("codexReasoningEffort" in buildStartRequest(f), false);
  f.codexModel = "gpt-test";
  f.codexEffort = "high";
  const req = buildStartRequest(f);
  assert.deepEqual([req.codexModel, req.codexReasoningEffort], ["gpt-test", "high"]);
  f.theme = "changed later";
  f.frames = 1;
  assert.equal(req.theme, "");
  assert.equal(req.frames, 4);
  assert.ok(Object.isFrozen(req) && Object.isFrozen(req.imageModels));
});

// ---------- run lifecycle against the real API ----------

test("Generate: one POST, 202 shown at once, no automatic second request, the form stays editable", async () => {
  const { runner, seen } = await useApp({ imageMs: 30 });
  reset();
  S.form.frames = 2;
  S.form.variations = 2;
  S.form.theme = "тест";
  const ok = await S.startGeneration();
  assert.equal(ok, true);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url === "/api/autopilot/start").length, 1);
  assert.equal(S.app.status?.run.status === "planning" || S.app.status?.run.status === "generating", true);
  assert.equal(S.app.status?.run.total, 4);
  S.form.theme = "уже для следующего запуска"; // editable during the run, does not touch it
  await until(() => !runner.active);
  assert.equal(seen.plan.length, 1);
  assert.equal(calls.filter((c) => c.url === "/api/autopilot/start").length, 1);
  assert.deepEqual((seen.plan[0] as any).models, ["crimson-oath", "duskrose"]);
});

test("Generate: a second click while the first is in flight or while a run is active sends nothing", async () => {
  const { runner } = await useApp({ imageMs: 40 });
  reset();
  const [a, b] = await Promise.all([S.startGeneration(), S.startGeneration()]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(calls.filter((c) => c.url === "/api/autopilot/start").length, 1);
  assert.equal(await S.startGeneration(), false); // active run known from the 202
  assert.equal(calls.filter((c) => c.url === "/api/autopilot/start").length, 1);
  assert.equal(S.canStart.value, false);
  await until(() => !runner.active);
});

test("an API refusal (400 / 409) is shown in Russian with the technical text kept, and is not retried", async () => {
  await useApp({ imageMs: 40 });
  reset();
  S.form.custom = ["duskrose", "nope", "duskrose", "duskrose"]; // not a catalog model: the form falls back, so force a bad request instead
  S.form.codexModel = "model-that-does-not-exist";
  const ok = await S.startGeneration();
  assert.equal(ok, false);
  assert.equal(S.app.startError?.code, "INVALID_GENERATION_SETTINGS");
  assert.match(S.app.startError!.message, /Настройки генерации не приняты/);
  assert.match(S.app.startError!.details ?? "", /model-that-does-not-exist|codex/i);
  assert.equal(calls.filter((c) => c.url === "/api/autopilot/start").length, 1);
  S.form.codexModel = "";
});

test("status: after a page reload the real run is shown from the API; a polling failure never ends a run", async () => {
  const { runner } = await useApp({ imageMs: 80 });
  reset();
  S.form.frames = 3;
  assert.equal(await S.startGeneration(), true);
  // "reload": all client state is lost
  (S.app as { status: unknown }).status = null;
  S.app.connection = "connecting";
  await S.refreshStatus();
  assert.equal(S.running.value, true);
  assert.equal(S.app.status?.run.frames, 3);
  assert.equal(S.app.connection, "ok");
  // the server stops answering for a moment: the last known state stays, nothing is marked finished or failed
  const saved = route;
  route = null;
  await S.refreshStatus();
  assert.equal(S.app.connection, "lost");
  assert.equal(S.running.value, true);
  assert.notEqual(S.app.status?.run.status, "failed");
  route = saved;
  await S.refreshStatus();
  assert.equal(S.app.connection, "ok");
  await until(() => !runner.active);
  await S.refreshStatus();
  assert.equal(S.app.status?.run.status, "completed");
  assert.equal(S.app.status?.run.done, 3);
});

test("status: a restarted server is idle and the unfinished collection is shown as interrupted, not as running", async () => {
  await useApp();
  reset();
  await S.refreshStatus();
  assert.equal(S.app.status?.run.status, "idle");
  assert.equal(S.running.value, false);
  await S.loadCollections();
  const balcony = S.app.collections.find((c) => c.id === "2026-11-07-balcony")!;
  assert.equal(balcony.status, "interrupted");
  assert.equal(lib.badgeOf(balcony).cls, "warn");
  const runs = await (await fetch("/api/runs")).json();
  assert.equal(runs.find((r: any) => r.id === "2026-11-07-ddd").status, "interrupted");
});

test("polling: only one status request at a time", async () => {
  await useApp();
  reset();
  let inflight = 0;
  let max = 0;
  const inner = route!;
  route = async (u, i) => {
    inflight++;
    max = Math.max(max, inflight);
    await new Promise((r) => setTimeout(r, 20));
    inflight--;
    return inner(u, i);
  };
  await Promise.all([S.refreshStatus(), S.refreshStatus(), S.refreshStatus()]);
  assert.equal(max, 1);
});

test("library keeps working during a run: the running collection appears, old ones stay readable", async () => {
  const { runner } = await useApp({ imageMs: 60 });
  reset();
  S.form.frames = 2;
  await S.startGeneration();
  let sawRunning = false;
  for (let i = 0; i < 150 && runner.active && !sawRunning; i++) {
    await S.loadCollections();
    sawRunning = S.app.collections.some((c) => c.status === "running");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(sawRunning, "the collection being generated is visible in the library during the run");
  assert.ok(S.app.collections.length >= 9);
  assert.ok(S.app.collections.find((c) => c.id === "2026-11-10-ovation")); // old data unaffected
  await until(() => !runner.active);
  await S.loadCollections();
  assert.equal(S.app.collections.filter((c) => c.status === "running").length, 0);
});

test("planning failure: the run is in the history with its code, the UI shows Russian text and keeps the technical details", async () => {
  const { runner, seen } = await useApp({ planError: new CodexError("Codex exited with code 1: boom") });
  reset();
  await S.startGeneration();
  await until(() => !runner.active);
  await S.refreshStatus();
  await S.loadRuns();
  assert.equal(S.app.status?.run.status, "failed");
  assert.equal(S.app.status?.run.errorCode, "CODEX_FAILED");
  const rec = S.app.runs.find((r) => r.id === S.app.status?.run.runId)!;
  assert.equal(rec.status, "failed");
  assert.deepEqual(rec.collectionIds, []);
  const u = errors.describeRunError(rec.error, rec.errorCode)!;
  assert.match(u.message, /Codex не смог составить план/);
  assert.equal(u.details, "Codex exited with code 1: boom");
  assert.equal(seen.plan.length, 1); // never repeated
  // and a plan that did not validate
  const second = await useApp({ planError: new PlanError("Invalid prompt plan: frame 2 model must be duskrose") });
  reset();
  await S.startGeneration();
  await until(() => !second.runner.active);
  await S.refreshStatus();
  assert.equal(S.app.status?.run.errorCode, "PLAN_INVALID");
  assert.match(errors.describeRunError(S.app.status?.run.error, S.app.status?.run.errorCode)!.message, /не прошёл проверку/);
});

// ---------- library, Best, Feedback, export ----------

test("library: 1, 2, 3 and 4 frame collections and an old collection without new fields are all readable", async () => {
  await useApp();
  reset();
  await S.loadCollections();
  const by = (id: string) => S.app.collections.find((c) => c.id === id)!;
  assert.deepEqual(["2026-11-10-ovation", "2026-11-09-library", "2026-11-09-greenhouse", "2026-11-10-ferry"].map((id) => lib.scenesOf(by(id)).length), [1, 2, 3, 4]);
  const old = by("2026-10-01-saltglass");
  assert.equal(old.frameCount, 4);
  assert.equal(lib.scenesOf(old).length, 4);
  assert.equal(lib.titleOf(old), "Saltglass Conservatory"); // original title as fallback
  assert.equal(lib.titleOf(by("2026-11-10-ferry")), "Утренний паром");
  assert.equal(old.generation, undefined);
  assert.equal(old.export.ready, false); // nothing selected: the server says not ready, no auto-selection
  assert.equal(lib.exportInfo(old).message, "Выберите хотя бы одно изображение.");
  // single-variant frames also need an explicit Best
  assert.equal(lib.exportInfo(by("2026-11-10-ovation")).ready, false);
  // ferry has Best on 2 of 4 frames: exactly those 2 are exported
  const ferry = lib.exportInfo(by("2026-11-10-ferry"));
  assert.equal(ferry.ready, true);
  assert.equal(ferry.resolved, 2);
  assert.equal(lib.needsSelection(by("2026-11-10-ferry")), false);
  assert.equal(lib.needsSelection(by("2026-11-10-ovation")), true);
  assert.equal(lib.hasIssues(by("2026-11-08-lemon")), true);
  assert.match(lib.exportInfo(by("2026-11-08-lemon")).message, /Выберите хотя бы одно изображение/); // has finished images, none selected
});

test("Best: shown as saved only after the server confirms; a failed save changes nothing", async () => {
  const a = await useApp();
  reset();
  await S.loadCollections();
  const c = () => S.app.collections.find((x) => x.id === "2026-11-10-ferry")!;
  assert.equal(c().selections["2"], undefined);
  await S.chooseBest(c(), 2, 1);
  assert.equal(c().selections["2"], 1);
  assert.equal(c().export.resolved, 3);
  await S.chooseBest(c(), 2, 1); // the same variant again clears it
  assert.equal(c().selections["2"], undefined);
  assert.equal(c().export.resolved, 2);
  // the server refuses: the UI keeps the confirmed state and tells why
  const before = JSON.stringify(c().selections);
  const saved = route!;
  route = async () => ({ ok: false, status: 404, json: async () => ({ error: "collection not found", code: "COLLECTION_NOT_FOUND" }) }) as Response;
  await S.chooseBest(c(), 4, 1);
  assert.equal(JSON.stringify(c().selections), before);
  assert.match(S.bestError["2026-11-10-ferry"], /Коллекция не найдена/);
  route = saved;
  await S.chooseBest(c(), 2, 1);
  await S.chooseBest(c(), 4, 2);
  assert.equal(c().selections["4"], 2);
  assert.equal(c().export.ready, true);
  assert.equal(c().export.resolved, 4); // all four frames selected: ZIP available
  const zip = await a.app.inject({ method: "GET", url: "/api/collections/2026-11-10-ferry/export", headers: { host: HOST } });
  assert.equal(zip.statusCode, 200);
  assert.equal(zip.headers["content-type"], "application/zip");
});
test("export: the server refuses an incomplete ZIP with EXPORT_INCOMPLETE, which the UI words in Russian", async () => {
  const a = await useApp();
  const r = await a.app.inject({ method: "GET", url: "/api/collections/2026-11-10-ovation/export", headers: { host: HOST } }); // no Best selected
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "EXPORT_INCOMPLETE");
  assert.match(errors.describeError(new ApiError(r.json().error, r.json().code, 409)).message, /ZIP пока недоступен/);
});

test("Feedback: rapid changes are sent one at a time and the newest rating wins even if an older answer is slow", async () => {
  const a = await useApp();
  reset();
  await S.loadCollections();
  const c = S.app.collections.find((x) => x.id === "2026-11-10-ferry")!;
  let inflight = 0;
  let max = 0;
  const sent: any[] = [];
  const inner = route!;
  route = async (u, i) => {
    if (!u.includes("/feedback")) return inner(u, i);
    inflight++;
    max = Math.max(max, inflight);
    sent.push(JSON.parse(String(i!.body)));
    await new Promise((r) => setTimeout(r, sent.length === 1 ? 60 : 5)); // the first answer is the slow one
    inflight--;
    return inner(u, i);
  };
  S.rate(c, 2);
  S.rate(c, 5);
  S.toggleTag(c, "great_outfit");
  await until(() => !S.draftOf(c).saving);
  assert.equal(max, 1);
  const last = sent[sent.length - 1];
  assert.deepEqual([last.rating, last.tags], [5, ["great_outfit"]]);
  const stored = JSON.parse(await readFile(join(a.fx.collectionsDir, "2026-11-10-ferry", "feedback.json"), "utf8"));
  assert.deepEqual([stored.rating, stored.tags], [5, ["great_outfit"]]); // format unchanged: rating, tags, note
  assert.equal(S.app.collections.find((x) => x.id === "2026-11-10-ferry")!.feedback?.rating, 5);
  // clearing the rating and a note over 500 characters
  S.rate(c, 5);
  await until(() => !S.draftOf(c).saving);
  assert.equal(S.draftOf(c).rating, null);
  assert.equal(S.app.collections.find((x) => x.id === "2026-11-10-ferry")!.feedback?.rating, null);
  S.draftOf(c).note = "x".repeat(501);
  S.saveNote(c);
  await until(() => !S.draftOf(c).saving);
  assert.ok(S.draftOf(c).error); // the server's limit is reported, not hidden
  assert.match(S.draftOf(c).error, /Сервер не принял запрос/);
});

// ---------- errors ----------

test("every API error code has a Russian message; unknown codes and network errors have fallbacks; technical text stays available", () => {
  assert.deepEqual([...WEB_CODES], [...SERVER_CODES]); // the browser list mirrors src/errors.ts
  for (const code of SERVER_CODES) {
    const m = errors.messageForCode(code);
    assert.match(m, /[а-яё]/i, code);
    assert.doesNotMatch(m, /\{|stack|Error:/);
  }
  assert.equal(errors.messageForCode("SOMETHING_NEW"), errors.FALLBACK_RU);
  assert.equal(errors.messageForCode(undefined), errors.FALLBACK_RU);
  const gen = errors.describeError(new ApiError("Generation failed: CUDA out of memory (KSampler)", "GENERATION_FAILED", 500));
  assert.equal(gen.details, "Generation failed: CUDA out of memory (KSampler)"); // ComfyUI's own wording is not hidden
  assert.match(gen.message, /Ошибка при создании изображений/);
  assert.equal(errors.describeError(new ApiError("fetch failed")).message, errors.NETWORK_RU);
  assert.equal(errors.describeError(new ApiError("HTTP 500", undefined, 500)).message, errors.FALLBACK_RU);
  assert.equal(errors.describeRunError(undefined, undefined), null);
});

// ---------- Codex catalog + localStorage ----------

test("Codex catalog comes from the API; the stored choice survives, and anything no longer offered falls back to Default", async () => {
  await useApp();
  reset();
  mem.set("neurostudio.codex", JSON.stringify({ model: "gpt-test", effort: "xhigh" }));
  await S.loadCodex();
  assert.deepEqual(S.codexModels.value.map((m) => m.id), ["gpt-test", "gpt-mini"]);
  S.form.codexModel = "gpt-test";
  S.form.codexEffort = "xhigh";
  assert.deepEqual(S.codexEfforts.value, ["low", "medium", "high", "xhigh"]);
  S.form.codexModel = "gpt-mini"; // does not support xhigh
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(S.form.codexEffort, "");
  assert.deepEqual(JSON.parse(mem.get("neurostudio.codex")!), { model: "gpt-mini", effort: "" });
  // catalog unavailable: Default only, with the technical reason kept
  route = null;
  await S.loadCodex();
  assert.equal(S.app.codex?.source, "none");
  assert.deepEqual(S.codexModels.value, []);
  assert.ok(S.app.codex?.error);
});

// ---------- hash navigation ----------

test("navigation: the screen lives in the URL hash and only known screens and safe ids are accepted", () => {
  assert.deepEqual(S.parseHash("#library/2026-11-10-ferry"), { view: "library", id: "2026-11-10-ferry" });
  assert.deepEqual(S.parseHash("#activity"), { view: "activity", id: null });
  assert.deepEqual(S.parseHash(""), { view: "create", id: null });
  assert.deepEqual(S.parseHash("#library/../../etc"), { view: "library", id: null });
  assert.deepEqual(S.parseHash("#nonsense"), { view: "create", id: null });
});

// ---------- production contains no prototype or demo material ----------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "prototype" || e.name === "dist" || e.name === "node_modules") continue;
      out.push(...(await walk(p)));
    } else out.push(p);
  }
  return out;
}

test("production UI has no mock data, demo menu, prototype label or imports from the prototype", async () => {
  const files = (await walk(join(root, "web/src"))).filter((f) => /\.(vue|ts)$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = await readFile(f, "utf8");
    assert.doesNotMatch(src, /prototype\//i, `${f} imports the prototype`);
    assert.doesNotMatch(src, /MOCK_|mockCollections|mockRuns|makeCollection|startDemoRun|failDemoRun|resetDemo/, `${f} uses mock data`);
    assert.doesNotMatch(src, /Демо|Прототип|демо-|\bdemo\b/i, `${f} contains demo wording`);
  }
  // and the production page itself
  const html = await readFile(join(root, "web/index.html"), "utf8");
  assert.doesNotMatch(html, /prototype/i);
});

test("ComfyUI down: the real state is shown, Generate is blocked, and a forced start is refused with COMFY_UNREACHABLE in Russian", async () => {
  const { seen } = await useApp({ comfyDown: true });
  reset();
  await S.refreshStatus();
  assert.equal(S.comfyOk.value, false);
  assert.equal(S.canStart.value, false);
  assert.match(S.app.status?.comfy.error ?? "", /ECONNREFUSED/);
  assert.equal(await S.startGeneration(), false);
  assert.equal(S.app.startError?.code, "COMFY_UNREACHABLE");
  assert.match(S.app.startError!.message, /ComfyUI недоступен/);
  assert.match(S.app.startError!.details ?? "", /ECONNREFUSED/); // the real reason stays visible
  assert.equal(seen.plan.length, 0); // Codex was never asked
});
