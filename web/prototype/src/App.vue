<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ActivityView from "./components/ActivityView.vue";
import CreateView from "./components/CreateView.vue";
import LibraryView from "./components/LibraryView.vue";
import { failDemoRun, go, library, resetDemo, run, running, setComfy, startDemoRun, ui, type View } from "./store";
import { needsSelection } from "./library";

const tabs: { id: View; label: string }[] = [
  { id: "create", label: "Create" },
  { id: "library", label: "Library" },
  { id: "activity", label: "Activity" },
];
const pending = computed(() => library.items.filter(needsSelection).length);
const pct = computed(() => (run.total ? Math.round((run.done / run.total) * 100) : 0));
const runLabel = computed(() => {
  if (run.status === "planning") return "Planning with Codex";
  if (run.status === "generating") return `Generating ${run.done}/${run.total}`;
  if (run.status === "completed") return "Run completed";
  if (run.status === "failed") return "Run stopped";
  return "";
});

const demoOpen = ref(false);
const demoEl = ref<HTMLElement | null>(null);
const onDoc = (e: MouseEvent) => {
  if (demoOpen.value && demoEl.value && !demoEl.value.contains(e.target as Node)) demoOpen.value = false;
};
const onKey = (e: KeyboardEvent) => e.key === "Escape" && (demoOpen.value = false);
onMounted(() => {
  document.addEventListener("mousedown", onDoc);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDoc);
  document.removeEventListener("keydown", onKey);
});
function demo(fn: () => void) {
  fn();
  demoOpen.value = false;
}
</script>

