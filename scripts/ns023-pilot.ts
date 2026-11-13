// NS-023 pilot 01 (experiment A, quality prefix): 1 model x 2 concepts x 2 seeds x 2 prefixes = 8 images.
// Prepares reproducible ComfyUI graphs and a blind scoring sheet. By default it does NOT contact ComfyUI.
//   npx tsx scripts/ns023-pilot.ts              prepare files in output/ns023-pilot-01/ (no GPU)
//   npx tsx scripts/ns023-pilot.ts --execute    also generate the 8 images through the existing runner (needs ComfyUI; GPU)
// The pilot only checks that the hypothesis is worth a larger test. It does not pick a winner. See docs/ns-023-anima-validation-plan.md.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ComfyClient, MODELS, applyParams, loadWorkflow, type Graph } from "../src/comfy.ts";
import { runCollection, type Job } from "../src/collection.ts";
import { writeAtomic } from "../src/persistence.ts";
import type { PromptPlan } from "../src/promptPlan.ts";

const root = resolve(import.meta.dirname, "..");
export const PILOT_ID = "ns023-pilot-01";
export const WORKFLOW = join(root, "workflows/anima-crimson-oath.api.json");

export const MODEL = "crimson-oath" as const;
export const SEEDS = [101, 2024];

/** The production prefix (section A of the Creative Director) and the candidate: the same prefix with five tags REMOVED, nothing added. */
export const PREFIX_CURRENT = "realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, intricate details, cinematic dramatic lighting, strong chiaroscuro,";
export const PREFIX_CANDIDATE = "realistic, masterpiece, best quality, absurdres,";
export const REMOVED_TAGS = ["ultra detailed", "sharp focus", "intricate details", "cinematic dramatic lighting", "strong chiaroscuro"];

/** Hand-written prompts in the current house format (blocks 2-7). Light belongs to the scene block, so the prefix does not have to supply it. */
export const CONCEPTS = [
  {
    id: "K1",
    title: "Daytime seaside terrace, casual, seated",
    blocks: [
      "solo female, adult woman, 33 years old, original character, mature face, adult body, huge breast,",
      "dark brown skin, warm brown eyes, thick straight eyebrows, short natural black curls pulled back with a wide cream headband, broad relaxed smile,",
      "sitting on a low whitewashed terrace wall, one palm flat on the stone beside her for support, bare feet on the tiles, looking toward the viewer,",
      "white cotton shirt knotted above the waist with rolled sleeves, high-waisted blue denim shorts, small gold stud earrings,",
      "sunny seaside terrace, whitewashed wall, terracotta pots with lemon trees, blue sea and a clear horizon behind her,",
      "slightly elevated three-quarter view, full seated composition, bright midday sunlight from the upper left, warm highlights on skin and cotton, glossy semi-realistic illustration",
    ],
  },
  {
    id: "K2",
    title: "Evening apartment, fitted satin dress, standing, side view",
    blocks: [
      "solo female, adult woman, 30 years old, original character, mature face, adult body, huge breast,",
      "fair skin, oval face, grey-green eyes, straight dark eyebrows, deep red lipstick, chin-length black hair in a sleek blunt bob, short blunt bangs,",
      "standing beside a tall window, one hand on the window frame edge, looking at the viewer over her shoulder,",
      "fitted plum satin midi dress, high neck, sleeveless, side slit, thin gold bracelet,",
      "modern apartment living room at evening, low sofa, floor lamp, city lights through the window,",
      "side view, waist-up composition, warm lamp light from the left, cool blue light from the window, glossy illustrative semi-realism",
    ],
  },
] as const;

/** Which label (X or Y) carries the CURRENT prefix, per pair in order: balanced inside every concept and fixed in advance. */
export const CURRENT_IS = ["X", "Y", "Y", "X"] as const;

export const CRITERIA = ["adherence", "anatomy", "face", "outfit", "background", "gloss", "composition", "appeal"] as const;

export interface PilotJob extends Job {
  pair: string;
  concept: string;
  label: "X" | "Y";
  prefix: "current" | "candidate";
  positive: string;
}

export const positiveOf = (conceptId: string, prefix: string): string => `${prefix}\n\n${CONCEPTS.find((c) => c.id === conceptId)!.blocks.join("\n\n")}`;

/** The 8 jobs. Per pair the graphs differ ONLY in the positive prompt (the prefix) and the output file name. */
export function buildPilot(base: Graph): { jobs: PilotJob[]; key: Record<string, { pair: string; prefix: string }> } {
  const jobs: PilotJob[] = [];
  let pairNo = 0;
  for (const c of CONCEPTS) {
    for (const seed of SEEDS) {
      const pair = `${c.id}-s${seed}`;
      const currentLabel = CURRENT_IS[pairNo++ % CURRENT_IS.length];
      for (const label of ["X", "Y"] as const) {
        const prefix = label === currentLabel ? "current" : "candidate";
        const file = `${pair}-${label}`;
        const positive = positiveOf(c.id, prefix === "current" ? PREFIX_CURRENT : PREFIX_CANDIDATE);
        const graph = applyParams(base, {
          positive,
          seed,
          unet: MODELS[MODEL],
          filenamePrefix: `NeuroStudio/${PILOT_ID}/${file}`,
        });
        jobs.push({ frame: jobs.length + 1, variant: 1, file, model: MODEL, seed, summary: `${c.title} (${pair} ${label})`, graph, pair, concept: c.id, label, prefix, positive });
      }
    }
  }
  const key = Object.fromEntries(jobs.map((j) => [j.file, { pair: j.pair, prefix: j.prefix }]));
  return { jobs, key };
}

