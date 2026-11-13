// NS-023: Creative Director v3 (visual diversity) and the compact visual history. Local only: no Codex, no GPU.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../server/app.ts";
import { AutopilotRunner } from "../server/runner.ts";
import { buildPreferenceContext } from "../server/promptEvolution.ts";
import { generateBatch, loadInstructions, planPrompt } from "../src/codex.ts";
import { validateBatch, validatePlan, type PromptPlan } from "../src/promptPlan.ts";
import { HISTORY_COLLECTIONS, HISTORY_MAX_CHARS, formatVisualHistory, loadVisualHistory, visualEntry } from "../src/visualHistory.ts";
import { planV3, strictPlan } from "./fixtures/strictPlan.ts";

const H = { host: "127.0.0.1:8787" };
const C = "crimson-oath";

/** A saved plan in the current house format (7 blocks). */
function housePlan(title: string, o: { hair?: string; outfit?: string; place?: string; light?: string } = {}): PromptPlan {
  const positive = [
    "realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, intricate details, cinematic dramatic lighting, strong chiaroscuro,",
    "solo female, adult woman, 34 years old, original character, mature face, adult body, huge breast,",
    `warm olive skin, heart-shaped face, hazel eyes, ${o.hair ?? "short silver pixie cut"}, clean natural skin, glossy semi-realistic illustration,`,
    "standing at a rail, looking out,",
    `${o.outfit ?? "emerald silk wrap top, high-waist tailored trousers"},`,
    `${o.place ?? "sunny terrace, terracotta tiles, potted lemon trees"},`,
    `front view, waist-up composition, ${o.light ?? "warm low sunlight from the left"}, gentle smile`,
  ].join("\n\n");
  const p = planV3(title, [C]);
  p.frames[0].positive = positive;
  p.concept.description = `${title}: a golden-hour terrace portrait. A second sentence that is dropped.`;
  return p;
}

const tmp = () => mkdtemp(join(tmpdir(), "ns23-"));

async function saveCollection(dir: string, id: string, createdAt: string, plan?: PromptPlan | string) {
  const d = join(dir, id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "collection.json"), JSON.stringify({ title: id, createdAt, status: "done", dir: d, frames: [], frameCount: 4 }));
  if (plan !== undefined) await writeFile(join(d, "prompt-plan.json"), typeof plan === "string" ? plan : JSON.stringify(plan));
}

// ---------- extraction ----------

test("visualEntry: compact characteristics from a house-format plan, hair first, boilerplate dropped", () => {
  const e = visualEntry("Terrace", housePlan("Terrace"))!;
  assert.equal(e.age, 34);
  assert.match(e.look, /^short silver pixie cut, /); // hair leads
  assert.doesNotMatch(e.look, /clean natural skin|semi-realistic/);
  assert.equal(e.outfit, "emerald silk wrap top, high-waist tailored trousers");
  assert.equal(e.place, "sunny terrace, terracotta tiles, potted lemon trees");
  assert.equal(e.light, "warm low sunlight from the left");
  assert.equal(e.idea, "Terrace: a golden-hour terrace portrait.");
});

test("visualEntry: old or unrecognised plans give no entry and never throw; nothing is invented", () => {
  assert.equal(visualEntry("Old", strictPlan("Old")), null); // pre-v3 layout (3 blocks)
  assert.equal(visualEntry("Old", planV3("V3")), null);
  for (const junk of [null, undefined, 5, "x", {}, { frames: [] }, { frames: [{ positive: 3 }] }, { frames: [{ positive: "a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng" }] }]) assert.equal(visualEntry("J", junk), null);
  const noLight = visualEntry("NoLight", housePlan("NoLight", { light: "front view" }))!; // no recognisable light words
  assert.equal(noLight.light, undefined);
});

test("visualEntry: the 6-block layout (appearance in the same block as 'solo female') gives the same characteristics", () => {
  const seven = housePlan("Six");
  const six = structuredClone(seven);
  const b = six.frames[0].positive.split("\n\n");
  six.frames[0].positive = [b[0], `${b[1]} ${b[2]}`, ...b.slice(3)].join("\n\n");
  assert.equal(six.frames[0].positive.split("\n\n").length, 6);
  assert.deepEqual(visualEntry("Six", six), visualEntry("Six", seven));
  const odd = structuredClone(seven); // 5 blocks: not the house format, so no guess
  odd.frames[0].positive = seven.frames[0].positive.split("\n\n").slice(0, 5).join("\n\n");
  assert.equal(visualEntry("Odd", odd), null);
});

// ---------- size ----------

