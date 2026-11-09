<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { exportUrl, imageUrl, saveFeedback, selectBest, thumbUrl, type Collection, type ExportStatus, type Feedback, type Frame } from "./api";

const props = defineProps<{ collection: Collection }>();
const emit = defineEmits<{ open: [frame: number, variant: number]; changed: [result: { selections: Record<string, number>; export: ExportStatus }]; feedback: [fb: Feedback | null] }>();

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

// Collection feedback (optional, saved immediately; independent of Select Best and ZIP export).
const GOOD = [
  ["beautiful_heroine", "Beautiful heroine"],
  ["great_outfit", "Great outfit"],
  ["good_composition", "Good composition"],
  ["beautiful_lighting", "Beautiful lighting"],
  ["original_concept", "Original concept"],
] as const;
const BAD = [
  ["bad_anatomy", "Bad anatomy"],
  ["inconsistent_heroine", "Inconsistent heroine"],
  ["poor_outfit", "Poor outfit"],
  ["repetitive_composition", "Repetitive composition"],
  ["weak_concept", "Weak concept"],
] as const;
const NOTE_MAX = 500;
const fbOpen = ref(false);
const fbHover = ref(0);
const fbError = ref("");
const fbSaving = ref(false);
const fbDraft = reactive({ rating: props.collection.feedback?.rating ?? (null as number | null), tags: [...(props.collection.feedback?.tags ?? [])], note: props.collection.feedback?.note ?? "" });
let fbSavedNote = fbDraft.note;

async function persistFeedback() {
  fbSaving.value = true;
  fbError.value = "";
  try {
    const r = await saveFeedback(props.collection.id, { rating: fbDraft.rating, tags: fbDraft.tags, note: fbDraft.note });
    fbSavedNote = fbDraft.note;
    emit("feedback", r.feedback);
  } catch (e) {
    fbError.value = (e as Error).message;
  } finally {
    fbSaving.value = false;
  }
}
function rate(n: number) {
  fbDraft.rating = fbDraft.rating === n ? null : n; // clicking the current rating clears it
  void persistFeedback();
}
function toggleTag(t: string) {
  const i = fbDraft.tags.indexOf(t);
  if (i >= 0) fbDraft.tags.splice(i, 1);
  else fbDraft.tags.push(t);
  void persistFeedback();
}
function saveNote() {
  if (fbDraft.note !== fbSavedNote) void persistFeedback();
}
const fbSummary = computed(() => {
  const f = props.collection.feedback;
  if (!f) return "Rate this collection";
  const n = f.tags.length;
  return (f.rating ? `${"★".repeat(f.rating)}${"☆".repeat(5 - f.rating)}` : "No rating") + (n ? ` · ${n} tag${n > 1 ? "s" : ""}` : "") + (f.note ? " · note" : "");
});

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

    <div class="fb">
      <button class="fbtoggle" :aria-expanded="fbOpen" @click="fbOpen = !fbOpen">
        <span>{{ fbOpen ? "▾" : "▸" }} Feedback</span>
        <span class="fbsum">{{ fbSummary }}</span>
      </button>
      <div v-if="fbOpen" class="fbbody">
        <div class="stars" role="radiogroup" aria-label="Collection rating" @mouseleave="fbHover = 0">
          <button
            v-for="n in 5"
            :key="n"
            class="starbtn"
            :class="{ on: n <= (fbHover || fbDraft.rating || 0) }"
            role="radio"
            :aria-checked="fbDraft.rating === n"
            :aria-label="`${n} star${n > 1 ? 's' : ''}`"
            @mouseenter="fbHover = n"
            @click="rate(n)"
          >★</button>
          <button v-if="fbDraft.rating" class="clear" @click="rate(fbDraft.rating)">Clear</button>
        </div>
        <div class="tags">
          <button v-for="[k, label] in GOOD" :key="k" class="tag good" :class="{ on: fbDraft.tags.includes(k) }" @click="toggleTag(k)">{{ label }}</button>
        </div>
        <div class="tags">
          <button v-for="[k, label] in BAD" :key="k" class="tag bad" :class="{ on: fbDraft.tags.includes(k) }" @click="toggleTag(k)">{{ label }}</button>
        </div>
        <textarea v-model="fbDraft.note" class="note" rows="2" :maxlength="NOTE_MAX" placeholder="Optional note (what worked, what didn't)" @blur="saveNote"></textarea>
        <small class="fbmeta">{{ fbDraft.note.length }}/{{ NOTE_MAX }}<template v-if="fbSaving"> · saving…</template></small>
        <p v-if="fbError" class="warnline bad">Could not save feedback: {{ fbError }}</p>
      </div>
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
.fb { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.fbtoggle { display: flex; justify-content: space-between; gap: 12px; width: 100%; background: none; border: 0; padding: 2px 0; color: var(--text); font-size: 14px; cursor: pointer; }
.fbsum { color: var(--muted); font-size: 13px; }
.fbbody { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.stars { display: flex; align-items: center; gap: 2px; }
.starbtn { background: none; border: 0; padding: 0 3px; font-size: 26px; line-height: 1; color: var(--line); cursor: pointer; }
.starbtn.on { color: #f5b942; }
.clear { margin-left: 10px; background: none; border: 0; color: var(--muted); font-size: 13px; cursor: pointer; text-decoration: underline; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 4px 10px; font-size: 12px; border-radius: 99px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); cursor: pointer; }
.tag.good.on { background: #10291f; color: var(--ok); border-color: var(--ok); }
.tag.bad.on { background: #2a1219; color: var(--bad); border-color: var(--bad); }
.note { width: 100%; box-sizing: border-box; resize: vertical; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: inherit; font-size: 13px; }
.fbmeta { margin-top: -6px; }
.warnline { font-size: 13px; color: var(--warn); margin: 12px 0 0; word-break: break-all; }
.warnline.bad { color: var(--bad); }
</style>
