<script setup lang="ts">
import { computed, watch } from "vue";
import { AUTO, COMPOSITION_FIELDS, COMPOSITION_OPTIONS, FIELD_LABEL, INHERIT, type CompositionField } from "../../../../src/composition";
import { EFFORT_LABEL, MOCK_CODEX } from "../mock";
import { modelById } from "../models";
import { assigned, copySceneToAll, form, guided, resetComposition, resetScene, resolved, sceneOverrides, ui } from "../store";

const models = MOCK_CODEX.models;
/** With a chosen model: its efforts. With Default: only efforts every model supports (same rule as NS-012). */
const efforts = computed(() => {
  const m = models.find((x) => x.id === form.codexModel);
  if (m) return m.efforts;
  const [first, ...rest] = models;
  return first.efforts.filter((e) => rest.every((x) => x.efforts.includes(e)));
});
watch(efforts, (list) => {
  if (form.codexEffort && !list.includes(form.codexEffort)) form.codexEffort = "";
});

const label = (f: CompositionField, id: string) => COMPOSITION_OPTIONS[f].find((x) => x.id === id)?.label ?? id;
const globalLabel = (f: CompositionField) => (form.global[f] === AUTO ? "Auto" : label(f, form.global[f]));
const codexSummary = computed(() => {
  const m = models.find((x) => x.id === form.codexModel)?.name ?? "Default";
  return form.codexEffort ? `${m} · ${EFFORT_LABEL[form.codexEffort]}` : m;
});
const compSummary = computed(() => (guided.value ? `${guided.value} of ${form.frames} scenes guided` : "All Auto"));
const anyComposition = computed(() => COMPOSITION_FIELDS.some((f) => form.global[f] !== AUTO) || form.scenes.some((_, i) => sceneOverrides(i) > 0));

/** Chips of the effective settings of a scene, marked by where each value comes from. */
function chips(i: number) {
  const r = resolved.value[i] ?? {};
  return COMPOSITION_FIELDS.filter((f) => r[f]).map((f) => ({ f, text: label(f, r[f]!), own: form.scenes[i][f] !== INHERIT }));
}
function toggleScene(i: number) {
  ui.openScene = ui.openScene === i ? null : i;
}
</script>

