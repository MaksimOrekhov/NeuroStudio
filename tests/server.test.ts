import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../server/app.ts";
import { safeImagePath } from "../server/collections.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { loadWorkflow } from "../src/comfy.ts";
import { generateBatch, loadInstructions, planPrompt, type BatchOptions, type BatchResult } from "../src/codex.ts";
import { strictPlan } from "./fixtures/strictPlan.ts";
import { PlanError, parseCount, validateBatch } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const PORT = 8787;
const H = { host: `127.0.0.1:${PORT}` };

async function setup(over: { systemStats?: () => Promise<unknown>; plan?: (o: BatchOptions) => Promise<BatchResult>; waitForImages?: () => Promise<unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns-srv-"));
  const planJson = strictPlan("Server Test");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls = { plan: 0, avoid: [] as string[][], submit: 0 };
  const client = {
    systemStats: over.systemStats ?? (async () => ({})),
    checkDependencies: async () => [] as string[],
    submit: async () => `pid-${++calls.submit}`,
    waitForImages:
      over.waitForImages ??
      (async () => {
        await gate;
        return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
      }),
    download: async () => Buffer.from("png"),
  };
  const runner = new AutopilotRunner({
    client: client as never,
    plan:
      over.plan ??
      (async (o) => {
        calls.plan++;
        calls.avoid.push(o.avoid ?? []);
        const plans = Array.from({ length: o.count }, (_, i) => ({ ...planJson, concept: { ...planJson.concept, title: `${planJson.concept.title} ${i + 1}` } }));
        return { plans, raw: "", ms: 5, tokens: null };
      }),
    baseGraph: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
    collectionsDir: dir,
    batchesDir: await mkdtemp(join(tmpdir(), "ns-batch-")),
  });
  const app = buildApp({
    runner,
    collectionsDir: dir,
    comfyUrl: "http://x",
    port: PORT,
    statusClient: { systemStats: async () => ({ system: { comfyui_version: "9.9" } }) as never, queue: async () => ({ queue_running: [], queue_pending: [] }) },
  });
  return { dir, app, runner, release, calls, planJson };
}

const post = (app: ReturnType<typeof buildApp>, theme = "", collections?: unknown, variations?: unknown) =>
  app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { theme, collections, variations } });

test("second start while running is rejected (409) and does not create a second batch", async () => {
  const { app, runner, release, calls } = await setup();
  const [a, b] = await Promise.all([post(app), post(app)]); // concurrent
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
  assert.equal((await post(app)).statusCode, 409);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.plan, 1);
  assert.equal(runner.state.status, "completed");
  const st = (await app.inject({ method: "GET", url: "/api/status", headers: H })).json();
  assert.equal(st.run.done, 4);
  assert.equal(st.comfy.ok, true);
});

test("ComfyUI down: 503 with clear message, Codex is never called", async () => {
  const { app, calls } = await setup({ systemStats: async () => Promise.reject(new Error("ECONNREFUSED")) });
  const r = await post(app);
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /ComfyUI is not reachable/);
  assert.equal(calls.plan, 0);
});

test("Codex failure is reported as failed state, nothing is retried, lock is released", async () => {
  let n = 0;
  const { app, runner } = await setup({ plan: async () => (n++, Promise.reject(new Error("Codex timed out"))) });
  assert.equal((await post(app)).statusCode, 202);
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  const st = (await app.inject({ method: "GET", url: "/api/status", headers: H })).json();
  assert.equal(st.run.status, "failed");
  assert.match(st.run.error, /timed out/);
  assert.equal(n, 1);
  assert.equal((await post(app)).statusCode, 202); // user may start again explicitly
});

