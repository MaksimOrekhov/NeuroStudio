import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { validatePlan, type PromptPlan } from "./promptPlan.ts";

export class CodexError extends Error {}

const SCHEMA = resolve(import.meta.dirname, "../schemas/prompt-plan.schema.json");

export function planPrompt(theme?: string, avoid: string[] = []): string {
  const themeLine = theme
    ? `Theme requested by the user (use it as the starting point): ${JSON.stringify(theme)}`
    : "No theme is given: invent ONE original concept yourself.";
  const avoidLine = avoid.length
    ? `
Concepts already created (do NOT repeat or resemble them; propose a substantially different concept, setting, palette and mood): ${avoid.map((t) => JSON.stringify(t)).join(", ")}.`
    : "";
  return `You are the creative director of NeuroDreams, a collection of semi-realistic portrait sets.
${themeLine}
Return a Prompt Plan as JSON matching the supplied schema.${avoidLine}

Rules:
- Exactly 4 frames, numbered 1-4, one single adult heroine (age 21+, state "adult woman, 25 years old" or similar in every positive prompt). Same heroine look in all frames (put her fixed look in concept.heroine and repeat it in each positive prompt).
- Frames 1 and 3 use model "crimson-oath", frames 2 and 4 use "duskrose". Both are anime-lineage checkpoints driven by comma-separated tags: start positive with quality tags (realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, refined semi-realistic rendering), then subject, outfit, hairstyle, pose, setting, lighting. Crimson Oath: warmer, painterly, dramatic. Duskrose: softer, moodier, twilight palettes.
- One coherent concept with visual unity (palette, location family, mood), but each frame differs in outfit, hairstyle, pose and viewing-angle wording, and scene composition. No repeated scenes.
- Beautiful, tasteful, non-explicit.
- Never use these words or phrases anywhere: brushing, camera, framing, twisted, parted lips, wide hips.
- negative: a concise tag list adapted per model (worst quality, low quality, blurry, bad anatomy, bad hands, extra fingers, signature, watermark, text, plus anything frame-specific).
- summary: one short sentence describing the frame.
Return only the JSON.`;
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

export interface CodexResult {
  plan: PromptPlan;
  raw: string;
  ms: number;
  tokens: { input?: number; cachedInput?: number; output?: number; total?: number } | null;
}

export interface CodexOptions {
  theme?: string;
  /** Titles of recent collections the new concept must differ from. */
  avoid?: string[];
  timeoutMs?: number;
  /** For tests: override the launcher. */
  launcher?: { command: string; args: string[] };
}

/** Exactly one Codex invocation. No retries: any failure throws CodexError. */
export async function generatePlan(opts: CodexOptions = {}): Promise<CodexResult> {
  const { command, args } = opts.launcher ?? resolveCodex();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 300_000);
  const dir = await mkdtemp(join(tmpdir(), "neurostudio-codex-"));
  const outFile = join(dir, "last-message.json");
  const full = [
    ...args,
    "exec",
    ...(process.env.CODEX_MODEL ? ["-m", process.env.CODEX_MODEL] : []),
    "--sandbox", "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--output-schema", SCHEMA,
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
      child.stdin.end(planPrompt(opts.theme, opts.avoid));
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
    return { plan: validatePlan(json), raw, ms: Date.now() - t0, tokens: parseUsage(stdout) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads token usage from `codex exec --json` events (turn.completed). */
export function parseUsage(jsonl: string): CodexResult["tokens"] {
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
