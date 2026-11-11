// NS-019: Image Arena (pairwise comparisons of variants of one frame). No GPU, no Codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { io } from "../src/regenerate.ts";
import { donePairs, openPairs, pairKey, pairsOf, statsOf, variantsOfFrame } from "../web/src/arena.ts";

const H = { host: "127.0.0.1:8787" };
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`fake-${tag}-` + "x".repeat(100))]);

type Rec = { frame: number; variant?: number; sourceVariant?: number; status?: string };
const name = (r: Rec) => (r.variant === undefined ? `scene-0${r.frame}` : `scene-0${r.frame}-v0${r.variant}`);
/** Frame 3 with `n` finished variants (v2.. are regenerated ones), plus frame 1 with one image. */
const frame3 = (n: number): Rec[] => [{ frame: 1 }, ...Array.from({ length: n }, (_, i) => ({ frame: 3, variant: i + 1, sourceVariant: i ? 1 : undefined }))];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ns19-"));
  const runner = new AutopilotRunner({ client: {} as never, plan: (async () => ({})) as never, baseGraph: {}, collectionsDir: dir, batchesDir: dir });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787 });
  const make = async (id: string, recs: Rec[], extra: Record<string, string> = {}) => {
    await mkdir(join(dir, id), { recursive: true });
    const frames = recs.map((r) => ({ frame: r.frame, variant: r.variant, sourceVariant: r.sourceVariant, model: "duskrose", seed: 1, status: r.status ?? "done", png: (r.status ?? "done") === "done" ? `${name(r)}.png` : undefined }));
    await writeFile(join(dir, id, "collection.json"), JSON.stringify({ title: id, createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames }));
    for (const r of recs) if ((r.status ?? "done") === "done") await writeFile(join(dir, id, `${name(r)}.png`), png(name(r)));
    for (const [f, c] of Object.entries(extra)) await writeFile(join(dir, id, f), c);
  };
  const put = (id: string, frame: number | string, body: unknown) => app.inject({ method: "PUT", url: `/api/collections/${id}/frames/${frame}/comparisons`, headers: H, payload: body as never });
  const get = (id: string) => app.inject({ method: "GET", url: `/api/collections/${id}/comparisons`, headers: H });
  return { dir, app, make, put, get };
}
const file = (t: { dir: string }, id: string) => join(t.dir, id, "comparisons.json");

// ---------- pairs and statistics (pure) ----------

test("pairs: 2 variants give 1 pair, 3 give 3, 4 give 6; each unordered pair once", () => {
  assert.deepEqual(pairsOf([1, 2]), [[1, 2]]);
  assert.deepEqual(pairsOf([1, 2, 3]), [[1, 2], [1, 3], [2, 3]]);
  assert.equal(pairsOf([1, 2, 3, 4]).length, 6);
  assert.deepEqual(pairsOf([5]), []);
  const c = { frames: [{ frame: 3, variant: 2, image: "a" }, { frame: 3, variant: 1, image: "b" }, { frame: 3, variant: 3 }, { frame: 1, variant: 1, image: "c" }] } as never;
  assert.deepEqual(variantsOfFrame(c, 3), [1, 2]); // only finished images of this frame, ascending
});

