import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deferred, H, reliabilityEnv, until } from "./fixtures/reliability.ts";
import type { Collection } from "../web/src/api.ts";

let route: (url: string, init?: RequestInit) => Promise<Response>;
(globalThis as any).fetch = (url: string, init?: RequestInit) => route(url, init);
const S = await import("../web/src/store.ts");

async function uiEnv(t: TestContext) {
  const e = await reliabilityEnv(t);
  S.stopPolling();
  Object.assign(S.ui, { view: "library", openCollection: null });
  Object.assign(S.app, { collections: [], extra: null, status: null, collectionsError: null });
  const calls: string[] = [];
  let hold: { url: string; captured: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | null = null;
  route = async (url, init) => {
    calls.push(url);
    const pending = hold?.url === url ? hold : null;
    if (pending) hold = null;
    const r = await e.app.inject({ method: (init?.method ?? "GET") as any, url, headers: { ...H, ...(init?.headers as Record<string, string>) }, payload: init?.body as any });
    // Capture the server response BEFORE the later mutation, then deliver it under the test's control.
    const body = r.json();
    if (pending) { pending.captured.resolve(); await pending.release.promise; }
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => body } as Response;
  };
  const pause = (url: string) => {
    const p = { url, captured: deferred(), release: deferred() };
    hold = p;
    return p;
  };
  const current = (id: string) => (S.app.collections.find((c) => c.id === id) ?? (S.app.extra?.id === id ? S.app.extra : undefined))!;
  t.after(() => { S.stopPolling(); Object.assign(S.ui, { view: "create", openCollection: null }); });
  return { ...e, pause, calls, current };
}

for (const signal of ["Best", "Image Feedback", "collection feedback"]) {
  test(`NS-021 UI: late GET cannot roll back confirmed ${signal}; a fresh GET accepts another tab's changes`, async (t) => {
    const e = await uiEnv(t);
    await e.make("rated");
    await S.loadCollections();
    const p = e.pause("/api/collections?limit=50");
    const pending = S.loadCollections();
    await p.captured.promise;
    if (signal === "Best") await S.chooseBest(e.current("rated"), 1, 1);
    else if (signal === "Image Feedback") await S.toggleVerdict(e.current("rated"), 1, 1, "like");
    else { S.draftOf(e.current("rated")).rating = 4; await S.persistFeedback(e.current("rated")); }
    p.release.resolve();
    await pending;
    if (signal === "Best") {
      assert.equal(e.current("rated").selections["1"], 1);
      assert.equal(e.current("rated").export.ready, true);
      await e.put("/api/collections/rated/selection", { frame: 1, variant: 2 });
    } else if (signal === "Image Feedback") {
      assert.equal(e.current("rated").imageFeedback["1-1"].verdict, "like");
      await e.put("/api/collections/rated/frames/1/variants/1/feedback", { verdict: "dislike", tags: ["face"] });
    } else {
      assert.equal(e.current("rated").feedback?.rating, 4);
      await e.put("/api/collections/rated/feedback", { rating: 2 });
    }
    await S.loadCollections();
    if (signal === "Best") assert.equal(e.current("rated").selections["1"], 2);
    else if (signal === "Image Feedback") assert.deepEqual(e.current("rated").imageFeedback["1-1"].tags, ["face"]);
    else assert.equal(e.current("rated").feedback?.rating, 2);
  });
}

