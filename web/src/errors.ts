// User-facing Russian messages for the stable API error codes (src/errors.ts).
// The technical text of the error (ComfyUI's or Codex's own wording, validation details) is kept separately
// and shown under "Подробности"; it is never replaced by these messages.
import type { ErrorCode } from "./errorCodes";
import { ApiError } from "./api";

export const ERROR_RU: Record<ErrorCode, string> = {
  INVALID_GENERATION_SETTINGS: "Настройки генерации не приняты. Проверьте число кадров, модели изображений, композицию и выбор модели Codex.",
  ALREADY_RUNNING: "Генерация уже идёт. Дождитесь её завершения — одновременно выполняется только одна.",
  COMFY_UNREACHABLE: "ComfyUI недоступен. Запустите ComfyUI и повторите попытку.",
  PLAN_INVALID: "Codex вернул план, который не прошёл проверку. Ни одно изображение не создавалось. Запустите генерацию заново.",
  CODEX_FAILED: "Codex не смог составить план. Ни одно изображение не создавалось. Проверьте, что Codex CLI установлен и выполнен вход, затем запустите заново.",
  GENERATION_FAILED: "Ошибка при создании изображений. Уже сохранённое осталось в библиотеке, остальное не создавалось и не отправляется повторно.",
  EXPORT_INCOMPLETE: "ZIP пока недоступен: выберите хотя бы одно изображение (Best), и убедитесь, что его файл на месте.",
  COLLECTION_NOT_FOUND: "Коллекция не найдена. Возможно, её папку удалили или переместили.",
  INVALID_REQUEST: "Сервер не принял запрос. Обновите страницу и повторите действие.",
};

export const FALLBACK_RU = "Что-то пошло не так.";
export const NETWORK_RU = "Сервер NeuroStudio не отвечает. Проверьте, что он запущен.";

export interface UiError {
  /** Russian sentence shown as the main message. */
  message: string;
  /** Original technical text (may be English); shown in a collapsible "Подробности". */
  details?: string;
  code?: string;
}

/** Main message for a machine code; unknown or missing codes get a generic text. */
export const messageForCode = (code?: string): string => (code && code in ERROR_RU ? ERROR_RU[code as ErrorCode] : FALLBACK_RU);

export function describeError(e: unknown): UiError {
  if (e instanceof ApiError) {
    if (!e.code && e.httpStatus === undefined) return { message: NETWORK_RU, details: e.message };
    return { message: messageForCode(e.code), details: e.message, code: e.code };
  }
  return { message: FALLBACK_RU, details: e instanceof Error ? e.message : String(e) };
}

/** For errors stored with a run or in a run record: `error` is the technical text, `code` the stable code. */
export function describeRunError(error?: string, code?: string): UiError | null {
  if (!error && !code) return null;
  return { message: messageForCode(code), details: error, code };
}
