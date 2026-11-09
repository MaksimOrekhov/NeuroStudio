<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getCollections, getStatus, startRun, type ApiStatus, type Collection } from "./api";
import CollectionCard from "./CollectionCard.vue";
import Lightbox from "./Lightbox.vue";

const status = ref<ApiStatus | null>(null);
const collections = ref<Collection[]>([]);
const theme = ref("");
const starting = ref(false);
const error = ref("");
const serverDown = ref(false);
const lightbox = ref<{ c: Collection; frame: number } | null>(null);
let timer: number | undefined;

const run = computed(() => status.value?.run);
const active = computed(() => run.value?.status === "planning" || run.value?.status === "generating");
const comfyOk = computed(() => status.value?.comfy.ok === true);
const canStart = computed(() => !starting.value && !active.value && comfyOk.value && !serverDown.value);
const percent = computed(() => (run.value ? (run.value.done / run.value.total) * 100 : 0));

const phase = computed(() => {
  const r = run.value;
  if (!r) return "";
  if (r.status === "planning") return "Creating concept and prompts with Codex…";
  if (r.status === "generating") {
    return r.currentFrame ? `Generating image — scene ${r.currentFrame}` : "Generating images";
  }
  if (r.status === "completed") return "Collection completed";
  return "";
});

const hint = computed(() => {
  if (serverDown.value) return "NeuroStudio server is not responding.";
  if (!comfyOk.value) return "ComfyUI is not reachable. Start ComfyUI first — generation is disabled.";
  return "";
});

async function refresh() {
  try {
    const prev = run.value?.status;
    status.value = await getStatus();
    serverDown.value = false;
    const cur = status.value.run.status;
    if (active.value || prev !== cur) collections.value = await getCollections();
  } catch {
    serverDown.value = true;
  }
  timer = window.setTimeout(refresh, active.value ? 1500 : 5000);
}

async function start() {
  error.value = "";
  starting.value = true;
  try {
    const s = await startRun(theme.value);
    if (status.value) status.value.run = s;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    starting.value = false;
  }
}

onMounted(async () => {
  try {
    collections.value = await getCollections();
  } catch {
    /* handled by refresh */
  }
  refresh();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
    <header>
      <h1>Neuro<span>Studio</span></h1>
      <div class="comfy" :class="{ ok: comfyOk }" :title="status?.comfy.error">
        <i /> ComfyUI
        <template v-if="comfyOk">
          connected · v{{ status?.comfy.version }}
          <small v-if="(status?.comfy.queueRunning ?? 0) + (status?.comfy.queuePending ?? 0) > 0">
            · queue {{ (status?.comfy.queueRunning ?? 0) + (status?.comfy.queuePending ?? 0) }}
          </small>
        </template>
        <template v-else>unreachable</template>
      </div>
    </header>

    <section class="panel hero">
      <label for="theme">Theme <em>optional</em></label>
      <input id="theme" v-model="theme" :disabled="active" maxlength="200" placeholder="Leave empty — AI invents the concept" @keyup.enter="canStart && start()" />
      <button class="go" :disabled="!canStart" @click="start">
        {{ active ? "Generating…" : "Generate Collections" }}
      </button>
      <p v-if="hint" class="note warn">{{ hint }}</p>

      <div v-if="active || run?.status === 'completed'" class="progress">
        <div class="row">
          <span>{{ phase }}</span>
          <b>{{ run?.done }} / {{ run?.total }} images</b>
        </div>
        <div class="bar"><div :style="{ width: percent + '%' }" /></div>
        <p v-if="run?.title" class="muted">{{ run.title }}</p>
      </div>

      <p v-if="run?.status === 'failed'" class="note bad">Run failed: {{ run.error }}</p>
      <p v-if="error" class="note bad">{{ error }}</p>
    </section>

    <section class="gallery">
      <h2>Collections</h2>
      <p v-if="!collections.length" class="muted">No collections yet. Press Generate Collections.</p>
      <CollectionCard v-for="c in collections" :key="c.id" :collection="c" @open="(f) => (lightbox = { c, frame: f })" />
    </section>

    <Lightbox v-if="lightbox" :collection="lightbox.c" :frame="lightbox.frame" @close="lightbox = null" />
  </div>
</template>

<style scoped>
.page { max-width: 1100px; margin: 0 auto; padding: 24px 20px 80px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 0.3px; }
h1 span { color: var(--accent-2); }
.comfy { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); padding: 6px 12px; border-radius: 999px; }
.comfy i { width: 9px; height: 9px; border-radius: 50%; background: var(--bad); }
.comfy.ok i { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
.hero { display: grid; gap: 12px; }
label { font-size: 13px; color: var(--muted); }
label em { font-style: normal; opacity: 0.6; margin-left: 6px; }
input { width: 100%; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 12px 14px; outline: none; }
input:focus { border-color: var(--accent); }
.go { margin-top: 4px; padding: 18px; font-size: 18px; font-weight: 600; color: #fff; border: 0; border-radius: 12px; cursor: pointer; background: linear-gradient(135deg, var(--accent), #5b8cff); }
.go:hover:not(:disabled) { filter: brightness(1.1); }
.go:disabled { opacity: 0.45; cursor: not-allowed; }
.note { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 14px; }
.note.warn { background: #2a2111; color: var(--warn); }
.note.bad { background: #2a1219; color: var(--bad); }
.progress { margin-top: 6px; }
.row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
.bar { height: 8px; border-radius: 99px; background: var(--panel-2); overflow: hidden; }
.bar div { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width 0.4s; }
.muted { color: var(--muted); font-size: 14px; }
.gallery { margin-top: 36px; display: grid; gap: 20px; }
h2 { margin: 0; font-size: 16px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
</style>
