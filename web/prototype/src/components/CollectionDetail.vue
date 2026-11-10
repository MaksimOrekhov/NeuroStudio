<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { COMPOSITION_FIELDS, COMPOSITION_OPTIONS, FIELD_LABEL } from "../../../../src/composition";
import { badgeOf, exportState, pad2, scenesOf, unknownFrames, type ProtoCollection, type Scene } from "../library";
import { EFFORT_LABEL, MOCK_CODEX } from "../mock";
import { modelById } from "../models";
import { go, selectBest, toast } from "../store";
import MockImage from "./MockImage.vue";
import Viewer from "./Viewer.vue";

const props = defineProps<{ c: ProtoCollection }>();

const scenes = computed(() => scenesOf(props.c));
const exp = computed(() => exportState(props.c));
const badge = computed(() => badgeOf(props.c));
const unknown = computed(() => unknownFrames(props.c));

/** Variant shown per scene: what the user clicked, else Best, else first finished. */
const viewing = reactive<Record<number, number>>({});
function current(s: Scene) {
  const want = viewing[s.frame] ?? props.c.selections[String(s.frame)];
  return s.variants.find((v) => v.variant === want) ?? s.variants.find((v) => v.image) ?? s.variants[0];
}
const isBest = (frame: number, variant: number) => props.c.selections[String(frame)] === variant;

const viewer = ref<{ frame: number; variant: number } | null>(null);

// ---- Feedback (same tags and limits as the real app) ----
const GOOD = [["beautiful_heroine", "Beautiful heroine"], ["great_outfit", "Great outfit"], ["good_composition", "Good composition"], ["beautiful_lighting", "Beautiful lighting"], ["original_concept", "Original concept"]] as const;
const BAD = [["bad_anatomy", "Bad anatomy"], ["inconsistent_heroine", "Inconsistent heroine"], ["poor_outfit", "Poor outfit"], ["repetitive_composition", "Repetitive composition"], ["weak_concept", "Weak concept"]] as const;
const hover = ref(0);
const note = ref(props.c.feedback?.note ?? "");
watch(() => props.c.id, () => (note.value = props.c.feedback?.note ?? ""));
function fb() {
  props.c.feedback ??= { version: 1, rating: null, tags: [], note: "", updatedAt: "" };
  props.c.feedback.updatedAt = new Date().toISOString();
  return props.c.feedback;
}
const rate = (n: number) => (fb().rating = fb().rating === n ? null : n);
function toggleTag(t: string) {
  const f = fb();
  f.tags = f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t];
}
function saveNote() {
  if (note.value === (props.c.feedback?.note ?? "")) return;
  fb().note = note.value;
  toast("Note saved (prototype: kept in memory only).");
}

