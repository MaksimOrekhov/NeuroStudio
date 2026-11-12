import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildJobs } from "../src/collection.ts";
import { FIELDS } from "../src/comfy.ts";
import { batchSchema, planSchema } from "../src/codex.ts";
import { resolveImageModels } from "../src/imageModels.ts";
import { validatePlan } from "../src/promptPlan.ts";
import { assignModels, modelName, modelUsage } from "../web/src/models.ts";
import { planV3 } from "./fixtures/strictPlan.ts";
import { H, reliabilityEnv } from "./fixtures/reliability.ts";

const I = "illustrijn";

test("IllustrijN: Only and custom assignments agree between UI and server; model name and summary are available", () => {
  assert.deepEqual(resolveImageModels({ mode: "only", model: I }, 4).models, [I, I, I, I]);
  assert.deepEqual(assignModels(`only:${I}`, 4), [I, I, I, I]);
  const custom = [I, "duskrose", "crimson-oath"];
  assert.deepEqual(resolveImageModels({ mode: "custom", perScene: custom }, 3).models, custom);
  assert.deepEqual(assignModels("custom", 3, custom), custom);
  assert.equal(modelName(I), "IllustrijN");
  assert.deepEqual(modelUsage([I, I]).map((u) => [u.model.name, u.scenes]), [["IllustrijN", [1, 2]]]);
});

test("IllustrijN: generated plan schemas and validation accept the exact assigned model", async () => {
  const plan = planV3("New model", [I]);
  assert.doesNotThrow(() => validatePlan(plan, { models: [I] }));
  assert.deepEqual((await planSchema([I]) as any).properties.frames.items.properties.model.enum, [I]);
  assert.deepEqual((await batchSchema(1, undefined, [I]) as any).properties.collections.items.properties.frames.items.properties.model.enum, [I]);
  const raw = JSON.parse(await readFile(new URL("../schemas/prompt-plan.schema.json", import.meta.url), "utf8"));
  assert.ok(raw.properties.frames.items.properties.model.enum.includes(I));
});

test("IllustrijN: job graph changes only model, prompt, seed and output prefix; source workflow stays intact", async (t) => {
  const e = await reliabilityEnv(t);
  const before = structuredClone(e.graph);
  const [job] = buildJobs(planV3("New model", [I]), e.graph, "new-model");
  assert.equal(job.model, I);
  assert.equal(job.graph[FIELDS.unet.node].inputs[FIELDS.unet.input], "IllustrijN.safetensors");
  const restored = structuredClone(job.graph);
  for (const field of ["unet", "positive", "seed", "filenamePrefix"] as const) {
    const f = FIELDS[field];
    restored[f.node].inputs[f.input] = before[f.node].inputs[f.input];
  }
  assert.deepEqual(restored, before);
  assert.deepEqual(e.graph, before);
});

test("IllustrijN: API generation persists the new model and regeneration uses its saved graph without another plan call", async (t) => {
  const e = await reliabilityEnv(t);
  const res = await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 1, imageModels: { mode: "only", model: I } } });
  assert.equal(res.statusCode, 202);
  await e.settle();
  assert.equal(e.runner.state.status, "completed");
  const [c] = await e.get("/api/collections");
  assert.equal(c.frames[0].model, I);
  assert.equal(c.frames[0].status, "done");
  assert.deepEqual(e.fake.plans[0].models, [I]);
  const regen = await e.app.inject({ method: "POST", url: `/api/collections/${c.id}/frames/1/regenerate`, headers: H, payload: { sourceVariant: 1 } });
  assert.equal(regen.statusCode, 202);
  await e.settle();
  const updated = await e.get(`/api/collections/${c.id}`);
  assert.deepEqual(updated.frames.map((f: any) => [f.variant, f.model, f.status]), [[1, I, "done"], [2, I, "done"]]);
  const side = JSON.parse(await readFile(join(e.collectionsDir, c.id, "scene-01-v02.json"), "utf8"));
  assert.equal(side.graph[FIELDS.unet.node].inputs[FIELDS.unet.input], "IllustrijN.safetensors");
  assert.equal(e.fake.plans.length, 1);
});