test("open pairs: saved verdicts are not offered again, a new variant adds only its own pairs, a skipped pair stays open", () => {
  const h = { [pairKey(3, 1, 2)]: { frame: 3, variantA: 1, variantB: 2, winnerVariant: 2, updatedAt: "x" } };
  assert.deepEqual(openPairs([1, 2, 3], 3, h), [[1, 3], [2, 3]]);
  assert.deepEqual(openPairs([1, 2, 3, 4], 3, h), [[1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]);
  assert.deepEqual(openPairs([1, 2], 3, {}), [[1, 2]]); // nothing saved (skip): still open
  assert.deepEqual(openPairs([1, 2], 1, h), [[1, 2]]); // the same variants of another frame are another pair
  assert.equal(pairKey(3, 2, 1), pairKey(3, 1, 2));
});

test("statistics: wins, losses, ties and completed comparisons from the saved verdicts only", () => {
  const e = (a: number, b: number, w: number | null) => [pairKey(3, a, b), { frame: 3, variantA: a, variantB: b, winnerVariant: w, updatedAt: "x" }] as const;
  const h = Object.fromEntries([e(1, 2, 2), e(1, 3, 3), e(2, 3, null)]);
  assert.deepEqual(statsOf([1, 2, 3], 3, h), [
    { variant: 1, wins: 0, losses: 2, ties: 0, total: 2 },
    { variant: 2, wins: 1, losses: 0, ties: 1, total: 2 },
    { variant: 3, wins: 1, losses: 0, ties: 1, total: 2 },
  ]);
  assert.equal(donePairs([1, 2, 3, 4], 3, h).length, 3);
  assert.deepEqual(statsOf([1, 2], 3, {}).map((r) => r.total), [0, 0]);
});

// ---------- API ----------

test("a verdict is saved by variant number: left/right/equal, A<B, server time, only the verdict is stored", async () => {
  const t = await setup();
  await t.make("a", frame3(3));
  assert.deepEqual((await t.get("a")).json().comparisons, {}); // no file: empty history, no migration
  const r = await t.put("a", 3, { variantA: 1, variantB: 3, winnerVariant: 3 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().comparison.winnerVariant, 3);
  // sides do not matter: given as (3, 2) with winner 2 -> stored as 2-3, winner 2
  await t.put("a", 3, { variantA: 3, variantB: 2, winnerVariant: 2 });
  await t.put("a", 3, { variantA: 1, variantB: 2, winnerVariant: null, updatedAt: "1999-01-01" }); // equal; client time is ignored
  const stored = JSON.parse(await readFile(file(t, "a"), "utf8"));
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.comparisons).sort(), ["3:1-2", "3:1-3", "3:2-3"]);
  assert.deepEqual(Object.keys(stored.comparisons["3:1-2"]).sort(), ["frame", "updatedAt", "variantA", "variantB", "winnerVariant"]);
  assert.equal(stored.comparisons["3:1-2"].winnerVariant, null);
  assert.equal(stored.comparisons["3:2-3"].variantA, 2);
  assert.equal(stored.comparisons["3:2-3"].winnerVariant, 2);
  assert.notEqual(stored.comparisons["3:1-2"].updatedAt, "1999-01-01");
  assert.deepEqual((await t.get("a")).json().comparisons, stored.comparisons);
});

test("a new verdict for the same pair replaces the old one (no second vote)", async () => {
  const t = await setup();
  await t.make("b", frame3(2));
  await t.put("b", 3, { variantA: 1, variantB: 2, winnerVariant: 1 });
  await t.put("b", 3, { variantA: 2, variantB: 1, winnerVariant: 2 });
  const c = (await t.get("b")).json().comparisons;
  assert.equal(Object.keys(c).length, 1);
  assert.equal(c["3:1-2"].winnerVariant, 2);
});

test("a skipped pair writes nothing: no request, no file", async () => {
  const t = await setup();
  await t.make("s", frame3(2));
  assert.ok(await stat(file(t, "s")).then(() => false, () => true));
});

