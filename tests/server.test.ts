import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../server/app.ts";
import { safeImagePath } from "../server/collections.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { loadWorkflow } from "../src/comfy.ts";
import { generateBatch, planPrompt, type BatchResult } from "../src/codex.ts";
import { PlanError, parseCount, validateBatch, validatePlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const PORT = 8787;
const H = { host: `127.0.0.1:${PORT}` };

async function setup(over: { systemStats?: () => Promise<unknown>; plan?: () => Promise<BatchResult>; waitForImages?: () => Promise<unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns-srv-"));
  const planJson = validatePlan(JSON.parse(await readFile(join(root, "docs/examples/prompt-plan.sample.json"), "utf8")));
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

const post = (app: ReturnType<typeof buildApp>, theme = "", collections?: unknown) =>
  app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { theme, collections } });

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
  assert.match(planPrompt(undefined, ["Saltglass Conservatory"]), /do NOT repeat[^\n]*"Saltglass Conservatory"/);
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
  const sample = JSON.parse(await readFile(join(root, "docs/examples/prompt-plan.sample.json"), "utf8"));
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
    const p = JSON.parse(fs.readFileSync(process.env.NS_SAMPLE, "utf8"));
    const q = { ...p, concept: { ...p.concept, title: "Second" } };
    fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ collections: [p, q] }));
    process.stdin.resume(); process.stdin.on("data", () => {});
  `;
  process.env.NS_COUNTER = counter;
  process.env.NS_SAMPLE = join(root, "docs/examples/prompt-plan.sample.json");
  const r = await generateBatch({ count: 2, launcher: { command: process.execPath, args: ["-e", script, "--"] }, timeoutMs: 10_000 });
  assert.equal(r.plans.length, 2);
  assert.equal((await readFile(counter, "utf8")).length, 1); // exactly one Codex process
  assert.match(planPrompt(undefined, [], 2), /exactly 2 Prompt Plans/);
});
