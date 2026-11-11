// Test data for the production UI (NS-015). Everything here is FAKE: collections with generated placeholder PNGs,
// batch records, a fake ComfyUI client and a fake Codex planner. Used by tests and by scripts/ui-test-server.ts.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { buildApp } from "../../server/app.ts";
import { AutopilotRunner } from "../../server/runner.ts";
import { MODELS, applyParams, loadWorkflow } from "../../src/comfy.ts";
import { planV3 } from "./strictPlan.ts";

const root = resolve(import.meta.dirname, "../..");
const C = "crimson-oath";
const D = "duskrose";

/** A real, small PNG: a gradient of the given hue with the frame/variant number, so screenshots show what is what. */
export async function placeholderPng(hue: number, frame: number, variant: number, w = 640, h = 960): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,30%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},55%,12%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="48%" fill="rgba(255,255,255,0.85)" font-size="150" font-family="sans-serif" text-anchor="middle">${frame}</text>
    <text x="50%" y="58%" fill="rgba(255,255,255,0.6)" font-size="44" font-family="sans-serif" text-anchor="middle">v${variant} · test data</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface Spec {
  id: string;
  title: string;
  titleRu?: string;
  hue: number;
  frameCount?: number; // undefined = written like an old collection (no frameCount field)
  variations: number;
  models: string[];
  /** Slot states in execution order; default: all done. */
  states?: Record<string, "done" | "failed" | "pending" | "submitted" | "timeout">;
  status?: "done" | "failed" | "running";
  selections?: Record<string, number>;
  feedback?: { rating: number | null; tags: string[]; note: string };
  createdAt: string;
  plan?: boolean;
  generation?: boolean;
}

async function writeCollection(dir: string, s: Spec) {
  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const d = join(dir, s.id);
  await mkdir(d, { recursive: true });
  const frames = s.frameCount ?? 4;
  const recs = [];
  for (let f = 1; f <= frames; f++) {
    for (let v = 1; v <= s.variations; v++) {
      const name = s.variations === 1 ? `scene-0${f}` : `scene-0${f}-v0${v}`;
      const st = s.states?.[`${f}-${v}`] ?? "done";
      recs.push({
        frame: f,
        variant: s.variations === 1 ? undefined : v,
        model: s.models[f - 1],
        seed: 100000 + f * 10 + v,
        status: st,
        promptId: st === "pending" ? undefined : `pid-${s.id.slice(-6)}-${f}-${v}`,
        png: st === "done" ? `${name}.png` : undefined,
        error: st === "failed" ? "Generation failed: CUDA out of memory (KSampler)" : undefined,
      });
      if (st === "done") {
        await writeFile(join(d, `${name}.png`), await placeholderPng(s.hue + f * 17, f, v));
        // the sidecar the real generator writes: it holds the ComfyUI graph that regeneration starts from (NS-017)
        const graph = applyParams(base, { positive: `masterpiece, scene ${f}, ${s.id}, soft light`, negative: "lowres", seed: 100000 + f * 10 + v, unet: MODELS[s.models[f - 1] as keyof typeof MODELS], filenamePrefix: `NeuroStudio/${s.id}/${name}` });
        await writeFile(join(d, `${name}.json`), JSON.stringify({ frame: f, model: s.models[f - 1], variant: v, seed: 100000 + f * 10 + v, graph }));
      }
    }
  }
  const generation = s.generation
    ? { theme: null, imageModels: { mode: "auto", models: s.models }, composition: s.models.map(() => ({})) }
    : undefined;
  await writeFile(
    join(d, "collection.json"),
    JSON.stringify({
      title: s.title,
      createdAt: s.createdAt,
      status: s.status ?? "done",
      dir: d,
      variations: s.variations === 1 ? undefined : s.variations,
      frameCount: s.frameCount,
      generation,
      codex: s.generation ? { seconds: 74.2, tokens: null, model: null, reasoningEffort: null } : undefined,
      comfySeconds: 212,
      frames: recs,
    }),
  );
  if (s.plan !== false) {
    const plan = planV3(s.title, s.models.slice(0, frames));
    plan.concept.titleRu = s.titleRu ?? plan.concept.titleRu;
    if (!s.titleRu) delete plan.concept.titleRu;
    await writeFile(join(d, "prompt-plan.json"), JSON.stringify(s.titleRu ? plan : legacyPlan(plan)));
  }
  if (s.selections) await writeFile(join(d, "selections.json"), JSON.stringify(s.selections));
  if (s.feedback) await writeFile(join(d, "feedback.json"), JSON.stringify({ version: 1, ...s.feedback, updatedAt: "2026-11-09T10:00:00Z" }));
}

