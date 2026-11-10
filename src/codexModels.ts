import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCodex } from "./codex.ts";

// Local Codex model catalog (NS-012). Source of truth is the installed Codex CLI:
//   1. <CODEX_HOME or ~/.codex>/models_cache.json  (plain JSON written by the CLI; no secrets, no network from us)
//   2. `codex debug models --bundled`              (catalog bundled in the binary; "--bundled" skips any refresh)
// auth.json and config.toml are never read.

export interface ModelInfo {
  id: string;
  name: string;
  /** Real CLI values, e.g. "low", "xhigh". */
  efforts: string[];
  defaultEffort?: string;
}

export interface Catalog {
  models: ModelInfo[];
  source: "cache" | "bundled" | "none";
  /** Human-readable reason when no catalog could be read. */
  error?: string;
}

export class CodexSelectionError extends Error {}

/** Display names for known effort values; unknown values are shown as-is. */
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Maximum", ultra: "Ultra" };
export const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e;

const SAFE = /^[A-Za-z0-9._-]{1,64}$/;

/** Parses the raw catalog JSON ({models: [...]}). Hidden models are dropped; malformed entries are skipped. */
export function parseCatalog(json: unknown): ModelInfo[] {
  const list = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) throw new Error("catalog has no models list");
  const out: ModelInfo[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m !== "object" || m.visibility !== "list" || typeof m.slug !== "string" || !SAFE.test(m.slug)) continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? (m.supported_reasoning_levels as { effort?: unknown }[]) : [];
    const efforts = levels.map((l) => l?.effort).filter((e): e is string => typeof e === "string" && SAFE.test(e));
    out.push({
      id: m.slug,
      name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug,
      efforts,
      defaultEffort: typeof m.default_reasoning_level === "string" && efforts.includes(m.default_reasoning_level) ? m.default_reasoning_level : undefined,
    });
  }
  return out;
}

export interface CatalogDeps {
  codexHome?: string;
  /** For tests: replaces reading models_cache.json. */
  readCache?: () => Promise<string>;
  /** For tests: replaces `codex debug models --bundled`. */
  runBundled?: () => Promise<string>;
}

function bundledJson(): Promise<string> {
  const { command, args } = resolveCodex();
  return new Promise((res, rej) => {
    const child = spawn(command, [...args, "debug", "models", "--bundled"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      rej(new Error("timed out"));
    }, 15_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? res(out) : rej(new Error(`exit code ${code}`));
    });
  });
}

/** Never throws: an unavailable catalog is reported in `error` and the UI falls back to Default. */
export async function loadCatalog(d: CatalogDeps = {}): Promise<Catalog> {
  const home = d.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const attempts: [Catalog["source"], () => Promise<string>][] = [
    ["cache", d.readCache ?? (() => readFile(join(home, "models_cache.json"), "utf8"))],
    ["bundled", d.runBundled ?? bundledJson],
  ];
  const problems: string[] = [];
  for (const [source, read] of attempts) {
    try {
      const models = parseCatalog(JSON.parse(await read()));
      if (models.length) return { models, source };
      problems.push(`${source}: no selectable models`);
    } catch (e) {
      problems.push(`${source}: ${(e as Error).message}`);
    }
  }
  return { models: [], source: "none", error: `Codex model list is unavailable (${problems.join("; ")}). Using Codex settings.` };
}

export interface CodexSelection {
  /** Explicit user choice; undefined = Default (Codex settings). */
  model?: string;
  reasoningEffort?: string;
}

/**
 * Validates the optional request fields against the catalog. Unknown or incompatible values throw (HTTP 400);
 * nothing is replaced silently. Without an explicit model the effort is checked against the union of listed models.
 */
export function resolveSelection(catalog: Catalog, model: unknown, effort: unknown): CodexSelection {
  const out: CodexSelection = {};
  if (model !== undefined && model !== null && model !== "") {
    if (typeof model !== "string") throw new CodexSelectionError("codexModel must be a string");
    if (!catalog.models.length) throw new CodexSelectionError("The Codex model list is unavailable, so a specific model cannot be verified. Use Default.");
    if (!catalog.models.some((m) => m.id === model)) throw new CodexSelectionError(`Unknown Codex model "${model}"`);
    out.model = model;
  }
  if (effort !== undefined && effort !== null && effort !== "") {
    if (typeof effort !== "string") throw new CodexSelectionError("codexReasoningEffort must be a string");
    if (!catalog.models.length) throw new CodexSelectionError("The Codex model list is unavailable, so a reasoning effort cannot be verified. Use Default.");
    const allowed = out.model ? catalog.models.find((m) => m.id === out.model)!.efforts : [...new Set(catalog.models.flatMap((m) => m.efforts))];
    if (!allowed.includes(effort)) {
      throw new CodexSelectionError(out.model ? `Model "${out.model}" does not support reasoning effort "${effort}"` : `Unknown reasoning effort "${effort}"`);
    }
    out.reasoningEffort = effort;
  }
  return out;
}
