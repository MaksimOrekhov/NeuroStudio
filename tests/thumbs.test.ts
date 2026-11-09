import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { getThumbnail } from "../server/thumbs.ts";

const H = { host: "127.0.0.1:8787" };

async function png(w: number, h: number, color: string) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "ns-th-"));
  const dir = join(base, "collections");
  const thumbsDir = join(base, "thumbs");
  await mkdir(join(dir, "c1"), { recursive: true });
  const big = await png(1440, 2176, "#336699");
  await writeFile(join(dir, "c1", "scene-01.png"), big);
  await writeFile(join(dir, "c1", "collection.json"), JSON.stringify({ title: "T", createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames: [{ frame: 1, model: "duskrose", seed: 1, status: "done", png: "scene-01.png" }] }));
  const runner = new AutopilotRunner({ client: {} as never, plan: (async () => ({})) as never, baseGraph: {}, collectionsDir: dir, batchesDir: base });
  const app = buildApp({ runner, collectionsDir: dir, thumbsDir, comfyUrl: "http://x", port: 8787 });
  return { base, dir, thumbsDir, app, big };
}

test("thumbnail: WebP, max 512 px wide, proportions kept, original PNG untouched", async () => {
  const { dir, thumbsDir, big } = await setup();
  const src = join(dir, "c1", "scene-01.png");
  const out = await getThumbnail(thumbsDir, "c1", src);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 512);
  assert.equal(meta.height, Math.round((2176 * 512) / 1440));
  assert.deepEqual(await readFile(src), big); // original byte-identical
  // small images are not enlarged
  const small = join(dir, "c1", "scene-02.png");
  await writeFile(small, await png(200, 300, "#aa5500"));
  const m2 = await sharp(await getThumbnail(thumbsDir, "c1", small)).metadata();
  assert.deepEqual([m2.width, m2.height], [200, 300]);
});

test("cache is reused, rebuilt when the PNG changes, and concurrent requests share one conversion", async () => {
  const { dir, thumbsDir } = await setup();
  const src = join(dir, "c1", "scene-01.png");
  const [a, b] = await Promise.all([getThumbnail(thumbsDir, "c1", src), getThumbnail(thumbsDir, "c1", src)]);
  assert.equal(a, b);
  const first = await stat(a);
  await new Promise((r) => setTimeout(r, 30));
  await getThumbnail(thumbsDir, "c1", src); // cache hit: file not rewritten
  assert.equal((await stat(a)).ctimeMs, first.ctimeMs);
  // source replaced by a different, newer image -> thumbnail rebuilt
  await writeFile(src, await png(800, 800, "#ff0000"));
  const later = new Date(Date.now() + 5000);
  await utimes(src, later, later);
  const rebuilt = await sharp(await getThumbnail(thumbsDir, "c1", src)).metadata();
  assert.deepEqual([rebuilt.width, rebuilt.height], [512, 512]);
});

test("endpoint: serves WebP for valid names, original PNG stays reachable, bad paths and hosts rejected", async () => {
  const { app, big, thumbsDir } = await setup();
  const th = await app.inject({ method: "GET", url: "/api/collections/c1/thumbs/scene-01.png", headers: H });
  assert.equal(th.statusCode, 200);
  assert.equal(th.headers["content-type"], "image/webp");
  assert.ok(th.rawPayload.length < big.length / 10);
  const full = await app.inject({ method: "GET", url: "/api/collections/c1/images/scene-01.png", headers: H });
  assert.deepEqual(full.rawPayload, big); // full-size viewer / ZIP source unchanged
  for (const url of ["/api/collections/c1/thumbs/collection.json", "/api/collections/c1/thumbs/..%2Fscene-01.png", "/api/collections/..%2F/thumbs/scene-01.png", "/api/collections/c1/thumbs/scene-09.png"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: H })).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/c1/thumbs/scene-01.png", headers: { host: "evil.example" } })).statusCode, 403);
  assert.ok(thumbsDir);
});

test("thumbnail failure falls back to the untouched original", async () => {
  const { app, dir } = await setup();
  const bad = Buffer.from("this is not a png");
  await writeFile(join(dir, "c1", "scene-03.png"), bad);
  const res = await app.inject({ method: "GET", url: "/api/collections/c1/thumbs/scene-03.png", headers: H });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-thumbnail"], "fallback");
  assert.deepEqual(res.rawPayload, bad);
  assert.deepEqual(await readFile(join(dir, "c1", "scene-03.png")), bad);
});
