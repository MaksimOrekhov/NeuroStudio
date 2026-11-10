// One-off evaluation for NS-009: Creative Director v1 (baseline) vs v2, one Codex call each, 3 collections, no theme,
// same history, no image generation. Results go to output/director-eval/ (git-ignored).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { autoMix } from "../src/imageModels.ts";
import { batchSchema, loadInstructions, planPrompt, runCodex } from "../src/codex.ts";
import { validateBatch } from "../src/promptPlan.ts";
import { listCollections } from "../server/collections.ts";

const root = resolve(import.meta.dirname, "..");
const COUNT = 3;
const outDir = join(root, "output/director-eval");

function v1Prompt(rules: string, avoid: string[]): string {
  const avoidLine = avoid.length
    ? `\nConcepts already created (do NOT repeat or resemble them; propose a substantially different concept, setting, palette and mood): ${avoid.map((t) => JSON.stringify(t)).join(", ")}.`
    : "";
  return `You are the creative director of NeuroDreams, a collection of semi-realistic portrait sets.
No theme is given: invent ${COUNT} original concepts yourself.
Return a Batch Plan: JSON {"collections": [...]} with exactly ${COUNT} Prompt Plans matching the supplied schema.${avoidLine}
The ${COUNT} collections must be substantially different from each other: different title, setting, palette, mood, heroine appearance and wardrobe themes. Never repeat a concept inside the batch.

Rules (apply to every collection):
${rules}`;
}

const rules = (await readFile(join(root, "prompts/baseline/v1-rules.md"), "utf8")).replace(/^<!--.*-->\n/, "").trim();
const avoid = (await listCollections(join(root, "output/collections"), 20)).map((c) => c.title);
await mkdir(outDir, { recursive: true });
console.log(`History (${avoid.length}): ${avoid.join(" | ")}`);

const v1Schema = await batchSchema(COUNT, join(root, "prompts/baseline/prompt-plan.v1.schema.json"));
const runs = [
  { name: "v1", prompt: v1Prompt(rules, avoid), schema: v1Schema },
  { name: "v2", prompt: planPrompt(await loadInstructions(), undefined, avoid, COUNT, undefined, autoMix(4)), schema: await batchSchema(COUNT, undefined, autoMix(4)) },
];

for (const run of runs) {
  console.log(`\n== ${run.name}: calling Codex once (${COUNT} collections)...`);
  const r = await runCodex(run.prompt, run.schema, 600_000);
  let strict: string | null = null;
  try {
    validateBatch(r.json, COUNT);
  } catch (e) {
    strict = (e as Error).message;
  }
  await writeFile(join(outDir, `${run.name}.json`), JSON.stringify({ seconds: r.ms / 1000, tokens: r.tokens, history: avoid, strictViolations: strict, result: r.json }, null, 2));
  console.log(`${run.name}: ${(r.ms / 1000).toFixed(1)}s, tokens ${JSON.stringify(r.tokens)}, strict v2 rules: ${strict ?? "all satisfied"}`);
}
