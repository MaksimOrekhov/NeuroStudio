import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../server/app.ts";
import { safeImagePath } from "../server/collections.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { loadWorkflow } from "../src/comfy.ts";
import { planPrompt, type CodexResult } from "../src/codex.ts";
import { validatePlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const PORT = 8787;
const H = { host: `127.0.0.1:${PORT}` };

async function setup(over: { systemStats?: () => Promise<unknown>; plan?: () => Promise<CodexResult> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ns-srv-"));
  const planJson = validatePlan(JSON.parse(await readFile(join(root, "docs/examples/prompt-plan.sample.json"), "utf8")));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls = { plan: 0, avoid: [] as string[][] };
  const client = {
    systemStats: over.systemStats ?? (async () => ({})),
    checkDependencies: async () => [] as string[],
    submit: async () => "pid",
    waitForImages: async () => {
      await gate;
      return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
    },
    download: async () => Buffer.from("png"),
  };
  const runner = new AutopilotRunner({
    client: client as never,
    plan:
      over.plan ??
      (async (o) => {
        calls.plan++;
        calls.avoid.push(o.avoid ?? []);
        return { plan: planJson, raw: "", ms: 5, tokens: null };
      }),
    baseGraph: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
    collectionsDir: dir,
  });
  const app = buildApp({
    runner,
    collectionsDir: dir,
    comfyUrl: "http://x",
    port: PORT,
    statusClient: { systemStats: async () => ({ system: { comfyui_version: "9.9" } }) as never, queue: async () => ({ queue_running: [], queue_pending: [] }) },
  });
  return { dir, app, runner, release, calls };
}

const post = (app: ReturnType<typeof buildApp>, theme = "") =>
  app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { theme } });

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
