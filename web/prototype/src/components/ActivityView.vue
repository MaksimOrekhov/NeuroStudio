<script setup lang="ts">
import { computed } from "vue";
import { COMPOSITION_FIELDS } from "../../../../src/composition";
import { MOCK_CODEX } from "../mock";
import { formula, modelUsage, sceneList } from "../models";
import { AUTO_RU, dateRu, effortRu, nPlural, ofImages, optionRu, W } from "../ru";
import { go, library, run, running, startDemoRun, ui } from "../store";

const pct = computed(() => (run.total ? Math.round((run.done / run.total) * 100) : 0));
const snap = computed(() => run.snapshot);

type StepState = "done" | "active" | "waiting" | "failed";
const steps = computed<{ label: string; detail: string; state: StepState }[]>(() => {
  const s = run.status;
  const genDone = s === "completed";
  const planFailed = s === "failed" && !run.items.some((i) => i.id);
  const genFailed = s === "failed" && !planFailed;
  return [
    { label: "Проверка ComfyUI", detail: "Доступен, модели на месте", state: "done" },
    {
      label: "Планирование в Codex",
      detail: snap.value ? `Один запрос: ${nPlural(snap.value.collections, ["концепция", "концепции", "концепций"])} и все промпты` : "",
      state: s === "planning" ? "active" : planFailed ? "failed" : "done",
    },
    {
      label: "Генерация изображений",
      detail:
        s === "generating"
          ? `Коллекция ${run.current + 1} из ${run.items.length} · кадр ${run.currentScene}${snap.value && snap.value.variations > 1 ? ` · вариант ${run.currentVariant}` : ""}`
          : `${run.done} из ${ofImages(run.total)}`,
      state: s === "generating" ? "active" : genFailed ? "failed" : genDone ? "done" : "waiting",
    },
    { label: "Сохранение в библиотеку", detail: genDone ? "Все коллекции сохранены" : "Каждая коллекция сохраняется сразу после завершения", state: genDone ? "done" : "waiting" },
  ];
});

const title = computed(
  () =>
    ({ planning: "Codex составляет план", generating: "Идёт генерация изображений", completed: "Генерация завершена", failed: "Генерация остановлена", idle: "Сейчас ничего не генерируется" })[run.status],
);

const ITEM: Record<string, { text: string; cls: string }> = {
  waiting: { text: "Ожидает", cls: "" },
  generating: { text: "Генерируется", cls: "run" },
  done: { text: "Сохранена", cls: "ok" },
  failed: { text: "Остановлена · частично", cls: "bad" },
  not_started: { text: "Не начата", cls: "" },
};

const codexLine = computed(() => {
  const s = snap.value;
  if (!s) return "";
  return `${MOCK_CODEX.models.find((m) => m.id === s.codexModel)?.name ?? "Модель по умолчанию"} · ${s.codexEffort ? `глубина: ${effortRu(s.codexEffort).toLowerCase()}` : "глубина по умолчанию"}`;
});
const guidedCount = computed(() => snap.value?.composition.filter((x) => Object.keys(x).length).length ?? 0);
const compOf = (i: number) => {
  const s = snap.value?.composition[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => optionRu(f, s[f]!));
  return parts.length ? parts.join(" · ") : AUTO_RU;
};
const savedCount = computed(() => run.items.filter((i) => i.status === "done").length);
const partial = computed(() => run.items.find((i) => i.status === "failed" && i.done > 0));
const titleOf = (id: string) => library.items.find((c) => c.id === id)?.title ?? id;
</script>

