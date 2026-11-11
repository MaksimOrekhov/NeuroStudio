// NS-017: targeted regeneration of ONE image of an existing collection (no Codex, no new plan).
// The source of every setting is the ComfyUI graph that was saved next to the source variant (<scene-name>.json):
// only positive prompt (when edited), seed and filename prefix change. Existing images, sidecars and prompts are never touched.
import { randomInt, randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { FIELDS, ComfyUnavailableError, applyParams, type ComfyClient, type Graph, type ImageRef } from "./comfy.ts";
import type { FrameRecord, Manifest } from "./collection.ts";
import type { ErrorCode } from "./errors.ts";

const SEED_MAX = 2 ** 48 - 1;
/** Matches the `-vNN` file name template (and safeImagePath in the server): variant numbers above 99 cannot be stored. */
export const MAX_VARIANT = 99;
export const POSITIVE_MAX = 4000;

const ID = /^[A-Za-z0-9._-]+$/;
const IMAGE = /^scene-\d{2}(-v\d{2})?\.png$/;
const pad = (n: number) => String(n).padStart(2, "0");

export class RegenError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface RegenSource {
  frame: number;
  variant: number;
  model: string;
  /** The positive prompt that variant was actually generated with (read from its own saved graph). */
  positive: string;
  graph: Graph;
  /** True when this variant is itself a regeneration with an edited prompt. */
  promptEdited: boolean;
}

function collectionDir(dir: string, id: string): string {
  if (!ID.test(id)) throw new RegenError("COLLECTION_NOT_FOUND", "collection not found", 404);
  const root = resolve(dir);
  const p = resolve(root, id);
  if (!p.startsWith(root + sep)) throw new RegenError("COLLECTION_NOT_FOUND", "collection not found", 404);
  return p;
}

async function readManifest(dir: string, id: string): Promise<Manifest> {
  try {
    const m = JSON.parse(await readFile(join(collectionDir(dir, id), "collection.json"), "utf8")) as Manifest;
    if (!Array.isArray(m.frames)) throw new Error("no frames");
    return m;
  } catch (e) {
    if (e instanceof RegenError) throw e;
    throw new RegenError("COLLECTION_NOT_FOUND", "collection not found", 404);
  }
}

/** Number of frames of the collection (collections made before NS-014 have no such field and had 4). */
export async function frameCountOf(dir: string, id: string): Promise<number> {
  return (await readManifest(dir, id)).frameCount ?? 4;
}

export function parseFrame(v: unknown, frameCount: number): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > frameCount) throw new RegenError("INVALID_REQUEST", `frame must be 1-${frameCount}`, 400);
  return n;
}
export function parseVariant(v: unknown, what = "variant"): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_VARIANT) throw new RegenError("INVALID_REQUEST", `${what} must be an integer 1-${MAX_VARIANT}`, 400);
  return n;
}

/** undefined = keep the source prompt. Anything else must be a non-empty string of sane size. */
export function parsePositive(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RegenError("INVALID_REQUEST", "positive must be a string", 400);
  const t = v.trim();
  if (!t) throw new RegenError("INVALID_REQUEST", "positive must not be empty", 400);
  if (t.length > POSITIVE_MAX) throw new RegenError("INVALID_REQUEST", `positive is too long (max ${POSITIVE_MAX} characters)`, 400);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) throw new RegenError("INVALID_REQUEST", "positive contains control characters", 400);
  return t;
}

const unavailable = (reason: string): RegenError => new RegenError("SOURCE_UNAVAILABLE", reason, 409);

/**
 * The finished variant `variant` of `frame`, with its saved graph. Throws RegenError: nothing is guessed, and the current
 * base workflow is never used instead of a missing or damaged graph.
 */