test("images: only scene-NN.png inside the collection dir; traversal and foreign hosts blocked", async () => {
  const { app, dir } = await setup();
  await mkdir(join(dir, "c1"));
  await writeFile(join(dir, "c1", "scene-01.png"), Buffer.from("png"));
  await writeFile(join(dir, "c1", "collection.json"), JSON.stringify({ title: "T", createdAt: "2026-01-01T00:00:00Z", status: "running", dir, frames: [{ frame: 1, model: "duskrose", seed: 1, status: "done", png: "scene-01.png" }] }));
  await writeFile(join(dir, "secret.png"), "x");
  const get = (url: string, headers = H) => app.inject({ method: "GET", url, headers });
  assert.equal((await get("/api/collections/c1/images/scene-01.png")).statusCode, 200);
  assert.equal((await get("/api/collections/c1/images/collection.json")).statusCode, 404);
  assert.equal((await get("/api/collections/c1/images/..%2Fsecret.png")).statusCode, 404);
  assert.equal((await get("/api/collections/..%2F..%2Fx/images/scene-01.png")).statusCode, 404);
  assert.equal(safeImagePath(dir, "..", "scene-01.png"), null);
  assert.equal((await get("/api/collections/c1/images/scene-01.png", { host: "evil.example:8787" })).statusCode, 403);
  const post403 = await app.inject({ method: "POST", url: "/api/autopilot/start", headers: { ...H, origin: "http://evil.example" }, payload: {} });
  assert.equal(post403.statusCode, 403);
  // a "running" manifest nobody is executing is shown as interrupted, never as completed
  const c = (await get("/api/collections/c1")).json();
  assert.equal(c.status, "interrupted");
});

test("concept history is passed to Codex and appears in the prompt", async () => {
  const { app, runner, release, calls, dir } = await setup();
  await mkdir(join(dir, "old"));
  await writeFile(join(dir, "old", "collection.json"), JSON.stringify({ title: "Saltglass Conservatory", createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames: [] }));
  await post(app);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.avoid[0], ["Saltglass Conservatory"]);
  assert.match(planPrompt("INSTRUCTIONS", undefined, ["Saltglass Conservatory"]), /do NOT repeat[^\n]*"Saltglass Conservatory"/);
});

test("collection count is validated (1-3 integer)", async () => {
  assert.equal(parseCount(undefined), 1);
  assert.equal(parseCount(3), 3);
  for (const bad of [0, 4, 2.5, "3", -1]) assert.throws(() => parseCount(bad), PlanError);
  const { app, calls } = await setup();
  for (const bad of [0, 4, "3"]) assert.equal((await post(app, "", bad)).statusCode, 400);
  assert.equal(calls.plan, 0);
});

test("batch of 3: ONE Codex call, 12 jobs, 3 collection dirs, progress counted in images", async () => {
  const { app, runner, release, calls, dir } = await setup();
  assert.equal((await post(app, "", 3)).statusCode, 202);
  assert.equal(runner.state.total, 12);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.plan, 1);
  assert.equal(calls.submit, 12);
  assert.equal(runner.state.status, "completed");
  assert.equal(runner.state.done, 12);
  assert.equal(runner.state.finished.length, 3);
  const list = (await app.inject({ method: "GET", url: "/api/collections", headers: H })).json();
  assert.equal(list.length, 3);
  assert.ok(list.every((c: { status: string }) => c.status === "done"));
  assert.ok(dir);
});

test("batch stops on first error: no retry, no next collection, finished results and prompt_ids kept", async () => {
  let waits = 0;
  const { app, runner, calls } = await setup({
    waitForImages: async () => {
      if (++waits === 6) throw new Error("Generation failed: boom"); // 2nd frame of collection 2
      return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
    },
  });
  await post(app, "", 3);
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.plan, 1);
  assert.equal(calls.submit, 6); // never resubmitted, collection 3 never started
  assert.equal(runner.state.status, "failed");
  assert.match(runner.state.error ?? "", /boom/);
  assert.equal(runner.state.finished.length, 1);
  const list = (await app.inject({ method: "GET", url: "/api/collections", headers: H })).json();
  assert.equal(list.length, 2);
  const failed = list.find((c: { status: string }) => c.status === "failed");
  assert.equal(failed.doneFrames, 1);
  assert.ok(failed.frames.some((f: { promptId?: string }) => f.promptId === "pid-6"));
});

