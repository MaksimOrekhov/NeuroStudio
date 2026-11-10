# NS-013 UX Architecture & Interactive Prototype

Design stage for the next NeuroStudio UI. Nothing in the generator, API, storage or the working UI is changed; the prototype is a separate Vite app with mock data.

```bash
npm install            # once
npm run dev:prototype  # http://127.0.0.1:5174
```

`npm run build:prototype` / `npm run preview:prototype` build and serve the static prototype. The real app (`npm start`, `npm run dev:web`) is untouched.

The prototype never calls `/api`, Codex or ComfyUI. **Generate · demo** starts a simulated run (planning ~2.6 s, then one placeholder image every ~0.65 s) that fills Activity and Library with demo collections. The **Demo ▾** menu in the header switches ComfyUI connected/unavailable, simulates a generation error or a ComfyUI disconnect, and restores the mock data.

## 1. What exists today (inventory)

| Area | Today (`web/src`) | Kept in the new UX as |
|---|---|---|
| Theme, collections 1–3, variations 1/2/4, total line | `App.vue` hero panel | Create → Theme / Idea, Batch size, Generation Summary |
| Codex model + reasoning effort | `CodexSettings.vue` (always visible) | Create → Advanced settings → Prompt generation |
| Composition (global + 4 scenes, Inherit/Auto, copy, reset) | `CompositionControls.vue` (collapsible) | Create → scene cards (summary) + Advanced → Composition (editor) |
| Progress, phase text, ComfyUI pill, errors | `App.vue` (under the Generate button) | Header run pill + Activity |
| Collections with 4 scenes, variants, Select Best, PNG, ZIP, Feedback, unknown prompt_id warning | `CollectionCard.vue` (one long feed) | Library grid → Collection detail |
| Lightbox | `Lightbox.vue` | Viewer (adds ←/→ browsing and Best toggle) |

Nothing from this list is dropped. New in the UX: frames per collection (1–4) and image-model selection (Auto Mix / one model / Custom per scene).

## 2. Information architecture

**Decision: two main sections plus a light status section — Create, Library, Activity — with a global run pill in the header.**

```
┌ Header ─────────────────────────────────────────────────────────────────┐
│ NeuroStudio   [ Create | Library (n need Best) | Activity • ]   ◔ Generating 6/16 ▬   ● ComfyUI │
└─────────────────────────────────────────────────────────────────────────┘
 Create                     Library                         Activity
 ┌─────────────┬────────┐   ┌ filters · search ────────┐    ┌ Current run ───────┬ ComfyUI ┐
 │ Theme       │Summary │   │ ┌card┐ ┌card┐            │    │ steps · progress   │ Run     │
 │ Batch size  │ 12 img │   │ │1234│ │123 │  …         │    │ per-collection rows│ settings│
 │ Scenes 01-N │Generate│   │ └────┘ └────┘            │    ├ Recent runs ───────┤         │
 │ Advanced ▸  │        │   │  → Collection detail     │    └────────────────────┴─────────┘
 └─────────────┴────────┘   └──────────────────────────┘
```

Why not a dashboard or a single long page:

- **Create and Library are different jobs.** Today the gallery sits under the form; with more collections (and 1–4 frame collections) the feed grows and the form pushes it down. Separate sections give the gallery the full width.
- **Activity is a section, but small.** A run lasts minutes; the user should browse the Library meanwhile. The header pill (spinner, `Generating 6/16`, mini bar) is visible on every screen and opens Activity. Activity itself holds only what the pill cannot: steps, per-collection progress, errors and what was saved, run settings, recent runs. No charts, no GPU stats, no time estimates.
- **No extra settings page.** Rare settings stay next to the thing they affect (Advanced on Create), so there is no "where is that option" problem.
- **Library tab badge** = number of completed collections that still need Select Best (the only follow-up action that blocks ZIP export).

## 3. Main user scenarios

