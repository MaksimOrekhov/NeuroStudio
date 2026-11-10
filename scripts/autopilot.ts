import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ComfyClient, loadWorkflow } from "../src/comfy.ts";
import { CodexError, generatePlan } from "../src/codex.ts";
import { buildJobs, runCollection, slugify } from "../src/collection.ts";
import { autoMix } from "../src/imageModels.ts";
import { parseFrames, parseVariations, summarize, validatePlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
const USAGE = `Usage: npm run autopilot -- [--execute] [--theme "text"] [--plan file.json]
  (default)   Dry run: validate a saved plan (docs/examples/prompt-plan.sample.json), no Codex, no ComfyUI.
  --execute   Real run: Codex plan (unless --plan is given) -> ComfyUI -> one PNG per frame x variation in output/collections/.
  --theme     Optional theme hint for Codex.
  --plan      Use this plan file instead of calling Codex.
  --variations 1|2|4  Seed variants per scene (default 1).
  --frames 1-4        Frames in the collection (default 4; Auto Mix of the image models).`;

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const execute = argv.includes("--execute");
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const planFile = opt("--plan");
const theme = opt("--theme");
const variations = parseVariations(opt("--variations") ? Number(opt("--variations")) : undefined);
const frames = parseFrames(opt("--frames") ? Number(opt("--frames")) : undefined);

async function main() {
  const t0 = Date.now();
  let codex: { seconds: number; tokens: unknown } | undefined;
  let plan;
  if (planFile || !execute) {
    const file = resolve(planFile ?? join(root, "docs/examples/prompt-plan.sample.json"));
    const raw = JSON.parse(await readFile(file, "utf8"));
    // A Plan v3 (Russian metadata present) is checked against its own model assignment; older plans the old way.
    plan = validatePlan(raw, raw?.concept?.titleRu ? { models: raw.frames?.map((f: { model: string }) => f.model) } : { legacy: true });
    console.log(`Plan loaded from ${file}`);
  } else {
    console.log("Asking Codex for a plan (1 request)...");
    const r = await generatePlan({ theme, models: autoMix(frames) });
    plan = r.plan;
    codex = { seconds: r.ms / 1000, tokens: r.tokens };
    console.log(`Codex: ${(r.ms / 1000).toFixed(1)}s, tokens: ${r.tokens ? JSON.stringify(r.tokens) : "n/a"}`);
  }
  console.log("\n" + summarize(plan) + "\n");

  const base = await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json"));
  const slug = slugify(plan.concept.title);
  const jobs = buildJobs(plan, base, slug, variations);
  console.log("Queue: " + jobs.map((j) => `${j.file}:${j.model}`).join(" -> "));
  if (!execute) {
    console.log(`\nDry run OK (plan valid, ${jobs.length} jobs built). Use --execute for a real run.`);
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const dir = join(root, "output/collections", `${date}-${slug}-${Date.now().toString(36)}`);
  const client = new ComfyClient(process.env.COMFY_URL ?? "http://127.0.0.1:8188");
  const m = await runCollection({ plan, jobs, dir, client, codex, log: console.log });
  const total = (Date.now() - t0) / 1000;
  console.log(`\nCollection ${m.status}: ${dir}`);
  console.log(`Total ${total.toFixed(0)}s (Codex ${codex ? codex.seconds.toFixed(0) : 0}s, ComfyUI ${m.comfySeconds?.toFixed(0)}s)`);
}

main().catch((e) => {
  const m = (e as { manifest?: { dir: string } }).manifest;
  console.error(`\nFAILED (${(e as Error).name}): ${(e as Error).message}`);
  if (m) console.error(`Partial results and prompt_ids: ${m.dir}\collection.json`);
  if (e instanceof CodexError) console.error("No retry was made. Check `codex login status` and CLI version.");
  process.exit(1);
});
