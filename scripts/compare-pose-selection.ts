// NS-026 controlled text comparison: free planning vs the pose library, two themes, no ComfyUI.
//   node --import tsx scripts/compare-pose-selection.ts                          -> 4 real Codex calls (free + auto per theme), new snapshot
//   node --import tsx scripts/compare-pose-selection.ts --auto-only <prevDir>    -> 2 real Codex calls (auto per theme) reusing <prevDir>/snapshot.json
// One frozen snapshot (recent titles, visual history, Preference Memory) is shared by every call; only the pose mode differs inside a
// theme. The auto request is built exactly like the runner builds it (sample, per-frame ids, view-history hint).
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { batchSchema, loadInstructions, planPrompt, runCodex } from "../src/codex.ts";
import { autoMix } from "../src/imageModels.ts";
import { validateBatch } from "../src/promptPlan.ts";
import { anatomyCaution, countPoseUses, framePoseIds, listedIds, loadPoseCatalog, posePrompt, selectPoses } from "../src/poses.ts";
import { loadVisualHistory } from "../src/visualHistory.ts";
import { listCollections } from "../server/collections.ts";
import { VIEW_HISTORY_COLLECTIONS, viewHistory, viewNote } from "../server/poseHistory.ts";
import { buildPreferenceContext } from "../server/promptEvolution.ts";

const root = resolve(import.meta.dirname, "..");
const collectionsDir = join(root, "output/collections");
const model = "gpt-6.1-sol";
const reasoningEffort = "high";
const models = autoMix(4);
const themes = [
  { key: "evening", seed: 26001, theme: "An elegant evening in the city: a realistic, glamorous night out between a hotel rooftop, a lamplit street and a quiet lobby." },
  { key: "daylight", seed: 26002, theme: "A bright, relaxed summer day outdoors: a meadow, an orchard and a lakeside path in soft natural daylight." },
];
const autoOnly = process.argv.indexOf("--auto-only");
const prevDir = autoOnly >= 0 ? process.argv[autoOnly + 1] : undefined;

const instructions = await loadInstructions();
const recent = await listCollections(collectionsDir, 20);
const plans: unknown[] = [];
for (const c of recent.slice(0, 12)) {
  try {
    plans.push(JSON.parse(await readFile(join(collectionsDir, c.id, "prompt-plan.json"), "utf8")));
  } catch {
    /* skip */
  }
}
type Snapshot = { avoid: string[]; history: string; preferences: string; recentPoseUses: Record<string, number>; cautious: boolean };
let snap: Snapshot;
if (prevDir) {
  snap = JSON.parse(await readFile(join(prevDir, "snapshot.json"), "utf8"));
} else {
  const ctx = await buildPreferenceContext(collectionsDir);
  snap = { avoid: recent.map((c) => c.title), history: await loadVisualHistory(collectionsDir, recent), preferences: ctx.text, recentPoseUses: countPoseUses(plans), cautious: anatomyCaution(ctx.memory) };
}
const catalog = loadPoseCatalog();
const views = viewHistory(plans, VIEW_HISTORY_COLLECTIONS);
await mkdir(join(root, "output/ns-026"), { recursive: true });
const outDir = await mkdtemp(join(root, prevDir ? "output/ns-026/rerun-" : "output/ns-026/compare-"));
await writeFile(join(outDir, "snapshot.json"), JSON.stringify({ model, reasoningEffort, models, ...snap, reusedFrom: prevDir ?? null, viewHistory: views, catalogVersion: catalog.version }, null, 2));
console.log(outDir);

let calls = 0;
const modes = prevDir ? (["auto"] as const) : (["free", "auto"] as const);
for (const t of themes) {
  const resolved = Array.from({ length: models.length }, () => ({}));
  const sample = selectPoses({ catalog, resolved, frames: models.length, collections: 1, seed: t.seed, recent: snap.recentPoseUses, cautious: snap.cautious });
  const ids = listedIds(sample, catalog.version);
  const listed = sample.filter((p) => ids.includes(p.id));
  const perFrame = framePoseIds(listed, resolved, models.length);
  const note = viewNote(views, listed, resolved[models.length - 1]);
  for (const mode of modes) {
    const poseText = mode === "auto" ? posePrompt(sample, catalog.version, perFrame, note.text) : "";
    const prompt = planPrompt(instructions, t.theme, snap.avoid, 1, undefined, models, true, snap.preferences, snap.history, poseText);
    const schema = await batchSchema(1, undefined, models, mode === "auto" ? ids : undefined);
    const file = join(outDir, `${t.key}-${mode}.json`);
    const inputs = { theme: t.theme, mode, seed: mode === "auto" ? t.seed : null, sample: mode === "auto" ? ids : null, finalSuggestions: mode === "auto" ? note.finalSuggestions : null, promptChars: prompt.length, prompt, schema };
    await writeFile(file, JSON.stringify(inputs, null, 2));
    calls++;
    console.log(`call ${calls}/${modes.length * themes.length}: ${t.key} ${mode} (${prompt.length} chars)`);
    try {
      const r = await runCodex(prompt, schema, 600_000, undefined, { model, reasoningEffort });
      let validationError: string | null = null;
      try {
        validateBatch(r.json, 1, { models, ...(mode === "auto" ? { poseIds: ids, framePoseIds: perFrame } : {}) });
      } catch (e) {
        validationError = (e as Error).message;
        process.exitCode = 1;
      }
      await writeFile(file, JSON.stringify({ ...inputs, seconds: r.ms / 1000, tokens: r.tokens, validationError, result: r.json }, null, 2));
      console.log(`  ${r.ms / 1000}s, validation ${validationError ?? "passed"}`);
    } catch (e) {
      await writeFile(file, JSON.stringify({ ...inputs, error: (e as Error).message }, null, 2));
      console.error(`  ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}
console.log(`Codex calls: ${calls}`);