test("invalid verdicts are refused: itself, other frame, unfinished or unknown variant, foreign winner, bad frame or collection", async () => {
  const t = await setup();
  await t.make("v", [...frame3(2), { frame: 3, variant: 3, status: "failed" }, { frame: 2 }]);
  const bad: [number | string, unknown][] = [
    [3, { variantA: 1, variantB: 1, winnerVariant: 1 }], // itself
    [3, { variantA: 1, variantB: 3, winnerVariant: 1 }], // v3 is not finished
    [3, { variantA: 1, variantB: 9, winnerVariant: 1 }], // unknown
    [3, { variantA: 1, variantB: 2, winnerVariant: 3 }], // winner not in the pair
    [3, { variantA: 1, variantB: 2 }], // winner missing
    [3, { variantA: 1, variantB: 2, winnerVariant: "1" }],
    [3, { variantA: 0, variantB: 2, winnerVariant: 2 }],
    [3, { variantA: 1.5, variantB: 2, winnerVariant: 2 }],
    [1, { variantA: 1, variantB: 2, winnerVariant: 1 }], // frame 1 has one variant: "another frame" cannot be mixed in
    [2, { variantA: 1, variantB: 2, winnerVariant: 1 }],
    [7, { variantA: 1, variantB: 2, winnerVariant: 1 }],
    ["x", { variantA: 1, variantB: 2, winnerVariant: 1 }],
  ];
  for (const [frame, body] of bad) {
    const r = await t.put("v", frame, body);
    assert.equal(r.statusCode, 400, JSON.stringify([frame, body]));
    assert.equal(r.json().code, "INVALID_REQUEST");
  }
  assert.ok(await stat(file(t, "v")).then(() => false, () => true)); // nothing was written
  assert.equal((await t.put("nope", 3, { variantA: 1, variantB: 2, winnerVariant: 1 })).json().code, "COLLECTION_NOT_FOUND");
  assert.equal((await t.get("nope")).statusCode, 404);
});

test("an unreadable or invalid comparisons.json is never overwritten: GET and PUT answer 409, the file stays byte-identical", async () => {
  const t = await setup();
  const ok = { frame: 3, variantA: 1, variantB: 2, winnerVariant: 1, updatedAt: "x" };
  const bad = [
    "{broken",
    "",
    "[]",
    "null",
    JSON.stringify({ version: 2, comparisons: {} }), // unknown version
    JSON.stringify({ comparisons: {} }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, comparisons: [] }),
    JSON.stringify({ version: 1, comparisons: { "3:1-2": { ...ok, variantA: 2, variantB: 1 } } }), // A must be smaller
    JSON.stringify({ version: 1, comparisons: { "3:1-2": { ...ok, winnerVariant: 5 } } }),
    JSON.stringify({ version: 1, comparisons: { "3:1-3": ok } }), // key does not match the entry
    JSON.stringify({ version: 1, comparisons: { "3:1-2": { ...ok, updatedAt: 5 } } }),
  ];
  for (const [i, content] of bad.entries()) {
    const id = `x${i}`;
    await t.make(id, frame3(2), { "comparisons.json": content });
    const g = await t.get(id);
    assert.equal(g.statusCode, 409, content);
    assert.equal(g.json().code, "COMPARISON_FILE_UNREADABLE");
    const p = await t.put(id, 3, { variantA: 1, variantB: 2, winnerVariant: 2 });
    assert.equal(p.statusCode, 409, content);
    assert.equal(p.json().code, "COMPARISON_FILE_UNREADABLE");
    assert.equal(await readFile(file(t, id), "utf8"), content);
    assert.deepEqual((await readdir(join(t.dir, id))).filter((f) => f.endsWith(".tmp")), []);
  }
  // a read error that is not ENOENT (a directory in place of the file)
  await t.make("dir", frame3(2));
  await mkdir(file(t, "dir"));
  assert.equal((await t.put("dir", 3, { variantA: 1, variantB: 2, winnerVariant: 1 })).statusCode, 409);
  assert.ok((await stat(file(t, "dir"))).isDirectory());
  // the collection itself still opens
  assert.equal((await t.app.inject({ method: "GET", url: "/api/collections/x0", headers: H })).statusCode, 200);
});

