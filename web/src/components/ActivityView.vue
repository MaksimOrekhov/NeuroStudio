<script setup lang="ts">
import { computed } from "vue";
import type { RunRecord } from "../api";
import { describeRunError } from "../errors";
import { titleOf } from "../lib";
import { formula, modelUsage, sceneList } from "../models";
import { dateRu, effortRu, nPlural, ofImages } from "../ru";
import { app, comfyOk, go, run, running } from "../store";
import ErrorNote from "./ErrorNote.vue";

const r = computed(() => run.value);
const state = computed(() => r.value?.status ?? "idle");
const pct = computed(() => (r.value?.total ? Math.round((r.value.done / r.value.total) * 100) : 0));
/** The history record of the current run (same id): the only source of Codex settings after a page reload. */
const record = computed(() => app.runs.find((x) => x.id === r.value?.runId));
const perCollection = computed(() => (r.value ? r.value.frames * r.value.variations : 0));

const titleFor = (id: string, fallback?: string) => {
  const c = app.collections.find((x) => x.id === id);
  return c ? titleOf(c) : (fallback ?? id);
};

type StepState = "done" | "active" | "waiting" | "failed";
const planFailed = computed(() => state.value === "failed" && (r.value?.errorCode === "CODEX_FAILED" || r.value?.errorCode === "PLAN_INVALID"));
const steps = computed<{ label: string; detail: string; state: StepState }[]>(() => {
  const s = state.value;
  const x = r.value;
  const genDone = s === "completed";
  const genFailed = s === "failed" && !planFailed.value;
  return [
    { label: "Проверка ComfyUI", detail: comfyOk.value ? "Доступен" : "Недоступен сейчас", state: comfyOk.value || s !== "idle" ? "done" : "failed" },
    {
      label: "Планирование в Codex",
      detail: x ? `Один запрос: ${nPlural(x.collections, ["концепция", "концепции", "концепций"])} и все промпты` : "",
      state: s === "planning" ? "active" : planFailed.value ? "failed" : "done",
    },
    {
      label: "Генерация изображений",
      detail:
        s === "generating"
          ? `Коллекция ${x?.collection} из ${x?.collections}${x?.currentFrame ? ` · кадр ${x.currentFrame}` : ""}`
          : `${x?.done ?? 0} из ${ofImages(x?.total ?? 0)}`,
      state: s === "generating" ? "active" : genFailed ? "failed" : genDone ? "done" : "waiting",
    },
    { label: "Сохранение в библиотеку", detail: genDone ? "Все коллекции сохранены" : "Каждая коллекция сохраняется сразу после завершения", state: genDone ? "done" : "waiting" },
  ];
});

const title = computed(() => ({ planning: "Codex составляет план", generating: "Идёт генерация изображений", completed: "Генерация завершена", failed: "Генерация остановлена", idle: "Сейчас ничего не генерируется" })[state.value]);

interface Item {
  id?: string;
  title: string;
  status: "waiting" | "generating" | "done" | "failed" | "not_started";
  done: number;
  total: number;
}
const ITEM: Record<Item["status"], { text: string; cls: string }> = {
  waiting: { text: "Ожидает", cls: "" },
  generating: { text: "Генерируется", cls: "run" },
  done: { text: "Сохранена", cls: "ok" },
  failed: { text: "Остановлена · частично", cls: "bad" },
  not_started: { text: "Не начата", cls: "" },
};
/** Collections of the current run, from the server state only: finished ids, the current one and the rest. */
const items = computed<Item[]>(() => {
  const x = r.value;
  if (!x || state.value === "idle") return [];
  const per = perCollection.value;
  const failed = state.value === "failed";
  return Array.from({ length: x.collections }, (_, i) => {
    const finishedId = x.finished[i];
    if (finishedId) return { id: finishedId, title: titleFor(finishedId), status: "done", done: per, total: per };
    if (i === x.finished.length && x.collectionId) {
      return {
        id: x.collectionId,
        title: titleFor(x.collectionId, x.title),
        status: failed ? "failed" : "generating",
        done: Math.max(0, Math.min(per, x.done - i * per)),
        total: per,
      };
    }
    return { title: `Коллекция ${i + 1}`, status: failed ? "not_started" : "waiting", done: 0, total: per };
  });
});
const saved = computed(() => items.value.filter((i) => i.status === "done").length);
const partial = computed(() => items.value.find((i) => i.status === "failed" && i.done > 0));
const runError = computed(() => describeRunError(r.value?.error, r.value?.errorCode));

const codexLine = computed(() => {
  const c = record.value?.codex;
  if (!c) return "";
  return `${c.model ?? "Модель по умолчанию"} · ${c.reasoningEffort ? `глубина: ${effortRu(c.reasoningEffort).toLowerCase()}` : "глубина по умолчанию"}`;
});