/** An old plan: no Russian fields at all. */
function legacyPlan(p: ReturnType<typeof planV3>) {
  const q = JSON.parse(JSON.stringify(p));
  delete q.concept.titleRu;
  delete q.concept.descriptionRu;
  for (const f of q.frames) delete f.summaryRu;
  return q;
}

async function writeBatch(dir: string, id: string, b: Record<string, unknown>) {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, "batch-plan.json"), JSON.stringify(b));
}

/** Creates the fake data set; returns the folders. */
export async function createFixture(base?: string) {
  const dir = base ?? (await mkdtemp(join(tmpdir(), "ns15-")));
  const collectionsDir = join(dir, "collections");
  const batchesDir = join(dir, "batches");
  const thumbsDir = join(dir, "thumbs");
  await mkdir(collectionsDir, { recursive: true });
  await mkdir(batchesDir, { recursive: true });
  const specs: Spec[] = [
    // 4 frames x 2 variants, Russian metadata, Best chosen for 2 of 4: "needs selection"
    { id: "2026-11-10-ferry", title: "Morning Ferry", titleRu: "Утренний паром", hue: 200, frameCount: 4, variations: 2, models: [C, C, D, D], selections: { "1": 2, "3": 1 }, createdAt: "2026-11-10T09:30:00Z", generation: true },
    // one frame: ready at once
    { id: "2026-11-10-ovation", title: "A Private Ovation", titleRu: "Аплодисменты для себя", hue: 340, frameCount: 1, variations: 1, models: [C], createdAt: "2026-11-10T08:10:00Z", generation: true, feedback: { rating: 5, tags: ["great_outfit", "good_composition"], note: "Один кадр держит композицию." } },
    // two frames x 2, both Best chosen, rated
    { id: "2026-11-09-library", title: "Noon in the Library", titleRu: "Полдень в библиотеке", hue: 40, frameCount: 2, variations: 2, models: [C, D], selections: { "1": 1, "2": 2 }, createdAt: "2026-11-09T15:00:00Z", generation: true, feedback: { rating: 4, tags: ["beautiful_lighting"], note: "" } },
    // three frames, one variant
    { id: "2026-11-09-greenhouse", title: "Rain in the Greenhouse", titleRu: "Дождь в теплице", hue: 140, frameCount: 3, variations: 1, models: [C, C, D], createdAt: "2026-11-09T11:00:00Z", generation: true },
    // old collection: no frameCount, no generation, no Russian text, one variant
    { id: "2026-10-01-saltglass", title: "Saltglass Conservatory", hue: 260, variations: 1, models: [C, C, D, D], createdAt: "2026-10-01T12:00:00Z" },
    // stopped by an error: 2 of 4 saved, one failed
    { id: "2026-11-08-lemon", title: "Lemon Grove Siesta", titleRu: "Сиеста в лимонной роще", hue: 70, frameCount: 4, variations: 1, models: [C, C, D, D], status: "failed", states: { "1-1": "done", "2-1": "done", "3-1": "failed", "4-1": "pending" }, createdAt: "2026-11-08T18:00:00Z", generation: true },
    // "running" on disk, but no run is active in this process: interrupted
    { id: "2026-11-07-balcony", title: "Balcony at Dusk", titleRu: "Балкон в сумерках", hue: 20, frameCount: 2, variations: 2, models: [C, D], status: "running", states: { "1-1": "done", "1-2": "done", "2-1": "submitted", "2-2": "pending" }, createdAt: "2026-11-07T20:00:00Z", generation: true },
    // a very long title
    { id: "2026-11-06-long", title: "An Extremely Long Original Title That Keeps Going", titleRu: "Очень длинное название коллекции, которое должно аккуратно переноситься по строкам и не ломать сетку библиотеки", hue: 300, frameCount: 4, variations: 1, models: [C, C, D, D], createdAt: "2026-11-06T10:00:00Z", generation: true },
  ];
  for (const s of specs) await writeCollection(collectionsDir, s);

  const base4 = { count: 1, frames: 4, variations: 2, imageModels: { mode: "auto", models: [C, C, D, D] }, composition: null, codex: { model: null, reasoningEffort: null, seconds: 74.2, tokens: null } };
  await writeBatch(batchesDir, "2026-11-10-aaa", { ...base4, createdAt: "2026-11-10T09:28:00Z", theme: "утренний туман над водой", status: "done", collectionIds: ["2026-11-10-ferry"], plans: [] });
  await writeBatch(batchesDir, "2026-11-10-bbb", {
    ...base4,
    createdAt: "2026-11-10T07:00:00Z",
    theme: null,
    count: 2,
    status: "failed",
    error: "Codex exited with code 1: stream disconnected",
    errorCode: "CODEX_FAILED",
    codex: { model: "gpt-test", reasoningEffort: "high" },
    collectionIds: [],
    plans: [],
  });
  await writeBatch(batchesDir, "2026-11-08-ccc", { ...base4, createdAt: "2026-11-08T17:55:00Z", theme: "лимоны", variations: 1, status: "failed", error: "Generation failed: CUDA out of memory (KSampler)", errorCode: "GENERATION_FAILED", collectionIds: ["2026-11-08-lemon"], plans: [] });
  await writeBatch(batchesDir, "2026-11-07-ddd", { ...base4, createdAt: "2026-11-07T19:59:00Z", theme: null, frames: 2, status: "running", collectionIds: ["2026-11-07-balcony"], plans: [] });
  await writeBatch(batchesDir, "2026-10-01-old", { createdAt: "2026-10-01T11:50:00Z", theme: null, count: 1, variations: 1, status: "done", collectionIds: ["2026-10-01-saltglass"], plans: [{ frames: [1, 2, 3, 4] }] }); // pre-NS-014 shape
  return { dir, collectionsDir, batchesDir, thumbsDir };
}