1. **Quick batch (most common).** Create → (optional theme) → Generate. Defaults: 2 collections × 4 frames × 2 variations, Auto Mix, everything else Auto. One click after opening the app.
2. **Shaped batch.** Change frames to 2 → the scene grid shows Scene 01–02 only, Summary updates to `2 collections × 2 frames × 2 variations = 8 images`, Auto Mix shows `Crimson Oath: Scene 1 · Duskrose: Scene 2`.
3. **Directed scenes.** Click a scene card's *Composition · Edit* → Advanced opens with that scene expanded → change Pose/Framing. Card summary and Summary (`2 of 4 scenes guided`) update.
4. **Specific models.** Image models → *Custom per scene* → each card gets a model select, preset from what Auto Mix showed (nothing jumps).
5. **Follow a run without waiting.** Generate → keep editing settings for the next run or open Library; the header pill shows progress; Activity shows the details. Completed collections appear in Library as soon as each one finishes.
6. **Review & export.** Library → card → detail: browse variants (thumbnails or viewer ←/→), *Select as Best* (or `B` in the viewer), rating/tags/note, *Export selected · ZIP*.
7. **Something failed.** Activity explains what stopped, what was saved (complete collections + partial images), that nothing is resumed or resubmitted, and points to the Library. The collection detail repeats this and lists prompt_ids with unknown state.

## 4. Create

Layout: main column + sticky Summary column (desktop); single column with a sticky bottom bar `16 images · 2 × 4 × 2 · Generate · demo` (≤ 900 px).

Top-to-bottom order follows decision importance:

1. **Theme / Idea** — optional, 200 chars (same limit as today).
2. **Batch size** — three segmented controls side by side: *Collections 1/2/3*, *Frames per collection 1/2/3/4*, *Seed variations 1/2/4*, each with a one-line hint.
3. **Scenes** — *Image models* mode switch + one card per frame. The number of cards always equals the frame count (2 frames → Scene 01, Scene 02). Each card shows: number, image model (chip, or a select in Custom), composition summary (`Auto` or e.g. `Full body · Eye level`) with *Edit*. A coloured top edge marks the model (Crimson Oath red, Duskrose violet).
4. **Advanced settings** — collapsed by default; the header still shows its state (`Codex: Default`, `Composition: All Auto` / `2 of 4 scenes guided`), so nothing configured is hidden silently.

**Generation Summary** (always visible): big total, the exact formula `2 collections × 3 frames × 2 variations = 12 images`, theme, image models per scene, Codex model/effort, composition state, Generate button. No time or GPU estimates. ComfyUI unavailable → button disabled with the reason. Run in progress → button disabled, inline progress + *Open Activity*; the form stays editable for the next run (one run at a time, as today).

### Frame-count rules

- 1–4 frames; the scene grid, Auto Mix, composition list, Summary and the request all use the same `frames` value.
- Reducing frames hides the last scenes but **keeps** their composition and custom model settings in memory (noted under the scene list); they are not sent while hidden and come back when frames are increased.
- Composition *Copy to all scenes* copies to the visible scenes only.

## 5. Image models (not Codex models)

Image models (ComfyUI checkpoints) and Codex models (prompt writing) are kept apart: image models live in the Scenes block; Codex model/effort are under *Advanced → Prompt generation* with the hint "It does not change the image models."

Modes (derived from an ordered registry, `web/prototype/src/models.ts`):

| Mode | Behaviour |
|---|---|
| **Auto Mix** (default) | Contiguous split in registry order, earlier models get the remainder. |
| **Crimson Oath only** / **Duskrose only** | Every scene uses that model. One option per registered model. |
| **Custom per scene** | A select on each scene card. Entering Custom pre-fills the current assignment. |

Auto Mix with the two current models:

| Frames | Scene 1 | Scene 2 | Scene 3 | Scene 4 |
|---|---|---|---|---|
| 1 | Crimson Oath | | | |
| 2 | Crimson Oath | Duskrose | | |
| 3 | Crimson Oath | Crimson Oath | Duskrose | |
| 4 | Crimson Oath | Crimson Oath | Duskrose | Duskrose (today's 2 + 2) |

The rule is shown in words under the mode switch (`Split in scene order — Crimson Oath: Scenes 1–2 · Duskrose: Scene 3.`; with 1 frame: `Duskrose is not used with one frame.`), on every scene card, and in the Summary.

**Third model:** add one registry entry `{ id, name, color }`. The mode switch gets `<Name> only`, Custom selects list it, Auto Mix becomes e.g. `A A B C` for 4 frames. No ComfyUI checkpoint discovery (out of scope).

## 6. Advanced settings (progressive disclosure)

Rules:

- Collapsed by default; state summarised in the header chips.
- Opened by the user, or automatically by a scene card's *Composition · Edit* (opens Advanced, expands that scene, scrolls it into view).
- Contents: **Prompt generation** (Codex model, reasoning effort — same rules as NS-012: efforts common to all models when Default is chosen; unsupported effort falls back to Default) and **Composition**.
- **Composition** uses the existing catalog `src/composition.ts` (`COMPOSITION_OPTIONS`, `resolveComposition`) unchanged:
  - *Global defaults*: 4 selects (Auto + options).
  - *Individual scenes*: one compact row per visible scene — number, model dot, chips of the **effective** values (violet = set on this scene, grey = inherited from global), `2 own` / `Inherits global`. Only **one** scene is expanded at a time (4 selects + *Copy to all scenes*, *Reset scene*). Scene options read `Inherit global (Full body)` so the inherited value is visible without looking up.
  - *Reset all* resets global and every scene.
- At 4 frames the worst case on screen is 4 global + 4 scene selects, never 16.

## 7. Library

- **Grid of collection cards** (2 columns on desktop, 1 on mobile). Each card: title, status badge, date, chips (`N frames`, `× V variations`, rating), a **strip of all scenes** in a fixed 4-slot grid (2:3 thumbnails; a 1- or 2-frame collection simply uses fewer slots, so thumbnails have the same size everywhere), Best marker ★, model dot per scene, and the export state (`✓ Ready to export` / `Best chosen 2/4` bar / `5 of 8 images saved`).
- Scene thumbnail = selected Best, else the only/first finished variant, else a placeholder with the state (`Queued`, `Generating`, `Not generated`, `Unknown`, `Failed`).
- **Filters**: All · Needs Best · Ready to export · Issues (failed + interrupted); title search.
- **Collection detail** (replaces the grid, `← Library`):
  - Header: title, status, date, `N frames × V variations`, description, **Export selected · ZIP** with the reason when disabled (`Select best images: 2/4`, `3 scenes have no finished image`).
  - Failed/interrupted banner: how many images were saved and usable, the error, "not regenerated or resumed automatically", unknown prompt_ids.
  - One column per scene (1–4): large current variant, scene number, model, PNG, variant thumbnails (v1…v4, ★ on Best, dimmed if missing), *Select vN as Best* / `✓ Best`, the shot brief.
  - Side panels: **Feedback** (stars, the same 10 tags, note saved on blur — identical to NS-010) and **Generation details** (created, theme, Codex model/effort, recorded Codex/ComfyUI time, model + composition per scene, seeds and prompt_ids, folder).
- **Viewer**: full image, ←/→ through every finished image (scene by scene), `B` toggles Best, PNG, Esc.
- Single-frame collections need no Select Best when variations = 1; with variations > 1 they need one choice.

## 8. Activity

- **Current run card**: status title (Planning the batch / Generating images / Run completed / Run stopped), start time and the formula, `done / total`, overall bar, and four steps: *ComfyUI check → Planning with Codex (one call for all collections) → Generating images (collection i of n · scene s · vK) → Saved to Library*.
- **Per-collection rows**: title (or "Concept is being written…" while planning), bar, `6/8`, state (Waiting, Generating, Saved, Stopped · partial, Not started), *Open* in Library.
- **Failure**: the error, what was saved (`1 complete collection, plus 1 of 8 images of "Greenhouse Rain"`), and explicitly: *Nothing is resumed or resubmitted automatically. Review what was saved in the Library and start a new run when ready.* On ComfyUI loss: an accepted image may still finish in ComfyUI — see its prompt_id on the collection. There is no Retry/Resume button on purpose.
- **Side**: ComfyUI status (connected/version/queue, or what to do when unreachable) and the run's settings snapshot (theme, models per scene, Codex, composition per scene).
- **Recent runs**: status, theme, formula, error line, links to the collections the run produced. (Source in NS-014: `output/batches/*/batch-plan.json`, which already exists.)

## 9. Visual design

- Dark only (as today), tokens in `web/prototype/src/styles.css`: background `#0a0b0f`, panels `#12141b`/`#181b24`, text `#e8eaf1`, muted `#8a8fa2` (≥ 4.5:1 on panels), accent violet `#7c6cff` kept from the current brand, semantic ok/warn/bad colours as today.
- Segmented controls for small closed sets, selects for long catalogs, chips for state. One primary button per screen (Generate, Export).
- States: hover (border/background), `:focus-visible` ring on every control, disabled at 45 % with a reason nearby, spinners respect `prefers-reduced-motion`.
- Layout: desktop first (Windows, ≥ 1280 px), breakpoints 1100 / 900 / 560 px. Mobile: tabs under the logo, sticky Generate bar, one-column cards, no horizontal scroll (checked at 375 px).
- No decoration without function: the only colour accents are model colours, status colours and the selection colour.

## 10. Reusable pieces

| Piece | Source | Reuse in NS-014 |
|---|---|---|
| Composition catalog + inheritance | `src/composition.ts` | As is; `SCENES` becomes the frame count |
| Codex catalog / effort rule | `src/codexModels.ts`, `CodexSettings.vue` | Move UI into Advanced (logic unchanged) |
| Model registry, Auto Mix, Custom, summary text | `web/prototype/src/models.ts` (unit-tested) | Move to `src/imageModels.ts`, shared by server and web |
| N-frame export rule | `web/prototype/src/library.ts` `exportState` | Replace hard-coded 4 in `server/collections.ts` |
| Feedback tags/limits | `server/collections.ts`, `CollectionCard.vue` | Same API, new panel |
| API types | `web/src/api.ts` | Extend (`frameCount`, models, metadata) |
| Prototype components | `web/prototype/src/components/*` | Starting point for the real views (swap mock store for API) |

## 11. Existing 4-frame constraints (must change for dynamic frames)

| Where | Constraint |
|---|---|
| `schemas/prompt-plan.schema.json` | `frames` `minItems/maxItems: 4`, `frame` `maximum: 4`, `model` enum of two ids |
| `src/promptPlan.ts` `validatePlan` | exactly 4 frames; exactly 2 per model; strict order 1–2 Crimson Oath, 3–4 Duskrose; 4 distinct prompts |
| `prompts/CREATIVE_DIRECTOR.md` | "exactly four … Frames 1-2 crimson-oath, 3-4 duskrose", "four frames/briefs" throughout |
| `src/codex.ts` `planPrompt` / `batchSchema` | schema reused as is → always 4 frames |
| `src/composition.ts` | `SCENES = 4`; `resolveComposition` always returns 4; parse allows ≤ 4 scenes |
| `src/collection.ts` `buildJobs` | job order assumes two models (Crimson first) |
| `src/comfy.ts` `MODELS` | two hard-coded checkpoints |
| `server/runner.ts` | `FRAMES = 4` for totals and progress offsets |
| `server/collections.ts` | `chooseScenes` iterates `[1,2,3,4]`; message `…/4`; selections filter `/^[1-4]$/`; `selectBest` checks `1-4` |
| `server/export.ts` | comment/assumption "the 4 files"; file name `scene-0${frame}` (fine up to 9) |
| `web/src/App.vue`, `CollectionCard.vue` | `× 4 scenes`, `chosen/4`, grid of 4 columns |
| `scripts/autopilot.ts` | help text and dry-run message say 4 |

## 12. Preliminary NS-014 plan

1. **Shared model registry** `src/imageModels.ts` (ids, names, checkpoints, colours) replacing `MODELS`; `autoMix`/`assignModels` moved from the prototype; tests kept.
2. **Plan schema v3** generated per request: `frames` length = N, `model` = the assigned model per frame (Codex receives the assignment, it does not choose). Keep reading v1/v2 plans with `legacy` validation.
3. **Validation**: `validatePlan(plan, { frames, models })` — N frames, frame numbers 1..N, model per frame equals the request; age/"adult woman"/banned-word rules unchanged.
4. **Creative Director**: parametrise "four" → N and the model sentence → the per-frame list; re-run the NS-009 quality checks for N = 1–3 (one-frame "collection" semantics).
5. **API**: `POST /api/autopilot/start` gains optional `frames` (1–4, default 4) and `imageModels` (`{ mode: "auto" | "only" | "custom", model?, perScene? }`, default Auto Mix). No new fields → exactly today's request.
6. **Runner / collection**: `FRAMES` from the request; manifest gets `frames` and per-frame model (already per frame); old manifests default to 4.
7. **Library backend**: `chooseScenes`/`exportStatus`/selections/`selectBest` use the manifest frame count; add `frameCount` + generation metadata (`theme`, codex, composition, models) to `CollectionView`; add `GET /api/runs` from `batch-plan.json`.
8. **Composition**: `SCENES` → request frame count; `parseComposition` accepts ≤ frames.
9. **UI**: replace `web/src` views with the prototype structure (Create / Library / Activity, header pill), wire to the API; keep `localStorage` only for UI preferences (Codex choice as today, maybe last frames/mode).
10. Tests: plan validation for 1–4 frames × modes, runner totals, export/selection with 1–3 frames, legacy 4-frame collections unchanged.

## 13. Decisions that need approval

1. Three sections (Create / Library / Activity) with a header run pill, instead of the current single page.
2. Default batch on Create: 2 collections × 4 frames × 2 variations (current UI defaults to 3 collections).
3. Auto Mix rule: contiguous blocks, Crimson Oath first (1 → C; 2 → C D; 3 → C C D). Alternative: alternate by collection for 1 frame (C, D, C) for balance — not chosen because the per-scene label would differ between collections.
4. Codex receives the model per frame (it no longer decides or validates "2 + 2"); Custom may use one model for all frames.
5. Composition editing lives in Advanced; scene cards show a summary and deep-link into it.
6. Hidden scenes keep their settings while frames are reduced.
7. The Create form stays editable during a run (Generate disabled); today it is locked.
8. Library as a card grid with a fixed 4-slot strip; collection detail as a separate view with Feedback and Details side panels.
9. No Retry/Resume anywhere; failed runs only explain what was saved.
10. Model colours (Crimson Oath red, Duskrose violet) as the only per-model visual cue.

## 14. Open questions and compatibility risks

- **Quality with 1–3 frames.** The Creative Director is tuned for four complementary shots; a 1-frame "collection" may need different guidance (the strongest single shot). Needs a prompt evaluation like NS-009.
- **Posting format.** NeuroDreams posts are 4-image posts on X; are 1–3 frame collections for posting or for exploration only?
- **Codex-chosen vs. assigned models.** Today Codex writes the model field and validation enforces 2 + 2. Assigning models server-side is simpler and transparent, but Codex no longer adapts shots to a model (the instructions already say not to).
- **Legacy data.** Old manifests, selections and ZIPs assume 4 frames; readers must default `frameCount = 4` and never rewrite old files.
- **Composition requests** for scenes > frames from older clients must be rejected or trimmed consistently.
- **Third model.** Needs a checkpoint, workflow compatibility (same UNET loader node?), and a decision on its Auto Mix position. Checkpoint discovery stays out of scope.
- **Run history.** `batch-plan.json` has no per-collection status beyond ids; Activity history may need `batch.status` per collection (small additive change).
- **Browser locale.** The prototype formats dates in en-GB to match the English UI; the real app currently uses the browser locale.

## 15. Verification (NS-013)

- `npm run typecheck` (root + `web` + `web/prototype`), `npm test` (55 tests incl. `tests/ns013-prototype.test.ts`: Auto Mix, Only/Custom, third model, summary text, N-frame export), `npm run build`, `npm run build:prototype` — all pass.
- No changes under `src/`, `server/`, `schemas/`, `prompts/`, `workflows/`, `web/src/`. Codex and ComfyUI were not started.
- Checked in the browser at 1440 × 1000 and 375 × 812 (no horizontal scroll): all segmented controls, mode switch, custom selects, Advanced open/close, global + per-scene composition (inherit/own chips, copy, reset), Summary updates, demo run, simulated error and ComfyUI disconnect, Library filters/search, detail Select Best, viewer keys, feedback, export enable/disable.

Screenshots (`docs/screenshots/`):

| File | State |
|---|---|
| `14-ns013-create.jpg` | Create — normal mode (2 × 3 × 2 = 12 images, Auto Mix) |
| `15-ns013-advanced.jpg` | Create — Advanced settings (Codex + global and per-scene composition) |
| `16-ns013-custom-models.jpg` | Create — Custom per scene models |
| `17-ns013-library.jpg` | Library grid (4 / 3 / 2-frame collections, failed) |
| `18-ns013-library-states.jpg` | Library — interrupted, failed, 1-frame |
| `19-ns013-collection-detail.jpg` | Collection detail (Select Best, Feedback, details) |
| `20-ns013-activity-generating.jpg` | Activity — generating |
| `21-ns013-activity-failed.jpg` | Activity — stopped after ComfyUI disconnect |
| `22-ns013-mobile-create.jpg` | Mobile — Create |
| `23-ns013-mobile-library.jpg` | Mobile — Library |