test("validateBatch and generateBatch: exact count, distinct titles, single Codex process", async () => {
  const sample = strictPlan("Sample");
  const other = { ...sample, concept: { ...sample.concept, title: "Another" } };
  assert.equal(validateBatch({ collections: [sample, other] }, 2).length, 2);
  assert.throws(() => validateBatch({ collections: [sample] }, 2), PlanError);
  assert.throws(() => validateBatch({ collections: [sample, sample] }, 2), /distinct/);
  const counter = join(await mkdtemp(join(tmpdir(), "ns-fake-")), "calls.txt");
  const script = `
    const fs = require("fs");
    fs.appendFileSync(process.env.NS_COUNTER, "x");
    const s = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--output-schema") + 1], "utf8"));
    if (s.properties.collections.minItems !== 2 || s.properties.collections.maxItems !== 2) process.exit(3);
    if ("negative" in s.properties.collections.items.properties.frames.items.properties) process.exit(4); // Codex is not asked for negatives
    const p = JSON.parse(fs.readFileSync(process.env.NS_SAMPLE, "utf8"));
    const q = { ...p, concept: { ...p.concept, title: "Second" } };
    fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ collections: [p, q] }));
    process.stdin.resume(); process.stdin.on("data", () => {});
  `;
  process.env.NS_COUNTER = counter;
  const planFile = join(await mkdtemp(join(tmpdir(), "ns-plan-")), "plan.json");
  await writeFile(planFile, JSON.stringify(strictPlan("Sample")));
  process.env.NS_SAMPLE = planFile;
  const r = await generateBatch({ count: 2, launcher: { command: process.execPath, args: ["-e", script, "--"] }, timeoutMs: 10_000 });
  assert.equal(r.plans.length, 2);
  assert.equal((await readFile(counter, "utf8")).length, 1); // exactly one Codex process
  assert.match(planPrompt(await loadInstructions(), undefined, [], 2), /exactly 2 Prompt Plans/);
});

test("variations: validated 1/2/4, 3x4x2 = 24 jobs with ONE Codex call, progress in images", async () => {
  const { app, runner, release, calls } = await setup();
  for (const bad of [0, 3, 5, "2"]) assert.equal((await post(app, "", 1, bad)).statusCode, 400);
  assert.equal(calls.plan, 0);
  assert.equal((await post(app, "", 3, 2)).statusCode, 202);
  assert.equal(runner.state.total, 24);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.plan, 1);
  assert.equal(calls.submit, 24);
  assert.equal(runner.state.done, 24);
  const list = (await app.inject({ method: "GET", url: "/api/collections", headers: H })).json();
  assert.equal(list.length, 3);
  assert.ok(list.every((c: { variations: number; frames: unknown[] }) => c.variations === 2 && c.frames.length === 8));
});

