import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { validateBatch, validatePlan, type PromptPlan } from "./promptPlan.ts";

export class CodexError extends Error {}

const SCHEMA = resolve(import.meta.dirname, "../schemas/prompt-plan.schema.json");

export const INSTRUCTIONS_PATH = resolve(import.meta.dirname, "../prompts/CREATIVE_DIRECTOR.md");

/** Reads the Creative Director instructions. A missing file is an error: there is no silent fallback to older rules. */
export async function loadInstructions(path = INSTRUCTIONS_PATH): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CodexError(`Creative Director instructions not found at ${path}. Restore prompts/CREATIVE_DIRECTOR.md.`);
  }
  if (!text.trim()) throw new CodexError(`Creative Director instructions at ${path} are empty.`);
  return text.trim();
}

/** instructions + the request. count = 1: a single Prompt Plan; count > 1: a Batch Plan {collections: PromptPlan[]} in the same call. */
export function planPrompt(instructions: string, theme?: string, avoid: string[] = [], count = 1): string {
  const batch = count > 1;
  const themeLine = theme
    ? `Theme requested by the user (use it as the starting point${batch ? " for all collections, but give each its own distinct angle" : ""}): ${JSON.stringify(theme)}`
    : batch
      ? `No theme is given: invent ${count} original concepts yourself.`
      : "No theme is given: invent ONE original concept yourself.";
  const avoidLine = avoid.length
    ? `
Collections already created (do NOT repeat or resemble them; propose a substantially different concept, setting, palette and mood): ${avoid.map((t) => JSON.stringify(t)).join(", ")}.`
    : "";
  const ask = batch
    ? `Return a Batch Plan: JSON {"collections": [...]} with exactly ${count} Prompt Plans matching the supplied schema.`
    : "Return a Prompt Plan as JSON matching the supplied schema.";
  const distinct = batch
    ? `
The ${count} collections must be substantially different from each other (concept, heroine, outfit, palette, setting, mood). Never repeat a concept inside the batch.`
    : "";
  return `${instructions}

---
Task: ${themeLine}
${ask}${avoidLine}${distinct}`;
}

/** Finds how to launch Codex without a shell. On Windows the PATH shim is a .cmd file, so run its JS entry with node. */
export function resolveCodex(): { command: string; args: string[] } {
  if (process.env.CODEX_BIN) return { command: process.env.CODEX_BIN, args: [] };
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (dir && existsSync(entry)) return { command: process.execPath, args: [entry] };
  }
  return { command: "codex", args: [] };
}

type Tokens = { input?: number; cachedInput?: number; output?: number; total?: number } | null;

export interface CodexResult {
  plan: PromptPlan;
  raw: string;
  ms: number;
  tokens: Tokens;
}

export interface BatchResult {
  plans: PromptPlan[];
  raw: string;
  ms: number;
  tokens: Tokens;
}

export interface CodexOptions {
  theme?: string;
  /** Titles of recent collections the new concept(s) must differ from. */
  avoid?: string[];
  timeoutMs?: number;
  /** For tests: override the launcher. */
  launcher?: { command: string; args: string[] };
}

export interface BatchOptions extends CodexOptions {
  count: number;
}

/** Exactly one Codex process. No retries: any failure throws CodexError. Returns the parsed final message. */
export async function runCodex(prompt: string, schema: object, timeoutMs: number, launcher = resolveCodex()) {
  const { command, args } = launcher;
  const dir = await mkdtemp(join(tmpdir(), "neurostudio-codex-"));
  const outFile = join(dir, "last-message.json");
  const schemaFile = join(dir, "schema.json");
  await writeFile(schemaFile, JSON.stringify(schema));
  const full = [
    ...args,
    "exec",
    ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []),
    "--sandbox", "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--output-schema", schemaFile,
    "-o", outFile,
    "-",
  ];
  const t0 = Date.now();
  try {
    const stdout = await new Promise<string>((res, rej) => {
      const child = spawn(command, full, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => {
        child.kill();
        rej(new CodexError(`Codex timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        rej(new CodexError(`Cannot start Codex (${command}): ${e.message}. Is Codex CLI installed and logged in?`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return res(out);
        const detail = [...out.split("\n"), ...err.split("\n")].filter((l) => /error|not supported|login|auth/i.test(l)).slice(0, 3).join(" | ");
        rej(new CodexError(`Codex exited with code ${code}. ${detail.slice(0, 600)}`));
      });
      child.stdin.end(prompt);
    });
    let raw: string;
    try {
      raw = await readFile(outFile, "utf8");
    } catch {
      throw new CodexError("Codex finished but wrote no final message");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new CodexError("Codex final message is not valid JSON");
    }
    return { json, raw, ms: Date.now() - t0, tokens: parseUsage(stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const timeout = (o: CodexOptions, count: number) => o.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 300_000) * count;

/** One Codex call, one collection. */
export async function generatePlan(opts: CodexOptions = {}): Promise<CodexResult> {
  const schema = JSON.parse(await readFile(SCHEMA, "utf8"));
  const instructions = await loadInstructions();
  const r = await runCodex(planPrompt(instructions, opts.theme, opts.avoid), schema, timeout(opts, 1), opts.launcher);
  return { plan: validatePlan(r.json), raw: r.raw, ms: r.ms, tokens: r.tokens };
}

/** JSON schema for a Batch Plan of exactly `count` Prompt Plans (derived from schemas/prompt-plan.schema.json). */
export async function batchSchema(count: number, planSchemaPath = SCHEMA): Promise<object> {
  const plan = JSON.parse(await readFile(planSchemaPath, "utf8"));
  return {
    type: "object",
    additionalProperties: false,
    required: ["collections"],
    properties: { collections: { type: "array", minItems: count, maxItems: count, items: plan } },
  };
}

/** One Codex call for the whole batch; all plans are validated before anything is returned. */
export async function generateBatch(opts: BatchOptions): Promise<BatchResult> {
  const instructions = await loadInstructions();
  const r = await runCodex(planPrompt(instructions, opts.theme, opts.avoid, opts.count), await batchSchema(opts.count), timeout(opts, opts.count), opts.launcher);
  return { plans: validateBatch(r.json, opts.count), raw: r.raw, ms: r.ms, tokens: r.tokens };
}

/** Reads token usage from `codex exec --json` events (turn.completed). */
export function parseUsage(jsonl: string): Tokens {
  for (const line of jsonl.split("\n").reverse()) {
    if (!line.includes("turn.completed")) continue;
    try {
      const u = JSON.parse(line).usage;
      if (!u) continue;
      return {
        input: u.input_tokens,
        cachedInput: u.cached_input_tokens,
        output: u.output_tokens,
        total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      };
    } catch {
      /* ignore */
    }
  }
  return null;
}
