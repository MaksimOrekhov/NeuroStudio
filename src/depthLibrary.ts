// NS-027: the local Depth library (local/depth/library.json + PNG maps, never in git) and the per-frame decision.
// Fail-closed: an invalid entry is excluded and reported, an unclear frame gets text-only generation with a stated reason.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { COMPOSITION_OPTIONS, type CompositionField, type Settings } from "./composition.ts";
import { boosterOff, graphImageSize, type ComfyClient, type Graph } from "./comfy.ts";
import { promptMismatch, type DepthApplied, type DepthNotApplied, type DepthReason, type DepthSpec, type Side } from "./depth.ts";
import { isModelId, type ImageModelId } from "./imageModels.ts";
import { FREE_POSE, type PoseCatalog } from "./poses.ts";

/** Default library folder (git-ignored). NEUROSTUDIO_DEPTH_DIR overrides it. */
export const DEPTH_DIR = process.env.NEUROSTUDIO_DEPTH_DIR ? resolve(process.env.NEUROSTUDIO_DEPTH_DIR) : resolve(import.meta.dirname, "../local/depth");
export const LIBRARY_FILE = "library.json";
/** ComfyUI input subfolder the maps are uploaded to. */
export const COMFY_SUBFOLDER = "neurostudio-depth";
/** Only these statuses exist; only "verified" is ever applied automatically. */
export const MAP_STATUSES = ["verified", "candidate", "experimental", "rejected"] as const;
export type MapStatus = (typeof MAP_STATUSES)[number];

export interface DepthMapEntry {
  id: string;
  poseId: string;
  /** Path relative to the library folder; must stay inside it. */
  file: string;
  sha256: string;
  /** [width, height] of the PNG = the generation size it was prepared for. */
  size: [number, number];
  views: string[];
  crops: string[];
  viewpoints: string[];
  poses: string[];
  posture: "standing";
  handOnHip: { anatomical: Side; image: Side };
  models: ImageModelId[];
  depth: { strength: number; startPercent: number; endPercent: number };
  /** The map is approved only with Smooth Booster off. */
  smoothBooster: false;
  status: MapStatus;
  evidence: string;
  provenance: Record<string, string>;
}

export interface DepthLibrary {
  version: number;
  dir: string;
  adapter: { file: string; sha256: string; source?: string; license?: string; localCopy?: string };
  /** Valid entries only (files present, hash and size checked). */
  maps: DepthMapEntry[];
  /** Entries that failed validation, with the reason (they are never used). */
  excluded: { id?: string; poseId?: string; problem: string }[];
}

export type LibraryResult = { ok: true; library: DepthLibrary } | { ok: false; error: string };

const MAP_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.png$/;
const ADAPTER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.safetensors$/;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Resolves `file` inside `dir` or returns null. Rejects absolute paths, "..", backslashes, odd characters, symlinks and anything whose
 * real path leaves the library folder.
 */
export function safeMapPath(dir: string, file: unknown): string | null {
  if (typeof file !== "string" || !SAFE_FILE.test(file) || isAbsolute(file) || file.split("/").some((p) => p === "." || p === "..")) return null;
  const root = resolve(dir);
  const p = resolve(root, file);
  if (!p.startsWith(root + sep)) return null;
  try {
    if (lstatSync(p).isSymbolicLink()) return null;
    const real = realpathSync(p);
    const realRoot = realpathSync(root);
    if (!real.startsWith(realRoot + sep)) return null;
  } catch {
    return p; // missing file: reported by the caller as "file not found"
  }
  return p;
}

/** Width and height from a PNG header, or null when it is not a PNG. */
export function pngSize(b: Buffer): [number, number] | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const strList = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === "string");
const knownIds = (f: CompositionField, list: string[]) => list.every((v) => COMPOSITION_OPTIONS[f].some((o) => o.id === v));
const side = (v: unknown) => v === "left" || v === "right";

