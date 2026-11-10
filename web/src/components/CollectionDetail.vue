<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { COMPOSITION_FIELDS } from "../../../src/composition";
import { exportUrl, imageUrl, type Collection } from "../api";
import { badgeOf, descriptionOf, exportInfo, pad2, scenesOf, titleOf, unknownFrames, type Scene } from "../lib";
import { modelById } from "../models";
import { AUTO_RU, BAD_TAGS, dateFullRu, effortRu, FIELD_RU, GOOD_TAGS, nPlural, ofImages, optionRu, secondsRu, W } from "../ru";
import { bestBusy, bestError, chooseBest, draftOf, go, rate, saveNote, toggleTag } from "../store";
import Thumb from "./Thumb.vue";
import Viewer from "./Viewer.vue";

const props = defineProps<{ c: Collection }>();

const scenes = computed(() => scenesOf(props.c).filter((s) => s.variants.length));
const exp = computed(() => exportInfo(props.c));
const badge = computed(() => badgeOf(props.c));
const unknown = computed(() => unknownFrames(props.c));

/** Variant shown per scene: what the user clicked, else Best, else first finished. */
const viewing = reactive<Record<number, number>>({});
function current(s: Scene) {
  const want = viewing[s.frame] ?? props.c.selections[String(s.frame)];
  return s.variants.find((v) => v.variant === want) ?? s.variants.find((v) => v.image) ?? s.variants[0];
}
const isBest = (frame: number, variant: number) => props.c.selections[String(frame)] === variant;
const stateText = (status: string) =>
  status === "pending" ? (props.c.status === "running" ? "В очереди" : "Не создано") : status === "submitted" ? (props.c.status === "running" ? "Генерируется…" : "Состояние неизвестно") : status === "timeout" ? "Состояние неизвестно" : "Ошибка";

const viewer = ref<{ frame: number; variant: number } | null>(null);

// ---- Оценка (NS-010: same tag ids, same API, saved at once; requests are serialised per collection) ----
const hover = ref(0);
const draft = computed(() => draftOf(props.c));

// ---- Параметры генерации ----
const codex = computed(() => {
  const m = props.c.codex;
  if (!m || (m.model === undefined && m.reasoningEffort === undefined)) return "Нет данных (коллекция создана до учёта этих настроек)";
  return `${m.model ?? "Модель по умолчанию"} · ${m.reasoningEffort ? `глубина: ${effortRu(m.reasoningEffort).toLowerCase()}` : "глубина по умолчанию"}`;
});
const modeText = computed(() => {
  const m = props.c.generation?.imageModels;
  if (!m) return "";
  return m.mode === "auto" ? "автоподбор" : m.mode === "only" ? "одна модель на все кадры" : "своя модель для каждого кадра";
});
const compLine = (i: number) => {
  const s = props.c.generation?.composition?.[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => `${FIELD_RU[f]}: ${optionRu(f, s[f]!).toLowerCase()}`);
  return parts.length ? parts.join(" · ") : AUTO_RU;
};
const date = computed(() => dateFullRu(props.c.createdAt));

</script>