export interface FakeBehaviour {
  /** Milliseconds a fake image takes. */
  imageMs?: number;
  /** Makes the fake Codex fail with this message. */
  planError?: Error;
  comfyDown?: boolean;
}

/** The real runner and API over a fake ComfyUI and a fake Codex. No GPU, no Codex process, no network. */
export async function createFakeApp(opts: { fx: Awaited<ReturnType<typeof createFixture>>; port: number; behaviour?: FakeBehaviour; webDist?: string }) {
  const b: FakeBehaviour = opts.behaviour ?? {};
  const seen = { plan: [] as unknown[], submit: 0 };
  const png = await placeholderPng(210, 1, 1, 320, 480);
  const client = {
    systemStats: async () => {
      if (b.comfyDown) throw new Error("ECONNREFUSED 127.0.0.1:8188");
      return {};
    },
    checkDependencies: async () => [] as string[],
    submit: async () => `fake-pid-${++seen.submit}`,
    waitForImages: async () => {
      await new Promise((r) => setTimeout(r, b.imageMs ?? 0));
      return { images: [{ filename: "a.png", subfolder: "", type: "output" }], history: {} };
    },
    download: async () => png,
  };
  const runner = new AutopilotRunner({
    client: client as never,
    plan: async (o) => {
      seen.plan.push(o);
      await new Promise((r) => setTimeout(r, b.imageMs ? 600 : 0));
      if (b.planError) throw b.planError;
      const titles = ["Сад после дождя", "Вечер на пристани", "Комната с окнами"];
      return {
        plans: Array.from({ length: o.count }, (_, i) => {
          const p = planV3(`Fake concept ${seen.plan.length}-${i + 1}`, o.models);
          p.concept.titleRu = titles[i % titles.length];
          return p;
        }),
        raw: "",
        ms: 1500,
        tokens: null,
      };
    },
    baseGraph: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
    collectionsDir: opts.fx.collectionsDir,
    batchesDir: opts.fx.batchesDir,
  });
  const app = buildApp({
    runner,
    collectionsDir: opts.fx.collectionsDir,
    batchesDir: opts.fx.batchesDir,
    thumbsDir: opts.fx.thumbsDir,
    comfyUrl: "http://fake",
    port: opts.port,
    webDist: opts.webDist,
    loadCatalog: async () => ({
      source: "cache" as const,
      models: [
        { id: "gpt-test", name: "GPT Test", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
        { id: "gpt-mini", name: "GPT Mini", efforts: ["low", "medium"], defaultEffort: "low" },
      ],
    }),
    statusClient: {
      systemStats: async () => {
        if (b.comfyDown) throw new Error("ECONNREFUSED 127.0.0.1:8188");
        return { system: { comfyui_version: "0.3.test" } } as never;
      },
      queue: async () => ({ queue_running: [], queue_pending: [] }),
    },
  });
  return { app, runner, seen, behaviour: b };
}
