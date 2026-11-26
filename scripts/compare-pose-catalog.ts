import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { batchSchema, loadInstructions, planPrompt, runCodex } from "../src/codex.ts";
import { validateBatch } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const count = 3;
const models = Array<string>(4).fill("crimson-oath");
const model = "gpt-6.1-sol";
const reasoningEffort = "high";
const theme = "An adult heroine keeping vigil in an observatory during the last hour before dawn. Use portrait through mid-thigh compositions that can read independently.";
const exampleIds = ["ND-P02", "ND-P05", "ND-P10", "ND-P14", "ND-P19", "ND-P22"];
const catalog = JSON.parse(await readFile(join(root, "prompts/experiments/ns-025-pose-catalog.json"), "utf8")) as {
  id: string;
  description: string;
  support: string;
  views: string[];
  crops: string[];
  risks: string;
}[];
const examples = exampleIds.map((id) => {
  const pose = catalog.find((entry) => entry.id === id);
  if (!pose) throw new Error(`Missing catalog entry ${id}`);
  return `- ${pose.description} Support: ${pose.support} Views: ${pose.views.join(", ")}. Crops: ${pose.crops.join(", ")}. Check: ${pose.risks}`;
});

const baseline = planPrompt(await loadInstructions(), theme, [], count, undefined, models, true);
const context = [
  "Optional pose catalog context. Use these examples as construction principles and invent variations that fit each scene.",
  "Favor readable support and relaxed hands with clear contact points. Let the crop determine which limbs to describe.",
  "Vary the supporting surface, torso direction, and visible hand placement across the batch. Follow any explicit composition requirements and relevant feedback first.",
  ...examples,
].join("\n");
const candidate = `${baseline}\n\n${context}`;
const schema = await batchSchema(count, undefined, models);
const outputRoot = join(root, "output/ns-025");
await mkdir(outputRoot, { recursive: true });
const outDir = await mkdtemp(join(outputRoot, "director-"));
console.log(outDir);

for (const [variant, prompt] of [["baseline", baseline], ["candidate", candidate]]) {
  const inputs = { model, reasoningEffort, count, models, theme, prompt, schema };
  const outFile = join(outDir, `${variant}.json`);
  await writeFile(outFile, JSON.stringify(inputs, null, 2));
  try {
    console.log(`${variant}: calling ${model} once (${prompt.length} chars)`);
    const result = await runCodex(prompt, schema, 300_000, undefined, { model, reasoningEffort });
    let validationError = null;
    try {
      validateBatch(result.json, count, { models });
    } catch (error) {
      validationError = (error as Error).message;
      process.exitCode = 1;
    }
    await writeFile(outFile, JSON.stringify({
      ...inputs,
      seconds: result.ms / 1000,
      tokens: result.tokens,
      validationError,
      result: result.json,
    }, null, 2));
    console.log(`${variant}: ${result.ms / 1000}s, validation ${validationError ?? "passed"}`);
  } catch (error) {
    await writeFile(outFile, JSON.stringify({ ...inputs, error: (error as Error).message }, null, 2));
    console.error(`${variant}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
