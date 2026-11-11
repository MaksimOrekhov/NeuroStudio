// Stable machine-readable error codes for the API (NS-014). The Russian user text is made by the UI (NS-015);
// the technical message (including ComfyUI's own wording) always travels separately and unchanged.
import { CodexError } from "./codex.ts";
import { ComfyUnavailableError } from "./comfy.ts";
import { PlanError } from "./promptPlan.ts";

export const ERROR_CODES = [
  "INVALID_GENERATION_SETTINGS", // 400: bad frames / models / composition / codex settings (nothing was started)
  "ALREADY_RUNNING", // 409
  "COMFY_UNREACHABLE", // 503 on start; also the run error when ComfyUI disappears
  "PLAN_INVALID", // run failed: Codex output did not pass validation
  "CODEX_FAILED", // run failed: Codex could not produce a plan (start, timeout, bad output)
  "GENERATION_FAILED", // run failed while generating images (ComfyUI error, timeout, missing dependency)
  "EXPORT_INCOMPLETE", // 409: ZIP not ready
  "COLLECTION_NOT_FOUND", // 404
  "INVALID_REQUEST", // 400: bad selection / feedback / regeneration body
  "SOURCE_UNAVAILABLE", // 409: regeneration source variant (image, saved graph) is missing, unfinished or damaged
  "FEEDBACK_FILE_UNREADABLE", // 409: image-feedback.json exists but cannot be read/parsed; saving is refused, the file is left untouched
  "VARIANT_LIMIT", // 409: the frame already has the maximum number of variants (-v99)
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Code of a failed run. Anything that is not Codex, plan validation or ComfyUI-unreachable is a generation failure. */
export function runErrorCode(e: unknown): ErrorCode {
  if (e instanceof PlanError) return "PLAN_INVALID";
  if (e instanceof CodexError) return "CODEX_FAILED";
  if (e instanceof ComfyUnavailableError) return "COMFY_UNREACHABLE";
  return "GENERATION_FAILED";
}