export async function loadSource(dir: string, id: string, frame: number, variant: number): Promise<RegenSource> {
  const m = await readManifest(dir, id);
  const rec = m.frames.find((f) => f.frame === frame && (f.variant ?? 1) === variant);
  if (!rec) throw unavailable(`frame ${frame} variant ${variant} does not exist`);
  if (rec.status !== "done" || !rec.png) throw unavailable(`frame ${frame} variant ${variant} has no finished image`);
  if (!IMAGE.test(rec.png)) throw unavailable(`frame ${frame} variant ${variant}: invalid image name`);
  const cdir = collectionDir(dir, id);
  try {
    if (!(await stat(join(cdir, rec.png))).isFile()) throw new Error("not a file");
  } catch {
    throw unavailable(`frame ${frame} variant ${variant}: image file ${rec.png} is missing on disk`);
  }
  const sidecarName = rec.png.replace(/\.png$/, ".json");
  let side: { graph?: unknown; promptEdited?: unknown };
  try {
    side = JSON.parse(await readFile(join(cdir, sidecarName), "utf8"));
  } catch {
    throw unavailable(`frame ${frame} variant ${variant}: the saved generation settings (${sidecarName}) are missing or unreadable`);
  }
  const graph = side?.graph as Graph | undefined;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw unavailable(`frame ${frame} variant ${variant}: the saved ComfyUI graph is missing`);
  const pos = graph[FIELDS.positive.node];
  const text = pos?.inputs?.[FIELDS.positive.input];
  if (pos?.class_type !== FIELDS.positive.cls || typeof text !== "string") throw unavailable(`frame ${frame} variant ${variant}: the saved graph has no positive prompt`);
  try {
    applyParams(graph, { positive: text, seed: 0, filenamePrefix: "x" }); // the graph must have the known workflow shape
  } catch (e) {
    throw unavailable(`frame ${frame} variant ${variant}: the saved graph is not usable (${(e as Error).message})`);
  }
  return { frame, variant, model: rec.model, positive: text, graph, promptEdited: side.promptEdited === true };
}

