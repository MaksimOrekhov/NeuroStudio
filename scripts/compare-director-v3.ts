// NS-023 evaluation: Creative Director v2 (baseline) vs v3, one real Codex call each, 3 collections x 4 frames, no theme,
// Prompt Evolution off, same model and reasoning effort, same underlying history (the 20 newest collections).
// v2 gets that history the way it always did (titles only); v3 gets titles + the compact visual history.
// No ComfyUI, no images. Results go to output/director-eval/ (git-ignored).
//   npx tsx scripts/compare-director-v3.ts [v2|v3] [model] [effort]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { autoMix } from "../src/imageModels.ts";
import { batchSchema, loadInstructions, planPrompt, runCodex } from "../src/codex.ts";
import { validateBatch } from "../src/promptPlan.ts";
import { loadVisualHistory } from "../src/visualHistory.ts";
import { listCollections } from "../server/collections.ts";

const root = resolve(import.meta.dirname, "..");
const COUNT = 3;
const models = autoMix(4);
const which = process.argv[2] ?? "v2";
const model = process.argv[3] ?? "gpt-6.1-sol";
const reasoningEffort = process.argv[4] ?? "high";
const outDir = join(root, "output/director-eval");
const dir = join(root, "output/collections");

const recent = await listCollections(dir, 20);
const avoid = recent.map((c) => c.title);
const history = await loadVisualHistory(dir, recent);
const v2Rules = (await readFile(join(root, "prompts/baseline/v2-creative-director.md"), "utf8")).trim();

const prompt =
  which === "v2"
    ? planPrompt(v2Rules, undefined, avoid, COUNT, undefined, models, true)
    : planPrompt(await loadInstructions(), undefined, avoid, COUNT, undefined, models, true, "", which === "v3" ? history : "");
await mkdir(outDir, { recursive: true });
console.log(`${which}: ${model} / ${reasoningEffort}, history titles ${avoid.length}, visual history ${which === "v3" ? history.length : 0} chars, prompt ${prompt.length} chars; calling Codex once...`);
const r = await runCodex(prompt, await batchSchema(COUNT, undefined, models), 900_000, undefined, { model, reasoningEffort });
let strict: string | null = null;
try {
  validateBatch(r.json, COUNT, { models });
} catch (e) {
  strict = (e as Error).message;
}
await writeFile(join(outDir, `ns023-${which}.json`), JSON.stringify({ model, reasoningEffort, seconds: r.ms / 1000, tokens: r.tokens, promptChars: prompt.length, history: avoid, visualHistory: which === "v3" ? history : null, strictViolations: strict, prompt, result: r.json }, null, 2));
console.log(`${which}: ${(r.ms / 1000).toFixed(1)}s, tokens ${JSON.stringify(r.tokens)}, strict validation: ${strict ?? "passed"}`);