<template>
  <div class="detail">
    <button class="btn ghost sm back" @click="go('library')">← Библиотека</button>

    <div class="head">
      <div class="ht">
        <div class="title">
          <h1>{{ titleOf(c) }}</h1>
          <span class="badge" :class="badge.cls"><span v-if="c.status === 'running'" class="spinner" />{{ badge.text }}</span>
        </div>
        <p class="muted small">{{ date }} · {{ nPlural(c.frameCount, W.frame) }}<template v-if="c.variations > 1"> × {{ nPlural(c.variations, W.variant) }}</template></p>
        <p v-if="descriptionOf(c)" class="desc">{{ descriptionOf(c) }}</p>
      </div>
      <div class="exp">
        <a v-if="exp.ready" class="btn primary" :href="exportUrl(c.id)" download>Скачать выбранные · ZIP</a>
        <button v-else class="btn primary" disabled :title="exp.message">Скачать выбранные · ZIP</button>
        <small :class="{ ok: exp.ready }">{{ exp.ready ? `✓ ${exp.message}` : exp.message }}</small>
      </div>
    </div>

    <div v-if="c.status === 'failed' || c.status === 'interrupted'" class="note" :class="c.status === 'failed' ? 'bad' : 'warn'">
      <b>{{ c.status === "failed" ? "Генерация завершилась с ошибкой." : "Генерация была прервана." }}</b>
      Сохранено {{ c.doneFrames }} из {{ ofImages(c.frames.length) }} — ими можно пользоваться как обычно.
      <template v-if="c.frames.find((f) => f.error)"> {{ c.frames.find((f) => f.error)?.error }}.</template>
      Недостающие изображения не создаются и не возобновляются автоматически — при необходимости запустите новую генерацию.
      <span v-if="unknown.length" class="ids">
        Состояние неизвестно: {{ nPlural(unknown.length, W.image) }} (ComfyUI мог успеть их закончить). Проверьте историю ComfyUI по prompt_id: {{ unknown.map((f) => f.promptId).join(", ") }}.
      </span>
    </div>

    <p v-if="bestError[c.id]" class="note bad">Не удалось сохранить выбор: {{ bestError[c.id] }}</p>

    <div class="layout">
      <div class="scenes" :class="`n${c.frameCount}`">
        <section v-for="s in scenes" :key="s.frame" class="scene">
          <template v-for="f in [current(s)]" :key="f.variant">
            <button v-if="f.image" class="img" :class="{ best: isBest(s.frame, f.variant) }" :aria-label="`Открыть кадр ${s.frame}, вариант ${f.variant}`" @click="viewer = { frame: s.frame, variant: f.variant }">
              <Thumb :id="c.id" :file="f.image" :alt="`Кадр ${s.frame}`" eager />
              <span v-if="isBest(s.frame, f.variant)" class="bst">★ Лучший</span>
              <span class="zoom">Открыть</span>
            </button>
            <div v-else class="img ph" :class="f.status">
              <span v-if="f.status === 'submitted' && c.status === 'running'" class="spinner" />
              <span>{{ stateText(f.status) }}</span>
            </div>
            <div class="cap">
              <b>{{ pad2(s.frame) }}</b>
              <span class="dot" :style="{ background: modelById(s.model)?.color }" />
              <span class="mn">{{ modelById(s.model)?.name ?? s.model }}</span>
              <a v-if="f.image" class="link png" title="Скачать исходный PNG" :href="imageUrl(c.id, f.image, true)" download>PNG</a>
            </div>
            <div v-if="s.variants.length > 1" class="vars" role="group" :aria-label="`Варианты кадра ${s.frame}`">
              <button
                v-for="v in s.variants"
                :key="v.variant"
                :class="{ on: v.variant === f.variant, best: isBest(s.frame, v.variant), off: !v.image }"
                :title="v.image ? `Вариант ${v.variant} · seed ${v.seed}` : `Вариант ${v.variant} · ${stateText(v.status).toLowerCase()}`"
                @click="viewing[s.frame] = v.variant"
              >
                <Thumb v-if="v.image" :id="c.id" :file="v.image" :alt="`Вариант ${v.variant}`" />
                <span class="vl">{{ v.variant }}<template v-if="isBest(s.frame, v.variant)"> ★</template></span>
              </button>
            </div>
            <button v-if="f.image" class="btn sm sel" :class="{ ok: isBest(s.frame, f.variant) }" :disabled="bestBusy[c.id]" @click="chooseBest(c, s.frame, f.variant)">
              {{ isBest(s.frame, f.variant) ? "✓ Лучший" : s.variants.length > 1 ? `Выбрать вариант ${f.variant} лучшим` : "Выбрать лучшим" }}
            </button>
            <p v-if="s.summary" class="sum">{{ s.summary }}</p>
          </template>
        </section>
      </div>

      <aside class="side">
        <section class="card panel">
          <h3>Оценка</h3>
          <div class="stars" role="radiogroup" aria-label="Оценка коллекции" @mouseleave="hover = 0">
            <button v-for="n in 5" :key="n" class="star" :class="{ on: n <= (hover || draft.rating || 0) }" role="radio" :aria-checked="draft.rating === n" :aria-label="`${n} из 5`" @mouseenter="hover = n" @click="rate(c, n)">★</button>
            <button v-if="draft.rating" class="link clr" @click="rate(c, draft.rating!)">Сбросить</button>
          </div>
          <div class="tags">
            <button v-for="[k, l] in GOOD_TAGS" :key="k" class="tag good" :class="{ on: draft.tags.includes(k) }" :aria-pressed="draft.tags.includes(k)" @click="toggleTag(c, k)">{{ l }}</button>
          </div>
          <div class="tags">
            <button v-for="[k, l] in BAD_TAGS" :key="k" class="tag bad" :class="{ on: draft.tags.includes(k) }" :aria-pressed="draft.tags.includes(k)" @click="toggleTag(c, k)">{{ l }}</button>
          </div>
          <textarea v-model="draft.note" rows="3" maxlength="500" placeholder="Заметка (что получилось, что нет) — необязательно" @blur="saveNote(c)" />
          <small class="muted">{{ draft.note.length }}/500 · сохраняется, когда вы покидаете поле<template v-if="draft.saving"> · сохранение…</template></small>
          <p v-if="draft.error" class="note bad">Не удалось сохранить оценку: {{ draft.error }}</p>
        </section>

        <section class="card panel">
          <h3>Параметры генерации</h3>
          <dl>
            <div><dt>Создана</dt><dd>{{ date }}</dd></div>
            <div><dt>Тема</dt><dd :class="{ muted: !c.generation?.theme }">{{ c.generation ? (c.generation.theme ?? "Не задана — концепцию придумал Codex") : "Нет данных (коллекция создана до учёта настроек)" }}</dd></div>
            <div><dt>Генерация промптов</dt><dd>{{ codex }}</dd></div>
            <div><dt>Модели изображений</dt><dd>{{ modeText || "Нет данных" }}</dd></div>
            <div><dt>Затраченное время</dt><dd>Codex {{ secondsRu(c.codex?.seconds) }} · ComfyUI {{ secondsRu(c.comfySeconds) }}</dd></div>
            <div>
              <dt>Кадры</dt>
              <dd>
                <ol class="sl">
                  <li v-for="(s, i) in scenes" :key="s.frame">
                    <span class="dot" :style="{ background: modelById(s.model)?.color }" /> <b>{{ pad2(s.frame) }}</b> {{ modelById(s.model)?.name }}
                    <span v-if="c.generation?.composition" class="muted">· {{ compLine(i) }}</span>
                  </li>
                </ol>
              </dd>
            </div>
          </dl>
          <details>
            <summary>Seed и prompt_id</summary>
            <table>
              <tbody>
                <tr v-for="f in c.frames" :key="`${f.frame}-${f.variant}`">
                  <td>Кадр {{ pad2(f.frame) }} · вар. {{ f.variant }}</td>
                  <td>{{ f.seed }}</td>
                  <td class="pid">{{ f.promptId ?? "—" }}</td>
                </tr>
              </tbody>
            </table>
          </details>
          <p class="muted small fid">Папка: output/collections/{{ c.id }}</p>
        </section>
      </aside>
    </div>

    <Viewer v-if="viewer" :c="c" :frame="viewer.frame" :variant="viewer.variant" @close="viewer = null" @move="(f, v) => (viewer = { frame: f, variant: v })" />
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 16px; }
.back { align-self: flex-start; margin-left: -8px; }
.head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.ht { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 960px; }
.title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 26px; }
.desc { color: var(--text-2); margin-top: 4px; }
.exp { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: none; }
.exp small { color: var(--muted); font-size: 13px; }
.exp small.ok { color: var(--ok); }
.ids { display: block; margin-top: 6px; font-size: 12px; word-break: break-all; }
/* Images first: the side panel is fixed at 380 px, everything else goes to the scenes. */
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 28px; align-items: start; }
.scenes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
.scenes.n1 { grid-template-columns: minmax(0, 520px); }
.scenes.n2 { grid-template-columns: repeat(2, minmax(0, 480px)); }
.scenes.n3 { grid-template-columns: repeat(3, minmax(0, 480px)); }
.scene { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.img { position: relative; display: block; width: 100%; aspect-ratio: 2 / 3; padding: 0; border-radius: 12px; overflow: hidden; border: 2px solid var(--line); background: var(--panel-2); cursor: zoom-in; }
.img.best { border-color: var(--ok); }
.img:hover .zoom { opacity: 1; }
.zoom { position: absolute; right: 8px; top: 8px; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: rgba(10, 11, 15, 0.8); opacity: 0; transition: opacity 0.15s; }
.bst { position: absolute; left: 8px; top: 8px; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: rgba(16, 41, 31, 0.92); color: var(--ok); }
.ph { cursor: default; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; background: repeating-linear-gradient(135deg, var(--panel-2) 0 10px, #1c1f29 10px 20px); }
.ph.failed { color: var(--bad); border-color: rgba(240, 80, 110, 0.35); }
.ph.timeout { color: var(--warn); border-color: rgba(245, 165, 36, 0.35); }
.cap { display: flex; align-items: center; gap: 7px; font-size: 14px; }
.cap b { background: var(--panel-2); border-radius: 6px; padding: 0 7px; }
.mn { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.png { margin-left: auto; font-size: 12px; }
.vars { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.vars button { position: relative; aspect-ratio: 2 / 3; padding: 0; border-radius: 7px; overflow: hidden; border: 2px solid transparent; background: var(--panel-2); opacity: 0.7; transition: opacity 0.15s, border-color 0.15s; }
.vars button:hover { opacity: 1; }
.vars button.on { border-color: var(--accent); opacity: 1; }
.vars button.best:not(.on) { border-color: rgba(62, 207, 142, 0.6); }
.vars button.off { opacity: 0.4; background: repeating-linear-gradient(135deg, var(--panel-2) 0 6px, #1c1f29 6px 12px); }
.vl { position: absolute; left: 0; right: 0; bottom: 0; font-size: 11px; background: rgba(10, 11, 15, 0.75); padding: 1px 0; text-align: center; }
.vars button.best .vl { color: var(--ok); }
.sel { width: 100%; }
.sum { font-size: 13px; color: var(--muted); }
.side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 88px; }
.panel { padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.panel h3 { font-size: 15px; }
.stars { display: flex; align-items: center; gap: 2px; }
.star { background: none; border: 0; padding: 0 2px; font-size: 26px; line-height: 1; color: var(--line-2); border-radius: 4px; }
.star.on { color: #f5b942; }
.clr { margin-left: 8px; font-size: 12px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 3px 10px; font-size: 13px; border-radius: 99px; background: var(--panel-2); color: var(--text-2); border: 1px solid var(--line); }
.tag:hover { border-color: var(--line-2); color: var(--text); }
.tag.good.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.tag.bad.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
dl { margin: 0; display: flex; flex-direction: column; gap: 9px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 14px; }
.sl { margin: 2px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.sl li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
details { font-size: 12px; }
summary { cursor: pointer; color: var(--accent-2); }
table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
td { padding: 3px 4px; border-top: 1px solid var(--line); color: var(--text-2); }
.pid { word-break: break-all; color: var(--muted); }
.fid { word-break: break-all; }
@media (max-width: 1500px) {
  .layout { grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; }
  .scenes { gap: 12px; }
}
</style>
