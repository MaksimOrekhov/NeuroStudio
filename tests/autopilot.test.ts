import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ComfyUnavailableError, MODELS, loadWorkflow } from "../src/comfy.ts";
import { buildJobs, runCollection } from "../src/collection.ts";
import { CodexError, generatePlan } from "../src/codex.ts";
import { strictPlan } from "./fixtures/strictPlan.ts";

const root = resolve(import.meta.dirname, "..");
const load = async () => ({
  plan: strictPlan("Autopilot Test"),
  base: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
});

test("buildJobs: 4 jobs, distinct seeds, right checkpoint per model, original graph untouched", async () => {
  const { plan, base } = await load();
  const before = JSON.stringify(base);
  const jobs = buildJobs(plan, base, "demo");
  assert.equal(jobs.length, 4);
  assert.equal(new Set(jobs.map((j) => j.seed)).size, 4);
  for (const j of jobs) assert.equal(j.graph["90:78"].inputs.unet_name, MODELS[j.model]);
  assert.deepEqual(jobs.map((j) => j.model), ["crimson-oath", "crimson-oath", "duskrose", "duskrose"]);
  assert.equal(jobs[0].graph["46"].inputs.filename_prefix, "NeuroStudio/demo/scene-01");
  assert.equal(JSON.stringify(base), before);
});

function fakeClient(over: Record<string, unknown> = {}) {
  const calls = { submit: 0 };
  const client = {
    systemStats: async () => ({}),
    checkDependencies: async () => [] as string[],
    submit: async () => `id-${++calls.submit}`,
    waitForImages: async () => ({ images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} }),
    download: async () => Buffer.from("png"),
    ...over,
  };
  return { client: client as never, calls };
}

test("runCollection: success writes 4 scenes and manifest", async () => {
  const { plan, base } = await load();
  const dir = await mkdtemp(join(tmpdir(), "ns-"));
  const { client, calls } = fakeClient();
  const m = await runCollection({ plan, jobs: buildJobs(plan, base, "demo"), dir, client });
  assert.equal(m.status, "done");
  assert.equal(calls.submit, 4);
  assert.equal(JSON.parse(await readFile(join(dir, "collection.json"), "utf8")).frames.length, 4);
});

test("runCollection: failure and timeout stop the run without resubmitting", async () => {
  const { plan, base } = await load();
  for (const msg of ["Generation failed: boom", "Timed out after 5 ms waiting for id-2"]) {
    const dir = await mkdtemp(join(tmpdir(), "ns-"));
    let waits = 0;
    const { client, calls } = fakeClient({
      waitForImages: async () => {
        if (++waits === 2) throw new Error(msg);
        return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
      },
    });
    await assert.rejects(runCollection({ plan, jobs: buildJobs(plan, base, "demo"), dir, client }), /boom|Timed out/);
    assert.equal(calls.submit, 2); // 3rd and 4th never sent, 2nd never repeated
    const m = JSON.parse(await readFile(join(dir, "collection.json"), "utf8"));
    assert.equal(m.status, "failed");
    assert.equal(m.frames[1].promptId, "id-2");
  }
});

test("generatePlan: timeout and bad output raise CodexError after a single launch", async () => {
  const sleeper = { command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)", "--"] };
  await assert.rejects(generatePlan({ launcher: sleeper, timeoutMs: 300 }), CodexError);
  const silent = { command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>{})", "--"] };
  await assert.rejects(generatePlan({ launcher: silent, timeoutMs: 5000 }), /no final message/);
});

test("ComfyUI disappears after a job was accepted: indeterminate status, prompt_id kept, no resubmit", async () => {
  const { plan, base } = await load();
  const dir = await mkdtemp(join(tmpdir(), "ns-"));
  const { client, calls } = fakeClient({
    waitForImages: async () => {
      throw new ComfyUnavailableError("ComfyUI not reachable at http://127.0.0.1:8188: fetch failed");
    },
  });
  await assert.rejects(runCollection({ plan, jobs: buildJobs(plan, base, "demo"), dir, client }), ComfyUnavailableError);
  assert.equal(calls.submit, 1);
  const m = JSON.parse(await readFile(join(dir, "collection.json"), "utf8"));
  assert.equal(m.status, "failed");
  assert.equal(m.frames[0].status, "timeout"); // "unknown": the accepted job may or may not have finished
  assert.equal(m.frames[0].promptId, "id-1");
  assert.equal(m.frames[1].status, "pending");
});

test("variants: same prompts and settings per frame, only seed (and file name) differ; seeds all unique; 4 x v jobs", async () => {
  const { plan, base } = await load();
  for (const v of [1, 2, 4]) assert.equal(buildJobs(plan, base, "demo", v).length, 4 * v);
  const jobs = buildJobs(plan, base, "demo", 4);
  assert.equal(new Set(jobs.map((j) => j.seed)).size, 16);
  assert.deepEqual(buildJobs(plan, base, "demo", 1).map((j) => j.file).sort(), ["scene-01", "scene-02", "scene-03", "scene-04"]); // legacy names
  assert.ok(jobs.every((j) => /^scene-0[1-4]-v0[1-4]$/.test(j.file)));
  const norm = (g: Record<string, { inputs: Record<string, unknown> }>) => {
    const c = structuredClone(g);
    c["90:76"].inputs.seed = 0;
    c["46"].inputs.filename_prefix = "";
    return JSON.stringify(c);
  };
  for (const frame of [1, 2, 3, 4]) {
    const same = jobs.filter((j) => j.frame === frame);
    assert.equal(same.length, 4);
    assert.equal(new Set(same.map((j) => norm(j.graph))).size, 1);
  }
});

test("a failing variant stops the run: ready images kept, prompt_id kept, nothing resubmitted", async () => {
  const { plan, base } = await load();
  const dir = await mkdtemp(join(tmpdir(), "ns-"));
  let waits = 0;
  const { client, calls } = fakeClient({
    waitForImages: async () => {
      if (++waits === 3) throw new Error("Generation failed: boom");
      return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
    },
  });
  await assert.rejects(runCollection({ plan, jobs: buildJobs(plan, base, "demo", 2), dir, client }), /boom/);
  assert.equal(calls.submit, 3);
  const m = JSON.parse(await readFile(join(dir, "collection.json"), "utf8"));
  assert.deepEqual(m.frames.map((f: { status: string }) => f.status).slice(0, 4), ["done", "done", "failed", "pending"]);
  assert.equal(m.frames[2].promptId, "id-3");
  assert.equal((await readFile(join(dir, "scene-01-v01.png"))).length, 3);
});