/** Problems of one entry (empty = usable); also reads the file and checks its hash and size. */
function entryProblems(e: Record<string, unknown>, dir: string, catalog: PoseCatalog): string[] {
  const errs: string[] = [];
  const pose = catalog.poses.find((p) => p.id === e.poseId);
  if (typeof e.id !== "string" || !MAP_ID.test(e.id)) errs.push("id must be lowercase letters, digits and dashes (3-64)");
  if (!pose) errs.push(`unknown poseId ${JSON.stringify(e.poseId)}`);
  if (e.poseId === FREE_POSE) errs.push(`"${FREE_POSE}" has no map`);
  if (!MAP_STATUSES.includes(e.status as MapStatus)) errs.push(`status must be one of ${MAP_STATUSES.join(", ")}`);
  for (const [k, f] of [["views", "orientation"], ["crops", "framing"], ["viewpoints", "viewpoint"], ["poses", "pose"]] as const) {
    if (!strList(e[k])) errs.push(`${k} must be a non-empty list`);
    else if (!knownIds(f, e[k] as string[])) errs.push(`${k}: unknown composition option`);
  }
  if (pose && strList(e.views) && !(e.views as string[]).every((v) => pose.views.includes(v))) errs.push(`views must be a subset of ${pose.id} views`);
  if (pose && strList(e.crops) && !(e.crops as string[]).every((v) => pose.crops.includes(v))) errs.push(`crops must be a subset of ${pose.id} crops`);
  if (pose && strList(e.poses) && !(e.poses as string[]).every((v) => pose.poses.includes(v))) errs.push(`poses must be a subset of ${pose.id} poses`);
  if (e.posture !== "standing") errs.push('posture must be "standing" (the only one supported)');
  const h = e.handOnHip as Record<string, unknown> | undefined;
  if (!h || !side(h.anatomical) || !side(h.image)) errs.push("handOnHip must give anatomical and image side (left/right)");
  if (!strList(e.models) || !(e.models as unknown[]).every(isModelId)) errs.push("models must list known image model ids");
  const d = e.depth as Record<string, unknown> | undefined;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (!d || !num(d.strength) || !num(d.startPercent) || !num(d.endPercent)) errs.push("depth needs strength, startPercent, endPercent");
  else if ((d.strength as number) <= 0 || (d.strength as number) > 2 || (d.startPercent as number) < 0 || (d.endPercent as number) > 1 || (d.startPercent as number) >= (d.endPercent as number)) errs.push("depth parameters out of range");
  if (e.smoothBooster !== false) errs.push("smoothBooster must be false (Depth is not checked with Smooth Booster)");
  if (typeof e.evidence !== "string" || !e.evidence.trim()) errs.push("evidence missing");
  const prov = e.provenance as Record<string, unknown> | undefined;
  if (!prov || typeof prov !== "object" || typeof prov.terms !== "string" || !prov.terms.trim()) errs.push("provenance.terms missing");
  const size = e.size as unknown[];
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && (n as number) > 0)) errs.push("size must be [width, height]");
  if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) errs.push("sha256 must be 64 lowercase hex characters");
  const path = safeMapPath(dir, e.file);
  if (!path) errs.push("file must be a relative .png path inside the library folder");
  else if (!errs.length) {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch {
      return [...errs, `file not found: ${e.file}`];
    }
    if (sha(buf) !== e.sha256) errs.push("sha256 does not match the file");
    const s = pngSize(buf);
    if (!s) errs.push("file is not a PNG");
    else if (s[0] !== size[0] || s[1] !== size[1]) errs.push(`PNG is ${s[0]}x${s[1]}, entry says ${size[0]}x${size[1]}`);
  }
  return errs;
}

/**
 * Reads and validates the library. A missing or unreadable library.json, or a bad adapter record, makes the whole library
 * unavailable; a bad map entry only excludes that entry. Duplicate ids exclude every entry with that id.
 */