<template>
  <div class="act">
    <div class="main">
      <section class="card current" :class="`st-${run.status}`">
        <div class="ch">
          <div>
            <p class="eyebrow">Текущая генерация</p>
            <h1>
              <span v-if="running" class="spinner" />
              {{ title }}
            </h1>
            <p v-if="snap" class="muted small">Начата {{ dateRu(run.startedAt) }} · {{ formula(snap.collections, snap.frames, snap.variations) }}</p>
          </div>
          <span v-if="run.status !== 'idle'" class="pct">{{ run.done }}<small> / {{ run.total }}</small></span>
        </div>

        <template v-if="run.status === 'idle'">
          <p class="muted">Запустите генерацию в разделе «Создание». Здесь появятся этапы, прогресс, ошибки и сохранённые коллекции; библиотекой можно пользоваться во время генерации.</p>
          <div class="row">
            <button class="btn primary" @click="go('create')">Перейти к созданию</button>
            <button class="btn" :disabled="ui.comfy === 'down'" @click="startDemoRun">Запустить имитацию</button>
          </div>
        </template>

        <template v-else>
          <div class="bar" :class="{ ok: run.status === 'completed', bad: run.status === 'failed' }"><div :style="{ width: pct + '%' }" /></div>

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

          <div v-if="run.status === 'failed'" class="note bad">
            <b>Генерация остановлена:</b> {{ run.error }}
            <p class="fx">
              <template v-if="savedCount">
                Сохранено: {{ nPlural(savedCount, ["полная коллекция", "полные коллекции", "полных коллекций"]) }}<template v-if="partial">, а также {{ partial.done }} из {{ ofImages(partial.total) }} коллекции «{{ partial.title }}»</template>.
              </template>
              <template v-else-if="partial">Сохранено {{ partial.done }} из {{ ofImages(partial.total) }} коллекции «{{ partial.title }}».</template>
              <template v-else>Ни одного изображения не создано.</template>
              Ничего не возобновляется и не отправляется повторно автоматически. Проверьте сохранённое в библиотеке и запустите новую генерацию, когда будете готовы.
            </p>
            <p v-if="ui.comfy === 'down'" class="fx">ComfyUI недоступен. Изображение, которое ComfyUI уже принял, может всё же завершиться там — его prompt_id указан в коллекции.</p>
          </div>

          <div class="items">
            <div v-for="(it, i) in run.items" :key="i" class="item">
              <span class="idx">{{ i + 1 }}</span>
              <div class="it">
                <b :class="{ muted: !it.id }">{{ it.id ? it.title : run.status === "planning" ? "Концепция пишется…" : it.title }}</b>
                <div class="bar slim" :class="{ ok: it.status === 'done', bad: it.status === 'failed' }"><div :style="{ width: (it.done / it.total) * 100 + '%' }" /></div>
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
        <ul>
          <li v-for="r in library.runs" :key="r.id">
            <span class="badge" :class="r.status === 'completed' ? 'ok' : 'bad'">{{ r.status === "completed" ? "Завершена" : "Остановлена" }}</span>
            <div class="hi">
              <b>{{ r.theme ?? "Без темы" }}</b>
              <p class="muted small">{{ dateRu(r.startedAt) }} · {{ formula(r.collections, r.frames, r.variations) }}</p>
              <p v-if="r.error" class="err small">{{ r.error }}</p>
            </div>
            <div class="links">
              <button v-for="id in r.collectionIds" :key="id" class="link" @click="go('library', id)">{{ titleOf(id) }}</button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <aside class="side">
      <section class="card panel">
        <h3>ComfyUI</h3>
        <p class="cst" :class="ui.comfy"><span class="dot" /> {{ ui.comfy === "ok" ? "Подключён · v0.3 (демо) · очередь пуста" : "Недоступен" }}</p>
        <p v-if="ui.comfy === 'down'" class="muted small">Запустите ComfyUI — статус обновится автоматически. До этого кнопка «Сгенерировать» неактивна.</p>
        <p v-else class="muted small">Статус проверяется каждые несколько секунд. Пока ComfyUI недоступен, генерация заблокирована.</p>
      </section>

      <section v-if="snap" class="card panel">
        <h3>Параметры генерации</h3>
        <dl>
          <div><dt>Тема</dt><dd :class="{ muted: !snap.theme }">{{ snap.theme || "Codex придумает концепцию сам" }}</dd></div>
          <div>
            <dt>Модели изображений</dt>
            <dd>
              <span v-for="u in modelUsage(snap.models)" :key="u.model.id" class="ml"><span class="dot" :style="{ background: u.model.color }" /> {{ u.model.name }} <span class="muted">— {{ sceneList(u.scenes).toLowerCase() }}</span></span>
            </dd>
          </div>
          <div><dt>Генерация промптов</dt><dd>{{ codexLine }}</dd></div>
          <div>
            <dt>Композиция</dt>
            <dd>
              {{ guidedCount ? `Задана для ${guidedCount} из ${snap.frames} ${snap.frames === 1 ? "кадра" : "кадров"}` : "Авто — решает Codex" }}
              <ol v-if="guidedCount" class="cl">
                <li v-for="i in snap.frames" :key="i"><b>{{ String(i).padStart(2, "0") }}</b> <span class="muted">{{ compOf(i - 1) }}</span></li>
              </ol>
            </dd>
          </div>
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
.fx { margin-top: 6px; }
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
.hist li { display: grid; grid-template-columns: 120px minmax(0, 1fr) auto; gap: 14px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.hist li:first-child { border-top: 0; }
.hist .badge { justify-self: start; }
.err { color: #f58aa0; }
.links { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.side { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 88px; }
.panel { padding: 18px; display: flex; flex-direction: column; gap: 8px; }
.panel h3 { font-size: 15px; }
.cst { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.cst .dot { background: var(--ok); }
.cst.down { color: #f58aa0; }
.cst.down .dot { background: var(--bad); }
dl { margin: 0; display: flex; flex-direction: column; gap: 9px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 14px; }
.ml { display: flex; align-items: center; gap: 6px; }
.cl { margin: 4px 0 0; padding: 0; list-style: none; font-size: 13px; display: flex; flex-direction: column; gap: 2px; }
@media (max-width: 1500px) {
  .act { grid-template-columns: minmax(0, 1fr) 340px; }
}
</style>
