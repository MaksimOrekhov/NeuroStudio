// NS-017: targeted regeneration of ONE image of an existing collection (no Codex, no new plan).
// The source of every setting is the ComfyUI graph that was saved next to the source variant (<scene-name>.json):
// only positive prompt (when edited), seed and filename prefix change. Existing images, sidecars and prompts are never touched.
import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { FIELDS, ComfyUnavailableError, applyParams, depthOf, removeDepth, setDepthImage, type ComfyClient, type Graph, type ImageRef } from "./comfy.ts";
import type { Settings } from "./composition.ts";
import { promptMismatch, readConditioning, type Conditioning, type DepthChoice, type Mismatch } from "./depth.ts";
import { MapIdentityError, adapterInstructions, comfyName, ensureMap, loadDepthLibrary, localMap, remoteInput } from "./depthLibrary.ts";
import { loadPoseCatalog } from "./poses.ts";
import type { FrameRecord, Manifest } from "./collection.ts";
import type { ErrorCode } from "./errors.ts";
import { io, writeAtomic } from "./persistence.ts";
import { readFramePose, type FramePose } from "./poses.ts";
export { io, writeAtomic } from "./persistence.ts";

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
  /** NS-026: the source's pose record (absent for images made without the pose catalog). */
  pose?: FramePose;
  /** NS-027: the source's conditioning record (absent when Depth was not requested). */
  conditioning?: Conditioning;
  /** NS-027: the collection's explicit composition requirements for this frame ({} = none). */
  requirements: Settings;
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
  let side: { graph?: unknown; promptEdited?: unknown; pose?: unknown; conditioning?: unknown };
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
  const pose = readFramePose(side.pose) ?? readFramePose(rec.pose);
  const conditioning = readConditioning(side.conditioning) ?? readConditioning(rec.conditioning);
  const requirements = { ...(m.generation?.composition?.[frame - 1] ?? {}) };
  return { frame, variant, model: rec.model, positive: text, graph, promptEdited: side.promptEdited === true, ...(pose ? { pose } : {}), ...(conditioning ? { conditioning } : {}), requirements };
}

