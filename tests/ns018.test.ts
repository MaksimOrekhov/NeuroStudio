// NS-018: per-image like/dislike + reasons (image-feedback.json). No GPU, no Codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { io } from "../src/regenerate.ts";

const H = { host: "127.0.0.1:8787" };
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`fake-${tag}-` + "x".repeat(100))]);

type Rec = { frame: number; variant?: number; sourceVariant?: number; status?: string };
const name = (r: Rec) => (r.variant === undefined ? `scene-0${r.frame}` : `scene-0${r.frame}-v0${r.variant}`);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ns18-"));
  const runner = new AutopilotRunner({ client: {} as never, plan: (async () => ({})) as never, baseGraph: {}, collectionsDir: dir, batchesDir: dir });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787 });
  const make = async (id: string, recs: Rec[], extra: Record<string, string> = {}) => {
    await mkdir(join(dir, id), { recursive: true });
    const frames = recs.map((r) => ({ frame: r.frame, variant: r.variant, sourceVariant: r.sourceVariant, model: "duskrose", seed: 1, status: r.status ?? "done", png: (r.status ?? "done") === "done" ? `${name(r)}.png` : undefined }));
    await writeFile(join(dir, id, "collection.json"), JSON.stringify({ title: id, createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames }));
    for (const r of recs) if ((r.status ?? "done") === "done") await writeFile(join(dir, id, `${name(r)}.png`), png(name(r)));
    for (const [f, c] of Object.entries(extra)) await writeFile(join(dir, id, f), c);
  };
  const put = (id: string, frame: number | string, variant: number | string, body: unknown) =>
    app.inject({ method: "PUT", url: `/api/collections/${id}/frames/${frame}/variants/${variant}/feedback`, headers: H, payload: body as never });
  const get = async (id: string) => (await app.inject({ method: "GET", url: `/api/collections/${id}`, headers: H })).json();
  return { dir, app, make, put, get };
}
const fbFile = (t: { dir: string }, id: string) => join(t.dir, id, "image-feedback.json");

