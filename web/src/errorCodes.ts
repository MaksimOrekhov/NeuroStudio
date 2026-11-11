// Mirror of ERROR_CODES in src/errors.ts. The server module pulls in Node-only code, so the browser keeps its own list;
// tests/ns015.test.ts checks that the two lists are identical.
export const ERROR_CODES = [
  "INVALID_GENERATION_SETTINGS",
  "ALREADY_RUNNING",
  "COMFY_UNREACHABLE",
  "PLAN_INVALID",
  "CODEX_FAILED",
  "GENERATION_FAILED",
  "EXPORT_INCOMPLETE",
  "COLLECTION_NOT_FOUND",
  "INVALID_REQUEST",
  "SOURCE_UNAVAILABLE",
  "VARIANT_LIMIT",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
