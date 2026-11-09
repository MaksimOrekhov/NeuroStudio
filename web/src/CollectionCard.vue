<script setup lang="ts">
import { computed, reactive } from "vue";
import { exportUrl, imageUrl, selectBest, thumbUrl, type Collection, type ExportStatus, type Frame } from "./api";

const props = defineProps<{ collection: Collection }>();
const emit = defineEmits<{ open: [frame: number, variant: number]; changed: [result: { selections: Record<string, number>; export: ExportStatus }] }>();

const MODEL_LABEL: Record<string, string> = { "crimson-oath": "Crimson Oath", duskrose: "Duskrose" };

/** Variant the user is currently looking at, per frame (defaults to the selected best, else the first finished one). */
const viewing = reactive<Record<number, number>>({});
const saveError = reactive({ text: "" });
/** Images whose file could not be loaded (deleted from disk): shown as a placeholder. */
const broken = reactive<Record<string, boolean>>({});
const isBroken = (f: Frame) => !!f.image && broken[`${props.collection.id}/${f.image}`];

// The four scenes, each with its seed variants.
const scenes = computed(() => {
  const byFrame = new Map<number, Frame[]>();
  for (const f of props.collection.frames) byFrame.set(f.frame, [...(byFrame.get(f.frame) ?? []), f]);
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, variants]) => ({ frame, variants }));
});

function current(frame: number, variants: Frame[]): Frame {
  const best = props.collection.selections[String(frame)];
  const want = viewing[frame] ?? best;
  return variants.find((v) => v.variant === want) ?? variants.find((v) => v.image) ?? variants[0];
}

async function pick(frame: number, variant: number) {
  const isBest = props.collection.selections[String(frame)] === variant;
  saveError.text = "";
  try {
    emit("changed", await selectBest(props.collection.id, frame, isBest ? null : variant));
  } catch (e) {
    saveError.text = (e as Error).message;
  }
}

const badge = computed(() => {
  const c = props.collection;
  const total = c.frames.length;
  if (c.status === "done") return { text: "Completed", cls: "ok" };
  if (c.status === "running") return { text: `Generating ${c.doneFrames}/${total}`, cls: "run" };
  if (c.status === "interrupted") return { text: `Interrupted · ${c.doneFrames}/${total}`, cls: "warn" };
  return { text: `Failed · ${c.doneFrames}/${total}`, cls: "bad" };
});

const chosen = computed(() => Object.keys(props.collection.selections).length);
const date = computed(() => new Date(props.collection.createdAt).toLocaleString());
const unknown = computed(() => props.collection.frames.filter((f) => f.status === "submitted" || f.status === "timeout"));
</script>

<template>
  <article class="card">
    <div class="head">
      <div>
        <h3>{{ collection.title }}</h3>
        <small>{{ date }}<template v-if="collection.variations > 1"> · {{ collection.variations }} variations per scene · {{ chosen }}/4 best chosen</template></small>
      </div>
      <span class="badge" :class="badge.cls">{{ badge.text }}</span>
    </div>
    <p v-if="collection.description" class="desc">{{ collection.description }}</p>

    <div class="grid">
      <figure v-for="s in scenes" :key="s.frame">
        <template v-for="f in [current(s.frame, s.variants)]" :key="f.variant">
          <button v-if="f.image && !isBroken(f)" class="img" :class="{ best: collection.selections[String(s.frame)] === f.variant }" @click="emit('open', s.frame, f.variant)">
            <img :src="thumbUrl(collection.id, f.image)" :alt="f.summary" loading="lazy" decoding="async" @error="broken[`${collection.id}/${f.image}`] = true" />
            <span v-if="collection.selections[String(s.frame)] === f.variant" class="star">★ Best</span>
          </button>
          <div v-else class="img empty" :class="f.status">
            <span v-if="isBroken(f)">File missing</span>
            <span v-else-if="f.status === 'submitted'">{{ collection.status === 'running' ? 'Generating…' : 'Unknown state' }}</span>
            <span v-else-if="f.status === 'pending'">{{ collection.status === 'running' ? 'Queued' : 'Not generated' }}</span>
            <span v-else>{{ f.status === 'timeout' ? 'Unknown state' : 'Failed' }}</span>
          </div>
          <figcaption>
            <b>{{ s.frame }}</b> {{ MODEL_LABEL[f.model] ?? f.model }}
            <a v-if="f.image && !isBroken(f)" :href="imageUrl(collection.id, f.image, true)" title="Download PNG">PNG ↓</a>
          </figcaption>
          <div v-if="s.variants.length > 1" class="vars">
            <button
              v-for="v in s.variants"
              :key="v.variant"
              :class="{ on: v.variant === f.variant, best: collection.selections[String(s.frame)] === v.variant, off: !v.image }"
              :title="v.image ? `Seed ${v.seed}` : v.status"
              @click="viewing[s.frame] = v.variant"
            >
              v{{ v.variant }}<template v-if="collection.selections[String(s.frame)] === v.variant"> ★</template>
            </button>
          </div>
          <button v-if="f.image && !isBroken(f)" class="sel" :class="{ on: collection.selections[String(s.frame)] === f.variant }" @click="pick(s.frame, f.variant)">
            {{ collection.selections[String(s.frame)] === f.variant ? "✓ Selected" : "Select Best" }}
          </button>
        </template>
      </figure>
    </div>

    <div class="export">
      <a v-if="collection.export.ready" class="dl" :href="exportUrl(collection.id)" download>Download Selected (ZIP)</a>
      <button v-else class="dl off" disabled :title="collection.export.message">Download Selected (ZIP)</button>
      <span v-if="!collection.export.ready" class="why">{{ collection.export.message }}</span>
      <span v-else class="why">4 scenes · original PNG files</span>
    </div>

    <p v-if="saveError.text" class="warnline bad">Could not save selection: {{ saveError.text }}</p>
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
.img { position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; border-radius: 10px; overflow: hidden; border: 2px solid var(--line); padding: 0; background: var(--panel-2); cursor: zoom-in; }
.img.best { border-color: var(--ok); }
.img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.star { position: absolute; top: 8px; left: 8px; background: rgba(16, 41, 31, 0.92); color: var(--ok); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
.img.empty { display: grid; place-items: center; color: var(--muted); font-size: 13px; cursor: default; }
.img.empty.failed, .img.empty.timeout { color: var(--bad); }
figcaption { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); margin-top: 6px; }
figcaption b { color: var(--text); background: var(--panel-2); border-radius: 6px; padding: 0 7px; }
figcaption a { margin-left: auto; color: var(--accent-2); text-decoration: none; }
.vars { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.vars button { flex: 1; min-width: 34px; padding: 3px 0; font-size: 12px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
.vars button.on { color: var(--text); border-color: var(--accent); }
.vars button.best { color: var(--ok); }
.vars button.off { opacity: 0.45; }
.sel { width: 100%; margin-top: 6px; padding: 6px; font-size: 13px; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.sel:hover { border-color: var(--accent); }
.sel.on { background: #10291f; color: var(--ok); border-color: var(--ok); }
.export { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.dl { padding: 9px 16px; border-radius: 10px; border: 0; font-size: 14px; font-weight: 600; color: #fff; background: linear-gradient(135deg, var(--accent), #5b8cff); text-decoration: none; cursor: pointer; }
.dl.off { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); cursor: not-allowed; font-weight: 500; }
.why { font-size: 13px; color: var(--muted); }
.warnline { font-size: 13px; color: var(--warn); margin: 12px 0 0; word-break: break-all; }
.warnline.bad { color: var(--bad); }
</style>