const STATUS: Record<RunRecord["status"], { text: string; cls: string }> = {
  running: { text: "Идёт", cls: "run" },
  completed: { text: "Завершена", cls: "ok" },
  failed: { text: "Остановлена", cls: "bad" },
  interrupted: { text: "Прервана", cls: "warn" },
};
const modelsLine = (m: RunRecord["imageModels"]) => (m ? (m.mode === "auto" ? "автоподбор" : m.mode === "only" ? "одна модель" : "по кадрам") : null);
</script>

<template>
  <div class="act">
    <div class="main">
      <section class="card current" :class="`st-${state}`">
        <div class="ch">
          <div>
            <p class="eyebrow">Текущая генерация</p>
            <h1>
              <span v-if="running" class="spinner" />
              {{ title }}
            </h1>
            <p v-if="r && state !== 'idle'" class="muted small">
              <template v-if="r.startedAt">Начата {{ dateRu(r.startedAt) }} · </template>{{ formula(r.collections, r.frames, r.variations) }}
            </p>
          </div>
          <span v-if="state !== 'idle'" class="pct">{{ r?.done }}<small> / {{ r?.total }}</small></span>
        </div>

        <template v-if="state === 'idle'">
          <p class="muted">Запустите генерацию в разделе «Создание». Здесь появятся этапы, прогресс, ошибки и сохранённые коллекции; библиотекой можно пользоваться во время генерации.</p>
          <div class="row"><button class="btn primary" @click="go('create')">Перейти к созданию</button></div>
        </template>

        <template v-else>
          <div class="bar" :class="{ ok: state === 'completed', bad: state === 'failed' }"><div :style="{ width: pct + '%' }" /></div>

          <ol class="steps">
            <li v-for="s in steps" :key="s.label" :class="s.state">
              <span class="ic" aria-hidden="true">
                <span v-if="s.state === 'active'" class="spinner" />
                <template v-else-if="s.state === 'done'">✓</template>
                <template v-else-if="s.state === 'failed'">!</template>
              </span>
              <div>
                <b>{{ s.label }}</b>
                <p class="muted small">{{ s.detail }}</p>
              </div>
            </li>
          </ol>

          <div v-if="state === 'failed'" class="stop">
            <ErrorNote :error="runError" />
            <p class="fx muted">
              <template v-if="planFailed">Ни одно изображение не создавалось.</template>
              <template v-else-if="saved">
                Сохранено: {{ nPlural(saved, ["полная коллекция", "полные коллекции", "полных коллекций"]) }}<template v-if="partial">, а также {{ partial.done }} из {{ ofImages(partial.total) }} коллекции «{{ partial.title }}»</template>.
              </template>
              <template v-else-if="partial">Сохранено {{ partial.done }} из {{ ofImages(partial.total) }} коллекции «{{ partial.title }}».</template>
              <template v-else>Ни одного изображения не создано.</template>
              Ничего не возобновляется и не отправляется повторно автоматически. Проверьте сохранённое в библиотеке и запустите новую генерацию, когда будете готовы.
            </p>
            <p v-if="!comfyOk" class="fx muted">ComfyUI сейчас недоступен. Изображение, которое ComfyUI уже принял, может всё же завершиться там — его prompt_id указан в коллекции.</p>
          </div>

          <div class="items">
            <div v-for="(it, i) in items" :key="i" class="item">
              <span class="idx">{{ i + 1 }}</span>
              <div class="it">
                <b :class="{ muted: !it.id }">{{ !it.id && state === "planning" ? "Концепция пишется…" : it.title }}</b>
                <div class="bar slim" :class="{ ok: it.status === 'done', bad: it.status === 'failed' }"><div :style="{ width: (it.total ? (it.done / it.total) * 100 : 0) + '%' }" /></div>
              </div>
              <span class="cnt">{{ it.done }}/{{ it.total }}</span>
              <span class="badge" :class="ITEM[it.status].cls">{{ ITEM[it.status].text }}</span>
              <button class="btn sm" :disabled="!it.id" @click="go('library', it.id!)">Открыть</button>
            </div>
          </div>
        </template>
      </section>

      <section class="card hist">
        <h2>История запусков</h2>
        <ErrorNote :error="app.runsError" />
        <p v-if="app.runsLoaded && !app.runs.length" class="muted empty">Запусков пока нет. Они появятся здесь после первой генерации.</p>
        <ul>
          <li v-for="h in app.runs" :key="h.id">
            <span class="badge" :class="STATUS[h.status].cls">{{ STATUS[h.status].text }}</span>
            <div class="hi">
              <b>{{ h.theme ?? "Без темы" }}</b>
              <p class="muted small">{{ dateRu(h.createdAt) }} · {{ formula(h.collections, h.frames, h.variations) }}<template v-if="modelsLine(h.imageModels)"> · модели: {{ modelsLine(h.imageModels) }}</template></p>
              <ErrorNote v-if="h.error || h.errorCode" :error="describeRunError(h.error, h.errorCode)" />
              <p v-if="h.status === 'interrupted'" class="muted small">Сервер был перезапущен или остановлен во время генерации. Сохранённое осталось в библиотеке.</p>
              <p v-else-if="h.status !== 'running' && !h.collectionIds.length" class="muted small">Коллекции не создавались.</p>
            </div>
            <div class="links">
              <button v-for="id in h.collectionIds" :key="id" class="link" @click="go('library', id)">{{ titleFor(id) }}</button>
            </div>
          </li>
        </ul>
        <p v-if="app.runs.length >= 50" class="muted small">Показаны последние 50 запусков.</p>
      </section>
    </div>

    <aside class="side">
      <section class="card panel">
        <h3>ComfyUI</h3>
        <p class="cst" :class="{ down: app.connection === 'ok' && !comfyOk }">
          <span class="dot" />
          <template v-if="app.connection === 'connecting'">Проверка…</template>
          <template v-else-if="comfyOk">Подключён · v{{ app.status?.comfy.version }}<template v-if="(app.status?.comfy.queueRunning ?? 0) + (app.status?.comfy.queuePending ?? 0)"> · в очереди: {{ (app.status?.comfy.queueRunning ?? 0) + (app.status?.comfy.queuePending ?? 0) }}</template><template v-else> · очередь пуста</template></template>
          <template v-else>Недоступен</template>
        </p>
        <p v-if="app.connection === 'ok' && !comfyOk" class="muted small">Запустите ComfyUI — статус обновится автоматически. До этого кнопка «Сгенерировать» неактивна.</p>
        <p v-else class="muted small">Статус проверяется каждые несколько секунд. Пока ComfyUI недоступен, запуск новой генерации заблокирован.</p>
      </section>

      <section v-if="r && state !== 'idle'" class="card panel">
        <h3>Параметры генерации</h3>
        <dl>
          <div><dt>Тема</dt><dd :class="{ muted: !r.theme }">{{ r.theme || "Codex придумал концепцию сам" }}</dd></div>
          <div v-if="r.imageModels">
            <dt>Модели изображений</dt>
            <dd>
              <span v-for="u in modelUsage(r.imageModels.models)" :key="u.model.id" class="ml"><span class="dot" :style="{ background: u.model.color }" /> {{ u.model.name }} <span class="muted">— {{ sceneList(u.scenes).toLowerCase() }}</span></span>
            </dd>
          </div>
          <div v-if="codexLine"><dt>Генерация промптов</dt><dd>{{ codexLine }}</dd></div>
        </dl>
      </section>
    </aside>
  </div>
