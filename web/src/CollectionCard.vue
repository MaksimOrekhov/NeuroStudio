<script setup lang="ts">
import { computed } from "vue";
import { imageUrl, type Collection } from "./api";

const props = defineProps<{ collection: Collection }>();
defineEmits<{ open: [frame: number] }>();

const MODEL_LABEL: Record<string, string> = { "crimson-oath": "Crimson Oath", duskrose: "Duskrose" };

const badge = computed(() => {
  const c = props.collection;
  if (c.status === "done") return { text: "Completed", cls: "ok" };
  if (c.status === "running") return { text: `Generating ${c.doneFrames}/4`, cls: "run" };
  if (c.status === "interrupted") return { text: `Interrupted · ${c.doneFrames}/4`, cls: "warn" };
  return { text: `Failed · ${c.doneFrames}/4`, cls: "bad" };
});

const date = computed(() => new Date(props.collection.createdAt).toLocaleString());
const unknown = computed(() => props.collection.frames.filter((f) => f.status === "submitted" || f.status === "timeout"));
</script>

<template>
  <article class="card">
    <div class="head">
      <div>
        <h3>{{ collection.title }}</h3>
        <small>{{ date }}</small>
      </div>
      <span class="badge" :class="badge.cls">{{ badge.text }}</span>
    </div>
    <p v-if="collection.description" class="desc">{{ collection.description }}</p>

    <div class="grid">
      <figure v-for="f in collection.frames" :key="f.frame">
        <button v-if="f.image" class="img" @click="$emit('open', f.frame)">
          <img :src="imageUrl(collection.id, f.image)" :alt="f.summary" loading="lazy" decoding="async" />
        </button>
        <div v-else class="img empty" :class="f.status">
          <span v-if="f.status === 'submitted'">{{ collection.status === 'running' ? 'Generating…' : 'Unknown state' }}</span>
          <span v-else-if="f.status === 'pending'">{{ collection.status === 'running' ? 'Queued' : 'Not generated' }}</span>
          <span v-else>{{ f.status === 'timeout' ? 'Unknown state' : 'Failed' }}</span>
        </div>
        <figcaption>
          <b>{{ f.frame }}</b> {{ MODEL_LABEL[f.model] ?? f.model }}
          <a v-if="f.image" :href="imageUrl(collection.id, f.image, true)" title="Download PNG">PNG ↓</a>
        </figcaption>
      </figure>
    </div>

    <p v-if="collection.status !== 'running' && unknown.length" class="warnline">
      Frame state is unknown (run interrupted or ComfyUI went away). Not re-submitted automatically. Check ComfyUI history for
      prompt_id: {{ unknown.map((f) => f.promptId).filter(Boolean).join(', ') || 'none' }}.
    </p>
    <p v-else-if="collection.status === 'failed'" class="warnline bad">
      {{ collection.frames.find((f) => f.error)?.error }}
    </p>
  </article>
</template>

<style scoped>
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 18px; }
.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
h3 { margin: 0; font-size: 18px; }
small { color: var(--muted); }
.desc { color: var(--muted); font-size: 14px; margin: 8px 0 14px; }
.badge { font-size: 12px; padding: 4px 10px; border-radius: 99px; white-space: nowrap; }
.badge.ok { background: #10291f; color: var(--ok); }
.badge.run { background: #1d1a3a; color: var(--accent-2); }
.badge.warn { background: #2a2111; color: var(--warn); }
.badge.bad { background: #2a1219; color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
@media (max-width: 800px) { .grid { grid-template-columns: repeat(2, 1fr); } }
figure { margin: 0; }
.img { display: block; width: 100%; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); padding: 0; background: var(--panel-2); cursor: zoom-in; }
.img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.img.empty { display: grid; place-items: center; color: var(--muted); font-size: 13px; cursor: default; }
.img.empty.failed, .img.empty.timeout { color: var(--bad); }
figcaption { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); margin-top: 6px; }
figcaption b { color: var(--text); background: var(--panel-2); border-radius: 6px; padding: 0 7px; }
figcaption a { margin-left: auto; color: var(--accent-2); text-decoration: none; }
.warnline { font-size: 13px; color: var(--warn); margin: 12px 0 0; word-break: break-all; }
.warnline.bad { color: var(--bad); }
</style>