export interface Reservation {
  name: string;
  variant: number;
  seed: number;
  graph: Graph;
  positive: string;
  promptEdited: boolean;
  pose?: FramePose;
  conditioning?: Conditioning;
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

const saveManifest = (cdir: string, m: Manifest) => writeAtomic(join(cdir, "collection.json"), JSON.stringify(m, null, 2));

const writeSidecar = (cdir: string, name: string, data: Record<string, unknown>) => writeAtomic(join(cdir, `${name}.json`), JSON.stringify(data, null, 2));

/**
 * Builds the new variant (number, seed, graph) and writes its slot into collection.json as "pending" together with its
 * sidecar. The number is the highest one ever recorded for the frame + 1 (failed attempts keep their number) and moves on
 * if a file with that name already exists; it is never reused and nothing is overwritten.
 */
export async function reserve(dir: string, id: string, src: RegenSource, positive: string | undefined, depth?: RegenDepth): Promise<Reservation> {
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
  // NS-027: the Depth nodes of the saved graph stay as they are unless the user dropped them (prepareRegenDepth).
  const graph = applyParams(depth?.graph ?? src.graph, { positive: text, seed, filenamePrefix: `${folder}/${name}` });
  const conditioning = depth ? depth.conditioning : src.conditioning;
  const promptEdited = positive !== undefined && positive !== src.positive;
  // NS-026: an unchanged prompt keeps the source's planned pose. After an edit the provenance stays, but the prompt is no longer the planned one.
  const pose: FramePose | undefined = src.pose && (promptEdited ? { ...src.pose, promptAsPlanned: false } : src.pose);
  const record: FrameRecord = { frame: src.frame, variant, model: src.model, seed, status: "pending", sourceVariant: src.variant, ...(promptEdited ? { promptEdited: true } : {}), ...(pose ? { pose } : {}), ...(conditioning ? { conditioning } : {}) };
  await writeSidecar(cdir, name, { frame: src.frame, variant, model: src.model, seed, sourceVariant: src.variant, promptEdited, ...(pose ? { pose } : {}), ...(conditioning ? { conditioning } : {}), positive: text, status: "pending", graph });
  m.frames.push(record);
  try {
    await saveManifest(cdir, m);
  } catch (e) {
    m.frames.pop(); // nothing was submitted: the slot does not exist; the old collection.json is untouched
    await io.unlink(join(cdir, `${name}.json`)).catch(() => {});
    throw e;
  }
  return { name, variant, seed, graph, positive: text, promptEdited, ...(pose ? { pose } : {}), ...(conditioning ? { conditioning } : {}), record, manifest: m, collectionDir: cdir };
}

type Client = Pick<ComfyClient, "systemStats" | "checkDependencies" | "submit" | "waitForImages" | "download">;

// ---------- NS-027: Depth on regeneration ----------

/** The graph to regenerate from and the conditioning record of the new variant. */
export interface RegenDepth {
  graph: Graph;
  conditioning?: Conditioning;
}

/**
 * Decides what happens to the source's depth map BEFORE anything is reserved:
 * - no Depth in the source graph: unchanged (a keep/drop choice is a 400);
 * - unchanged prompt: keep by default, drop on request;
 * - edited prompt: checked against the map's stored spec (view, shot size, gesture, hand side...); a conflict without an explicit
 *   choice is DEPTH_CONFLICT (409);
 * - drop: the three nodes go and KSampler gets its original model link back;
 * - keep: ComfyUI must list the nodes and the adapter, and its input folder must hold a file whose SHA-256 is the recorded one
 *   (checked through /view, never assumed from the name). A missing copy is uploaded again under the content-addressed name, taken
 *   from the library map with that hash or from the file the saved graph points to (an older subfolder path), both hash-checked; the
 *   new graph then points to that name. Anything else is DEPTH_UNAVAILABLE (409): never a silent switch to text, never another map.
 */
export async function prepareRegenDepth(o: {
  src: RegenSource;
  positive?: string;
  choice?: DepthChoice;
  client: Partial<Pick<ComfyClient, "objectInfo" | "uploadImage" | "download">>;
  depthDir: string;
  poseCatalogPath?: string;
}): Promise<RegenDepth> {
  const { src } = o;
  const d = depthOf(src.graph);
  if (!d) {
    if (o.choice) throw new RegenError("INVALID_REQUEST", "this variant was generated without a depth map", 400);
    return { graph: src.graph, ...(src.conditioning ? { conditioning: src.conditioning } : {}) };
  }
  const cond = src.conditioning?.mode === "depth" ? src.conditioning : undefined;
  const edited = o.positive !== undefined && o.positive !== src.positive;
  let conflict: Mismatch | null = null;
  if (edited) conflict = cond ? promptMismatch(cond.spec, o.positive!, src.requirements) : { reason: "map-invalid", detail: "the source has no Depth record to check the edited prompt against" };
  const choice = o.choice ?? (conflict ? undefined : "keep");
  if (!choice) throw new RegenError("DEPTH_CONFLICT", `the edited prompt does not clearly fit the depth map (${conflict!.reason}${conflict!.detail ? `: ${conflict!.detail}` : ""}); choose to keep or drop the map`, 409);
  if (choice === "drop") {
    return { graph: removeDepth(src.graph), ...(cond ? { conditioning: { mode: "text", userDecision: "drop", droppedFrom: { mapId: cond.mapId, mapSha256: cond.mapSha256 } } } : {}) };
  }
  const unavailable = (why: string) => new RegenError("DEPTH_UNAVAILABLE", `${why}; regenerate without the map`, 409);
  if (!cond) throw unavailable("the source has no Depth record, so the identity of its map cannot be verified");
  const client = o.client;
  if (!client.objectInfo || !client.download || !client.uploadImage) throw unavailable("the ComfyUI client cannot verify the map");
  let info: Record<string, any>;
  try {
    info = await client.objectInfo();
  } catch (e) {
    throw new RegenError("COMFY_UNREACHABLE", `ComfyUI is not reachable: ${(e as Error).message}`, 503);
  }
  if (!["LoadImage", "ModelPatchLoader", "AnimaLLLiteApply"].every((c) => info[c])) throw unavailable("ComfyUI has no Anima LLLite nodes");
  const patches = info.ModelPatchLoader?.input?.required?.name?.[0];
  if (!Array.isArray(patches) || !patches.includes(d.adapter)) {
    let help = "";
    try {
      const lib = loadDepthLibrary(o.depthDir, loadPoseCatalog(o.poseCatalogPath));
      if (lib.ok) help = `\n${adapterInstructions(lib.library)}`;
    } catch {
      /* the instructions are a courtesy */
    }
    throw new RegenError("DEPTH_UNAVAILABLE", `the Depth adapter ${d.adapter} is not listed by ComfyUI; regenerate without the map or install it${help}`, 409);
  }
  // Where an identical copy can come from if ComfyUI does not have it: the library map with this hash, else the saved graph's file.
  const copy = async (): Promise<Buffer> => {
    try {
      const lib = loadDepthLibrary(o.depthDir, loadPoseCatalog(o.poseCatalogPath));
      const same = lib.ok ? lib.library.maps.find((m) => m.sha256 === cond.mapSha256) : undefined;
      if (lib.ok && same) return localMap(lib.library, same);
    } catch {
      /* fall through to the file in ComfyUI */
    }
    const remote = d.imageName ? await remoteInput(client, d.imageName) : null;
    if (remote && createHash("sha256").update(remote).digest("hex") === cond.mapSha256) return remote;
    throw new MapIdentityError(`no copy with sha256 ${cond.mapSha256} in the local library or in ComfyUI`);
  };
  let image: string;
  try {
    image = await ensureMap(client, cond.mapSha256, comfyName({ id: cond.mapId, sha256: cond.mapSha256 }), copy);
  } catch (e) {
    throw unavailable(`the depth map cannot be verified in ComfyUI: ${(e as Error).message}`);
  }
  const graph = image === d.imageName ? src.graph : setDepthImage(src.graph, image);
  const kept = { ...cond, comfyImage: image, ...(o.choice === "keep" ? { userDecision: "keep" as const } : {}), ...(conflict ? { conflict: { reason: conflict.reason, ...(conflict.detail ? { detail: conflict.detail } : {}) } } : {}) };
  return { graph, conditioning: kept };
}

/**
 * Runs the reserved job once. Never resubmits. A rejected or failed job is recorded as "failed"; if ComfyUI accepted the job
 * and then vanished or timed out, the record becomes "timeout" (indeterminate) and keeps its prompt_id. The collection's own
 * status is never changed.
 */
export async function runRegeneration(opts: { r: Reservation; client: Client; frameTimeoutMs?: number; log?: (s: string) => void; onProgress?: () => void }): Promise<FrameRecord> {
  const { r, client } = opts;
  const rec = r.record;
  const cdir = r.collectionDir;
  const base = { frame: rec.frame, variant: r.variant, model: rec.model, seed: r.seed, sourceVariant: rec.sourceVariant, promptEdited: r.promptEdited, ...(r.pose ? { pose: r.pose } : {}), ...(r.conditioning ? { conditioning: r.conditioning } : {}), positive: r.positive, graph: r.graph };
  const t0 = Date.now();
  /** Persistence problems after ComfyUI accepted the job: never fatal for the job itself, never a reason to resubmit. */
  const problems: string[] = [];
  const side = (extra: Record<string, unknown>) => writeSidecar(cdir, r.name, { ...base, promptId: rec.promptId, ...extra });
  const save = async () => {
    await saveManifest(cdir, r.manifest);
    opts.onProgress?.();
  };
  const trySave = async () => {
    try {
      await save();
    } catch (e) {
      problems.push(`collection.json: ${(e as Error).message}`);
    }
  };
  const tag = () => (rec.promptId ? ` [prompt_id ${rec.promptId}]` : "");
  const fail = async (status: FrameRecord["status"], e: Error) => {
    rec.status = status;
    rec.error = e.message + tag() + (problems.length ? ` (could not be saved: ${problems.join("; ")})` : "");
    rec.seconds = (Date.now() - t0) / 1000;
    await side({ status, seconds: rec.seconds, error: rec.error }).catch(() => {});
    await trySave();
    e.message = rec.error;
  };
  try {
    await client.systemStats();
    const problemsDeps = await client.checkDependencies(r.graph);
    if (problemsDeps.length) throw new Error(`Missing dependencies for ${rec.model}:\n  ${problemsDeps.join("\n  ")}`);
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
  // The job is accepted. FIRST make the prompt_id durable in the variant's own sidecar (a new file, written atomically), THEN try the
  // manifest. A failure of either is recorded and the job is still awaited; it is never submitted again.
  rec.status = "submitted";
  try {
    await side({ status: "submitted" });
  } catch (e) {
    problems.push(`${r.name}.json: ${(e as Error).message}`);
  }
  await trySave();
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
    await io.writeFile(join(cdir, `${r.name}.png`), png, { flag: "wx" }); // never overwrites
  } catch (e) {
    await fail("failed", e as Error); // the job finished in ComfyUI (prompt_id kept) but its image could not be stored
    throw e;
  }
  rec.png = `${r.name}.png`;
  rec.seconds = (Date.now() - t0) / 1000;
  rec.status = "done";
  try {
    await side({ status: "done", seconds: rec.seconds, image: images[0], history });
  } catch (e) {
    problems.push(`${r.name}.json: ${(e as Error).message}`);
  }
  try {
    await save();
  } catch (e) {
    // The PNG is on disk and (if the sidecar was written) described there; the manifest still lists the slot as submitted. Reading the
    // collection recovers the slot from its sidecar. Report it instead of pretending everything is saved.
    throw new Error(`The image ${rec.png} was created${tag()} but collection.json could not be updated: ${(e as Error).message}`);
  }
  opts.log?.(`regenerated ${r.name} in ${rec.seconds!.toFixed(1)}s`);
  return rec;
}
