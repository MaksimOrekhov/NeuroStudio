<script setup lang="ts">
import { computed } from "vue";
import { formula, modelUsage, sceneList } from "../models";
import { effortRu, ruPlural, W } from "../ru";
import ErrorNote from "./ErrorNote.vue";
import { app, assigned, canStart, codexModels, comfyOk, form, go, guided, run, running, startGeneration, total } from "../store";

const usage = computed(() => modelUsage(assigned.value));
const codex = computed(() => {
  const m = codexModels.value.find((x) => x.id === form.codexModel)?.name ?? "Модель по умолчанию";
  return `${m} · ${form.codexEffort ? `глубина: ${effortRu(form.codexEffort).toLowerCase()}` : "глубина по умолчанию"}`;
});
const pct = computed(() => (run.value?.total ? Math.round((run.value.done / run.value.total) * 100) : 0));
const unreachable = computed(() => app.connection === "lost");
const comfyDown = computed(() => app.connection === "ok" && !comfyOk.value);
async function generate() {
  await startGeneration();
}
</script>

<template>
  <div class="card summary">
    <p class="eyebrow">Сводка генерации</p>
    <div class="big"><b>{{ total }}</b> {{ ruPlural(total, W.image) }}</div>
    <p class="formula">{{ formula(form.collections, form.frames, form.variations) }}</p>

    <dl>
      <div>
        <dt>Тема</dt>
        <dd :class="{ muted: !form.theme.trim() }">{{ form.theme.trim() || "Codex придумает концепцию сам" }}</dd>
      </div>
      <div>
        <dt>Модели изображений</dt>
        <dd>
          <span v-for="u in usage" :key="u.model.id" class="mline">
            <span class="dot" :style="{ background: u.model.color }" /> {{ u.model.name }} <span class="muted">— {{ sceneList(u.scenes).toLowerCase() }}</span>
          </span>
        </dd>
      </div>
      <div>
        <dt>Генерация промптов</dt>
        <dd>{{ codex }}</dd>
      </div>
      <div>
        <dt>Композиция</dt>
        <dd :class="{ muted: !guided }">{{ guided ? `Задана для ${guided} из ${form.frames} ${form.frames === 1 ? "кадра" : "кадров"}` : "Авто — решает Codex" }}</dd>
      </div>
    </dl>

    <button class="btn primary go" :disabled="!canStart" @click="generate">{{ app.starting ? "Запуск…" : running ? "Идёт генерация…" : "Сгенерировать" }}</button>
    <p class="hintline">Один запрос к Codex на весь запуск; после старта параметры не меняются.</p>

    <ErrorNote :error="app.startError" />
    <p v-if="unreachable" class="note warn">Нет связи с сервером NeuroStudio — запуск недоступен.</p>
    <p v-else-if="comfyDown" class="note bad">ComfyUI недоступен. Сначала запустите ComfyUI — до этого генерация отключена.</p>
    <div v-if="running && run" class="live">
      <div class="lrow">
        <span class="spinner" />
        <span>{{ run.status === "planning" ? "Codex составляет план генерации…" : `Генерация ${run.done} из ${run.total}` }}</span>
      </div>
      <div class="bar"><div :style="{ width: pct + '%' }" /></div>
      <p class="muted small">Одновременно выполняется одна генерация. Настройки для следующей можно менять уже сейчас — текущий запуск они не затронут.</p>
      <button class="link" @click="go('activity')">Открыть «Запуски»</button>
    </div>
  </div>
</template>

<style scoped>
.summary { padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.big { font-size: 16px; color: var(--text-2); }
.big b { font-size: 44px; line-height: 1; color: var(--text); font-weight: 600; margin-right: 6px; font-variant-numeric: tabular-nums; }
.formula { font-size: 14px; color: var(--text-2); padding: 9px 12px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); font-variant-numeric: tabular-nums; }
dl { margin: 0; display: flex; flex-direction: column; gap: 12px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.mline { display: flex; align-items: center; gap: 6px; }
.go { width: 100%; padding: 13px; font-size: 16px; font-weight: 600; margin-top: 4px; }
.hintline { font-size: 12px; color: var(--muted); }
.live { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
.lrow { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.live .link { align-self: flex-start; }
</style>
