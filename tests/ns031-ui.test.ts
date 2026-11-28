// NS-031 UI store: the repair dialog loads what the server says, validates the description, sends ONE request with the painted mask.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Collection } from "../web/src/api.ts";
import { H, body, maskPng, setup } from "./fixtures/repair.ts";

let route: (url: string, init?: RequestInit) => Promise<Response>;
(globalThis as any).fetch = (url: string, init?: RequestInit) => route(url, init);
const S = await import("../web/src/store.ts");

async function env(o: Parameters<typeof setup>[0] = {}) {
  const e = await setup(o);
  S.stopPolling();
  S.app.status = null; // each test starts with no run in progress (the store is shared by the tests of this file)
  const posts: { url: string; body: any }[] = [];
  route = async (url, init) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
    const r = await e.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { ...H, ...(init?.headers as Record<string, string>) }, payload: init?.body as any });
    const b = r.json();
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => b } as Response;
  };
  const c = (await e.get()) as Collection;
  return { ...e, posts, c };
}

test("UI: the dialog loads the source info and the ComfyUI status; presets set denoise; a changed denoise is 'custom'", async () => {
  const e = await env();
  await S.openRepair(e.c, 1, 1);
  assert.equal(S.repair.loading, false);
  assert.equal(S.repair.info?.model, "crimson-oath-v03");
  assert.deepEqual(S.repair.info?.regions, [512, 1024]);
  assert.equal(S.repair.status?.ready, true);
  assert.deepEqual([S.repair.preset, S.repair.denoise, S.repair.region], ["remove", 1, 1024]);
  S.setRepairPreset("fix");
  assert.deepEqual([S.repair.preset, S.repair.denoise], ["fix", 0.65]);
  S.setRepairDenoise(0.8);
  assert.equal(S.repair.preset, "custom");
  S.setRepairDenoise(1);
  assert.equal(S.repair.preset, "remove");
  S.closeRepair();
  assert.equal(S.repair.target, null);
});

test("UI: empty or Russian description is refused locally; an English one sends exactly one POST with the mask and settings", async () => {
  const e = await env();
  await S.openRepair(e.c, 1, 1);
  const mask = await maskPng([[300, 500, 60]]);
  S.repair.text = "  ";
  assert.equal(await S.submitRepair(mask), false);
  assert.match(S.repair.error!.message, /английском/);
  S.repair.text = "ковёр";
  assert.equal(await S.submitRepair(mask), false);
  assert.equal(e.posts.length, 0);
  S.repair.text = "the patterned woven rug continuing between her feet";
  S.setRepairPreset("fix");
  S.repair.region = 512;
  assert.equal(await S.submitRepair(mask), true);
  assert.equal(e.posts.length, 1);
  assert.equal(e.posts[0].url, `/api/collections/${e.id}/frames/1/repair`);
  assert.deepEqual({ ...e.posts[0].body, mask: undefined }, { sourceVariant: 1, mask: undefined, text: "the patterned woven rug continuing between her feet", denoise: 0.65, region: 512, preset: "fix" });
  assert.equal(e.posts[0].body.mask, mask);
  assert.equal(S.repair.target, null, "the dialog closes once the server accepted the repair");
  assert.equal(S.app.status?.run.regeneration?.repair, true);
  await e.settle();
  assert.equal(e.runner.state.status, "completed", e.runner.state.error);
});

test("UI: an unsupported model shows the Russian reason and keeps the technical text; nothing is sent", async () => {
  const e = await env({ model: "duskrose" });
  await S.openRepair(e.c, 1, 1);
  assert.equal(S.repair.info, null);
  assert.equal(S.repair.error?.code, "REPAIR_MODEL_UNSUPPORTED");
  assert.match(S.repair.error!.message, /Crimson Oath v0\.3/);
  assert.match(S.repair.error!.details!, /Duskrose/);
  assert.equal(await S.submitRepair(await maskPng([[300, 500, 60]])), false);
  assert.equal(e.posts.length, 0);
  S.closeRepair();
});

test("UI: a server refusal (mask does not fit 512 px) is shown in Russian; the dialog stays open", async () => {
  const e = await env();
  await S.openRepair(e.c, 1, 1);
  S.repair.text = "rug";
  S.repair.region = 512;
  assert.equal(await S.submitRepair((await body({ discs: [[300, 500, 260]] })).mask), false);
  assert.equal(S.repair.error?.code, "INVALID_MASK");
  assert.match(S.repair.error!.message, /1024/);
  assert.ok(S.repair.target);
  S.closeRepair();
});
