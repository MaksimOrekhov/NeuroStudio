<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import ActivityView from "./components/ActivityView.vue";
import CreateView from "./components/CreateView.vue";
import LibraryView from "./components/LibraryView.vue";
import { W, nPlural } from "./ru";
import { app, comfyOk, go, pendingSelection, run, running, startPolling, stopPolling, ui, type View } from "./store";

const tabs: { id: View; label: string }[] = [
  { id: "create", label: "Создание" },
  { id: "library", label: "Библиотека" },
  { id: "activity", label: "Запуски" },
];
const state = computed(() => run.value?.status ?? "idle");
const pct = computed(() => (run.value?.total ? Math.round((run.value.done / run.value.total) * 100) : 0));
const runLabel = computed(() => {
  if (state.value === "planning") return "Codex составляет план";
  if (state.value === "generating") return `Генерация ${run.value?.done}/${run.value?.total}`;
  if (state.value === "completed") return "Генерация завершена";
  if (state.value === "failed") return "Генерация остановлена";
  return "";
});
const comfyText = computed(() => (app.connection === "connecting" ? "проверка…" : comfyOk.value ? "подключён" : "недоступен"));
const comfyTitle = computed(() => (comfyOk.value ? `ComfyUI подключён · v${app.status?.comfy.version}` : (app.status?.comfy.error ?? "ComfyUI недоступен")));

onMounted(startPolling);
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand"><b>Neuro<span>Studio</span></b></div>

      <nav class="tabs" aria-label="Разделы">
        <button v-for="t in tabs" :key="t.id" :class="{ on: ui.view === t.id }" :aria-current="ui.view === t.id ? 'page' : undefined" @click="go(t.id)">
          {{ t.label }}
          <span v-if="t.id === 'library' && pendingSelection" class="count" :title="`Требуется выбор лучших: ${nPlural(pendingSelection, W.collection)}`">{{ pendingSelection }}</span>
          <span v-if="t.id === 'activity' && running" class="live" aria-label="идёт генерация" />
          <span v-if="t.id === 'activity' && state === 'failed'" class="live bad" aria-label="последняя генерация остановлена" />
        </button>
      </nav>

      <div class="right">
        <button v-if="state !== 'idle'" class="runpill" :class="state" title="Открыть «Запуски»" @click="go('activity')">
          <span v-if="running" class="spinner" />
          <span v-else class="dot" />
          <span class="rl">{{ runLabel }}</span>
          <span v-if="state === 'generating'" class="mini"><span :style="{ width: pct + '%' }" /></span>
        </button>
        <div class="comfy" :class="{ down: app.connection !== 'connecting' && !comfyOk }" :title="comfyTitle">
          <span class="dot" />
          ComfyUI <span class="cs">{{ comfyText }}</span>
        </div>
      </div>
    </header>

    <p v-if="app.connection === 'lost'" class="lost" role="alert">
      Нет связи с сервером NeuroStudio. Показано последнее известное состояние<template v-if="running"> — генерация на сервере при этом продолжается</template>. Связь проверяется автоматически.
    </p>

    <main>
      <CreateView v-if="ui.view === 'create'" />
      <LibraryView v-else-if="ui.view === 'library'" />
      <ActivityView v-else />
    </main>

    <div class="toast" role="status" aria-live="polite">
      <div v-if="ui.toast" class="tmsg">{{ ui.toast }}</div>
    </div>
  </div>
</template>

<style scoped>
.shell { min-height: 100vh; }
.top { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 20px; padding: 12px 32px; background: rgba(10, 11, 15, 0.88); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.brand b { font-size: 18px; letter-spacing: 0.2px; }
.brand b span { color: var(--accent-2); }
.tabs { display: flex; gap: 4px; padding: 3px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.tabs button { position: relative; display: flex; align-items: center; gap: 8px; padding: 7px 22px; border: 0; border-radius: 9px; background: none; color: var(--text-2); font-weight: 500; font-size: 15px; }
.tabs button:hover:not(.on) { color: var(--text); background: var(--panel-2); }
.tabs button.on { background: var(--panel-3); color: var(--text); }
.count { min-width: 20px; padding: 0 6px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-2); font-size: 12px; line-height: 20px; text-align: center; }
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 0 3px var(--accent-soft); }
.live.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.right { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.runpill { display: flex; align-items: center; gap: 8px; padding: 5px 14px; border-radius: 99px; border: 1px solid var(--line-2); background: var(--panel); color: var(--text); font-size: 13px; min-width: 0; }
.runpill:hover { border-color: var(--accent); }
.runpill .dot { background: var(--ok); }
.runpill.failed .dot { background: var(--bad); }
.runpill .rl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini { width: 64px; height: 4px; border-radius: 99px; background: var(--panel-3); overflow: hidden; flex: none; }
.mini span { display: block; height: 100%; background: var(--accent-2); transition: width 0.4s; }
.comfy { display: flex; align-items: center; gap: 6px; padding: 5px 14px; border-radius: 99px; border: 1px solid var(--line); background: var(--panel); font-size: 13px; color: var(--text-2); white-space: nowrap; }
.comfy .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.comfy.down { border-color: rgba(240, 80, 110, 0.4); color: #f58aa0; }
.comfy.down .dot { background: var(--bad); box-shadow: none; }
.cs { color: var(--muted); }
.comfy.down .cs { color: inherit; }
.lost { margin: 0; padding: 8px 32px; background: var(--warn-soft); color: #f7c06a; font-size: 14px; border-bottom: 1px solid rgba(245, 165, 36, 0.25); }
/* Desktop only (27" 2560×1440 primary, 1920×1080 secondary): wide but bounded content area. */
main { padding: 28px 40px 80px; max-width: 2240px; margin: 0 auto; }
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 50; pointer-events: none; }
.tmsg { background: var(--panel-3); border: 1px solid var(--line-2); color: var(--text); padding: 10px 18px; border-radius: 10px; box-shadow: var(--shadow); font-size: 14px; max-width: 640px; }
@media (max-width: 1360px) {
  .top { padding: 10px 20px; }
  main { padding: 20px 20px 80px; }
  .cs { display: none; }
}
</style>