/** Throws unless the two graphs of every pair are identical apart from the positive prompt and the file name. */
export function assertPairsIdentical(jobs: PilotJob[]): void {
  const strip = (g: Graph) => {
    const c = structuredClone(g);
    delete c["90:77"].inputs.text;
    delete c["46"].inputs.filename_prefix;
    return JSON.stringify(c);
  };
  for (const pair of new Set(jobs.map((j) => j.pair))) {
    const [a, b] = jobs.filter((j) => j.pair === pair);
    if (strip(a.graph) !== strip(b.graph)) throw new Error(`pair ${pair}: graphs differ in more than the prompt`);
    const body = (j: PilotJob) => j.positive.replace(PREFIX_CURRENT, "").replace(PREFIX_CANDIDATE, "");
    if (body(a) !== body(b)) {
      throw new Error(`pair ${pair}: prompts differ beyond the prefix`);
    }
  }
}

/** Blank scoring sheet: one row per pair, 1-5 per criterion for X and Y, then the overall preference. Labels hide which prefix is which. */
export function scoringSheet(jobs: PilotJob[]): string {
  const head = ["pair", "image_X", "image_Y", ...CRITERIA.flatMap((c) => [`${c}_X`, `${c}_Y`]), "prefer(X/Y/tie)", "notes"];
  const rows = [...new Set(jobs.map((j) => j.pair))].map((pair) => [pair, `${pair}-X.png`, `${pair}-Y.png`, ...CRITERIA.flatMap(() => ["", ""]), "", ""]);
  return [head, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}

/** Everything that must be identical between runs, read from the workflow itself rather than typed in. */
export function fixedParameters(base: Graph, workflowSha256: string) {
  const n = (id: string) => base[id].inputs;
  return {
    workflow: "workflows/anima-crimson-oath.api.json",
    workflowSha256,
    checkpoint: MODELS[MODEL],
    textEncoder: n("90:71").clip_name,
    vae: n("90:72").vae_name,
    sampler: n("90:76").sampler_name,
    scheduler: n("90:76").scheduler,
    denoise: n("90:76").denoise,
    cfg: n("90:86").value,
    steps: n("90:79").value,
    resolution: { aspectRatio: n("91").aspect_ratio, megapixels: n("91").megapixels, multiple: n("91").multiple },
    turboLora: "off (workflow switch unchanged)",
    negative: n("90:75").text,
    seeds: SEEDS,
    prefixes: { current: PREFIX_CURRENT, candidate: PREFIX_CANDIDATE, removedTags: REMOVED_TAGS },
  };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const out = join(root, "output", PILOT_ID);
  const base = await loadWorkflow(WORKFLOW);
  const sha = createHash("sha256").update(await readFile(WORKFLOW)).digest("hex");
  const { jobs, key } = buildPilot(base);
  assertPairsIdentical(jobs);

  await mkdir(join(out, "graphs"), { recursive: true });
  await writeAtomic(join(out, "spec.json"), JSON.stringify({ id: PILOT_ID, fixed: fixedParameters(base, sha), concepts: CONCEPTS, jobs: jobs.map(({ file, pair, seed }) => ({ file, pair, seed })) }, null, 2));
  await writeAtomic(join(out, "key.json"), JSON.stringify({ note: "Do NOT open before scoring: it says which label carries which prefix.", key }, null, 2));
  await writeAtomic(join(out, "scores.csv"), scoringSheet(jobs));
  for (const j of jobs) await writeAtomic(join(out, "graphs", `${j.file}.api.json`), JSON.stringify(j.graph, null, 2));
  console.log(`Prepared ${jobs.length} jobs (${jobs.length / 2} pairs) in ${out}\nNo ComfyUI contact. ${execute ? "" : "Add --execute to generate the images."}`);
  if (!execute) return;

  const plan: PromptPlan = {
    concept: { title: `NS-023 ${PILOT_ID}`, description: "Quality prefix pilot: current vs candidate.", heroine: "see spec.json" },
    frames: jobs.map((j) => ({ frame: j.frame, model: MODEL, summary: j.summary, positive: j.positive })),
  };
  const client = new ComfyClient(process.env.COMFY_URL ?? "http://127.0.0.1:8188");
  await runCollection({ plan, jobs, dir: join(out, "run"), client, log: console.log });
  console.log(`Images in ${join(out, "run")}. Score them blind in scores.csv, then open key.json.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