test("set, change and remove the feedback of one image; only verdict, tags and time are stored", async () => {
  const t = await setup();
  await t.make("a", [1, 2, 3, 4].map((frame) => ({ frame })));
  assert.deepEqual((await t.get("a")).imageFeedback, {}); // no file: works without migration
  const r = await t.put("a", 3, 1, { verdict: "like", tags: ["great_outfit", "beautiful_lighting"] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().feedback.verdict, "like");
  const stored = JSON.parse(await readFile(fbFile(t, "a"), "utf8"));
  assert.deepEqual(Object.keys(stored), ["version", "images"]);
  assert.deepEqual(Object.keys(stored.images["3-1"]).sort(), ["tags", "updatedAt", "verdict"]); // no prompt, graph, seed, path
  assert.deepEqual((await t.get("a")).imageFeedback["3-1"].tags, ["great_outfit", "beautiful_lighting"]);
  // change: verdict switch with tags of the new kind; tags of the other kind are refused
  assert.equal((await t.put("a", 3, 1, { verdict: "dislike", tags: ["great_outfit"] })).statusCode, 400);
  assert.equal((await t.put("a", 3, 1, { verdict: "dislike", tags: ["face", "anatomy", "face"] })).statusCode, 200);
  assert.deepEqual((await t.get("a")).imageFeedback["3-1"].tags, ["anatomy", "face"]); // unique, stable order
  // verdict without tags is fine; remove with null
  await t.put("a", 3, 1, { verdict: "dislike" });
  assert.deepEqual((await t.get("a")).imageFeedback["3-1"].tags, []);
  assert.equal((await t.put("a", 3, 1, { verdict: null })).json().feedback, null);
  assert.deepEqual((await t.get("a")).imageFeedback, {});
  assert.ok(!(await readdir(join(t.dir, "a"))).includes("image-feedback.json")); // empty feedback leaves no file
});

test("feedback is bound to the right frame and variant (incl. regenerated ones); bad targets are refused", async () => {
  const t = await setup();
  await t.make("b", [{ frame: 1, variant: 1 }, { frame: 1, variant: 2, sourceVariant: 1 }, { frame: 1, variant: 3, status: "failed" }, { frame: 2 }]);
  await t.put("b", 1, 1, { verdict: "dislike", tags: ["face"] });
  await t.put("b", 1, 2, { verdict: "like", tags: ["original_idea"] }); // regenerated variant
  await t.put("b", 2, 1, { verdict: "like" });
  const c = await t.get("b");
  assert.equal(c.imageFeedback["1-1"].verdict, "dislike");
  assert.equal(c.imageFeedback["1-2"].verdict, "like");
  assert.deepEqual(Object.keys(c.imageFeedback).sort(), ["1-1", "1-2", "2-1"]);
  assert.equal((await t.put("b", 1, 3, { verdict: "like" })).statusCode, 400); // not finished
  assert.equal((await t.put("b", 1, 9, { verdict: "like" })).statusCode, 400); // does not exist
  assert.equal((await t.put("b", 7, 1, { verdict: "like" })).statusCode, 400);
  assert.equal((await t.put("b", "x", 1, { verdict: "like" })).statusCode, 400);
  assert.equal((await t.put("b", 1, 1, { verdict: "great" })).statusCode, 400);
  assert.equal((await t.put("b", 1, 1, { verdict: "like", tags: "x" })).statusCode, 400);
  assert.equal((await t.put("nope", 1, 1, { verdict: "like" })).json().code, "COLLECTION_NOT_FOUND");
  assert.equal((await t.app.inject({ method: "GET", url: "/api/collections/b/image-feedback", headers: H })).json().images["1-2"].tags[0], "original_idea");
});

test("independent from Best, collection feedback and export; unrelated files are untouched", async () => {
  const t = await setup();
  await t.make("c", [{ frame: 1 }, { frame: 2 }], { "selections.json": JSON.stringify({ "1": 1 }), "feedback.json": JSON.stringify({ version: 1, rating: 4, tags: [], note: "", updatedAt: "x" }) });
  const before = await Promise.all(["selections.json", "feedback.json", "collection.json", "scene-01.png"].map((f) => readFile(join(t.dir, "c", f))));
  await t.put("c", 2, 1, { verdict: "like" }); // a rated image that is not Best is not exported
  await t.put("c", 1, 1, { verdict: "dislike" }); // a disliked Best stays Best
  const after = await Promise.all(["selections.json", "feedback.json", "collection.json", "scene-01.png"].map((f) => readFile(join(t.dir, "c", f))));
  assert.deepEqual(after, before);
  const c = await t.get("c");
  assert.deepEqual(c.selections, { "1": 1 });
  assert.equal(c.export.resolved, 1);
  assert.equal(c.feedback.rating, 4);
});

test("unknown single entries are ignored; a missing file is simply no feedback", async () => {
  const t = await setup();
  await t.make("d", [{ frame: 1 }]);
  assert.deepEqual((await t.get("d")).imageFeedback, {});
  assert.equal((await t.get("d")).imageFeedbackError, undefined);
  await writeFile(fbFile(t, "d"), JSON.stringify({ version: 1, images: { "1-1": { verdict: "like", tags: ["face", "great_outfit"] }, "9-9": { verdict: "like" }, "1-2": { verdict: "meh" } } }));
  assert.deepEqual((await t.get("d")).imageFeedback, { "1-1": { verdict: "like", tags: ["great_outfit"], updatedAt: "" } });
});

test("an unreadable or corrupt image-feedback.json is never overwritten: save is refused (409), the file stays byte-identical, the view says so", async () => {
  const t = await setup();
  const bad = ["{broken", "", "[]", "{}", '{"images":[]}', '{"images":null}', "null", '{"version":1,"images":{"1-1":{"verdict":"like"}}'];
  for (const [i, content] of bad.entries()) {
    const id = `x${i}`;
    await t.make(id, [{ frame: 1 }], { "image-feedback.json": content });
    const c = await t.get(id);
    assert.deepEqual(c.imageFeedback, {});
    assert.ok(c.imageFeedbackError, content);
    for (const body of [{ verdict: "like", tags: ["great_outfit"] }, { verdict: null }]) {
      const r = await t.put(id, 1, 1, body);
      assert.equal(r.statusCode, 409, content);
      assert.equal(r.json().code, "FEEDBACK_FILE_UNREADABLE");
    }
    assert.equal(await readFile(fbFile(t, id), "utf8"), content); // byte-identical
    assert.deepEqual((await readdir(join(t.dir, id))).filter((f) => f.endsWith(".tmp")), []);
  }
  // a read error other than ENOENT (here: a directory where the file should be) is also "unreadable", not "missing"
  await t.make("dir", [{ frame: 1 }]);
  await mkdir(fbFile(t, "dir"));
  assert.ok((await t.get("dir")).imageFeedbackError);
  assert.equal((await t.put("dir", 1, 1, { verdict: "like" })).statusCode, 409);
  assert.ok((await stat(fbFile(t, "dir"))).isDirectory());
  // once the user repairs the file, saving works again
  await writeFile(fbFile(t, "x0"), JSON.stringify({ version: 1, images: {} }));
  assert.equal((await t.put("x0", 1, 1, { verdict: "like" })).statusCode, 200);
});

test("removing the last rating: only ENOENT is ignored; EPERM is returned and the API never claims success while the file remains", async () => {
  const t = await setup();
  await t.make("r", [{ frame: 1 }, { frame: 2 }]);
  await t.put("r", 1, 1, { verdict: "like" });
  const before = await readFile(fbFile(t, "r"), "utf8");
  const real = io.unlink;
  io.unlink = async () => {
    throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
  };
  let res;
  try {
    res = await t.put("r", 1, 1, { verdict: null });
  } finally {
    io.unlink = real;
  }
  assert.equal(res.statusCode, 500);
  assert.match(res.json().message, /EPERM/);
  assert.equal(await readFile(fbFile(t, "r"), "utf8"), before); // still there, rating still shown
  assert.equal((await t.get("r")).imageFeedback["1-1"].verdict, "like");
  assert.equal((await t.put("r", 1, 1, { verdict: null })).statusCode, 200);
  assert.ok(!(await readdir(join(t.dir, "r"))).includes("image-feedback.json"));
  // the file vanished by itself (ENOENT): removing is still a success
  await t.put("r", 2, 1, { verdict: "like" });
  io.unlink = async () => {
    throw Object.assign(new Error("ENOENT: injected"), { code: "ENOENT" });
  };
  try {
    assert.equal((await t.put("r", 2, 1, { verdict: null })).statusCode, 200);
  } finally {
    io.unlink = real;
  }
});

test("saves are atomic and serialised: a failing rename keeps the old file; parallel saves for different images are all kept", async () => {
  const t = await setup();
  await t.make("e", [1, 2, 3, 4].map((frame) => ({ frame })));
  await Promise.all([1, 2, 3, 4].map((f) => t.put("e", f, 1, { verdict: "like" })));
  assert.deepEqual(Object.keys((await t.get("e")).imageFeedback).sort(), ["1-1", "2-1", "3-1", "4-1"]);
  const before = await readFile(fbFile(t, "e"), "utf8");
  const real = io.rename;
  io.rename = async () => {
    throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
  };
  let res;
  try {
    res = await t.put("e", 1, 1, { verdict: "dislike" });
  } finally {
    io.rename = real;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(await readFile(fbFile(t, "e"), "utf8"), before);
  assert.ok(!(await readdir(join(t.dir, "e"))).some((f) => f.endsWith(".tmp")));
  assert.equal((await t.put("e", 1, 1, { verdict: "dislike" })).statusCode, 200); // recovers
});

// ---------- UI store ----------

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
let route: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new TypeError("fetch failed");
};
const posts: unknown[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  if (init?.method === "PUT") posts.push(JSON.parse(String(init.body)));
  return route(url, init);
};
const S = await import("../web/src/store.ts");

test("UI store: like, tags, switching and clearing go through the API in click order and show the server's answer", async () => {
  const t = await setup();
  await t.make("u", [{ frame: 1 }, { frame: 1, variant: 2, sourceVariant: 1 }]);
  route = async (url, init) => {
    const r = await t.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: H.host, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
  };
  await S.loadCollections();
  const c = () => S.app.collections.find((x) => x.id === "u")!;
  const k = "1-2";
  const p = [S.toggleVerdict(c(), 1, 2, "dislike"), S.toggleImageTag(c(), 1, 2, "face")]; // queued without waiting
  await Promise.all(p);
  assert.deepEqual(c().imageFeedback[k].tags, ["face"]); // queued clicks build on the previous answer
  await Promise.all([S.toggleImageTag(c(), 1, 2, "anatomy"), S.toggleImageTag(c(), 1, 2, "outfit"), S.toggleImageTag(c(), 1, 2, "outfit")]); // quick consecutive clicks
  assert.deepEqual(c().imageFeedback[k].tags, ["anatomy", "face"]);
  assert.deepEqual(c().imageFeedback[k].tags, ["anatomy", "face"]);
  await S.toggleVerdict(c(), 1, 2, "like"); // switching verdict drops the other kind of tags
  assert.deepEqual(c().imageFeedback[k], { ...c().imageFeedback[k], verdict: "like", tags: [] });
  assert.equal(c().imageFeedback["1-1"], undefined); // another variant is untouched
  await S.toggleVerdict(c(), 1, 2, "like"); // same verdict again clears
  assert.equal(c().imageFeedback[k], undefined);
  assert.equal(c().selections["1"], undefined); // Best untouched
  // server error: nothing changes, a Russian message is kept
  const saved = route;
  route = async (url, init) => (init?.method === "PUT" ? ({ ok: false, status: 404, json: async () => ({ error: "collection not found", code: "COLLECTION_NOT_FOUND" }) } as Response) : saved(url, init));
  await S.toggleVerdict(c(), 1, 1, "like");
  assert.equal(c().imageFeedback["1-1"], undefined);
  assert.match(S.imageFbError["u"], /Коллекция не найдена/);
});
