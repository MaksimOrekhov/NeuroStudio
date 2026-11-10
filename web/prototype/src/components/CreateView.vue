<script setup lang="ts">
import { computed } from "vue";
import { COMPOSITION_FIELDS, COMPOSITION_OPTIONS } from "../../../../src/composition";
import { COLLECTION_CHOICES, FRAME_CHOICES, IMAGE_MODELS, VARIATION_CHOICES, modelById, modelUsage, sceneList, type ModelMode } from "../models";
import { assigned, form, openSceneComposition, resolved, running, setModelMode, startDemoRun, total, ui } from "../store";
import AdvancedSettings from "./AdvancedSettings.vue";
import SummaryCard from "./SummaryCard.vue";

const modes = computed<{ id: ModelMode; label: string }[]>(() => [
  { id: "auto", label: "Auto Mix" },
  ...IMAGE_MODELS.map((m) => ({ id: `only:${m.id}` as ModelMode, label: `${m.name} only` })),
  { id: "custom", label: "Custom per scene" },
]);

const modeHint = computed(() => {
  const usage = modelUsage(assigned.value);
  if (form.modelMode === "custom") return "Choose the image model for each scene below.";
  if (form.modelMode.startsWith("only:")) return `Every scene is generated with ${usage[0]?.model.name}.`;
  const parts = usage.map((u) => `${u.model.name}: ${sceneList(u.scenes)}`).join(" · ");
  const unused = IMAGE_MODELS.filter((m) => !usage.some((u) => u.model.id === m.id)).map((m) => m.name);
  return `Split in scene order — ${parts}.${unused.length ? ` ${unused.join(", ")} is not used with ${form.frames === 1 ? "one frame" : `${form.frames} frames`}.` : ""}`;
});

const label = (f: (typeof COMPOSITION_FIELDS)[number], id: string) => COMPOSITION_OPTIONS[f].find((x) => x.id === id)?.label ?? id;
const compSummary = (i: number) => {
  const s = resolved.value[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => label(f, s[f]!));
  return parts.length ? parts.join(" · ") : "Auto";
};

const disabledGenerate = computed(() => running.value || ui.comfy === "down");
</script>

<template>
  <div class="create">
    <div class="main">
      <section class="card idea">
        <label class="eyebrow" for="theme">Theme / Idea</label>
        <textarea id="theme" v-model="form.theme" rows="2" maxlength="200" placeholder="Leave empty — Codex invents the concept. Or describe a mood, place or story…" />
        <div class="meta"><span>Optional</span><span>{{ form.theme.length }}/200</span></div>
      </section>

      <section class="card shape" aria-label="Batch size">
        <div class="ctl">
          <span class="eyebrow" id="l-col">Collections</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-col">
            <button v-for="n in COLLECTION_CHOICES" :key="n" role="radio" :aria-checked="form.collections === n" :class="{ on: form.collections === n }" @click="form.collections = n">{{ n }}</button>
          </div>
          <small>Separate concepts, one Codex call</small>
        </div>
        <div class="ctl">
          <span class="eyebrow" id="l-fr">Frames per collection</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-fr">
            <button v-for="n in FRAME_CHOICES" :key="n" role="radio" :aria-checked="form.frames === n" :class="{ on: form.frames === n }" @click="form.frames = n">{{ n }}</button>
          </div>
          <small>Scenes of the same heroine and concept</small>
        </div>
        <div class="ctl">
          <span class="eyebrow" id="l-var">Seed variations</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-var">
            <button v-for="n in VARIATION_CHOICES" :key="n" role="radio" :aria-checked="form.variations === n" :class="{ on: form.variations === n }" @click="form.variations = n">{{ n }}</button>
          </div>
          <small>{{ form.variations === 1 ? "One image per scene" : `Pick the best of ${form.variations} per scene` }}</small>
        </div>
      </section>

      <section class="card scenes">
        <div class="shead">
          <div>
            <h2>Scenes <span class="muted">· {{ form.frames }} per collection</span></h2>
            <p class="muted small">Image model and composition for each scene. The same scene layout is used in every collection.</p>
          </div>
        </div>

        <div class="models">
          <span class="eyebrow" id="l-mm">Image models</span>
          <div class="seg modes" role="radiogroup" aria-labelledby="l-mm">
            <button v-for="m in modes" :key="m.id" role="radio" :aria-checked="form.modelMode === m.id" :class="{ on: form.modelMode === m.id }" @click="setModelMode(m.id)">{{ m.label }}</button>
          </div>
          <p class="mhint">{{ modeHint }}</p>
        </div>

        <TransitionGroup name="sc" tag="div" class="grid" :class="`n${form.frames}`">
          <article v-for="i in form.frames" :key="i" class="scene" :style="{ '--mc': modelById(assigned[i - 1])?.color }">
            <header>
              <span class="num">{{ String(i).padStart(2, "0") }}</span>
              <span class="lbl">Scene</span>
            </header>
            <label v-if="form.modelMode === 'custom'" class="field">
              <span>Image model</span>
              <select v-model="form.custom[i - 1]" :aria-label="`Image model for scene ${i}`">
                <option v-for="m in IMAGE_MODELS" :key="m.id" :value="m.id">{{ m.name }}</option>
              </select>
            </label>
            <div v-else class="mfix">
              <span class="dot" :style="{ background: modelById(assigned[i - 1])?.color }" />
              {{ modelById(assigned[i - 1])?.name }}
              <span class="muted small">{{ form.modelMode === "auto" ? "· auto" : "" }}</span>
            </div>
            <button class="comp" :title="`Edit composition of scene ${i}`" @click="openSceneComposition(i - 1)">
              <span class="k">Composition</span>
              <span class="v" :class="{ auto: compSummary(i - 1) === 'Auto' }">{{ compSummary(i - 1) }}</span>
              <span class="e">Edit</span>
            </button>
          </article>
        </TransitionGroup>
      </section>

      <AdvancedSettings />
    </div>

    <aside class="side">
      <SummaryCard />
    </aside>

    <div class="mobilebar">
      <div>
        <b>{{ total }} images</b>
        <small>{{ form.collections }} × {{ form.frames }} × {{ form.variations }}</small>
      </div>
      <button class="btn primary" :disabled="disabledGenerate" @click="startDemoRun">Generate · demo</button>
    </div>
  </div>
