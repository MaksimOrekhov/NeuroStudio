// NS-017: targeted regeneration of one image. No GPU, no Codex: ComfyUI is a fake client, Codex is a function that fails the test if called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { readCollection } from "../server/collections.ts";
import { ComfyUnavailableError, FIELDS, loadWorkflow, type Graph } from "../src/comfy.ts";
import { buildJobs, runCollection } from "../src/collection.ts";
import { MAX_VARIANT } from "../src/regenerate.ts";
import { planV3 } from "./fixtures/strictPlan.ts";

const root = resolve(import.meta.dirname, "..");
const H = { host: "127.0.0.1:8787" };
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`fake-${tag}-` + "x".repeat(100))]);

interface Fake {
  submits: Graph[];
  /** When set, waitForImages waits for it (gate) before answering. */
  gate?: Promise<void>;
  waitError?: Error;
  submitError?: Error;
  statsError?: Error;
  n: number;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ns17-"));
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const fake: Fake = { submits: [], n: 0 };
  const client = {
    systemStats: async () => {
      if (fake.statsError) throw fake.statsError;
      return {} as never;
    },
    checkDependencies: async () => [],
    submit: async (g: Graph) => {
      if (fake.submitError) throw fake.submitError;
      fake.submits.push(g);
      return `pid-${fake.submits.length}`;
    },
    waitForImages: async () => {
      if (fake.gate) await fake.gate;
      if (fake.waitError) throw fake.waitError;
      return { images: [{ filename: `r${++fake.n}.png`, subfolder: "", type: "output" }], history: { ok: true } };
    },
    download: async (ref: { filename: string }) => png(ref.filename),
  };
  let codexCalls = 0;
  const runner = new AutopilotRunner({
    client: client as never,
    plan: (async () => {
      codexCalls++;
      throw new Error("Codex must not be called");
    }) as never,
    baseGraph: base,
    collectionsDir: dir,
    batchesDir: join(dir, "_batches"),
  });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787 });
  const settle = async () => {
    while (runner.active) await new Promise((r) => setTimeout(r, 5));
  };
  /** A genuine collection written by the real runCollection (so sidecars hold real graphs): legacy names scene-0N.png. */
  const make = async (id: string, models: string[] = ["crimson-oath", "crimson-oath", "duskrose", "duskrose"]) => {
    const plan = planV3(id, models as never);
    const jobs = buildJobs(plan, base, id, 1);
    await runCollection({ plan, jobs, dir: join(dir, id), client: client as never });
    fake.submits.length = 0;
    fake.n = 0;
  };
  const post = (id: string, frame: number | string, body: unknown) => app.inject({ method: "POST", url: `/api/collections/${id}/frames/${frame}/regenerate`, headers: H, payload: body as never });
  const prompt = (id: string, frame: number | string, variant: number | string) => app.inject({ method: "GET", url: `/api/collections/${id}/frames/${frame}/variants/${variant}/prompt`, headers: H });
  const get = async (id: string) => (await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: H })).json();
  const sidecar = async (id: string, name: string) => JSON.parse(await readFile(join(dir, id, `${name}.json`), "utf8"));
  return { dir, base, fake, runner, app, settle, make, post, prompt, get, sidecar, codexCalls: () => codexCalls };
}