export function loadDepthLibrary(dir: string, catalog: PoseCatalog): LibraryResult {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolve(dir, LIBRARY_FILE), "utf8"));
  } catch (e) {
    return { ok: false, error: `Depth library cannot be read at ${resolve(dir, LIBRARY_FILE)}: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || !Number.isInteger(raw.version) || (raw.version as number) < 1) return { ok: false, error: "library.version must be a positive integer" };
  const a = raw.adapter as Record<string, unknown> | undefined;
  if (!a || typeof a.file !== "string" || !ADAPTER_FILE.test(a.file) || typeof a.sha256 !== "string" || !HEX64.test(a.sha256)) {
    return { ok: false, error: "library.adapter needs a plain .safetensors file name and a sha256" };
  }
  if (!Array.isArray(raw.maps)) return { ok: false, error: "library.maps must be an array" };
  const counts = new Map<unknown, number>();
  for (const m of raw.maps as Record<string, unknown>[]) counts.set(m?.id, (counts.get(m?.id) ?? 0) + 1);
  const maps: DepthMapEntry[] = [];
  const excluded: DepthLibrary["excluded"] = [];
  for (const m of raw.maps as Record<string, unknown>[]) {
    const tag = { ...(typeof m?.id === "string" ? { id: m.id } : {}), ...(typeof m?.poseId === "string" ? { poseId: m.poseId } : {}) };
    if (!m || typeof m !== "object") {
      excluded.push({ problem: "entry must be an object" });
      continue;
    }
    const errs = (counts.get(m.id) ?? 0) > 1 ? ["duplicate id"] : entryProblems(m, dir, catalog);
    if (errs.length) excluded.push({ ...tag, problem: errs.join("; ") });
    else {
      const d = m.depth as DepthMapEntry["depth"];
      const h = m.handOnHip as DepthMapEntry["handOnHip"];
      maps.push({
        id: m.id as string, poseId: m.poseId as string, file: m.file as string, sha256: m.sha256 as string, size: [...(m.size as [number, number])],
        views: [...(m.views as string[])], crops: [...(m.crops as string[])], viewpoints: [...(m.viewpoints as string[])], poses: [...(m.poses as string[])],
        posture: "standing", handOnHip: { anatomical: h.anatomical, image: h.image }, models: [...(m.models as ImageModelId[])],
        depth: { strength: d.strength, startPercent: d.startPercent, endPercent: d.endPercent }, smoothBooster: false,
        status: m.status as MapStatus, evidence: m.evidence as string, provenance: { ...(m.provenance as Record<string, string>) },
      });
    }
  }
  const adapter: DepthLibrary["adapter"] = { file: a.file, sha256: a.sha256 };
  for (const k of ["source", "license", "localCopy"] as const) if (typeof a[k] === "string") adapter[k] = a[k] as string;
  return { ok: true, library: { version: raw.version as number, dir: resolve(dir), adapter, maps, excluded } };
}

export const specOf = (m: DepthMapEntry): DepthSpec => ({ views: m.views, crops: m.crops, viewpoints: m.viewpoints, poses: m.poses, posture: m.posture, handOnHip: m.handOnHip });

/** What ComfyUI offers for Depth (checked once per run, before anything is submitted). Only presence is checked, never the hash. */
export interface DepthEnvironment {
  nodes: boolean;
  adapter: boolean;
  error?: string;
}
type InfoClient = Partial<Pick<ComfyClient, "objectInfo">>;
export async function depthEnvironment(client: InfoClient, adapterFile: string): Promise<DepthEnvironment> {
  if (!client.objectInfo) return { nodes: false, adapter: false, error: "ComfyUI client cannot list nodes" };
  try {
    const info = await client.objectInfo();
    const nodes = ["LoadImage", "ModelPatchLoader", "AnimaLLLiteApply"].every((c) => info[c]);
    const list = info.ModelPatchLoader?.input?.required?.name?.[0];
    return { nodes, adapter: nodes && Array.isArray(list) && list.includes(adapterFile) };
  } catch (e) {
    return { nodes: false, adapter: false, error: (e as Error).message };
  }
}

export interface FrameInput {
  poseId?: string;
  model: string;
  positive: string;
  /** Explicit composition requirements of this frame (resolved); {} = none. */
  requirements: Settings;
  /** The job graph the map would be added to (size and Smooth Booster are read from it). */
  graph: Graph;
}

/** A map chosen for a frame (not yet uploaded) or the reason none can be used. */
export type FrameDecision = { ok: true; entry: DepthMapEntry } | { ok: false; reason: DepthReason; detail?: string };

/** The per-frame rules of docs/ns-027 (fixed order). Pure apart from the already-loaded library. */
export function decideFrame(input: FrameInput, lib: LibraryResult, env: DepthEnvironment | null): FrameDecision {
  const no = (reason: DepthReason, detail?: string): FrameDecision => ({ ok: false, reason, ...(detail ? { detail } : {}) });
  if (input.poseId === FREE_POSE) return no("free-pose");
  if (!input.poseId) return no("no-pose");
  if (!lib.ok) return no("library-unavailable", lib.error);
  const all = lib.library.maps.filter((m) => m.poseId === input.poseId);
  if (!all.length) {
    const bad = lib.library.excluded.find((x) => x.poseId === input.poseId);
    return bad ? no("map-invalid", `${bad.id ?? "entry"}: ${bad.problem}`) : no("no-map");
  }
  const verified = all.filter((m) => m.status === "verified");
  if (!verified.length) return no("map-not-verified", all.map((m) => `${m.id}: ${m.status}`).join(", "));
  const forModel = verified.filter((m) => m.models.includes(input.model as ImageModelId));
  if (!forModel.length) return no("model-not-compatible", `${input.model} is not among ${[...new Set(verified.flatMap((m) => m.models))].join(", ")}`);
  if (!boosterOff(input.graph)) return no("booster-untested");
  const size = graphImageSize(input.graph);
  const sized = forModel.filter((m) => size && m.size[0] === size[0] && m.size[1] === size[1]);
  if (!sized.length) return no("size-mismatch", `frame ${size ? size.join("x") : "unknown"}, map ${forModel[0].size.join("x")}`);
  let first: FrameDecision | undefined;
  for (const m of sized) {
    const mm = promptMismatch(specOf(m), input.positive, input.requirements);
    if (!mm) {
      if (!env || !env.nodes) return no("nodes-unavailable", env?.error);
      if (!env.adapter) return no("adapter-unavailable", lib.library.adapter.file);
      return { ok: true, entry: m };
    }
    first ??= no(mm.reason, mm.detail);
  }
  return first!;
}

/** The file name a map gets in ComfyUI's input folder: content-addressed, so a different file never takes the same name. */
export const comfyName = (m: Pick<DepthMapEntry, "id" | "sha256">) => `${m.id}-${m.sha256.slice(0, 12)}.png`;

type UploadClient = Partial<Pick<ComfyClient, "uploadImage">>;

/**
 * Re-reads the map, checks its hash again and uploads it to ComfyUI (input/neurostudio-depth/<name>). Returns the LoadImage value.
 * ComfyUI stores identical content under the same name; if it had to rename the file, another file with that name exists and the
 * map is NOT used (never substituted).
 */
export async function uploadMap(client: UploadClient, lib: DepthLibrary, m: Pick<DepthMapEntry, "id" | "sha256" | "file">, name = comfyName(m)): Promise<string> {
  if (!client.uploadImage) throw new Error("ComfyUI client cannot upload images");
  const path = safeMapPath(lib.dir, m.file);
  if (!path) throw new Error(`unsafe map path ${m.file}`);
  const buf = readFileSync(path);
  if (sha(buf) !== m.sha256) throw new Error(`map ${m.id} changed on disk (sha256 mismatch)`);
  const r = await client.uploadImage(buf, name, COMFY_SUBFOLDER);
  if (r.name !== name || (r.subfolder ?? "") !== COMFY_SUBFOLDER) throw new Error(`ComfyUI stored the map as ${r.subfolder}/${r.name}: another file with that name exists`);
  return `${COMFY_SUBFOLDER}/${name}`;
}

/** The Depth record of a frame that gets the map. */
export function appliedRecord(lib: DepthLibrary, m: DepthMapEntry, poseId: string, model: string, comfyImage: string): DepthApplied {
  return {
    mode: "depth", mapId: m.id, mapSha256: m.sha256, poseId, model,
    adapter: { file: lib.adapter.file, expectedSha256: lib.adapter.sha256, check: "listed-by-comfyui" },
    strength: m.depth.strength, startPercent: m.depth.startPercent, endPercent: m.depth.endPercent,
    libraryVersion: lib.version, comfyImage, spec: specOf(m),
  };
}
export const textRecord = (reason: DepthReason, detail?: string): DepthNotApplied => ({ mode: "text", depthRequested: true, reason, ...(detail ? { detail } : {}) });

/** Exact steps to install the adapter from the copy already on disk (shown when ComfyUI does not list it). Nothing is copied automatically. */
export function adapterInstructions(lib: DepthLibrary): string {
  const src = lib.adapter.localCopy ?? `<локальная копия ${lib.adapter.file}>`;
  return [
    `Адаптер ${lib.adapter.file} не найден в ComfyUI. Скачивать его заново не нужно: используйте копию из NS-025.`,
    `1. Закройте ComfyUI Desktop.`,
    `2. Скопируйте файл ${src} в папку model_patches общей папки моделей Desktop (по умолчанию E:\\Comfy-Desktop\\ComfyUI-Shared\\models\\model_patches\\).`,
    `3. Проверьте хеш в PowerShell: (Get-FileHash -Algorithm SHA256 "<путь к скопированному файлу>").Hash — должен совпасть с ${lib.adapter.sha256.toUpperCase()}.`,
    `4. Запустите ComfyUI Desktop. NeuroStudio проверяет только наличие файла в списке ComfyUI, хеш установленного файла сервер не проверяет.`,
    `Лицензия адаптера: ${lib.adapter.license ?? "см. карточку модели"}.`,
  ].join("\n");
}