// ---- Details ----
const codex = computed(() => {
  const m = MOCK_CODEX.models.find((x) => x.id === props.c.meta.codexModel)?.name ?? "Default";
  return `${m} · ${props.c.meta.codexEffort ? EFFORT_LABEL[props.c.meta.codexEffort] : "default effort"}`;
});
const compLine = (i: number) => {
  const s = props.c.meta.composition[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => `${FIELD_LABEL[f]}: ${COMPOSITION_OPTIONS[f].find((x) => x.id === s[f])?.label}`);
  return parts.length ? parts.join(" · ") : "Auto";
};
const date = computed(() => new Date(props.c.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }));
const secs = (s?: number) => (s === undefined ? "—" : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

function exportZip() {
  toast(`Prototype: would download ${exp.value.total} original PNG ${exp.value.total === 1 ? "file" : "files"} as one ZIP.`);
}
function downloadPng(frame: number, variant: number) {
  toast(`Prototype: would download scene ${pad2(frame)} v${pad2(variant)} as PNG.`);
}
</script>

<template>
  <div class="detail">
    <button class="btn ghost sm back" @click="go('library')">← Library</button>

    <div class="head">
      <div class="ht">
        <div class="title">
          <h1>{{ c.title }}</h1>
          <span class="badge" :class="badge.cls"><span v-if="c.status === 'running'" class="spinner" />{{ badge.text }}</span>
        </div>
        <p class="muted small">{{ date }} · {{ c.frameCount }} {{ c.frameCount === 1 ? "frame" : "frames" }}<template v-if="c.variations > 1"> × {{ c.variations }} variations</template></p>
        <p v-if="c.description" class="desc">{{ c.description }}</p>
      </div>
      <div class="exp">
        <button class="btn primary" :disabled="!exp.ready" :title="exp.ready ? '' : exp.message" @click="exportZip">Export selected · ZIP</button>
        <small :class="{ ok: exp.ready }">{{ exp.ready ? `✓ ${exp.message}` : exp.message }}</small>
      </div>
    </div>

    <div v-if="c.status === 'failed' || c.status === 'interrupted'" class="note" :class="c.status === 'failed' ? 'bad' : 'warn'">
      <b>{{ c.status === "failed" ? "Generation failed." : "Generation was interrupted." }}</b>
      {{ c.doneFrames }} of {{ c.frames.length }} images were saved and can be used normally.
      <template v-if="c.frames.find((f) => f.error)"> Error: {{ c.frames.find((f) => f.error)?.error }}.</template>
      Missing images are not regenerated or resumed automatically — start a new run from Create if you need them.
      <span v-if="unknown.length" class="ids">
        State unknown for {{ unknown.length }} {{ unknown.length === 1 ? "image" : "images" }} (ComfyUI may still have finished it). Check ComfyUI history for prompt_id {{ unknown.map((f) => f.promptId).join(", ") }}.
      </span>
    </div>

    <div class="layout">
      <div class="scenes" :class="`n${c.frameCount}`">
        <section v-for="s in scenes" :key="s.frame" class="scene">
          <template v-for="f in [current(s)]" :key="f.variant">
            <button v-if="f.image" class="img" :class="{ best: isBest(s.frame, f.variant) }" :aria-label="`Open scene ${s.frame} variant ${f.variant}`" @click="viewer = { frame: s.frame, variant: f.variant }">
              <MockImage :hue="c.hue" :frame="s.frame" :variant="f.variant" />
              <span v-if="isBest(s.frame, f.variant)" class="bst">★ Best</span>
              <span class="zoom">Open</span>
            </button>
            <div v-else class="img ph" :class="f.status">
              <span v-if="f.status === 'submitted'" class="spinner" />
              <span>{{ f.status === "pending" ? (c.status === "running" ? "Queued" : "Not generated") : f.status === "submitted" ? "Generating…" : f.status === "timeout" ? "State unknown" : "Failed" }}</span>
            </div>
            <div class="cap">
              <b>{{ pad2(s.frame) }}</b>
              <span class="dot" :style="{ background: modelById(s.model)?.color }" />
              <span class="mn">{{ modelById(s.model)?.name ?? s.model }}</span>
              <button v-if="f.image" class="link png" @click="downloadPng(s.frame, f.variant)">PNG</button>
            </div>
            <div v-if="s.variants.length > 1" class="vars" role="group" :aria-label="`Variants of scene ${s.frame}`">
              <button
                v-for="v in s.variants"
                :key="v.variant"
                :class="{ on: v.variant === f.variant, best: isBest(s.frame, v.variant), off: !v.image }"
                :title="v.image ? `v${v.variant} · seed ${v.seed}` : `v${v.variant} · ${v.status}`"
                @click="viewing[s.frame] = v.variant"
              >
                <MockImage v-if="v.image" :hue="c.hue" :frame="s.frame" :variant="v.variant" />
                <span class="vl">v{{ v.variant }}<template v-if="isBest(s.frame, v.variant)"> ★</template></span>
              </button>
            </div>
            <button v-if="f.image" class="btn sm sel" :class="{ ok: isBest(s.frame, f.variant) }" @click="selectBest(c, s.frame, f.variant)">
              {{ isBest(s.frame, f.variant) ? "✓ Best" : s.variants.length > 1 ? `Select v${f.variant} as Best` : "Select as Best" }}
            </button>
            <p v-if="s.summary" class="sum">{{ s.summary }}</p>
          </template>
        </section>
      </div>

      <aside class="side">
        <section class="card panel">
          <h3>Feedback</h3>
          <div class="stars" role="radiogroup" aria-label="Collection rating" @mouseleave="hover = 0">
            <button v-for="n in 5" :key="n" class="star" :class="{ on: n <= (hover || c.feedback?.rating || 0) }" role="radio" :aria-checked="c.feedback?.rating === n" :aria-label="`${n} star${n > 1 ? 's' : ''}`" @mouseenter="hover = n" @click="rate(n)">★</button>
            <button v-if="c.feedback?.rating" class="link clr" @click="rate(c.feedback!.rating!)">Clear</button>
          </div>
          <div class="tags">
            <button v-for="[k, l] in GOOD" :key="k" class="tag good" :class="{ on: c.feedback?.tags.includes(k) }" :aria-pressed="!!c.feedback?.tags.includes(k)" @click="toggleTag(k)">{{ l }}</button>
          </div>
          <div class="tags">
            <button v-for="[k, l] in BAD" :key="k" class="tag bad" :class="{ on: c.feedback?.tags.includes(k) }" :aria-pressed="!!c.feedback?.tags.includes(k)" @click="toggleTag(k)">{{ l }}</button>
          </div>
          <textarea v-model="note" rows="3" maxlength="500" placeholder="Optional note (what worked, what didn't)" @blur="saveNote" />
          <small class="muted">{{ note.length }}/500 · saved when you leave the field</small>
        </section>

        <section class="card panel">
          <h3>Generation details</h3>
          <dl>
            <div><dt>Created</dt><dd>{{ date }}</dd></div>
            <div><dt>Theme</dt><dd :class="{ muted: !c.meta.theme }">{{ c.meta.theme ?? "None — Codex invented the concept" }}</dd></div>
            <div><dt>Prompt generation</dt><dd>{{ codex }}</dd></div>
            <div><dt>Recorded time</dt><dd>Codex {{ secs(c.meta.codexSeconds) }} · ComfyUI {{ secs(c.meta.comfySeconds) }}</dd></div>
            <div>
              <dt>Scenes</dt>
              <dd>
                <ol class="sl">
                  <li v-for="(s, i) in scenes" :key="s.frame">
                    <span class="dot" :style="{ background: modelById(s.model)?.color }" /> <b>{{ pad2(s.frame) }}</b> {{ modelById(s.model)?.name }}
                    <span class="muted">· {{ compLine(i) }}</span>
                  </li>
                </ol>
              </dd>
            </div>
          </dl>
          <details>
            <summary>Seeds and prompt IDs</summary>
            <table>
              <tbody>
                <tr v-for="f in c.frames" :key="`${f.frame}-${f.variant}`">
                  <td>{{ pad2(f.frame) }}·v{{ f.variant }}</td>
                  <td>{{ f.seed }}</td>
                  <td class="pid">{{ f.promptId ?? "—" }}</td>
                </tr>
              </tbody>
            </table>
          </details>
          <p class="muted small fid">Folder: output/collections/{{ c.id }}</p>
        </section>
      </aside>
    </div>

    <Viewer v-if="viewer" :c="c" :frame="viewer.frame" :variant="viewer.variant" @close="viewer = null" @move="(f, v) => (viewer = { frame: f, variant: v })" @download="downloadPng" />
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 16px; }
.back { align-self: flex-start; margin-left: -8px; }
.head { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.ht { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 760px; }
.title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 24px; }
.desc { color: var(--text-2); margin-top: 4px; }
.exp { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.exp small { color: var(--muted); font-size: 12px; }
.exp small.ok { color: var(--ok); }
.ids { display: block; margin-top: 6px; font-size: 12px; word-break: break-all; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.scenes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.scenes.n1 { grid-template-columns: minmax(0, 340px); }
.scenes.n2 { grid-template-columns: repeat(2, minmax(0, 300px)); }
.scenes.n3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.scene { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.img { position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; padding: 0; border-radius: 12px; overflow: hidden; border: 2px solid var(--line); background: var(--panel-2); cursor: zoom-in; }
.img.best { border-color: var(--ok); }
.img:hover .zoom { opacity: 1; }
.zoom { position: absolute; right: 8px; top: 8px; font-size: 11px; padding: 2px 8px; border-radius: 6px; background: rgba(10, 11, 15, 0.8); opacity: 0; transition: opacity 0.15s; }
.bst { position: absolute; left: 8px; top: 8px; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: rgba(16, 41, 31, 0.92); color: var(--ok); }
.ph { cursor: default; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; background: repeating-linear-gradient(135deg, var(--panel-2) 0 10px, #1c1f29 10px 20px); }
.ph.failed { color: var(--bad); border-color: rgba(240, 80, 110, 0.35); }
.ph.timeout { color: var(--warn); border-color: rgba(245, 165, 36, 0.35); }
.cap { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.cap b { background: var(--panel-2); border-radius: 6px; padding: 0 7px; }
.mn { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.png { margin-left: auto; font-size: 12px; }
.vars { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.vars button { position: relative; aspect-ratio: 2 / 3; padding: 0; border-radius: 7px; overflow: hidden; border: 2px solid transparent; background: var(--panel-2); opacity: 0.7; transition: opacity 0.15s, border-color 0.15s; }
.vars button:hover { opacity: 1; }
.vars button.on { border-color: var(--accent); opacity: 1; }
.vars button.best:not(.on) { border-color: rgba(62, 207, 142, 0.6); }
.vars button.off { opacity: 0.4; background: repeating-linear-gradient(135deg, var(--panel-2) 0 6px, #1c1f29 6px 12px); }
.vl { position: absolute; left: 0; right: 0; bottom: 0; font-size: 10px; background: rgba(10, 11, 15, 0.75); padding: 1px 0; text-align: center; }
.vars button.best .vl { color: var(--ok); }
.sel { width: 100%; }
.sum { font-size: 12px; color: var(--muted); }
.side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 76px; }
.panel { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.panel h3 { font-size: 14px; }
.stars { display: flex; align-items: center; gap: 2px; }
.star { background: none; border: 0; padding: 0 2px; font-size: 24px; line-height: 1; color: var(--line-2); border-radius: 4px; }
.star.on { color: #f5b942; }
.clr { margin-left: 8px; font-size: 12px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 3px 10px; font-size: 12px; border-radius: 99px; background: var(--panel-2); color: var(--text-2); border: 1px solid var(--line); }
.tag:hover { border-color: var(--line-2); color: var(--text); }
.tag.good.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.tag.bad.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
dl { margin: 0; display: flex; flex-direction: column; gap: 8px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 13px; }
.sl { margin: 2px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.sl li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
details { font-size: 12px; }
summary { cursor: pointer; color: var(--accent-2); }
table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
td { padding: 3px 4px; border-top: 1px solid var(--line); color: var(--text-2); }
.pid { word-break: break-all; color: var(--muted); }
.fid { word-break: break-all; }
@media (max-width: 1100px) {
  .layout { grid-template-columns: 1fr; }
  .side { position: static; display: grid; grid-template-columns: 1fr 1fr; }
}
@media (max-width: 900px) {
  .scenes, .scenes.n3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scenes.n1 { grid-template-columns: minmax(0, 1fr); max-width: 360px; }
  .side { grid-template-columns: 1fr; }
  .exp { align-items: stretch; width: 100%; }
}
</style>