/** Paths whose values differ between two JSON values. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b ? [] : [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}/${k}`));
}
const POS = `/${FIELDS.positive.node}/inputs/${FIELDS.positive.input}`;
const SEED = `/${FIELDS.seed.node}/inputs/${FIELDS.seed.input}`;
const PREFIX = `/${FIELDS.filenamePrefix.node}/inputs/${FIELDS.filenamePrefix.input}`;

test("regeneration builds a new variant from the saved graph: unedited prompt, only seed and filename prefix change", async () => {
  const t = await setup();
  await t.make("c1");
  const before = await t.get("c1");
  const src = await t.sidecar("c1", "scene-03");
  const res = await t.post("c1", 3, { sourceVariant: 1 });
  assert.equal(res.statusCode, 202);
  await t.settle();
  assert.equal(t.fake.submits.length, 1);
  assert.deepEqual(diff(src.graph, t.fake.submits[0]).sort(), [PREFIX, SEED].sort()); // positive untouched, nothing else touched
  assert.match(String(t.fake.submits[0]["46"].inputs.filename_prefix), /\/scene-03-v02$/);
  const after = await t.get("c1");
  const v2 = after.frames.find((f: any) => f.frame === 3 && f.variant === 2);
  assert.equal(v2.status, "done");
  assert.equal(v2.image, "scene-03-v02.png");
  assert.equal(v2.sourceVariant, 1);
  assert.equal(v2.model, before.frames.find((f: any) => f.frame === 3).model);
  assert.ok(!before.frames.some((f: any) => f.seed === v2.seed)); // new seed, unique in the collection
  assert.equal(after.status, "done");
  assert.equal(after.frames.length, before.frames.length + 1);
  assert.equal(after.doneFrames, before.doneFrames + 1);
  assert.equal(t.codexCalls(), 0);
});

test("edited prompt: only positive, seed and prefix change; the source prompt, PNG and sidecar stay byte-identical", async () => {
  const t = await setup();
  await t.make("c2");
  const pngBefore = await readFile(join(t.dir, "c2", "scene-03.png"));
  const sideBefore = await readFile(join(t.dir, "c2", "scene-03.json"), "utf8");
  const src = JSON.parse(sideBefore);
  const res = await t.post("c2", 3, { sourceVariant: 1, positive: "  1girl, red umbrella, rain  " });
  assert.equal(res.statusCode, 202);
  await t.settle();
  assert.deepEqual(diff(src.graph, t.fake.submits[0]).sort(), [POS, PREFIX, SEED].sort());
  assert.equal(t.fake.submits[0]["90:77"].inputs.text, "1girl, red umbrella, rain");
  assert.equal(t.fake.submits[0]["90:75"].inputs.text, src.graph["90:75"].inputs.text); // negative unchanged
  assert.deepEqual(await readFile(join(t.dir, "c2", "scene-03.png")), pngBefore);
  assert.equal(await readFile(join(t.dir, "c2", "scene-03.json"), "utf8"), sideBefore);
  const side = await t.sidecar("c2", "scene-03-v02");
  assert.equal(side.positive, "1girl, red umbrella, rain");
  assert.equal(side.sourceVariant, 1);
  assert.equal(side.promptEdited, true);
  assert.equal(side.status, "done");
  assert.equal(side.promptId, "pid-1");
  assert.equal(side.model, src.model);
  assert.ok(side.graph && side.history && side.seconds >= 0);
  assert.deepEqual(await readFile(join(t.dir, "c2", "scene-03-v02.png")), png("r1.png")); // original bytes
  assert.equal((await t.get("c2")).frames.find((f: any) => f.variant === 2).promptEdited, true);
});

test("each variant has its own prompt: regenerating v02 starts from the v02 prompt, not v01", async () => {
  const t = await setup();
  await t.make("c3");
  const p1 = (await t.prompt("c3", 3, 1)).json();
  assert.equal(p1.available, true);
  assert.equal(p1.model, "duskrose");
  await t.post("c3", 3, { sourceVariant: 1, positive: "edited v2 prompt" });
  await t.settle();
  const p2 = (await t.prompt("c3", 3, 2)).json();
  assert.equal(p2.positive, "edited v2 prompt");
  assert.equal(p2.promptEdited, true);
  assert.notEqual(p2.positive, p1.positive);
  assert.equal((await t.prompt("c3", 3, 1)).json().positive, p1.positive); // v01 prompt unchanged
  await t.post("c3", 3, { sourceVariant: 2 });
  await t.settle();
  assert.equal(t.fake.submits[1]["90:77"].inputs.text, "edited v2 prompt");
  assert.equal((await t.sidecar("c3", "scene-03-v03")).sourceVariant, 2);
  // a third variant: all numbers distinct, files side by side
  const files = (await readdir(join(t.dir, "c3"))).filter((f) => f.startsWith("scene-03")).sort();
  assert.deepEqual(files, ["scene-03-v02.json", "scene-03-v02.png", "scene-03-v03.json", "scene-03-v03.png", "scene-03.json", "scene-03.png"]);
});

test("Best, Feedback and selections.json are untouched; the new variant can be chosen Best and is exported by NS-016", async () => {
  const t = await setup();
  await t.make("c4");
  await writeFile(join(t.dir, "c4", "selections.json"), JSON.stringify({ "1": 1, "3": 1 }));
  await writeFile(join(t.dir, "c4", "feedback.json"), JSON.stringify({ version: 1, rating: 4, tags: [], note: "n", updatedAt: "x" }));
  const sel = await readFile(join(t.dir, "c4", "selections.json"), "utf8");
  const fb = await readFile(join(t.dir, "c4", "feedback.json"), "utf8");
  await t.post("c4", 3, { sourceVariant: 1 });
  await t.settle();
  assert.equal(await readFile(join(t.dir, "c4", "selections.json"), "utf8"), sel);
  assert.equal(await readFile(join(t.dir, "c4", "feedback.json"), "utf8"), fb);
  const put = await t.app.inject({ method: "PUT", url: "/api/collections/c4/selection", headers: H, payload: { frame: 3, variant: 2 } });
  assert.equal(put.statusCode, 200);
  const zip = await t.app.inject({ method: "GET", url: "/api/collections/c4/export", headers: H });
  assert.equal(zip.statusCode, 200);
  assert.ok(zip.rawPayload.includes(png("r1.png"))); // the regenerated image is in the archive
  assert.ok(zip.rawPayload.includes(Buffer.from("scene-03.png")) && zip.rawPayload.includes(Buffer.from("scene-01.png")));
  assert.ok(!zip.rawPayload.includes(Buffer.from("scene-02.png")));
});

test("only one operation at a time: a second regeneration or a batch gets 409 ALREADY_RUNNING, and vice versa", async () => {
  const t = await setup();
  await t.make("c5");
  let open!: () => void;
  t.fake.gate = new Promise<void>((r) => (open = r));
  const [a, b] = await Promise.all([t.post("c5", 1, { sourceVariant: 1 }), t.post("c5", 2, { sourceVariant: 1 })]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
  const loser = a.statusCode === 409 ? a : b;
  assert.equal(loser.json().code, "ALREADY_RUNNING");
  const status = (await t.app.inject({ method: "GET", url: "/api/status", headers: H })).json();
  assert.equal(status.run.status, "generating");
  assert.equal(status.run.regeneration.frame, a.statusCode === 202 ? 1 : 2);
  const batch = await t.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { frames: 1 } });
  assert.equal(batch.statusCode, 409);
  assert.equal(batch.json().code, "ALREADY_RUNNING");
  open();
  await t.settle();
  assert.equal(t.fake.submits.length, 1);
});

test("a batch run holds the same lock: regeneration is refused while it runs", async () => {
  const t = await setup();
  await t.make("c6");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const runner = new AutopilotRunner({
    client: { systemStats: async () => ({}) } as never,
    plan: (async () => {
      await hold;
      throw new Error("stop");
    }) as never,
    baseGraph: t.base,
    collectionsDir: t.dir,
    batchesDir: join(t.dir, "_b"),
  });
  const app = buildApp({ runner, collectionsDir: t.dir, comfyUrl: "http://x", port: 8787 });
  await runner.start("x");
  const res = await app.inject({ method: "POST", url: "/api/collections/c6/frames/1/regenerate", headers: H, payload: { sourceVariant: 1 } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "ALREADY_RUNNING");
  release();
  while (runner.active) await new Promise((r) => setTimeout(r, 5));
});

test("timeout or ComfyUI vanishing: not resubmitted, prompt_id and unknown state kept, collection stays done, number never reused", async () => {
  const t = await setup();
  await t.make("c7");
  t.fake.waitError = new Error("Timed out waiting for prompt pid-1");
  assert.equal((await t.post("c7", 2, { sourceVariant: 1, positive: "p" })).statusCode, 202);
  await t.settle();
  assert.equal(t.fake.submits.length, 1); // never resubmitted
  let c = await t.get("c7");
  let v2 = c.frames.find((f: any) => f.frame === 2 && f.variant === 2);
  assert.equal(v2.status, "timeout");
  assert.equal(v2.promptId, "pid-1");
  assert.match(v2.error, /Timed out/);
  assert.equal(c.status, "done"); // the collection is not marked failed
  assert.equal((await t.app.inject({ method: "GET", url: "/api/status", headers: H })).json().run.errorCode, "GENERATION_FAILED");
  assert.equal((await t.sidecar("c7", "scene-02-v02")).status, "timeout");
  // ComfyUI disappears
  t.fake.waitError = new ComfyUnavailableError("connection refused");
  await t.post("c7", 2, { sourceVariant: 1 });
  await t.settle();
  c = await t.get("c7");
  assert.equal(c.frames.find((f: any) => f.frame === 2 && f.variant === 3).status, "timeout");
  assert.equal((await t.app.inject({ method: "GET", url: "/api/status", headers: H })).json().run.errorCode, "COMFY_UNREACHABLE");
  // a plain failure after the attempts: next number continues, failed variants are not sources
  t.fake.waitError = undefined;
  await t.post("c7", 2, { sourceVariant: 1 });
  await t.settle();
  assert.equal((await t.get("c7")).frames.find((f: any) => f.frame === 2 && f.variant === 4).status, "done");
  assert.equal((await t.post("c7", 2, { sourceVariant: 2 })).json().code, "SOURCE_UNAVAILABLE");
  assert.equal(t.fake.submits.length, 3);
});

test("ComfyUI rejecting the job is recorded as failed without a prompt_id; ComfyUI unreachable at the start creates nothing", async () => {
  const t = await setup();
  await t.make("c8");
  t.fake.submitError = new Error("ComfyUI rejected the workflow: bad input");
  await t.post("c8", 1, { sourceVariant: 1 });
  await t.settle();
  const v2 = (await t.get("c8")).frames.find((f: any) => f.frame === 1 && f.variant === 2);
  assert.equal(v2.status, "failed");
  assert.equal(v2.promptId, undefined);
  assert.match(v2.error, /rejected/);
  t.fake.submitError = undefined;
  t.fake.statsError = new Error("ECONNREFUSED");
  const res = await t.post("c8", 1, { sourceVariant: 1 });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "COMFY_UNREACHABLE");
  assert.equal((await t.get("c8")).frames.filter((f: any) => f.frame === 1).length, 2); // no slot was reserved
  assert.equal(t.runner.active, false);
});

test("missing or damaged sidecar/graph: clear error, nothing is generated, the base workflow is not used instead", async () => {
  const t = await setup();
  await t.make("c9");
  const side = join(t.dir, "c9");
  const orig = await readFile(join(side, "scene-01.json"), "utf8");
  const cases: [string, () => Promise<void>][] = [
    ["missing", async () => (await import("node:fs/promises")).rm(join(side, "scene-01.json"))],
    ["not json", () => writeFile(join(side, "scene-01.json"), "{broken")],
    ["no graph", () => writeFile(join(side, "scene-01.json"), JSON.stringify({ frame: 1 }))],
    ["wrong node", () => writeFile(join(side, "scene-01.json"), JSON.stringify({ graph: { "90:77": { class_type: "Other", inputs: { text: "x" } } } }))],
    ["no seed node", async () => {
      const g = JSON.parse(orig).graph;
      delete g["90:76"];
      await writeFile(join(side, "scene-01.json"), JSON.stringify({ graph: g }));
    }],
  ];
  for (const [name, breakIt] of cases) {
    await writeFile(join(side, "scene-01.json"), orig);
    await breakIt();
    const p = (await t.prompt("c9", 1, 1)).json();
    assert.equal(p.available, false, name);
    assert.equal(p.code, "SOURCE_UNAVAILABLE");
    const res = await t.post("c9", 1, { sourceVariant: 1 });
    assert.equal(res.statusCode, 409, name);
    assert.equal(res.json().code, "SOURCE_UNAVAILABLE");
    assert.equal(t.runner.active, false);
  }
  assert.equal(t.fake.submits.length, 0);
  assert.equal((await t.get("c9")).frames.length, 4); // nothing was added
  // the other frames still work
  assert.equal((await t.post("c9", 2, { sourceVariant: 1 })).statusCode, 202);
  await t.settle();
  // PNG missing on disk
  await (await import("node:fs/promises")).rm(join(side, "scene-04.png"));
  assert.equal((await t.post("c9", 4, { sourceVariant: 1 })).json().code, "SOURCE_UNAVAILABLE");
});

test("request validation: frame, sourceVariant, positive, ids; no arbitrary paths", async () => {
  const t = await setup();
  await t.make("c10");
  const bad: [string | number, unknown][] = [
    [0, { sourceVariant: 1 }],
    [5, { sourceVariant: 1 }],
    ["x", { sourceVariant: 1 }],
    [1, {}],
    [1, { sourceVariant: 0 }],
    [1, { sourceVariant: 1.5 }],
    [1, { sourceVariant: "1; rm" }],
    [1, { sourceVariant: 1, positive: "" }],
    [1, { sourceVariant: 1, positive: "   " }],
    [1, { sourceVariant: 1, positive: 5 }],
    [1, { sourceVariant: 1, positive: "x".repeat(5000) }],
    [1, { sourceVariant: 1, positive: "a\u0000b" }],
  ];
  for (const [frame, body] of bad) {
    const r = await t.post("c10", frame, body);
    assert.equal(r.statusCode, 400, JSON.stringify([frame, body]).slice(0, 80));
    assert.equal(r.json().code, "INVALID_REQUEST");
  }
  assert.equal((await t.post("nope", 1, { sourceVariant: 1 })).statusCode, 404);
  assert.equal((await t.post("..%2F..", 1, { sourceVariant: 1 })).statusCode, 404);
  assert.equal((await t.prompt("nope", 1, 1)).statusCode, 404);
  assert.equal((await t.prompt("c10", 9, 1)).statusCode, 400);
  assert.equal((await t.prompt("c10", 1, "abc")).statusCode, 400);
  assert.equal((await t.prompt("c10", 1, 7)).json().available, false); // unknown variant
  assert.equal(t.fake.submits.length, 0);
  assert.equal(t.runner.active, false);
});

test("variant limit: -v99 is the last number; the next request is refused instead of making an unsupported path", async () => {
  const t = await setup();
  await t.make("c11");
  const f = join(t.dir, "c11", "collection.json");
  const m = JSON.parse(await readFile(f, "utf8"));
  m.frames.push({ frame: 1, variant: MAX_VARIANT, model: "crimson-oath", seed: 7, status: "failed" });
  await writeFile(f, JSON.stringify(m));
  const r = await t.post("c11", 1, { sourceVariant: 1 });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, "VARIANT_LIMIT");
  assert.equal(t.fake.submits.length, 0);
  assert.equal(t.runner.active, false);
});

test("an existing file is never overwritten: the number moves past stray files", async () => {
  const t = await setup();
  await t.make("c12");
  await writeFile(join(t.dir, "c12", "scene-02-v02.png"), "stray");
  await t.post("c12", 2, { sourceVariant: 1 });
  await t.settle();
  assert.equal(await readFile(join(t.dir, "c12", "scene-02-v02.png"), "utf8"), "stray");
  assert.equal((await t.get("c12")).frames.find((f: any) => f.frame === 2 && f.image === "scene-02-v03.png").variant, 3);
});

test("old collections are read without migration; frames get different numbers of variants", async () => {
  const t = await setup();
  await t.make("c13");
  const f = join(t.dir, "c13", "collection.json");
  const m = JSON.parse(await readFile(f, "utf8"));
  delete m.variations; // as before NS-006/NS-014
  delete m.frameCount;
  delete m.generation;
  await writeFile(f, JSON.stringify(m));
  const before = await readFile(f, "utf8");
  const c = await t.get("c13");
  assert.equal(c.frameCount, 4);
  assert.equal((await t.prompt("c13", 4, 1)).json().available, true);
  assert.equal(await readFile(f, "utf8"), before); // reading and the prompt endpoint rewrite nothing
  await t.post("c13", 4, { sourceVariant: 1 });
  await t.settle();
  const after = await t.get("c13");
  assert.deepEqual([1, 2, 3, 4].map((n) => after.frames.filter((x: any) => x.frame === n).length), [1, 1, 1, 2]);
  const written = JSON.parse(await readFile(f, "utf8"));
  assert.equal(written.variations, undefined); // generation metadata is not rewritten
  assert.equal(written.status, "done");
  assert.equal(written.frames[3].png, "scene-04.png");
});

test("server restart after an unfinished regeneration: the slot is shown as unknown/failed and is never submitted again", async () => {
  const t = await setup();
  await t.make("c14");
  const f = join(t.dir, "c14", "collection.json");
  const m = JSON.parse(await readFile(f, "utf8"));
  m.frames.push({ frame: 1, variant: 2, model: "crimson-oath", seed: 9, status: "submitted", promptId: "lost-pid", sourceVariant: 1 });
  m.frames.push({ frame: 2, variant: 2, model: "crimson-oath", seed: 10, status: "pending", sourceVariant: 1 });
  await writeFile(f, JSON.stringify(m));
  // a fresh process: new runner, nothing active
  const c = (await readCollection(t.dir, "c14"))!;
  assert.equal(c.status, "done");
  const lost = c.frames.find((x) => x.frame === 1 && x.variant === 2)!;
  assert.equal(lost.status, "timeout");
  assert.equal(lost.promptId, "lost-pid");
  assert.equal(c.frames.find((x) => x.frame === 2 && x.variant === 2)!.status, "failed");
  assert.equal(c.doneFrames, 4);
  assert.equal(t.fake.submits.length, 0);
  // while it is actually being regenerated it is shown as in progress
  assert.equal((await readCollection(t.dir, "c14", "c14"))!.frames.find((x) => x.frame === 1 && x.variant === 2)!.status, "submitted");
  // a new regeneration continues the numbering
  await t.post("c14", 1, { sourceVariant: 1 });
  await t.settle();
  assert.equal((await t.get("c14")).frames.find((x: any) => x.frame === 1 && x.variant === 3).status, "done");
  assert.equal(t.fake.submits.length, 1);
});

// ---------- UI logic (store, helpers, Russian messages) against the real API ----------

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
let route: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const calls: { method: string; url: string; body?: any }[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (!route) throw new TypeError("fetch failed");
  return route(url, init);
};
const S = await import("../web/src/store.ts");
const lib = await import("../web/src/lib.ts");
const errors = await import("../web/src/errors.ts");
const until = async (cond: () => boolean) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > 5000) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function uiSetup(id: string) {
  const t = await setup();
  await t.make(id);
  route = async (url, init) => {
    const r = await t.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: H.host, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
  };
  calls.length = 0;
  S.app.status = null;
  S.app.connection = "connecting";
  S.regen.target = null;
  await S.loadCollections();
  const c = () => S.app.collections.find((x) => x.id === id)!;
  return { t, c };
}

test("UI: the editor loads the prompt of the variant being regenerated; one POST with only the changes; the new variant appears; Best stays", async () => {
  const { t, c } = await uiSetup("u1");
  await S.chooseBest(c(), 3, 1);
  await S.openRegen(c(), 3, 1);
  assert.equal(S.regen.available, true, JSON.stringify(S.regen.error));
  const original = S.regen.original;
  assert.equal(S.regen.text, original);
  assert.equal(S.regen.model, "duskrose");
  S.regen.text = original + ", rain";
  S.resetRegenText();
  assert.equal(S.regen.text, original); // "Сбросить изменения"
  S.regen.text = original + ", rain";
  let gate!: () => void;
  t.fake.gate = new Promise<void>((r) => (gate = r));
  calls.length = 0;
  assert.equal(await S.submitRegen(), true);
  const posts = calls.filter((x) => x.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { sourceVariant: 1, positive: original + ", rain" });
  assert.equal(S.regen.target, null);
  assert.equal(S.running.value, true);
  // a second launch from the UI is refused locally: no second request
  await S.openRegen(c(), 1, 1);
  assert.equal(await S.submitRegen(), false);
  assert.equal(calls.filter((x) => x.method === "POST").length, 1);
  S.closeRegen();
  // real status, not simulated progress
  await S.loadCollections();
  const slot = c().frames.find((f) => f.frame === 3 && f.variant === 2)!;
  assert.ok(lib.isRegenerating(S.run.value, c(), slot));
  assert.equal(S.run.value?.regeneration?.variant, 2);
  gate();
  await t.settle();
  await S.refreshStatus();
  await until(() => S.run.value?.status === "completed" || S.run.value?.status === "failed");
  assert.equal(S.run.value?.status, "completed", JSON.stringify(S.run.value));
  await S.loadCollections();
  assert.equal(c().frames.find((f) => f.frame === 3 && f.variant === 2)?.status, "done");
  assert.equal(c().selections["3"], 1); // Best not switched
  assert.equal(lib.variantsLine(c()), "· вариантов на кадр: 1–2");
  assert.equal(lib.scenesOf(c())[2].variants.length, 2);
  // the editor of the new variant starts from ITS prompt
  await S.openRegen(c(), 3, 2);
  assert.equal(S.regen.original, original + ", rain");
  assert.equal(S.regen.edited, true);
  S.closeRegen();
});

test("UI: unavailable source and server refusals are shown in Russian with the technical text kept", async () => {
  const { t, c } = await uiSetup("u2");
  await (await import("node:fs/promises")).rm(join(t.dir, "u2", "scene-02.json"));
  await S.openRegen(c(), 2, 1);
  assert.equal(S.regen.available, false);
  assert.equal(S.regen.error?.code, "SOURCE_UNAVAILABLE");
  assert.match(S.regen.error!.message, /нельзя перегенерировать/);
  assert.match(S.regen.error!.details!, /scene-02\.json/);
  assert.equal(await S.submitRegen(), false);
  assert.equal(calls.filter((x) => x.method === "POST").length, 0);
  // empty prompt: refused locally
  await S.openRegen(c(), 1, 1);
  S.regen.text = "   ";
  assert.equal(await S.submitRegen(), false);
  assert.equal(S.regen.error?.message, "Промпт не может быть пустым.");
  assert.equal(calls.filter((x) => x.method === "POST").length, 0);
  // the server says 409 ALREADY_RUNNING (another tab): Russian message
  S.regen.text = S.regen.original;
  const saved = route!;
  route = async (url, init) => (init?.method === "POST" ? ({ ok: false, status: 409, json: async () => ({ error: "A generation is already in progress", code: "ALREADY_RUNNING" }) } as Response) : saved(url, init));
  assert.equal(await S.submitRegen(), false);
  assert.match(S.regen.error!.message, /Генерация уже идёт/);
  route = saved;
  assert.match(errors.messageForCode("VARIANT_LIMIT"), /99/);
  S.closeRegen();
});