test("formatVisualHistory: empty input gives an empty block; the cap holds and the oldest entries go first", () => {
  assert.equal(formatVisualHistory([]), "");
  const entries = Array.from({ length: 8 }, (_, i) => visualEntry(`T${i}`, housePlan(`T${i}`, { hair: `very long wavy auburn hair number ${i}, ${"curl, ".repeat(60)}` }))!);
  const full = formatVisualHistory(entries);
  assert.ok(full.length <= HISTORY_MAX_CHARS, `${full.length}`);
  const tight = formatVisualHistory(entries, 1500);
  assert.ok(tight.length <= 1500);
  assert.match(tight, /"T0"/); // newest kept
  assert.doesNotMatch(tight, /"T7"/); // oldest dropped
  assert.equal(formatVisualHistory(entries, 50), ""); // nothing fits: no half-block
});

test("loadVisualHistory: reads only the newest collections, skips missing, damaged and legacy plans", async () => {
  const dir = await tmp();
  const recent: { id: string; title: string }[] = [];
  const add = async (id: string, plan?: PromptPlan | string) => {
    await saveCollection(dir, id, "2026-01-01T00:00:00Z", plan);
    recent.push({ id, title: id });
  };
  await add("good-1", housePlan("Good1"));
  await add("no-plan");
  await add("broken", "{ not json");
  await add("legacy", strictPlan("Legacy"));
  await add("good-2", housePlan("Good2", { hair: "tight black coils" }));
  const text = await loadVisualHistory(dir, recent);
  assert.match(text, /^Visual memory of the most recent collections/);
  assert.match(text, /1\. "good-1"/);
  assert.match(text, /2\. "good-2"/); // numbered after skipping; titles come from the collection list
  assert.doesNotMatch(text, /legacy|broken|no-plan/);
  const old = [...recent];
  for (let i = 0; i < HISTORY_COLLECTIONS; i++) recent.unshift({ id: `filler-${i}`, title: `filler-${i}` }); // newest-8 window no longer reaches good-*
  assert.equal(await loadVisualHistory(dir, recent), "");
  assert.notEqual(await loadVisualHistory(dir, old), "");
  assert.equal(await loadVisualHistory(join(dir, "missing"), old), ""); // unreadable directory: no history, no error
});

// ---------- the Codex request ----------

test("planPrompt: history unavailable = byte-identical request; with history the block follows the titles and precedes the rest", () => {
  const base = planPrompt("INSTR", undefined, ["Old A", "Old B"], 3, undefined, [C], true, "");
  assert.equal(planPrompt("INSTR", undefined, ["Old A", "Old B"], 3, undefined, [C], true, "", ""), base);
  assert.equal(planPrompt("INSTR", undefined, ["Old A", "Old B"], 3, undefined, [C], true, "", undefined), base);
  const h = 'Visual memory of the most recent collections (newest first): 1. "Old A": ...';
  const p = planPrompt("INSTR", undefined, ["Old A", "Old B"], 3, undefined, [C], true, "PREFS", h);
  assert.ok(p.includes('"Old A", "Old B"')); // titles stay
  assert.ok(p.indexOf('"Old B"') < p.indexOf(h));
  assert.ok(p.indexOf(h) < p.indexOf("must be substantially different from each other"));
  assert.ok(p.indexOf(h) < p.indexOf("Each collection has exactly"));
  assert.ok(p.endsWith("PREFS")); // Prompt Evolution text stays last
  assert.equal(p.split(h).length, 2);
});

test("generateBatch: the visual history reaches the single Codex process once, and the plan is still validated", async () => {
  const dir = await tmp();
  const planFile = join(dir, "plan.json");
  const promptFile = join(dir, "prompt.txt");
  const countFile = join(dir, "runs.txt");
  await writeFile(planFile, JSON.stringify(planV3("One", [C])));
  const script = `
    const fs = require("fs");
    const a = process.argv, out = a[a.indexOf("-o") + 1];
    let text = "";
    process.stdin.on("data", (d) => (text += d));
    process.stdin.on("end", () => {
      fs.appendFileSync(process.env.NS_RUNS, "x");
      fs.writeFileSync(process.env.NS_PROMPT, text);
      fs.writeFileSync(out, JSON.stringify({ collections: [JSON.parse(fs.readFileSync(process.env.NS_PLAN, "utf8"))] }));
    });
  `;
  Object.assign(process.env, { NS_PLAN: planFile, NS_PROMPT: promptFile, NS_RUNS: countFile });
  const launcher = { command: process.execPath, args: ["-e", script, "--"] };
  const history = formatVisualHistory([visualEntry("Terrace", housePlan("Terrace"))!]);
  const r = await generateBatch({ count: 1, models: [C], launcher, timeoutMs: 10_000, avoid: ["Terrace"], history });
  const sent = await readFile(promptFile, "utf8");
  assert.equal(sent.split("Visual memory of the most recent collections").length, 2);
  assert.match(sent, /short silver pixie cut/);
  assert.equal((await readFile(countFile, "utf8")).length, 1); // one process
  assert.equal(r.plans.length, 1);
  await assert.rejects(generateBatch({ count: 1, models: ["duskrose"], launcher, timeoutMs: 10_000, history }), /must be duskrose/); // validation still applies
});

