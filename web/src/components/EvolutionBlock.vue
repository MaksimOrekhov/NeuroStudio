<script setup lang="ts">
import { computed } from "vue";
import type { TagStat } from "../api";
import { COLLECTION_TAG_RU, IMAGE_TAG_RU } from "../ru";
import { evolution, form, toggleEvolutionPreview } from "../store";
import ErrorNote from "./ErrorNote.vue";

const m = computed(() => evolution.data?.memory);
const name = (t: TagStat, collection = false) => (collection ? COLLECTION_TAG_RU : IMAGE_TAG_RU)[t.tag] ?? t.tag;
const conf = (t: TagStat) => (t.confidence === "stable" ? "устойчиво" : t.confidence === "mixed" ? "противоречиво — не используется" : "мало данных — не используется");
const status = computed(() => {
  const s = m.value?.status;
  if (s === "ready") return "Есть устойчивые закономерности: они будут переданы Codex как мягкие пожелания.";
  if (s === "low") return "Данных пока недостаточно: есть отдельные оценки, но устойчивых закономерностей нет. Codex ничего не получит, генерация пойдёт как обычно.";
  return "Данных пока недостаточно: оценок ещё нет. Генерация пойдёт как обычно.";
});
</script>

<template>
  <section class="block">
    <div class="bh">
      <h3>Prompt Evolution</h3>
      <p class="muted small">Мягкие пожелания по вашим прошлым оценкам. Это обычная локальная сводка, отдельных запросов к Codex нет.</p>
    </div>
    <label class="sw" title="Codex будет учитывать ваши предыдущие оценки, выбранные изображения и результаты сравнений. Дополнительные запросы к Codex не выполняются.">
      <input v-model="form.promptEvolution" type="checkbox" />
      <span>Учитывать мои оценки (Prompt Evolution)</span>
    </label>
    <div>
      <button class="link" :aria-expanded="evolution.open" @click="toggleEvolutionPreview()">{{ evolution.open ? "Скрыть" : "Посмотреть, что учитывается" }}</button>
    </div>

    <div v-if="evolution.open" class="prev">
      <p v-if="evolution.loading && !m" class="muted">Анализ оценок…</p>
      <ErrorNote :error="evolution.error" />
      <template v-if="m">
        <p class="st" :class="m.status">{{ status }}</p>
        <p class="muted small">
          Коллекций проанализировано: {{ m.sample.collections }} · с оценками: {{ m.sample.collectionsWithSignals }} · оценённых изображений: {{ m.sample.ratedImages }} · выбрано лучшими: {{ m.sample.bestImages }} · сравнений: {{ m.sample.comparisons }} · оценённых коллекций: {{ m.sample.ratedCollections }}
        </p>
        <div v-if="m.positive.length || m.negative.length" class="cols">
          <div v-if="m.positive.length">
            <b>Нравится</b>
            <ul><li v-for="t in m.positive" :key="t.tag">{{ name(t) }} — {{ t.count }} ({{ conf(t) }})</li></ul>
          </div>
          <div v-if="m.negative.length">
            <b>Не нравится</b>
            <ul><li v-for="t in m.negative" :key="t.tag">{{ name(t) }} — {{ t.count }} ({{ conf(t) }})</li></ul>
          </div>
        </div>
        <div v-if="m.collection.positive.length || m.collection.negative.length" class="muted small">
          Оценки коллекций целиком:
          <template v-for="t in [...m.collection.positive, ...m.collection.negative]" :key="t.tag">{{ name(t, true) }} ({{ t.count }}); </template>
        </div>
        <div v-if="m.warnings.length" class="note warn">
          Пропущены повреждённые файлы (они не изменены и не исправлялись):
          <ul><li v-for="(w, i) in m.warnings" :key="i">{{ w.collectionId }} · {{ w.source }}</li></ul>
        </div>
        <template v-if="evolution.data!.text">
          <p class="muted small">Текст, который будет передан Codex ({{ evolution.data!.chars }} из 4000 символов):</p>
          <pre>{{ evolution.data!.text }}</pre>
        </template>
        <p v-else class="muted small">В Codex сейчас ничего не передаётся.</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.block { padding: 16px 0; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); }
.bh h3 { font-size: 15px; margin: 0; }
p { margin: 0; }
.sw { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.sw input { width: 18px; height: 18px; accent-color: var(--accent); }
.prev { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-2); }
.st { font-size: 14px; }
.st.ready { color: var(--ok); }
.st.low, .st.empty { color: var(--warn); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
ul { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; font: 12px/1.45 ui-monospace, Consolas, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
</style>
