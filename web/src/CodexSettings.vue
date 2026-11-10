<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { getCodexModels, type CodexModels } from "./api";

defineProps<{ disabled?: boolean }>();

const KEY = "neurostudio.codex";
const catalog = ref<CodexModels | null>(null);
const sel = reactive({ model: "", effort: "" }); // "" = Default (Codex settings)

const models = computed(() => catalog.value?.models ?? []);
/** With a chosen model: its efforts. With Default model we cannot know which model Codex will use, so only efforts every listed model supports. */
const efforts = computed(() => {
  const m = models.value.find((x) => x.id === sel.model);
  if (m) return m.efforts;
  const [first, ...rest] = models.value;
  return first ? first.efforts.filter((e) => rest.every((x) => x.efforts.some((y) => y.id === e.id))) : [];
});

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    sel.model = typeof s.model === "string" ? s.model : "";
    sel.effort = typeof s.effort === "string" ? s.effort : "";
  } catch {
    /* no storage: defaults */
  }
}
/** Anything that is no longer offered falls back to Default. */
function sanitize() {
  if (sel.model && !models.value.some((m) => m.id === sel.model)) sel.model = "";
  if (sel.effort && !efforts.value.some((e) => e.id === sel.effort)) sel.effort = "";
}
watch(
  () => [sel.model, sel.effort],
  () => {
    if (!catalog.value) return; // do not overwrite stored values before the catalog is known
    sanitize();
    try {
      localStorage.setItem(KEY, JSON.stringify({ model: sel.model, effort: sel.effort }));
    } catch {
      /* ignore */
    }
  },
);

onMounted(async () => {
  load();
  try {
    catalog.value = await getCodexModels();
  } catch (e) {
    catalog.value = { source: "none", error: `Codex model list is unavailable (${(e as Error).message}). Using Codex settings.`, models: [] };
  }
  sanitize();
});

/** Request fields; undefined = Default (the old behaviour). */
const value = computed(() => ({ codexModel: sel.model || undefined, codexReasoningEffort: sel.effort || undefined }));
defineExpose({ value });
</script>

<template>
  <div class="cs">
    <h4>Prompt Generation Settings <em>optional</em></h4>
    <div class="row">
      <label>
        <span>Model</span>
        <select v-model="sel.model" :disabled="disabled || !models.length">
          <option value="">Default (Codex settings)</option>
          <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </label>
      <label>
        <span>Reasoning Effort</span>
        <select v-model="sel.effort" :disabled="disabled || !models.length">
          <option value="">Default</option>
          <option v-for="e in efforts" :key="e.id" :value="e.id">{{ e.label }}</option>
        </select>
      </label>
    </div>
    <p v-if="catalog?.error" class="diag">{{ catalog.error }}</p>
    <p v-else-if="sel.model || sel.effort" class="hint">Passed to Codex as an explicit choice; Codex or managed settings may still affect the result.</p>
  </div>
</template>

<style scoped>
.cs { margin-top: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); padding: 10px 14px 12px; }
h4 { margin: 0 0 8px; font-size: 14px; font-weight: 500; }
h4 em { color: var(--muted); font-style: normal; font-size: 12px; margin-left: 6px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); min-width: 0; }
select { width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px; font-size: 13px; }
.diag { margin: 8px 0 0; font-size: 12px; color: var(--warn); }
.hint { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
</style>
