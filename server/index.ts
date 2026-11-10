import { join, resolve } from "node:path";
import { ComfyClient, loadWorkflow } from "../src/comfy.ts";
import { generateBatch } from "../src/codex.ts";
import { buildApp } from "./app.ts";
import { AutopilotRunner } from "./runner.ts";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT ?? 8787);
const comfyUrl = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
const collectionsDir = process.env.COLLECTIONS_DIR ?? join(root, "output/collections");

const batchesDir = join(root, "output/batches");
const runner = new AutopilotRunner({
  client: new ComfyClient(comfyUrl),
  plan: generateBatch,
  baseGraph: await loadWorkflow(join(root, "workflows/anima-crimson-oath.api.json")),
  collectionsDir,
  batchesDir,
  log: (s) => console.log(s),
});

const app = buildApp({ runner, collectionsDir, batchesDir, thumbsDir: process.env.THUMBS_DIR ?? join(root, "output/thumbs"), comfyUrl, port, webDist: join(root, "web/dist") });
await app.listen({ host: "127.0.0.1", port });
console.log(`NeuroStudio: http://127.0.0.1:${port}  (ComfyUI: ${comfyUrl})`);
