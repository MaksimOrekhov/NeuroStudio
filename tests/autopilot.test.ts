import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MODELS, loadWorkflow } from "../src/comfy.ts";
import { buildJobs, runCollection } from "../src/collection.ts";
import { CodexError, generatePlan } from "../src/codex.ts";
import { validatePlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const load = async () => ({
  plan: validatePlan(JSON.parse(await readFile(join(root, "docs/examples/prompt-plan.sample.json"), "utf8"))),
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
