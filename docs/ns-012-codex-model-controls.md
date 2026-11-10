# NS-012 Codex Model & Reasoning Controls

Two optional selects (Model, Reasoning Effort) above Composition Controls. Uses the existing Codex CLI login/subscription; no OpenAI API, no changes to config.toml or auth.

- Catalog: `<CODEX_HOME or ~/.codex>/models_cache.json`, fallback `codex debug models --bundled` (no refresh, no network from NeuroStudio). Only `visibility: list` models; auth files are never read. `GET /api/codex/models` returns id, name, efforts (real CLI ids + display labels, e.g. `xhigh` = Extra High). If the catalog is unavailable the UI shows a diagnostic and only Default is usable.
- API: optional `codexModel`, `codexReasoningEffort` in `POST /api/autopilot/start`. Unknown or incompatible values -> 400; with no catalog any explicit value is refused. Calls without them never read the catalog.
- CLI: explicit model -> `-m <id>` (beats `CODEX_MODEL`); explicit effort -> `-c model_reasoning_effort="<id>"`. Default adds nothing. No retry/fallback to another model. Effort with Default model is checked against all listed models (UI offers only efforts common to all).
- UI: choice kept in `localStorage` (`neurostudio.codex`, model + effort only); stale model or unsupported effort falls back to Default; changing model resets an unsupported effort.
- History: `batch-plan.json` and `collection.json` get `codex.model` / `codex.reasoningEffort` = the explicit user choice, `null` = Default from Codex settings. The actually effective model/effort is NOT recorded: the CLI does not report it reliably and managed settings may override.
