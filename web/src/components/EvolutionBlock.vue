<script setup lang="ts">
import { computed } from "vue";
import type { TagStat } from "../api";
import { COLLECTION_TAG_RU, IMAGE_TAG_RU } from "../ru";
import { evolution, form, loadEvolutionPreview, toggleEvolutionPreview } from "../store";
import ErrorNote from "./ErrorNote.vue";

const m = computed(() => evolution.data?.memory);
const name = (t: TagStat, collection = false) => (collection ? COLLECTION_TAG_RU : IMAGE_TAG_RU)[t.tag] ?? t.tag;
const conf = (value: TagStat["confidence"]) => ({ stable: "устойчиво", mixed: "неоднозначно", low: "мало данных" })[value];
const count = (t: TagStat) => t.count === t.independent ? String(t.count) : `${t.count} · независимых кадров ${t.independent}`;
const status = computed(() => {
  if (m.value?.status === "ready") return "Есть устойчивые сигналы для мягких рекомендаций Codex.";
  if (m.value?.status === "empty") return "Данных пока недостаточно. Оценок ещё нет.";
  if (evolution.data?.text) return "Устойчивых закономерностей пока нет. Доступны отдельные наблюдения.";
  return "Данных пока недостаточно для контекста Codex.";
});
const kind: Record<string, string> = { pose: "Поза", angle: "Ракурс", shot: "Крупность", gesture: "Жест", limbs: "Положение рук и ног", setting: "Окружение" };
const featureName: Record<string, string> = {
  standing: "стоя", sitting: "сидя", reclining: "полулёжа или лёжа", kneeling: "на коленях", crouching: "на корточках", walking: "в шаге", running: "в беге",
  "front view": "спереди", "three-quarter view": "три четверти", "rear three-quarter view": "три четверти со спины", "side view": "сбоку", "rear view": "сзади", "high angle": "сверху", "low angle": "снизу", "eye level": "на уровне глаз",
  "full body": "в полный рост", "waist up": "по пояс", "chest up": "по грудь", "head to mid-thigh": "от головы до середины бедра", "close-up": "крупный план", "wide shot": "общий план",
  "hand-object contact": "контакт руки с предметом", "hand gesture": "жест рукой", "crossed arms": "скрещённые руки", "crossed legs": "скрещённые ноги",
  "overhead arms": "руки над головой", "interlaced fingers": "переплетённые пальцы",
  "natural landscape": "природный пейзаж", "urban exterior": "городская улица или крыша", "garden or park": "сад или парк", "built interior": "интерьер", "plain background": "нейтральный фон",
};
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
    <p v-if="!form.promptEvolution" class="muted small">Prompt Evolution выключен. Оценки не попадут в запрос Codex.</p>
    <div>
      <button class="link" :aria-expanded="evolution.open" @click="toggleEvolutionPreview()">{{ evolution.open ? "Скрыть" : "Посмотреть, что учитывается" }}</button>
    </div>

    <div v-if="evolution.open" class="prev">
      <p v-if="evolution.loading && !m" class="muted">Анализ оценок…</p>
      <ErrorNote :error="evolution.error" />
      <template v-if="m">
        <button class="link refresh" :disabled="evolution.loading" @click="loadEvolutionPreview()">Обновить сводку</button>
        <p class="st" :class="m.status">{{ status }}</p>
        <p class="muted small">
          Изображений с оценкой: {{ m.sample.ratedImages }} · коллекций с оценкой 1–5: {{ m.sample.ratedCollections }} · коллекций с обратной связью: {{ m.sample.collectionsWithSignals }} из {{ m.sample.collections }} · выбрано лучшими: {{ m.sample.bestImages }} · сравнений: {{ m.sample.comparisons }}
        </p>
        <div v-if="m.positive.length || m.negative.length" class="cols">
          <div v-if="m.positive.length">
            <b>Нравится</b>
            <ul><li v-for="t in m.positive" :key="t.tag">{{ name(t) }} — {{ count(t) }} ({{ conf(t.confidence) }})</li></ul>
          </div>
          <div v-if="m.negative.length">
            <b>Не нравится</b>
            <ul><li v-for="t in m.negative" :key="t.tag">{{ name(t) }} — {{ count(t) }} ({{ conf(t.confidence) }})</li></ul>
          </div>
        </div>
        <div v-if="m.collection.positive.length || m.collection.negative.length" class="muted small">
          Оценки коллекций целиком:
          <ul><li v-for="t in [...m.collection.positive, ...m.collection.negative]" :key="t.tag">{{ name(t, true) }} — {{ t.count }} ({{ conf(t.confidence) }})</li></ul>
        </div>
        <p v-if="m.sample.ratedCollections" class="muted small">
          Оценки серий · 4–5: {{ m.collection.ratings.positive }} · 3: {{ m.collection.ratings.neutral }} · 1–2: {{ m.collection.ratings.negative }} ({{ conf(m.collection.ratings.confidence) }})
        </p>
        <details v-if="m.features.length || m.sample.ratedImages">
          <summary>Признаки в промптах оценённых вариантов</summary>
          <p class="muted small">Граф найден у {{ m.featureCoverage.sidecars }} из {{ m.sample.ratedImages }} изображений. Признаки определены у {{ m.featureCoverage.identified }}.</p>
          <ul v-if="m.features.length">
            <li v-for="f in m.features" :key="`${f.feature}/${f.value}`">
              {{ kind[f.feature] ?? f.feature }} · {{ featureName[f.value] ?? f.value }} · 👍 {{ f.likes }} · 👎 {{ f.dislikes }} ({{ conf(f.confidence) }})
            </li>
          </ul>
        </details>
        <div v-if="m.reviews.length">
          <b>{{ form.promptEvolution ? "Заметки для Codex" : "Заметки при включении Prompt Evolution" }}</b>
          <ul>
            <li v-for="r in m.reviews" :key="r.scope === 'image' ? `${r.collectionId}/${r.frame}-${r.variant}` : r.collectionId">
              {{ r.collectionId }} · {{ r.scope === "image" ? `кадр ${r.frame}, вариант ${r.variant}` : "вся коллекция" }} · «{{ r.note }}»
            </li>
          </ul>
        </div>
        <details v-if="m.recommendations.length">
          <summary>{{ form.promptEvolution ? "Рекомендации для Codex" : "Рекомендации при включении Prompt Evolution" }}</summary>
          <ul><li v-for="r in m.recommendations" :key="r">{{ r }}</li></ul>
        </details>
        <div v-if="m.warnings.length" class="note warn">
          Пропущены повреждённые файлы (они не изменены и не исправлялись):
          <ul><li v-for="(w, i) in m.warnings" :key="i">{{ w.collectionId }} · {{ w.source }}</li></ul>
        </div>
        <template v-if="evolution.data!.text">
          <details>
            <summary>{{ form.promptEvolution ? "Точный текст для Codex" : "Точный текст при включении Prompt Evolution" }} ({{ evolution.data!.chars }} из 4000 символов)</summary>
            <pre>{{ evolution.data!.text }}</pre>
          </details>
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
.refresh { align-self: flex-start; }
summary { cursor: pointer; font-size: 13px; }
ul { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; font: 12px/1.45 ui-monospace, Consolas, monospace; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
</style>