test("a failing write is not a saved verdict: the old file stays, no temp file; parallel saves are all kept", async () => {
  const t = await setup();
  await t.make("f", frame3(4));
  await Promise.all(pairsOf([1, 2, 3, 4]).map(([a, b]) => t.put("f", 3, { variantA: a, variantB: b, winnerVariant: b })));
  assert.equal(Object.keys((await t.get("f")).json().comparisons).length, 6); // serialised read-modify-write: none lost
  const before = await readFile(file(t, "f"), "utf8");
  const real = io.rename;
  io.rename = async () => {
    throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
  };
  let res;
  try {
    res = await t.put("f", 3, { variantA: 1, variantB: 2, winnerVariant: 1 });
  } finally {
    io.rename = real;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(await readFile(file(t, "f"), "utf8"), before);
  assert.ok(!(await readdir(join(t.dir, "f"))).some((n) => n.endsWith(".tmp")));
  assert.equal((await t.put("f", 3, { variantA: 1, variantB: 2, winnerVariant: 1 })).statusCode, 200);
});

test("independent of Best, image feedback, collection feedback, collection.json and the ZIP; regenerated variants are comparable", async () => {
  const t = await setup();
  await t.make("i", frame3(3), {
    "selections.json": JSON.stringify({ "3": 1 }),
    "feedback.json": JSON.stringify({ version: 1, rating: 4, tags: [], note: "", updatedAt: "x" }),
    "image-feedback.json": JSON.stringify({ version: 1, images: { "3-2": { verdict: "like", tags: [], updatedAt: "x" } } }),
  });
  const files = ["selections.json", "feedback.json", "image-feedback.json", "collection.json", "scene-03-v01.png", "scene-03-v02.png", "scene-03-v03.png"];
  const before = await Promise.all(files.map((f) => readFile(join(t.dir, "i", f))));
  const zipBefore = (await t.app.inject({ method: "GET", url: "/api/collections/i/export", headers: H })).rawPayload;
  assert.equal((await t.put("i", 3, { variantA: 1, variantB: 3, winnerVariant: 3 })).statusCode, 200); // v03 is a regenerated variant, the Best v01 loses
  assert.equal((await t.put("i", 3, { variantA: 2, variantB: 3, winnerVariant: 3 })).statusCode, 200);
  const after = await Promise.all(files.map((f) => readFile(join(t.dir, "i", f))));
  assert.deepEqual(after, before);
  const c = (await t.app.inject({ method: "GET", url: "/api/collections/i", headers: H })).json();
  assert.deepEqual(c.selections, { "3": 1 }); // Best did not move
  assert.deepEqual((await t.app.inject({ method: "GET", url: "/api/collections/i/export", headers: H })).rawPayload, zipBefore);
});

// ---------- UI store ----------

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
let route: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new TypeError("fetch failed");
};
(globalThis as any).fetch = async (url: string, init?: RequestInit) => route(url, init);
const S = await import("../web/src/store.ts");

test("UI store: history loads, a verdict appears only after the server confirms, reopening does not offer saved pairs, a new variant adds pairs", async () => {
  const t = await setup();
  await t.make("u", frame3(2));
  route = async (url, init) => {
    const r = await t.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: H.host, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
  };
  await S.loadArena("u");
  assert.deepEqual(openPairs([1, 2], 3, S.arena.history), [[1, 2]]);
  assert.equal(await S.submitComparison("u", 3, 2, 1, 1), true); // shown on the right, v1 wins: stored by number
  assert.equal(S.arena.history[pairKey(3, 1, 2)].winnerVariant, 1);
  await S.loadArena("u"); // "reopen"
  assert.deepEqual(openPairs([1, 2], 3, S.arena.history), []);
  assert.deepEqual(openPairs([1, 2, 3], 3, S.arena.history), [[1, 3], [2, 3]]); // a new variant: only its pairs
  assert.equal(await S.submitComparison("u", 3, 1, 2, null), true); // change of mind replaces
  assert.equal(Object.keys(S.arena.history).length, 1);
  assert.equal(S.arena.history[pairKey(3, 1, 2)].winnerVariant, null);
  // refusal: nothing changes, Russian message
  const saved = route;
  route = async (url, init) => (init?.method === "PUT" ? ({ ok: false, status: 409, json: async () => ({ error: "comparisons.json cannot be used: x", code: "COMPARISON_FILE_UNREADABLE" }) } as Response) : saved(url, init));
  assert.equal(await S.submitComparison("u", 3, 1, 2, 1), false);
  assert.equal(S.arena.history[pairKey(3, 1, 2)].winnerVariant, null);
  assert.match(S.arena.error!.message, /История сравнений недоступна/);
  assert.match(S.arena.error!.details!, /comparisons\.json/);
});

