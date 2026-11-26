// NS-026 controlled text comparison: free planning vs the pose library, two themes, exactly 4 real Codex calls, no ComfyUI.
// One frozen snapshot (recent titles, visual history, Preference Memory) is shared by every call; only the pose mode differs inside a theme.
//   node --import tsx scripts/compare-pose-selection.ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { batchSchema, loadInstructions, planPrompt, runCodex } from "../src/codex.ts";
import { autoMix } from "../src/imageModels.ts";
import { validateBatch } from "../src/promptPlan.ts";
import { anatomyCaution, countPoseUses, listedIds, loadPoseCatalog, posePrompt, selectPoses } from "../src/poses.ts";
import { loadVisualHistory } from "../src/visualHistory.ts";
import { listCollections } from "../server/collections.ts";
import { buildPreferenceContext } from "../server/promptEvolution.ts";
import { readFile } from "node:fs/promises";

const root = resolve(import.meta.dirname, "..");
const collectionsDir = join(root, "output/collections");
const model = "gpt-6.1-sol";
const reasoningEffort = "high";
const models = autoMix(4);
const themes = [
  { key: "evening", seed: 26001, theme: "An elegant evening in the city: a realistic, glamorous night out between a hotel rooftop, a lamplit street and a quiet lobby." },
  { key: "daylight", seed: 26002, theme: "A bright, relaxed summer day outdoors: a meadow, an orchard and a lakeside path in soft natural daylight." },
];

const instructions = await loadInstructions();
const recent = await listCollections(collectionsDir, 20);
const avoid = recent.map((c) => c.title);
const history = await loadVisualHistory(collectionsDir, recent);
const ctx = await buildPreferenceContext(collectionsDir);
const plans: unknown[] = [];
for (const c of recent.slice(0, 12)) {
  try {
    plans.push(JSON.parse(await readFile(join(collectionsDir, c.id, "prompt-plan.json"), "utf8")));
  } catch {
    /* skip */
  }
}
const catalog = loadPoseCatalog();
const used = countPoseUses(plans);
const cautious = anatomyCaution(ctx.memory);
await mkdir(join(root, "output/ns-026"), { recursive: true });
const outDir = await mkdtemp(join(root, "output/ns-026/compare-"));
await writeFile(join(outDir, "snapshot.json"), JSON.stringify({ model, reasoningEffort, models, avoid, history, preferences: ctx.text, memoryStatus: ctx.memory.status, recentPoseUses: used, cautious, catalogVersion: catalog.version }, null, 2));
console.log(outDir);

let calls = 0;
for (const t of themes) {
  const sample = selectPoses({ catalog, resolved: [], frames: models.length, collections: 1, seed: t.seed, recent: used, cautious });
  const ids = listedIds(sample, catalog.version);
  for (const mode of ["free", "auto"] as const) {
    const poseText = mode === "auto" ? posePrompt(sample, catalog.version) : "";
    const prompt = planPrompt(instructions, t.theme, avoid, 1, undefined, models, true, ctx.text, history, poseText);
    const schema = await batchSchema(1, undefined, models, mode === "auto" ? ids : undefined);
    const file = join(outDir, `${t.key}-${mode}.json`);
    const inputs = { theme: t.theme, mode, seed: mode === "auto" ? t.seed : null, sample: mode === "auto" ? ids : null, promptChars: prompt.length, prompt, schema };
    await writeFile(file, JSON.stringify(inputs, null, 2));
    calls++;
    console.log(`call ${calls}/4: ${t.key} ${mode} (${prompt.length} chars)`);
    try {
      const r = await runCodex(prompt, schema, 600_000, undefined, { model, reasoningEffort });
      let validationError: string | null = null;
      try {
        validateBatch(r.json, 1, { models, ...(mode === "auto" ? { poseIds: ids } : {}) });
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