test("best-image selection is validated, persisted on disk and survives a new app instance", async () => {
  const { app, runner, release, dir } = await setup();
  await post(app, "", 1, 2);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  const id = (await app.inject({ method: "GET", url: "/api/collections", headers: H })).json()[0].id;
  const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/collections/${id}/selection`, headers: H, payload });
  assert.equal((await put({ frame: 2, variant: 2 })).statusCode, 200);
  assert.equal((await put({ frame: 2, variant: 9 })).statusCode, 400); // no such image
  assert.equal((await put({ frame: 7, variant: 1 })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/collections/nope/selection", headers: H, payload: { frame: 1, variant: 1 } })).statusCode, 404);
  assert.equal((await put({ frame: 1, variant: 1 })).statusCode, 200);
  assert.equal((await put({ frame: 2, variant: 1 })).statusCode, 200); // exactly one per frame: replaces v2
  const saved = JSON.parse(await readFile(join(dir, id, "selections.json"), "utf8"));
  assert.deepEqual(saved, { "1": 1, "2": 1 });
  const c = (await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: H })).json();
  assert.deepEqual(c.selections, { "1": 1, "2": 1 });
  assert.equal((await put({ frame: 1, variant: null })).statusCode, 200);
  assert.deepEqual(JSON.parse(await readFile(join(dir, id, "selections.json"), "utf8")), { "2": 1 });
});

test("historic collection (no variant field, scene-01.png) opens as variant 1 and can be selected", async () => {
  const { app, dir } = await setup();
  await mkdir(join(dir, "old"));
  await writeFile(join(dir, "old", "scene-01.png"), Buffer.from("png"));
  await writeFile(join(dir, "old", "collection.json"), JSON.stringify({ title: "Old", createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames: [{ frame: 1, model: "duskrose", seed: 1, status: "done", png: "scene-01.png" }] }));
  const c = (await app.inject({ method: "GET", url: "/api/collections/old", headers: H })).json();
  assert.equal(c.variations, 1);
  assert.equal(c.frames[0].variant, 1);
  assert.deepEqual(c.selections, {});
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/old/images/scene-01.png", headers: H })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/collections/old/selection", headers: H, payload: { frame: 1, variant: 1 } })).statusCode, 200);
});

test("feedback: save, read, change, delete, validate, survive restart, old collections work, sources untouched", async () => {
  const PLAN = JSON.stringify({ concept: { description: "d" }, frames: [] });
  const { app, dir } = await setup();
  await mkdir(join(dir, "old"));
  await writeFile(join(dir, "old", "scene-01.png"), Buffer.from("png"));
  const manifest = JSON.stringify({ title: "Old", createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames: [{ frame: 1, model: "duskrose", seed: 1, status: "done", png: "scene-01.png" }] });
  await writeFile(join(dir, "old", "collection.json"), manifest);
  await writeFile(join(dir, "old", "prompt-plan.json"), PLAN);
  const get = async (a = app) => (await a.inject({ method: "GET", url: "/api/collections/old", headers: H })).json();
  const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/collections/old/feedback", headers: H, payload: payload as never });

  assert.equal((await get()).feedback, null); // old collection without feedback.json
  assert.equal((await put({ rating: 4, tags: ["great_outfit", "weak_concept", "great_outfit"], note: " nice " })).statusCode, 200);
  let fb = (await get()).feedback;
  assert.equal(fb.rating, 4);
  assert.deepEqual(fb.tags, ["great_outfit", "weak_concept"]);
  assert.equal(fb.note, "nice");
  assert.equal(fb.version, 1);

  // restart: a brand-new app reads the same data from disk
  const app2 = buildApp({ runner: {} as never, collectionsDir: dir, comfyUrl: "http://x", port: PORT });
  assert.equal((await get(app2)).feedback.rating, 4);

  // change, then remove the rating but keep tags
  assert.equal((await put({ rating: 2, tags: [], note: "" })).statusCode, 200);
  assert.equal((await get()).feedback.rating, 2);
  assert.equal((await put({ rating: null, tags: ["bad_anatomy"] })).statusCode, 200);
  fb = (await get()).feedback;
  assert.equal(fb.rating, null);
  assert.deepEqual(fb.tags, ["bad_anatomy"]);
  // fully empty feedback removes the file
  assert.equal((await put({ rating: null, tags: [], note: "" })).statusCode, 200);
  assert.equal((await get()).feedback, null);

  // validation
  for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 3.5 }, { rating: "4" }, { tags: ["nope"] }, { tags: "great_outfit" }, { note: 5 }, { note: "x".repeat(501) }, [1]]) {
    assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal((await app.inject({ method: "PUT", url: "/api/collections/nope/feedback", headers: H, payload: { rating: 3 } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: "/api/collections/..%2Fx/feedback", headers: H, payload: { rating: 3 } })).statusCode, 404);

  // generation sources are untouched
  await put({ rating: 5 });
  assert.equal(await readFile(join(dir, "old", "collection.json"), "utf8"), manifest);
  assert.equal(await readFile(join(dir, "old", "prompt-plan.json"), "utf8"), PLAN);
  assert.equal((await readFile(join(dir, "old", "scene-01.png"))).toString(), "png");
});

test("composition: API validates it (400), old body works, and ONE plan call receives it for the whole batch", async () => {
  const seen: unknown[] = [];
  const planJson = strictPlan("Comp");
  const { app, runner, release } = await setup({
    plan: async (o) => {
      seen.push(o.composition);
      return { plans: Array.from({ length: o.count }, (_, i) => ({ ...planJson, concept: { ...planJson.concept, title: `Comp ${i + 1}` } })), raw: "", ms: 1, tokens: null };
    },
  });
  const body = (composition: unknown) => app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { collections: 3, variations: 1, composition } as never });
  for (const bad of ["x", { global: { pose: "nope" } }, { scenes: [{ pose: "inherit" }, 7] }, { scenes: [{}, {}, {}, {}, {}] }, { extra: 1 }]) {
    assert.equal((await body(bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal(seen.length, 0);
  const comp = { global: { framing: "waist_up" }, scenes: [{ orientation: "direct_front_view" }] };
  assert.equal((await body(comp)).statusCode, 202);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [comp]); // one call, 3 collections, same requirements
  // old API without composition is unchanged
  assert.equal((await post(app, "", 1, 1)).statusCode, 202);
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen[1], undefined);
});

test("codex model: API validates against the catalog (400), passes the choice to the plan call and records it in batch + collection metadata", async () => {
  const seen: { model?: string; reasoningEffort?: string }[] = [];
  const planJson = strictPlan("CM");
  const { app: _unused, runner, release, dir } = await setup({
    plan: async (o) => {
      seen.push({ model: o.model, reasoningEffort: o.reasoningEffort });
      return { plans: [planJson], raw: "", ms: 1, tokens: null };
    },
  });
  const models = [{ id: "m-big", name: "Big", efforts: ["low", "xhigh"] }, { id: "m-small", name: "Small", efforts: ["medium"] }];
  const app2 = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: PORT, loadCatalog: async () => ({ models, source: "cache" }) });
  const go = (payload: Record<string, unknown>) => app2.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { collections: 1, variations: 1, ...payload } as never });
  const list = (await app2.inject({ method: "GET", url: "/api/codex/models", headers: H })).json();
  assert.equal(list.models[0].efforts[1].label, "Extra High");
  assert.equal(list.models[0].efforts[1].id, "xhigh");
  for (const bad of [{ codexModel: "nope" }, { codexModel: "m-small", codexReasoningEffort: "xhigh" }, { codexReasoningEffort: "extra_high" }, { codexModel: 1 }]) {
    const r = await go(bad);
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
    assert.ok(r.json().error);
  }
  assert.equal(seen.length, 0); // nothing was launched
  assert.equal((await go({ codexModel: "m-big", codexReasoningEffort: "xhigh" })).statusCode, 202);
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [{ model: "m-big", reasoningEffort: "xhigh" }]);
  const c = (await app2.inject({ method: "GET", url: "/api/collections", headers: H })).json()[0];
  assert.equal(c.codex.model, "m-big");
  assert.equal(c.codex.reasoningEffort, "xhigh");
  // old call without parameters: no catalog needed, Default recorded as null
  assert.equal((await go({})).statusCode, 202);
  while (runner.active) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen[1], { model: undefined, reasoningEffort: undefined });
  const c2 = (await app2.inject({ method: "GET", url: "/api/collections", headers: H })).json()[0];
  assert.equal(c2.codex.model, null);
  // catalog unavailable: unknown ids are refused, Default still works
  const app3 = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: PORT, loadCatalog: async () => ({ models: [], source: "none", error: "gone" }) });
  assert.equal((await app3.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { codexModel: "m-big" } as never })).statusCode, 400);
});