<template>
  <section class="card adv">
    <button class="head" :aria-expanded="ui.advancedOpen" aria-controls="adv-body" @click="ui.advancedOpen = !ui.advancedOpen">
      <span class="chev" :class="{ open: ui.advancedOpen }" aria-hidden="true">›</span>
      <span class="title">
        <b>Advanced settings</b>
        <small>Prompt generation · Composition</small>
      </span>
      <span class="sum">
        <span class="chip">Codex: {{ codexSummary }}</span>
        <span class="chip" :class="{ on: guided }">Composition: {{ compSummary }}</span>
      </span>
    </button>

    <div v-if="ui.advancedOpen" id="adv-body" class="body">
      <section class="block">
        <div class="bh">
          <h3>Prompt generation</h3>
          <p class="muted small">The Codex model that writes concepts and prompts. It does not change the image models.</p>
        </div>
        <div class="row2">
          <label class="field">
            <span>Codex model</span>
            <select v-model="form.codexModel">
              <option value="">Default (Codex settings)</option>
              <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>Reasoning effort</span>
            <select v-model="form.codexEffort">
              <option value="">Default</option>
              <option v-for="e in efforts" :key="e" :value="e">{{ EFFORT_LABEL[e] ?? e }}</option>
            </select>
          </label>
        </div>
        <p class="muted small">Mock catalog in the prototype. The real list comes from the installed Codex CLI.</p>
      </section>

      <section class="block">
        <div class="bh split">
          <div>
            <h3>Composition</h3>
            <p class="muted small">Global defaults apply to every scene set to <i>Inherit global</i>. <i>Auto</i> leaves the choice to Codex.</p>
          </div>
          <button class="link" :disabled="!anyComposition" @click="resetComposition">Reset all</button>
        </div>

        <div class="sub">Global defaults</div>
        <div class="row4">
          <label v-for="f in COMPOSITION_FIELDS" :key="f" class="field">
            <span>{{ FIELD_LABEL[f] }}</span>
            <select v-model="form.global[f]" :class="{ set: form.global[f] !== AUTO }">
              <option :value="AUTO">Auto</option>
              <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ x.label }}</option>
            </select>
          </label>
        </div>

        <div class="sub">Individual scenes</div>
        <div class="slist">
          <div v-for="i in form.frames" :id="`scene-comp-${i - 1}`" :key="i" class="srow" :class="{ open: ui.openScene === i - 1 }">
            <button class="srh" :aria-expanded="ui.openScene === i - 1" @click="toggleScene(i - 1)">
              <span class="chev" :class="{ open: ui.openScene === i - 1 }" aria-hidden="true">›</span>
              <span class="snum">Scene {{ String(i).padStart(2, "0") }}</span>
              <span class="dot" :style="{ background: modelById(assigned[i - 1])?.color }" :title="modelById(assigned[i - 1])?.name" />
              <span class="chips">
                <template v-if="chips(i - 1).length">
                  <span v-for="c in chips(i - 1)" :key="c.f" class="vchip" :class="{ own: c.own }" :title="`${FIELD_LABEL[c.f]}: ${c.text}${c.own ? ' (this scene)' : ' (from global)'}`">{{ c.text }}</span>
                </template>
                <span v-else class="auto">Auto</span>
              </span>
              <span class="ovr">{{ sceneOverrides(i - 1) ? `${sceneOverrides(i - 1)} own` : "Inherits global" }}</span>
            </button>
            <div v-if="ui.openScene === i - 1" class="sbody">
              <div class="row4">
                <label v-for="f in COMPOSITION_FIELDS" :key="f" class="field">
                  <span>{{ FIELD_LABEL[f] }}</span>
                  <select v-model="form.scenes[i - 1][f]" :class="{ set: form.scenes[i - 1][f] !== INHERIT }">
                    <option :value="INHERIT">Inherit global ({{ globalLabel(f) }})</option>
                    <option :value="AUTO">Auto (Codex decides)</option>
                    <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ x.label }}</option>
                  </select>
                </label>
              </div>
              <div class="actions">
                <button class="btn sm" :disabled="form.frames < 2" @click="copySceneToAll(i - 1)">Copy to all scenes</button>
                <button class="btn sm ghost" :disabled="!sceneOverrides(i - 1)" @click="resetScene(i - 1)">Reset scene</button>
              </div>
            </div>
          </div>
        </div>
        <p v-if="form.frames < 4" class="muted small">Settings of hidden scenes are kept and come back when you add frames; they are not sent while hidden.</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.adv { overflow: hidden; }
.head { display: flex; align-items: center; gap: 12px; width: 100%; padding: 14px 18px; border: 0; background: none; text-align: left; flex-wrap: wrap; }
.head:hover { background: var(--panel-2); }
.chev { display: inline-block; color: var(--muted); font-size: 18px; line-height: 1; transition: transform 0.15s; width: 10px; }
.chev.open { transform: rotate(90deg); }
.title { display: flex; flex-direction: column; line-height: 1.3; }
.title small { color: var(--muted); font-size: 12px; }
.sum { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.sum .chip.on { border-color: rgba(124, 108, 255, 0.45); color: var(--accent-2); }
.body { border-top: 1px solid var(--line); padding: 4px 18px 18px; display: flex; flex-direction: column; }
.block { padding: 14px 0; display: flex; flex-direction: column; gap: 10px; }
.block + .block { border-top: 1px solid var(--line); }
.bh h3 { font-size: 14px; }
.bh.split { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 4px; }
.row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; max-width: 560px; }
.row4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
select.set { border-color: rgba(124, 108, 255, 0.55); }
.slist { display: flex; flex-direction: column; gap: 6px; }
.srow { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); scroll-margin: 130px; }
.srow.open { border-color: var(--line-2); }
.srh { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; background: none; border: 0; text-align: left; border-radius: 10px; }
.srh:hover { background: var(--panel-3); }
.snum { font-weight: 600; white-space: nowrap; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; min-width: 0; flex: 1; }
.vchip { font-size: 12px; padding: 1px 8px; border-radius: 6px; background: var(--panel-3); color: var(--text-2); white-space: nowrap; }
.vchip.own { background: var(--accent-soft); color: var(--accent-2); }
.auto { font-size: 12px; color: var(--muted); }
.ovr { font-size: 12px; color: var(--muted); white-space: nowrap; }
.sbody { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 900px) { .row4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) {
  .row2, .row4 { grid-template-columns: 1fr; }
  .sum { margin-left: 22px; justify-content: flex-start; }
  .ovr { display: none; }
}
</style>
