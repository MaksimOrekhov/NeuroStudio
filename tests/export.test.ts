import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";

const H = { host: "127.0.0.1:8787" };

// Tiny but distinct "PNG" payloads: export must return these exact bytes.
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`fake-${tag}-` + "x".repeat(300))]);

async function makeApp() {
  const dir = await mkdtemp(join(tmpdir(), "ns-exp-"));
  const runner = new AutopilotRunner({ client: {} as never, plan: (async () => ({})) as never, baseGraph: {}, collectionsDir: dir, batchesDir: dir });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787 });
  return { dir, app };
}

type Rec = { frame: number; variant?: number; png?: string; status?: string };

async function collection(dir: string, id: string, recs: Rec[], selections?: Record<string, number>) {
  await mkdir(join(dir, id), { recursive: true });
  const frames = recs.map((r) => ({ frame: r.frame, variant: r.variant, model: "duskrose", seed: 1, status: r.status === "gone" ? "done" : (r.status ?? "done"), png: r.png }));
  await writeFile(join(dir, id, "collection.json"), JSON.stringify({ title: id, createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames }));
  for (const r of recs) if (r.png && r.status !== "gone") await writeFile(join(dir, id, r.png), png(r.png));
  if (selections) await writeFile(join(dir, id, "selections.json"), JSON.stringify(selections));
}

