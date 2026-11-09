import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ComfyClient, ComfyUnavailableError, GenerationError, WorkflowError, applyParams, loadWorkflow } from "../src/comfy.ts";

const wf = resolve(import.meta.dirname, "../workflows/anima-crimson-oath.api.json");

const fakeFetch = (routes: Record<string, () => Response>): typeof fetch =>
  (async (url: string) => {
    const path = new URL(url).pathname;
    const h = routes[path];
    if (!h) return new Response("not found", { status: 404 });
    return h();
  }) as unknown as typeof fetch;

test("applyParams patches only mapped fields and leaves the original untouched", async () => {
  const orig = await loadWorkflow(wf);
  const before = JSON.stringify(orig);
  const g = applyParams(orig, { positive: "p", negative: "n", seed: 42, steps: 20 });
  assert.equal(JSON.stringify(orig), before);
  assert.equal(g["90:77"].inputs.text, "p");
  assert.equal(g["90:75"].inputs.text, "n");
  assert.equal(g["90:76"].inputs.seed, 42);
  assert.equal(g["90:79"].inputs.value, 20);
  // everything else identical
  g["90:77"].inputs.text = orig["90:77"].inputs.text;
  g["90:75"].inputs.text = orig["90:75"].inputs.text;
  g["90:76"].inputs.seed = orig["90:76"].inputs.seed;
  g["90:79"].inputs.value = orig["90:79"].inputs.value;
  assert.deepEqual(g, orig);
});

test("applyParams fails when a required node is missing or has the wrong type", async () => {
  const orig = await loadWorkflow(wf);
  const missing = structuredClone(orig);
  delete missing["90:77"];
  assert.throws(() => applyParams(missing, { positive: "p", seed: 1 }), WorkflowError);
  const wrong = structuredClone(orig);
  wrong["90:77"].class_type = "SomethingElse";
  assert.throws(() => applyParams(wrong, { positive: "p", seed: 1 }), WorkflowError);
});

test("unreachable ComfyUI raises ComfyUnavailableError", async () => {
  const c = new ComfyClient("http://127.0.0.1:1", fetch, 2000);
  await assert.rejects(c.systemStats(), ComfyUnavailableError);
});

test("rejected prompt, failed execution and bad response raise GenerationError", async () => {
  const bad = new ComfyClient("http://x", fakeFetch({ "/prompt": () => new Response(JSON.stringify({ error: "x", node_errors: {} }), { status: 400 }) }));
  await assert.rejects(bad.submit({}, "c"), GenerationError);

  const failed = new ComfyClient(
    "http://x",
    fakeFetch({ "/history/abc": () => Response.json({ abc: { status: { status_str: "error", completed: false, messages: [["execution_error", {}]] }, outputs: {} } }) }),
  );
  await assert.rejects(failed.waitForImages("abc", 2000, 10), GenerationError);

  const garbage = new ComfyClient("http://x", fakeFetch({ "/prompt": () => new Response("<html>", { status: 200 }) }));
  await assert.rejects(garbage.submit({}, "c"), GenerationError);

  const notPng = new ComfyClient("http://x", fakeFetch({ "/view": () => new Response("hello world, not png") }));
  await assert.rejects(notPng.download({ filename: "a.png", subfolder: "", type: "output" }), GenerationError);
});