// ---------- Arena screen logic: locking while saving, retry, stale sessions (review of PR #21) ----------

const { createArenaFlow } = await import("../web/src/arenaFlow.ts");

/** A fake fetch over the real API. A "hold" delays ONE matching request until released; `snapshot` answers with the data the server had when the request was sent. */
async function arenaEnv(ids: string[] = ["A"]) {
  const t = await setup();
  for (const id of ids) await t.make(id, frame3(3));
  const puts: string[] = [];
  type Hold = { match: (url: string, init?: RequestInit) => boolean; gate: Promise<void>; fail?: { status: number; body: unknown }; snapshot?: boolean };
  const holds: Hold[] = [];
  route = async (url, init) => {
    if (init?.method === "PUT") puts.push(url);
    const i = holds.findIndex((x) => x.match(url, init));
    const h = i >= 0 ? holds.splice(i, 1)[0] : undefined; // one-shot
    const send = async () => {
      const r = await t.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: H.host, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
      return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
    };
    if (!h) return send();
    const early = h.snapshot ? await send() : null;
    await h.gate;
    if (h.fail) return { ok: false, status: h.fail.status, json: async () => h.fail!.body } as Response;
    return early ?? send();
  };
  const hold = (match: Hold["match"], extra: Pick<Hold, "fail" | "snapshot"> = {}) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    holds.push({ match, gate, ...extra });
    return release;
  };
  const flowFor = (id: string) => createArenaFlow({ id, frame: 3, variants: () => [1, 2, 3] });
  const isPut = (id: string) => (url: string, init?: RequestInit) => init?.method === "PUT" && url.includes(`/collections/${id}/`);
  const isGet = (id: string) => (url: string, init?: RequestInit) => !init?.method && url.endsWith(`/collections/${id}/comparisons`);
  return { t, puts, hold, flowFor, isPut, isGet };
}
const tick = () => new Promise((r) => setTimeout(r, 15));

test("Arena: while a verdict is being saved, S does not skip, a second confirmation sends nothing, and another pair cannot be reopened", async () => {
  const env = await arenaEnv();
  const f = env.flowFor("A");
  await f.start();
  const first = f.current.value!;
  const release = env.hold(env.isPut("A"));
  const saving = f.choose(first[0]); // the verdict is in flight
  assert.equal(S.arena.saving, true); // locked synchronously, before anything is awaited
  f.onKey("s", "KeyS"); // S must not skip the next pair
  f.onKey("ArrowLeft", "ArrowLeft");
  f.onKey("ArrowRight", "ArrowRight");
  f.onKey("ArrowDown", "ArrowDown");
  assert.equal(f.skipped.size, 0);
  assert.equal(f.current.value, first);
  assert.equal(await f.choose(first[1]), false); // quick second confirmation of the same pair
  f.skip();
  f.reopen(2, 3); // reviewing another pair is blocked as well
  f.retrySkipped();
  assert.equal(f.editing.value, false);
  assert.equal(f.current.value, first);
  await tick();
  assert.equal(env.puts.length, 1); // exactly one request
  release();
  assert.equal(await saving, true);
  assert.notEqual(f.current.value, first); // moved on to the next open pair
  assert.equal(S.arena.saving, false);
  assert.equal(env.puts.length, 1);
  // unlocked again: the same actions work now
  f.skip();
  assert.equal(f.skipped.size, 1);
  f.reopen(1, 2);
  assert.equal(f.editing.value, true);
  f.dispose();
});

