<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  AUTO,
  COMPOSITION_FIELDS,
  COMPOSITION_OPTIONS,
  FIELD_LABEL,
  INHERIT,
  SCENES,
  resolveComposition,
  type Composition,
  type CompositionField,
  type Settings,
} from "../../src/composition";

defineProps<{ disabled?: boolean }>();

const blank = (v: string): Record<CompositionField, string> => ({ pose: v, orientation: v, framing: v, viewpoint: v });
const global = reactive(blank(AUTO));
const scenes = reactive(Array.from({ length: SCENES }, () => blank(INHERIT)));
const open = ref(false);
const openScene = ref<number | null>(null);

const label = (f: CompositionField, id: string) => COMPOSITION_OPTIONS[f].find((x) => x.id === id)?.label ?? id;
const resolved = computed(() => resolveComposition({ global, scenes }));
const sceneSummary = (i: number) => {
  const parts = COMPOSITION_FIELDS.filter((f) => resolved.value[i][f]).map((f) => label(f, resolved.value[i][f]!));
  return parts.length ? parts.join(" · ") : "Auto";
};
const controlled = computed(() => resolved.value.filter((s) => COMPOSITION_FIELDS.some((f) => s[f])).length);

/** Request value: undefined when nothing is configured, so the API call is exactly the old one. */
const value = computed<Composition | undefined>(() => (controlled.value ? { global: { ...global }, scenes: scenes.map((s) => ({ ...s })) } : undefined));
defineExpose({ value });

function resetAll() {
  Object.assign(global, blank(AUTO));
  for (const s of scenes) Object.assign(s, blank(INHERIT));
}
function copyToAll(i: number) {
  for (const [j, s] of scenes.entries()) if (j !== i) Object.assign(s, scenes[i] as Settings);
}
</script>

<template>
  <div class="cc">
    <button class="head" :aria-expanded="open" @click="open = !open">
      <span>{{ open ? "▾" : "▸" }} Composition Controls <em>optional</em></span>
      <span class="sum">{{ controlled ? `${controlled} of 4 scenes guided` : "All Auto" }}</span>
    </button>

    <div v-if="open" class="body">
      <section class="block">
        <h4>Global Defaults <small>applies to every scene set to Inherit Global</small></h4>
        <div class="selects">
          <label v-for="f in COMPOSITION_FIELDS" :key="f">
            <span>{{ FIELD_LABEL[f] }}</span>
            <select v-model="global[f]" :disabled="disabled">
              <option :value="AUTO">Auto</option>
              <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ x.label }}</option>
            </select>
          </label>
        </div>
      </section>

      <section v-for="(s, i) in scenes" :key="i" class="block scene">
        <button class="shead" :aria-expanded="openScene === i" @click="openScene = openScene === i ? null : i">
          <b>{{ openScene === i ? "▾" : "▸" }} Scene {{ String(i + 1).padStart(2, "0") }}</b>
          <span class="sum" :class="{ auto: sceneSummary(i) === 'Auto' }">{{ sceneSummary(i) }}</span>
        </button>
        <div v-if="openScene === i" class="sbody">
          <div class="selects">
            <label v-for="f in COMPOSITION_FIELDS" :key="f">
              <span>{{ FIELD_LABEL[f] }}</span>
              <select v-model="s[f]" :disabled="disabled">
                <option :value="INHERIT">Inherit Global</option>
                <option :value="AUTO">Auto (Codex decides)</option>
                <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ x.label }}</option>
              </select>
            </label>
          </div>
          <button class="link" :disabled="disabled" @click="copyToAll(i)">Copy these settings to all scenes</button>
        </div>
      </section>

      <button class="link reset" :disabled="disabled" @click="resetAll">Reset All</button>
    </div>
  </div>
</template>

<style scoped>
.cc { margin-top: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); }
.head, .shead { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; background: none; border: 0; color: var(--text); font-size: 14px; padding: 10px 14px; cursor: pointer; text-align: left; }
.head em { color: var(--muted); font-style: normal; font-size: 12px; margin-left: 6px; }
.sum { color: var(--muted); font-size: 12px; text-align: right; }
.sum.auto { opacity: 0.6; }
.body { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.block { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
.block h4 { margin: 0 0 8px; font-size: 13px; }
.block h4 small { color: var(--muted); font-weight: 400; margin-left: 6px; }
.scene { padding: 0; }
.shead { padding: 8px 12px; font-size: 13px; }
.shead b { white-space: nowrap; }
.sbody { padding: 0 12px 10px; }
.selects { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
@media (max-width: 800px) { .selects { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 480px) { .selects { grid-template-columns: 1fr; } }
label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); min-width: 0; }
select { width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px; font-size: 13px; }
.link { background: none; border: 0; color: var(--accent-2); font-size: 12px; cursor: pointer; padding: 8px 0 0; text-decoration: underline; }
.link:disabled { opacity: 0.5; cursor: not-allowed; }
.reset { align-self: flex-start; padding-top: 0; }
</style>
