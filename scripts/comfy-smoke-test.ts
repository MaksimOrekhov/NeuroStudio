import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ComfyClient, applyParams, loadWorkflow, type GenParams } from "../src/comfy.ts";

const baseUrl = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
const workflowPath = resolve(import.meta.dirname, "../workflows/anima-crimson-oath.api.json");
const outDir = resolve(import.meta.dirname, "../output/smoke");

async function main() {
  const comfy = new ComfyClient(baseUrl);

  // 1. Preflight: reachable? queue idle? (we never interrupt or clear existing jobs)
  const stats = await comfy.systemStats();
  console.log(`ComfyUI ${stats.system.comfyui_version} at ${baseUrl}`);
  const q = await comfy.queue();
  if (q.queue_running.length || q.queue_pending.length) {
    throw new Error(`Queue is busy (running=${q.queue_running.length}, pending=${q.queue_pending.length}); not submitting.`);
  }

  // 2. Load workflow, patch an in-memory copy
  const original = await loadWorkflow(workflowPath);
  const params: GenParams = {
    positive: "masterpiece, best quality, a lone lighthouse on a rocky coast at sunset, dramatic clouds, detailed illustration",
    seed: Math.floor(Math.random() * 2 ** 48),
    filenamePrefix: "NeuroStudio/smoke",
  };
  const graph = applyParams(original, params);

  // 3. Verify nodes and model files exist on this ComfyUI
  const problems = await comfy.checkDependencies(graph);
  if (problems.length) throw new Error("Missing dependencies:\n  " + problems.join("\n  "));

  // 4. Submit, wait, download
  const t0 = Date.now();
  const promptId = await comfy.submit(graph, randomUUID());
  console.log(`Submitted prompt_id=${promptId}`);
  const { images, history } = await comfy.waitForImages(promptId);
  const png = await comfy.download(images[0]);
  const seconds = (Date.now() - t0) / 1000;

  // 5. Save PNG + metadata (output/ is git-ignored)
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `smoke-${promptId}`);
  await writeFile(`${base}.png`, png);
  await writeFile(
    `${base}.json`,
    JSON.stringify({ promptId, comfyVersion: stats.system.comfyui_version, workflow: "anima-crimson-oath.api.json", params, seconds, image: images[0], graph, history }, null, 2),
  );
  console.log(`OK: ${png.length} bytes, ${seconds.toFixed(1)}s -> ${base}.png`);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
});