export interface Reservation {
  name: string;
  variant: number;
  seed: number;
  graph: Graph;
  positive: string;
  promptEdited: boolean;
  record: FrameRecord;
  manifest: Manifest;
  collectionDir: string;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/**
 * Atomic replace (write a temp file, rename over the target). On Windows the rename fails with EPERM/EBUSY while the UI
 * is reading the file, so it is retried briefly; as a last resort the file is written in place (never lose a prompt_id).
 */
async function saveManifest(cdir: string, m: Manifest) {
  const file = join(cdir, "collection.json");
  const text = JSON.stringify(m, null, 2);
  await writeFile(file + ".tmp", text);
  for (let i = 0; i < 8; i++) {
    try {
      await rename(file + ".tmp", file);
      return;
    } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  await writeFile(file, text);
  await unlink(file + ".tmp").catch(() => {});
}

async function writeSidecar(cdir: string, name: string, data: Record<string, unknown>) {
  await writeFile(join(cdir, `${name}.json`), JSON.stringify(data, null, 2));
}

/**
 * Builds the new variant (number, seed, graph) and writes its slot into collection.json as "pending" together with its
 * sidecar. The number is the highest one ever recorded for the frame + 1 (failed attempts keep their number) and moves on
 * if a file with that name already exists; it is never reused and nothing is overwritten.
 */
export async function reserve(dir: string, id: string, src: RegenSource, positive: string | undefined): Promise<Reservation> {
  const cdir = collectionDir(dir, id);
  const m = await readManifest(dir, id);
  let variant = Math.max(0, ...m.frames.filter((f) => f.frame === src.frame).map((f) => f.variant ?? 1)) + 1;
  const free = async (v: number) => !(await exists(join(cdir, `scene-${pad(src.frame)}-v${pad(v)}.png`))) && !(await exists(join(cdir, `scene-${pad(src.frame)}-v${pad(v)}.json`)));
  while (variant <= MAX_VARIANT && !(await free(variant))) variant++;
  if (variant > MAX_VARIANT) throw new RegenError("VARIANT_LIMIT", `frame ${src.frame} already has the maximum of ${MAX_VARIANT} variants`, 409);
  const name = `scene-${pad(src.frame)}-v${pad(variant)}`;
  const used = new Set(m.frames.map((f) => f.seed));
  let seed = randomInt(0, SEED_MAX);
  while (used.has(seed)) seed = randomInt(0, SEED_MAX);
  const prevPrefix = src.graph[FIELDS.filenamePrefix.node]?.inputs?.[FIELDS.filenamePrefix.input];
  const folder = typeof prevPrefix === "string" && prevPrefix.includes("/") ? prevPrefix.slice(0, prevPrefix.lastIndexOf("/")) : `NeuroStudio/${id}`;
  const text = positive ?? src.positive;
  // Only these three change; negative prompt, model, sampler settings and size stay exactly as in the saved graph.
  const graph = applyParams(src.graph, { positive: text, seed, filenamePrefix: `${folder}/${name}` });
  const promptEdited = positive !== undefined && positive !== src.positive;
  const record: FrameRecord = { frame: src.frame, variant, model: src.model, seed, status: "pending", sourceVariant: src.variant, ...(promptEdited ? { promptEdited: true } : {}) };
  m.frames.push(record);
  await writeSidecar(cdir, name, { frame: src.frame, variant, model: src.model, seed, sourceVariant: src.variant, promptEdited, positive: text, status: "pending", graph });
  await saveManifest(cdir, m);
  return { name, variant, seed, graph, positive: text, promptEdited, record, manifest: m, collectionDir: cdir };
}

type Client = Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download">;

/**
 * Runs the reserved job once. Never resubmits. A rejected or failed job is recorded as "failed"; if ComfyUI accepted the job
 * and then vanished or timed out, the record becomes "timeout" (indeterminate) and keeps its prompt_id. The collection's own
 * status is never changed.
 */
export async function runRegeneration(opts: { r: Reservation; client: Client; frameTimeoutMs?: number; log?: (s: string) => void; onProgress?: () => void }): Promise<FrameRecord> {
  const { r, client } = opts;
  const rec = r.record;
  const cdir = r.collectionDir;
  const base = { frame: rec.frame, variant: r.variant, model: rec.model, seed: r.seed, sourceVariant: rec.sourceVariant, promptEdited: r.promptEdited, positive: r.positive, graph: r.graph };
  const t0 = Date.now();
  const save = async () => {
    await saveManifest(cdir, r.manifest);
    opts.onProgress?.();
  };
  const fail = async (status: FrameRecord["status"], e: Error) => {
    rec.status = status;
    rec.error = e.message;
    rec.seconds = (Date.now() - t0) / 1000;
    await writeSidecar(cdir, r.name, { ...base, status, promptId: rec.promptId, seconds: rec.seconds, error: e.message }).catch(() => {});
    await save().catch(() => {});
  };
  try {
    await client.systemStats();
    const problems = await client.checkDependencies(r.graph);
    if (problems.length) throw new Error(`Missing dependencies for ${rec.model}:\n  ${problems.join("\n  ")}`);
  } catch (e) {
    await fail("failed", e as Error); // nothing was submitted
    throw e;
  }
  try {
    rec.promptId = await client.submit(r.graph, randomUUID());
  } catch (e) {
    await fail("failed", e as Error); // rejected: nothing was accepted
    throw e;
  }
  rec.status = "submitted";
  await save();
  let images: ImageRef[];
  let history: unknown;
  try {
    ({ images, history } = await client.waitForImages(rec.promptId, opts.frameTimeoutMs ?? 20 * 60_000));
  } catch (e) {
    // Indeterminate: ComfyUI accepted the job and may still finish it. Keep prompt_id, never resubmit.
    await fail(/timed out/i.test((e as Error).message) || e instanceof ComfyUnavailableError ? "timeout" : "failed", e as Error);
    throw e;
  }
  try {
    const png = await client.download(images[0]);
    await writeFile(join(cdir, `${r.name}.png`), png, { flag: "wx" }); // never overwrites
    rec.png = `${r.name}.png`;
    rec.seconds = (Date.now() - t0) / 1000;
    rec.status = "done";
    await writeSidecar(cdir, r.name, { ...base, status: "done", promptId: rec.promptId, seconds: rec.seconds, image: images[0], history });
    await save();
  } catch (e) {
    rec.png = undefined;
    await fail("failed", e as Error); // the job finished in ComfyUI (prompt_id kept) but its image could not be stored
    throw e;
  }
  opts.log?.(`regenerated ${r.name} in ${rec.seconds!.toFixed(1)}s`);
  return rec;
}
