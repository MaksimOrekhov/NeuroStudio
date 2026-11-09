import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { summarize, validatePlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const schema = join(root, "schemas/prompt-plan.schema.json");
const outDir = join(root, "output/prompt-plans");

const PROMPT = `You are the creative director of NeuroDreams, a collection of semi-realistic portrait sets.
Invent ONE original concept yourself (no theme is given) and return a Prompt Plan as JSON matching the supplied schema.

Rules:
- Exactly 4 frames, numbered 1-4, one single adult heroine (age 21+, state "adult woman, 25 years old" or similar in every positive prompt). Same heroine look in all frames (put her fixed look in concept.heroine and repeat it in each positive prompt).
- Frames 1 and 3 use model "crimson-oath", frames 2 and 4 use "duskrose". Both are anime-lineage checkpoints driven by comma-separated tags: start positive with quality tags (realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, refined semi-realistic rendering), then subject, outfit, hairstyle, pose, setting, lighting. Crimson Oath: warmer, painterly, dramatic. Duskrose: softer, moodier, twilight palettes.
- One coherent concept with visual unity (palette, location family, mood), but each frame differs in outfit, hairstyle, pose and viewing-angle wording, and scene composition. No repeated scenes.
- Beautiful, tasteful, non-explicit.
- Never use these words or phrases anywhere: brushing, camera, framing, twisted, parted lips, wide hips.
- negative: a concise tag list adapted per model (worst quality, low quality, blurry, bad anatomy, bad hands, extra fingers, signature, watermark, text, plus anything frame-specific).
- summary: one short sentence describing the frame.
Return only the JSON.`;

function run(): Promise<string> {
  return new Promise((res, rej) => {
    const outFile = join(outDir, "codex-last-message.json");
    const p = spawn("codex", ["exec", ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL, "-c", "model_reasoning_effort=low"] : []), "--sandbox", "read-only", "--ephemeral", "--output-schema", schema, "-o", outFile, "-"], {
      cwd: root,
      shell: true, // codex is a .cmd shim on Windows
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.on("error", rej);
    p.on("close", async (code) => {
      if (code !== 0) return rej(new Error(`codex exited with code ${code}`));
      res(await readFile(outFile, "utf8"));
    });
    p.stdin.end(PROMPT);
  });
}

await mkdir(outDir, { recursive: true });
try {
  const raw = await run();
  const plan = validatePlan(JSON.parse(raw));
  const file = join(outDir, `plan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(plan, null, 2));
  console.log(`\nSaved ${file}\n\n${summarize(plan)}`);
} catch (e) {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
}
