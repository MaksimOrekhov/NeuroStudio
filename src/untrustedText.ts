/**
 * Text that comes from saved files (prompts, titles) and is quoted back into a Codex request is DATA, never instructions.
 * Shared by Prompt Evolution (NS-020) and the visual history (NS-023) so both apply the same rule.
 */

/** Phrases that read like instructions to the model. A stored prompt containing one is never quoted. */
export const INSTRUCTIVE = /\b(ignore|disregard|forget|override|overrule|bypass|jailbreak|system prompt|developer message|instructions?|you must|you should|you are|do not|don't|never|always|hard constraint|creative director|assistant|codex)\b/i;

/**
 * The unmistakable subset, for free prose (titles, one-line ideas) where "never" or "always" is ordinary language
 * ("A Summer That Never Ends") and must not be mistaken for a command.
 */
export const INSTRUCTIVE_STRONG = /\b(ignore|disregard|forget|override|overrule|bypass|jailbreak|system prompt|developer message|instructions?|you must|you should|you are|hard constraint|creative director|assistant|codex)\b/i;

/** One line: no control characters, no structural characters (markup, code fences, rules), double quotes become single, single spaces. */
export function flatten(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[`<>{}[\]|\\#]/g, " ").replace(/"/g, "'").replace(/-{3,}|={3,}|\*{2,}/g, " ").replace(/\s+/g, " ").trim();
}