</template>

<style scoped>
/* Wide but bounded: a status page does not need the full 2560 px. */
.act { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 24px; align-items: start; max-width: 1880px; margin: 0 auto; }
.main { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.current { padding: 22px 24px; display: flex; flex-direction: column; gap: 18px; }
.current.st-failed { border-color: rgba(240, 80, 110, 0.35); }
.current.st-completed { border-color: rgba(62, 207, 142, 0.3); }
.ch { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
h1 { font-size: 22px; display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.pct { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pct small { font-size: 16px; color: var(--muted); font-weight: 400; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.steps li { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
.steps li.active { border-color: rgba(124, 108, 255, 0.5); }
.steps li.waiting { opacity: 0.55; }
.steps li.failed { border-color: rgba(240, 80, 110, 0.45); }
.ic { width: 22px; height: 22px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--panel-3); color: var(--muted); }
.steps li.done .ic { background: var(--ok-soft); color: var(--ok); }
.steps li.failed .ic { background: var(--bad-soft); color: var(--bad); }
.steps li.active .ic { background: transparent; }
.steps b { font-size: 14px; }
.stop { display: flex; flex-direction: column; gap: 8px; }
.fx { font-size: 13px; }
.items { display: flex; flex-direction: column; gap: 8px; }
.item { display: grid; grid-template-columns: 24px minmax(0, 1fr) 56px 190px auto; align-items: center; gap: 14px; padding: 11px 14px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
.item .badge { justify-self: start; }
.idx { color: var(--muted); font-variant-numeric: tabular-nums; }
.it { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.it b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar.slim { height: 4px; }
.cnt { font-size: 14px; color: var(--text-2); font-variant-numeric: tabular-nums; text-align: right; }
.item .badge:not(.ok):not(.run):not(.bad) { background: var(--panel-3); color: var(--muted); }
.hist { padding: 20px 24px; }
.hist h2 { font-size: 16px; margin-bottom: 8px; }
.hist ul { list-style: none; margin: 0; padding: 0; }
.hist li { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(0, 320px); gap: 14px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.hist li:first-child { border-top: 0; }
.hist .badge { justify-self: start; }
.hi { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.hi b { overflow-wrap: anywhere; }
.empty { padding: 8px 0; }
.links { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 0; }
.links .link { text-align: right; overflow-wrap: anywhere; }
.side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 88px; }
.panel { padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.panel h3 { font-size: 15px; }
.cst { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.cst .dot { background: var(--ok); }
.cst.down { color: #f58aa0; }
.cst.down .dot { background: var(--bad); }
dl { margin: 0; display: flex; flex-direction: column; gap: 9px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.ml { display: flex; align-items: center; gap: 6px; }
@media (max-width: 1500px) {
  .act { grid-template-columns: minmax(0, 1fr) 340px; }
}
</style>