</template>

<style scoped>
.create { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; align-items: start; }
.main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.side { position: sticky; top: 76px; }

.idea { padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
.idea textarea { font-size: 15px; padding: 10px 12px; min-height: 64px; background: var(--panel-2); }
.meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }

.shape { padding: 16px 18px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.ctl { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }
.ctl .seg button { min-width: 44px; }
.ctl small { color: var(--muted); font-size: 12px; }

.scenes { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
.shead h2 { font-size: 16px; }
.shead h2 .muted { font-weight: 400; }
.models { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.mhint { font-size: 13px; color: var(--text-2); }

.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.grid.n1 { grid-template-columns: minmax(0, 300px); }
.grid.n2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.n3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.scene { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
.scene::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--mc, var(--line)); }
.scene header { display: flex; align-items: baseline; gap: 8px; }
.num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.lbl { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; }
.mfix { display: flex; align-items: center; gap: 8px; font-weight: 500; min-height: 34px; padding: 0 2px; }
.comp { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "k e" "v v"; gap: 2px 8px; text-align: left; padding: 8px 10px; border-radius: 9px; border: 1px dashed var(--line-2); background: transparent; }
.comp:hover { border-color: var(--accent); border-style: solid; background: var(--panel-3); }
.comp .k { grid-area: k; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.comp .e { grid-area: e; font-size: 12px; color: var(--accent-2); }
.comp .v { grid-area: v; font-size: 13px; color: var(--text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.comp .v.auto { color: var(--muted); }

.sc-enter-active, .sc-leave-active { transition: opacity 0.18s, transform 0.18s; }
.sc-enter-from, .sc-leave-to { opacity: 0; transform: translateY(6px); }
.sc-leave-active { position: absolute; }

.mobilebar { display: none; }

@media (max-width: 1100px) {
  .create { grid-template-columns: minmax(0, 1fr) 300px; }
  .grid, .grid.n3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .create { grid-template-columns: 1fr; }
  .side { position: static; }
  .shape { grid-template-columns: 1fr; gap: 14px; }
  .ctl { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
  .ctl .eyebrow { flex: 1 1 140px; }
  .ctl small { flex-basis: 100%; }
  .mobilebar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 15; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: rgba(18, 20, 27, 0.96); backdrop-filter: blur(10px); border-top: 1px solid var(--line); }
  .mobilebar div { display: flex; flex-direction: column; line-height: 1.2; }
  .mobilebar small { color: var(--muted); }
}
@media (max-width: 560px) {
  .ctl { flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 6px; }
  .ctl .eyebrow, .ctl small { flex: none; }
  .ctl .seg { display: flex; }
  .ctl .seg button { flex: 1; }
  .grid, .grid.n2, .grid.n3, .grid.n1 { grid-template-columns: 1fr; }
  .scene { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px 12px; }
  .scene header { flex-direction: column; gap: 0; grid-row: span 2; align-items: center; min-width: 44px; }
  .modes { width: 100%; }
  .modes button { flex: 1 1 45%; }
}
</style>
