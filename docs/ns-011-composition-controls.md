# NS-011 Advanced Composition Controls

Optional Pose / Orientation / Framing / Viewpoint selects, global and per scene (Scene 01-04). UI state only (not persisted).

- Catalog and logic: `src/composition.ts` (shared by web and server). API: optional `composition` in `POST /api/autopilot/start`:
  `{ global: {pose,orientation,framing,viewpoint}, scenes: [ {...}, ... up to 4 ] }`, values are option ids or `"auto"` (scenes also `"inherit"`). Unknown values -> 400. Omitted = old behaviour (request to Codex unchanged).
- Priority: scene value > scene Auto > Inherit Global > global Auto.
- Codex gets only resolved non-Auto lines per scene number ("Shot size" / "View height and direction" wording, because `camera` and `framing` are banned in prompts). Applies to the same scene number in every collection of the batch; still one Codex call per batch.
- The resolved requirements are saved as `composition` in `batch-plan.json` for reproducibility. Prompt Plan schema is unchanged.
- Screenshots: `docs/screenshots/11-composition-controls.jpg`, `12-composition-controls-mobile.jpg`.