test("Arena: a failed save keeps the pair on screen, shows the error, and the same action can be repeated", async () => {
  const env = await arenaEnv();
  const f = env.flowFor("A");
  await f.start();
  const p = f.current.value!;
  const release = env.hold(env.isPut("A"), { fail: { status: 409, body: { error: "comparisons.json cannot be used: x", code: "COMPARISON_FILE_UNREADABLE" } } });
  const r = f.choose(p[1]);
  release();
  assert.equal(await r, false);
  assert.equal(f.current.value, p); // still on screen
  assert.match(S.arena.error!.message, /История сравнений недоступна/);
  assert.equal(S.arena.saving, false); // unlocked, so the user can repeat
  assert.deepEqual(S.arena.history, {}); // nothing is shown as saved
  assert.equal(await f.choose(p[1]), true); // the repeat (no hold any more) works and moves on
  assert.notEqual(f.current.value, p);
  assert.equal(S.arena.error, null);
  f.dispose();
});

test("Arena: a late error from collection A is not shown in collection B and does not release B's save lock", async () => {
  const env = await arenaEnv(["A", "B"]);
  const a = env.flowFor("A");
  await a.start();
  const releaseA = env.hold(env.isPut("A"), { fail: { status: 500, body: { error: "late A failure" } } });
  const sa = a.choose(a.current.value![0]); // in flight for A
  a.dispose(); // the user closes A and opens B
  const b = env.flowFor("B");
  await b.start();
  assert.equal(S.arena.error, null);
  assert.equal(S.arena.loadedFor, "B");
  const releaseB = env.hold(env.isPut("B"));
  const sb = b.choose(b.current.value![0]); // B saves
  assert.equal(S.arena.saving, true);
  releaseA(); // A's failure arrives late
  assert.equal(await sa, false);
  await tick();
  assert.equal(S.arena.error, null); // not shown in B
  assert.equal(S.arena.saving, true); // B's operation still holds its lock
  releaseB();
  assert.equal(await sb, true);
  assert.equal(S.arena.saving, false);
  assert.equal(Object.keys(S.arena.history).length, 1);
  b.dispose();
});

test("Arena: a late successful answer of A does not write into B's history", async () => {
  const env = await arenaEnv(["A", "B"]);
  const a = env.flowFor("A");
  await a.start();
  const releaseA = env.hold(env.isPut("A"));
  const sa = a.choose(a.current.value![0]);
  a.dispose();
  const b = env.flowFor("B");
  await b.start();
  releaseA();
  assert.equal(await sa, false); // the session is gone: not reported as saved here
  assert.deepEqual(S.arena.history, {});
  assert.equal(S.arena.loadedFor, "B");
  b.dispose();
});

test("Arena: closing and reopening quickly does not bring back stale state", async () => {
  const env = await arenaEnv(["A"]);
  // the first open's history request is sent with the then-empty history and answered late
  const release = env.hold(env.isGet("A"), { snapshot: true });
  const f1 = env.flowFor("A");
  const s1 = f1.start();
  await tick();
  f1.dispose(); // closed at once
  await env.t.put("A", 3, { variantA: 1, variantB: 2, winnerVariant: 2 }); // a verdict exists by the time of the second open
  const f2 = env.flowFor("A");
  await f2.start();
  assert.equal(Object.keys(S.arena.history).length, 1);
  const shown = f2.current.value;
  release(); // the stale empty answer of the first session arrives now
  await s1;
  await tick();
  assert.equal(Object.keys(S.arena.history).length, 1); // not replaced by the stale empty history
  assert.equal(S.arena.loadedFor, "A");
  assert.equal(S.arena.loading, false);
  assert.equal(S.arena.error, null);
  assert.equal(f2.current.value, shown);
  assert.ok(!f2.open.value.some(([a, b]) => a === 1 && b === 2)); // the saved pair is still not offered
  // closing clears everything: nothing of the old Arena is left for the next one
  f2.dispose();
  assert.deepEqual(S.arena.history, {});
  assert.equal(S.arena.loadedFor, null);
});