// ---------- the run ----------

async function runEnv() {
  const dir = await tmp();
  const batchesDir = join(dir, "_batches");
  const calls: Record<string, unknown>[] = [];
  const runner = new AutopilotRunner({
    client: { systemStats: async () => ({}) } as never,
    plan: (async (o: Record<string, unknown>) => {
      calls.push(o);
      throw new Error("stop after planning");
    }) as never,
    baseGraph: {},
    collectionsDir: dir,
    batchesDir,
  });
  const app = buildApp({ runner, collectionsDir: dir, batchesDir, comfyUrl: "http://x", port: 8787 });
  const start = async (payload: object = { frames: 2 }) => {
    const res = await app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload });
    assert.equal(res.statusCode, 202);
    while (runner.active) await new Promise((r) => setTimeout(r, 5));
  };
  return { dir, calls, start };
}

test("run: one Codex request carries both the titles and the visual history of recent collections", async () => {
  const e = await runEnv();
  await saveCollection(e.dir, "a", "2026-02-01T00:00:00Z", housePlan("A", { hair: "long auburn braid" }));
  await saveCollection(e.dir, "b", "2026-02-02T00:00:00Z", housePlan("B", { hair: "tight black coils" }));
  await e.start();
  assert.equal(e.calls.length, 1);
  assert.deepEqual(e.calls[0].avoid, ["b", "a"]); // titles as before, newest first
  const history = e.calls[0].history as string;
  assert.ok(history.indexOf("tight black coils") < history.indexOf("long auburn braid")); // newest first
  assert.ok(history.length <= HISTORY_MAX_CHARS);
  assert.equal("preferences" in e.calls[0], false); // Prompt Evolution off: nothing from it
});

test("run: old collections without a usable plan leave the request exactly as before", async () => {
  const e = await runEnv();
  await saveCollection(e.dir, "legacy", "2026-02-01T00:00:00Z", strictPlan("Legacy"));
  await saveCollection(e.dir, "bare", "2026-02-02T00:00:00Z"); // collection.json only
  await e.start();
  assert.equal(e.calls.length, 1);
  assert.deepEqual(e.calls[0].avoid, ["bare", "legacy"]);
  assert.equal("history" in e.calls[0], false);
  assert.equal("preferences" in e.calls[0], false);
});

test("Prompt Evolution is untouched: its context does not depend on the visual history", async () => {
  const dir = await tmp();
  await saveCollection(dir, "x", "2026-02-01T00:00:00Z", housePlan("X"));
  const before = await buildPreferenceContext(dir);
  await loadVisualHistory(dir, [{ id: "x", title: "X" }]);
  assert.deepEqual(await buildPreferenceContext(dir), before);
  assert.equal(before.text, "");
});

// ---------- instructions and validation ----------

test("Creative Director v3 keeps section A byte-for-byte as in v2 and addresses the diversity axes", async () => {
  const lf = (t: string) => t.replace(/\r\n/g, "\n");
  const head = (t: string) => lf(t).slice(0, lf(t).indexOf("## B.")).trim();
  const v2 = await readFile(new URL("../prompts/baseline/v2-creative-director.md", import.meta.url), "utf8");
  const v3 = await loadInstructions();
  assert.equal(head(v3), head(v2));
  for (const part of ["hair length and structure", "Wardrobe is a wide pool", "Places are chosen", "originality with strangeness", "map of what is already familiar"]) assert.ok(v3.includes(part), part);
});

test("Prompt Plan validation is unchanged by v3", () => {
  const plans = [planV3("A", [C]), planV3("B", [C])];
  assert.equal(validateBatch({ collections: plans }, 2, { models: [C] }).length, 2);
  const bad = structuredClone(plans[0]);
  bad.frames[0].positive = bad.frames[0].positive.replace("huge breast", "huge breasts");
  assert.throws(() => validatePlan(bad, { models: [C] }), /huge breast/);
  bad.frames[0].positive = planV3("A", [C]).frames[0].positive.replace("29 years old", "19 years old");
  assert.throws(() => validatePlan(bad, { models: [C] }), /adult age/);
});
