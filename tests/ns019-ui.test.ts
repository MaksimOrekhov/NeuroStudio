// NS-019: what the user SEES in the Image Arena after errors. The real ImageArena.vue is compiled by Vite and rendered to HTML
// (server renderer, no browser); the store and the API are the real ones over a fake fetch. No GPU, no Codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";

const H = { host: "127.0.0.1:8787" };
const root = resolve(import.meta.dirname, "..");
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("x".repeat(100))]);

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
let failNext: { method: string; status: number; body: unknown } | null = null;
let route: (url: string, init?: RequestInit) => Promise<Response>;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  if (failNext && (init?.method ?? "GET") === failNext.method) {
    const f = failNext;
    failNext = null; // one failure only
    return { ok: false, status: f.status, json: async () => f.body } as Response;
  }
  return route(url, init);
};

// The component, the flow and the store must come from ONE module graph, so all three are loaded through the same Vite server.
const vite = await createServer({ root: join(root, "web"), configFile: join(root, "web/vite.config.ts"), appType: "custom", logLevel: "silent", server: { middlewareMode: true, hmr: false } });
const Arena = (await vite.ssrLoadModule("/src/components/ImageArena.vue")).default;
const { createArenaFlow } = await vite.ssrLoadModule("/src/arenaFlow.ts");
const store = await vite.ssrLoadModule("/src/store.ts");

async function env() {
  const dir = await mkdtemp(join(tmpdir(), "ns19ui-"));
  const runner = new AutopilotRunner({ client: {} as never, plan: (async () => ({})) as never, baseGraph: {}, collectionsDir: dir, batchesDir: dir });
  const app = buildApp({ runner, collectionsDir: dir, comfyUrl: "http://x", port: 8787 });
  await mkdir(join(dir, "A"), { recursive: true });
  const frames = [1, 2, 3].map((v) => ({ frame: 3, variant: v, model: "duskrose", seed: 100 + v, status: "done", png: `scene-03-v0${v}.png` }));
  await writeFile(join(dir, "A", "collection.json"), JSON.stringify({ title: "A", createdAt: "2026-01-01T00:00:00Z", status: "done", dir, frames, frameCount: 3 }));
  for (const f of frames) await writeFile(join(dir, "A", f.png), png);
  route = async (url, init) => {
    const r = await app.inject({ method: (init?.method ?? "GET") as any, url, headers: { host: H.host, ...((init?.headers as Record<string, string>) ?? {}) }, payload: init?.body as any });
    return { ok: r.statusCode < 400, status: r.statusCode, json: async () => r.json() } as Response;
  };
  const c = (await app.inject({ method: "GET", url: "/api/collections/A", headers: H })).json();
  const flow = createArenaFlow({ id: "A", frame: 3, variants: () => [1, 2, 3] });
  const render = () => renderToString(createSSRApp(Arena, { c, frame: 3, flow }));
  return { c, flow, render };
}

const SEES = { images: /<img /g, left: "Левое лучше", equal: "Равны", right: "Правое лучше", skip: "Пропустить" };
const assertComparisonUi = (html: string) => {
  assert.equal((html.match(SEES.images) ?? []).length, 2, "both images are visible");
  for (const t of [SEES.left, SEES.equal, SEES.right, SEES.skip]) assert.ok(html.includes(t), `button "${t}" is visible`);
};

test("the comparison UI stays on screen after a failed save; a repeat sends a new request, clears the error and opens the next pair", async () => {
  const { flow, render } = await env();
  await flow.start();
  assertComparisonUi(await render());
  assert.ok(!(await render()).includes("История сравнений недоступна"));
  const pair = flow.current.value;

  failNext = { method: "PUT", status: 409, body: { error: "comparisons.json cannot be used: x", code: "COMPARISON_FILE_UNREADABLE" } };
  assert.equal(await flow.choose(flow.left.value), false);
  const html = await render();
  assert.ok(html.includes("История сравнений недоступна"), "the error is shown");
  assertComparisonUi(html); // ... and the images and buttons are still there
  assert.ok(!/disabled/.test(html.match(/class="ctl"[\s\S]*?<\/div>/)![0]), "the buttons are enabled again");
  assert.equal(flow.current.value, pair);

  assert.equal(await flow.choose(flow.left.value), true); // the repeat is a new request for the same pair
  const after = await render();
  assert.ok(!after.includes("История сравнений недоступна"), "the error is gone");
  assertComparisonUi(after);
  assert.notEqual(flow.current.value, pair); // next pair
  assert.equal(Object.keys(store.arena.history).length, 1);
});

test("a failed FIRST load shows the error without the comparison UI", async () => {
  const { flow, render } = await env();
  failNext = { method: "GET", status: 409, body: { error: "comparisons.json cannot be used: x", code: "COMPARISON_FILE_UNREADABLE" } };
  await flow.start();
  const html = await render();
  assert.ok(html.includes("История сравнений недоступна"));
  assert.equal((html.match(SEES.images) ?? []).length, 0);
  for (const t of [SEES.left, SEES.right, SEES.skip]) assert.ok(!html.includes(t));
  assert.equal(flow.current.value, null);
});

test.after(async () => {
  await vite.close();
});