<template>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <b>Neuro<span>Studio</span></b>
        <span class="proto" title="Interactive UX prototype for NS-013 — mock data only">Prototype</span>
      </div>

      <nav class="tabs" aria-label="Sections">
        <button v-for="t in tabs" :key="t.id" :class="{ on: ui.view === t.id }" :aria-current="ui.view === t.id ? 'page' : undefined" @click="go(t.id)">
          {{ t.label }}
          <span v-if="t.id === 'library' && pending" class="count" :title="`${pending} collections need Select Best`">{{ pending }}</span>
          <span v-if="t.id === 'activity' && running" class="live" aria-label="run in progress" />
          <span v-if="t.id === 'activity' && run.status === 'failed'" class="live bad" aria-label="last run stopped" />
        </button>
      </nav>

      <div class="right">
        <button v-if="run.status !== 'idle'" class="runpill" :class="run.status" :title="'Open Activity'" @click="go('activity')">
          <span v-if="running" class="spinner" />
          <span v-else class="dot" />
          <span class="rl">{{ runLabel }}</span>
          <span v-if="run.status === 'generating'" class="mini"><span :style="{ width: pct + '%' }" /></span>
        </button>
        <div class="comfy" :class="ui.comfy" :title="ui.comfy === 'ok' ? 'ComfyUI connected (mock)' : 'ComfyUI is not reachable (mock)'">
          <span class="dot" />
          <span class="cl">ComfyUI</span>
          <span class="cs">{{ ui.comfy === "ok" ? "connected" : "unavailable" }}</span>
        </div>
        <div ref="demoEl" class="demo">
          <button class="btn sm ghost" :aria-expanded="demoOpen" aria-haspopup="true" @click="demoOpen = !demoOpen">Demo ▾</button>
          <div v-if="demoOpen" class="menu card" role="menu">
            <p class="eyebrow">Prototype controls</p>
            <p class="hint">Mock states for review. Nothing is sent to Codex or ComfyUI.</p>
            <div class="grp">
              <span>ComfyUI</span>
              <div class="seg">
                <button :class="{ on: ui.comfy === 'ok' }" @click="setComfy('ok')">Connected</button>
                <button :class="{ on: ui.comfy === 'down' }" @click="setComfy('down')">Unavailable</button>
              </div>
            </div>
            <button class="item" role="menuitem" :disabled="running || ui.comfy === 'down'" @click="demo(() => { startDemoRun(); go('activity'); })">Start simulated run with current Create settings</button>
            <button class="item" role="menuitem" :disabled="!running" @click="demo(() => failDemoRun('error'))">Simulate a generation error</button>
            <button class="item" role="menuitem" :disabled="!running" @click="demo(() => setComfy('down'))">Simulate ComfyUI disconnect</button>
            <button class="item" role="menuitem" @click="demo(resetDemo)">Reset demo data</button>
          </div>
        </div>
      </div>
    </header>

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
.top { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 16px; padding: 10px 24px; background: rgba(10, 11, 15, 0.86); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; }
.brand b { font-size: 17px; letter-spacing: 0.2px; }
.brand b span { color: var(--accent-2); }
.proto { font-size: 11px; color: var(--warn); border: 1px solid rgba(245, 165, 36, 0.35); border-radius: 6px; padding: 1px 7px; }
.tabs { display: flex; gap: 4px; padding: 3px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.tabs button { position: relative; display: flex; align-items: center; gap: 7px; padding: 6px 16px; border: 0; border-radius: 9px; background: none; color: var(--text-2); font-weight: 500; }
.tabs button:hover:not(.on) { color: var(--text); background: var(--panel-2); }
.tabs button.on { background: var(--panel-3); color: var(--text); }
.count { min-width: 18px; padding: 0 5px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-2); font-size: 11px; line-height: 18px; text-align: center; }
.live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 0 3px var(--accent-soft); }
.live.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.runpill { display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 99px; border: 1px solid var(--line-2); background: var(--panel); color: var(--text); font-size: 13px; min-width: 0; }
.runpill:hover { border-color: var(--accent); }
.runpill .dot { background: var(--ok); }
.runpill.failed .dot { background: var(--bad); }
.runpill .rl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini { width: 54px; height: 4px; border-radius: 99px; background: var(--panel-3); overflow: hidden; flex: none; }
.mini span { display: block; height: 100%; background: var(--accent-2); transition: width 0.4s; }
.comfy { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 99px; border: 1px solid var(--line); background: var(--panel); font-size: 13px; color: var(--text-2); white-space: nowrap; }
.comfy .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.comfy.down { border-color: rgba(240, 80, 110, 0.4); color: #f58aa0; }
.comfy.down .dot { background: var(--bad); box-shadow: none; }
.cs { color: var(--muted); }
.comfy.down .cs { color: inherit; }
.demo { position: relative; }
.menu { position: absolute; right: 0; top: calc(100% + 8px); width: 300px; padding: 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow); z-index: 30; }
.hint { font-size: 12px; color: var(--muted); margin-top: -4px; }
.grp { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text-2); padding: 4px 0 6px; border-bottom: 1px solid var(--line); }
.item { text-align: left; background: none; border: 0; border-radius: 8px; padding: 7px 8px; color: var(--text); font-size: 13px; }
.item:hover:not(:disabled) { background: var(--panel-2); }
.item:disabled { opacity: 0.4; }
main { padding: 24px 24px 120px; max-width: 1320px; margin: 0 auto; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 50; pointer-events: none; }
.tmsg { background: var(--panel-3); border: 1px solid var(--line-2); color: var(--text); padding: 10px 16px; border-radius: 10px; box-shadow: var(--shadow); font-size: 13px; max-width: min(520px, calc(100vw - 32px)); }

@media (max-width: 900px) {
  .top { grid-template-columns: 1fr auto; padding: 10px 16px; row-gap: 10px; }
  .tabs { grid-column: 1 / -1; grid-row: 2; justify-content: stretch; }
  .tabs button { flex: 1; justify-content: center; padding: 7px 8px; }
  .cl, .rl { display: none; }
  .runpill { padding: 6px 10px; }
  main { padding: 16px 16px 120px; }
  .toast { bottom: 88px; }
}
@media (max-width: 480px) {
  .proto { display: none; }
  .cs { display: none; }
  .comfy::after { content: "ComfyUI"; }
  .comfy.down::after { content: "ComfyUI off"; }
}
</style>
