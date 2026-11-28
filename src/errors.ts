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
  "COMPARISON_FILE_UNREADABLE", // 409: comparisons.json exists but cannot be read/validated; saving is refused, the file is left untouched
  "PREFERENCE_MEMORY_FAILED", // 500: Prompt Evolution preview could not be built (a run continues without the memory)
  "VARIANT_LIMIT", // 409: the frame already has the maximum number of variants (-v99)
  "DEPTH_CONFLICT", // 409: regeneration with an edited prompt that does not clearly fit the source's depth map; keep or drop it explicitly
  "DEPTH_UNAVAILABLE", // 409: regeneration keeping a depth map that ComfyUI cannot use now (map, nodes or adapter missing); nothing was reserved
  "REPAIR_NOT_REGENERABLE", // 409: NS-031: the variant was made by local repair; its graph is not a generation graph, regenerate the source instead
  "REPAIR_MODEL_UNSUPPORTED", // 409: NS-031: local repair is verified only for some image models (Crimson Oath v0.3); nothing was reserved
  "REPAIR_UNAVAILABLE", // 409: NS-031: ComfyUI lacks the repair nodes, the mask input or the Inpainting adapter; nothing was reserved
  "INVALID_MASK", // 400: NS-031: the repair mask is missing, empty, too large, the wrong size or does not fit the processing area
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Code of a failed run. Anything that is not Codex, plan validation or ComfyUI-unreachable is a generation failure. */
export function runErrorCode(e: unknown): ErrorCode {
  if (e instanceof PlanError) return "PLAN_INVALID";
  if (e instanceof CodexError) return "CODEX_FAILED";
  if (e instanceof ComfyUnavailableError) return "COMFY_UNREACHABLE";
  return "GENERATION_FAILED";
}