test("NS-021 UI: opening an old collection and regeneration polling refresh only its detail outside the latest 50", async (t) => {
  const e = await uiEnv(t);
  await e.make("old", "2000-01-01T00:00:00Z");
  for (let n = 0; n < 50; n++) {
    const dir = join(e.collectionsDir, `new-${n}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "collection.json"), JSON.stringify({ title: `New ${n}`, createdAt: "2026-01-01T00:00:00Z", status: "done", frames: [], frameCount: 1 }));
  }
  S.ui.openCollection = "old";
  await S.ensureCollection("old");
  await S.loadCollections();
  assert.equal(S.app.collections.length, 50);
  assert.ok(!S.app.collections.some((c) => c.id === "old"));
  assert.equal(S.currentCollection.value?.id, "old");
  const gate = deferred();
  e.fake.gate = gate.promise;
  try {
    await S.openRegen(e.current("old"), 1, 1);
    assert.equal(await S.submitRegen(), true);
    await S.loadCollections();
    assert.equal(e.current("old").frames.find((f) => f.frame === 1 && f.variant === 3)?.image, undefined);
  } finally { gate.resolve(); }
  await e.settle();
  await S.refreshStatus();
  await S.loadCollections();
  const slot = e.current("old").frames.find((f) => f.frame === 1 && f.variant === 3)!;
  assert.equal(slot.status, "done");
  assert.equal(slot.image, "scene-01-v03.png");
  assert.ok(e.calls.includes("/api/collections/old"));
  assert.ok(!e.calls.some((url) => /^\/api\/collections\/new-/.test(url)), "other old/listed collections need no detail fetch");

  // An idle poll must also pick up an external tab's Best change, including in app.extra.
  await e.put("/api/collections/old/selection", { frame: 1, variant: 3 });
  await S.refreshStatus();
  await until(() => e.current("old").selections["1"] === 3);
  assert.equal(e.current("old").selections["1"], 3);
});

test("NS-021 UI: stale detail responses also preserve confirmed Best on app.extra", async (t) => {
  const e = await uiEnv(t);
  await e.make("extra");
  S.ui.openCollection = "extra";
  await S.ensureCollection("extra");
  const p = e.pause("/api/collections/extra");
  const pending = S.ensureCollection("extra", true);
  await p.captured.promise;
  await S.chooseBest(e.current("extra"), 1, 2);
  p.release.resolve();
  await pending;
  assert.equal(S.app.extra!.selections["1"], 2);
  await e.put("/api/collections/extra/selection", { frame: 1, variant: 1 });
  await S.ensureCollection("extra", true);
  assert.equal(S.app.extra!.selections["1"], 1);
});

test("NS-021 UI: switching and closing details invalidate delayed responses, including reopening the same id", async (t) => {
  const e = await uiEnv(t);
  await e.make("A"); await e.make("B");
  S.ui.openCollection = "A";
  const p = e.pause("/api/collections/A");
  const pending = S.ensureCollection("A", true);
  await p.captured.promise;
  S.go("library", "B", false);
  await S.loadCollections();
  await S.ensureCollection("B", true);
  p.release.resolve();
  await pending;
  assert.equal(S.app.extra?.id, "B");
  assert.equal(S.currentCollection.value?.id, "B");

  const q = e.pause("/api/collections/B");
  const closed = S.ensureCollection("B", true);
  await q.captured.promise;
  S.go("create", null, false);
  S.app.extra = null;
  q.release.resolve();
  await closed;
  assert.equal(S.app.extra, null);
  assert.equal(S.ui.openCollection, null);
  const detailCalls = e.calls.filter((url) => /\/api\/collections\/[AB]$/.test(url)).length;
  await S.loadCollections();
  assert.equal(e.calls.filter((url) => /\/api\/collections\/[AB]$/.test(url)).length, detailCalls, "closed collections are not refreshed");

  S.go("library", "A", false);
  await S.loadCollections();
  const r = e.pause("/api/collections/A");
  const oldOpen = S.ensureCollection("A", true);
  await r.captured.promise;
  S.go("create", null, false);
  S.go("library", "A", false);
  await S.loadCollections();
  // Same id, new opening: even a visibly distinguishable old response must be ignored.
  S.app.extra = { ...e.current("A"), title: "current session" } as Collection;
  r.release.resolve();
  await oldOpen;
  assert.equal(S.app.extra.title, "current session");
});