/** Minimal reader for the stored (uncompressed) entries of a ZIP: name -> bytes, in archive order. */
function readZip(buf: Buffer): { name: string; data: Buffer; method: number }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    out.push({ name, method, data: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const exportReq = (app: Awaited<ReturnType<typeof makeApp>>["app"], id: string) => app.inject({ method: "GET", url: `/api/collections/${id}/export`, headers: H });

test("export picks the Best of each scene and names files scene-01..04.png with the original bytes", async () => {
  const { dir, app } = await makeApp();
  const recs: Rec[] = [];
  for (const f of [1, 2, 3, 4]) for (const v of [1, 2]) recs.push({ frame: f, variant: v, png: `scene-0${f}-v0${v}.png` });
  await collection(dir, "multi", recs, { "1": 2, "2": 1, "3": 2, "4": 1 });
  const before = await readFile(join(dir, "multi", "selections.json"), "utf8");
  const res = await exportReq(app, "multi");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/zip");
  assert.match(String(res.headers["content-disposition"]), /multi-selected\.zip/);
  const zip = readZip(res.rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-01.png", "scene-02.png", "scene-03.png", "scene-04.png"]);
  assert.ok(zip.every((z) => z.method === 0)); // stored: PNG bytes are not recompressed
  assert.deepEqual(zip[0].data, png("scene-01-v02.png"));
  assert.deepEqual(zip[1].data, png("scene-02-v01.png"));
  assert.deepEqual(zip[2].data, png("scene-03-v02.png"));
  assert.deepEqual(zip[3].data, png("scene-04-v01.png"));
  assert.equal(await readFile(join(dir, "multi", "selections.json"), "utf8"), before); // export changes nothing
});

test("single-variant frames are not auto-selected: Best on frames 1 and 3 only gives exactly 2 PNG", async () => {
  const { dir, app } = await makeApp();
  await collection(dir, "single4", [1, 2, 3, 4].map((f) => ({ frame: f, png: `scene-0${f}.png` })), { "1": 1, "3": 1 });
  const c = (await app.inject({ method: "GET", url: "/api/collections/single4", headers: H })).json();
  assert.deepEqual(c.export, { ready: true, resolved: 2 });
  const zip = readZip((await exportReq(app, "single4")).rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-01.png", "scene-03.png"]);
  assert.deepEqual(zip[0].data, png("scene-01.png")); // original bytes
  assert.deepEqual(zip[1].data, png("scene-03.png"));
});

test("two variants per frame, Best on frames 2 and 4: exactly the chosen PNGs", async () => {
  const { dir, app } = await makeApp();
  const recs: Rec[] = [];
  for (const f of [1, 2, 3, 4]) for (const v of [1, 2]) recs.push({ frame: f, variant: v, png: `scene-0${f}-v0${v}.png` });
  await collection(dir, "half", recs, { "2": 2, "4": 1 });
  const zip = readZip((await exportReq(app, "half")).rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-02.png", "scene-04.png"]);
  assert.deepEqual(zip[0].data, png("scene-02-v02.png"));
  assert.deepEqual(zip[1].data, png("scene-04-v01.png"));
});

test("one selected frame gives one PNG; all four selected give four", async () => {
  const { dir, app } = await makeApp();
  await collection(dir, "one", [1, 2, 3, 4].map((f) => ({ frame: f, png: `scene-0${f}.png` })), { "2": 1 });
  assert.deepEqual(readZip((await exportReq(app, "one")).rawPayload).map((z) => z.name), ["scene-02.png"]);
  await collection(dir, "all", [1, 2, 3, 4].map((f) => ({ frame: f, png: `scene-0${f}.png` })), { "1": 1, "2": 1, "3": 1, "4": 1 });
  assert.equal(readZip((await exportReq(app, "all")).rawPayload).length, 4);
});

test("nothing selected: export is not ready and the endpoint refuses", async () => {
  const { dir, app } = await makeApp();
  await collection(dir, "none", [1, 2, 3, 4].map((f) => ({ frame: f, png: `scene-0${f}.png` })));
  const c = (await app.inject({ method: "GET", url: "/api/collections/none", headers: H })).json();
  assert.deepEqual(c.export, { ready: false, resolved: 0, message: "Select at least one image" });
  const res = await exportReq(app, "none");
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "EXPORT_INCOMPLETE");
});

test("partially finished collection: selected finished images export, unfinished frames do not block", async () => {
  const { dir, app } = await makeApp();
  await collection(
    dir,
    "partial",
    [
      { frame: 1, png: "scene-01.png" },
      { frame: 2, png: "scene-02.png" },
      { frame: 3, status: "failed" },
      { frame: 4, status: "submitted" },
    ],
    { "2": 1 },
  );
  const zip = readZip((await exportReq(app, "partial")).rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-02.png"]);
  assert.deepEqual(zip[0].data, png("scene-02.png"));
});

test("old collection with saved Best (no new fields) keeps working; old selections stay unchanged", async () => {
  const { dir, app } = await makeApp();
  await collection(dir, "old", [1, 2, 3, 4].map((f) => ({ frame: f, png: `scene-0${f}.png` })), { "4": 1, "1": 1 });
  const before = await readFile(join(dir, "old", "selections.json"), "utf8");
  const zip = readZip((await exportReq(app, "old")).rawPayload);
  assert.deepEqual(zip.map((z) => z.name), ["scene-01.png", "scene-04.png"]);
  assert.equal(await readFile(join(dir, "old", "selections.json"), "utf8"), before);
});

test("missing selected file is an error, never replaced by another variant", async () => {
  const { dir, app } = await makeApp();
  const recs: Rec[] = [];
  for (const f of [1, 2, 3, 4]) for (const v of [1, 2]) recs.push({ frame: f, variant: v, png: `scene-0${f}-v0${v}.png`, status: f === 2 && v === 2 ? "gone" : "done" });
  await collection(dir, "gone", recs, { "1": 1, "2": 2, "3": 1, "4": 1 }); // scene 2: selected v2 deleted from disk
  const res = await exportReq(app, "gone");
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /scene 2.*missing on disk/);
  // selected variant that never finished
  const recs2 = recs.map((r) => (r.frame === 2 && r.variant === 2 ? { ...r, status: "failed", png: undefined } : r));
  await collection(dir, "failedsel", recs2, { "1": 1, "2": 2, "3": 1, "4": 1 });
  assert.match((await exportReq(app, "failedsel")).json().error, /scene 2: the selected image \(v2\) is not available/);
});

test("paths outside the collection directory are never read; unknown or malicious ids give 404", async () => {
  const { dir, app } = await makeApp();
  await writeFile(join(dir, "secret.png"), png("secret"));
  await collection(dir, "evil", [1, 2, 3, 4].map((f) => ({ frame: f, png: f === 1 ? "../secret.png" : `scene-0${f}.png` })), { "1": 1 });
  const res = await exportReq(app, "evil");
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /invalid image path/);
  assert.equal((await exportReq(app, "nope")).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/..%2F/export", headers: H })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/collections/evil/export", headers: { host: "evil.example" } })).statusCode, 403);
});
