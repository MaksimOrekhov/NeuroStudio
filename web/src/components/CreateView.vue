<script setup lang="ts">
import { computed } from "vue";
import { COMPOSITION_FIELDS } from "../../../src/composition";
import { COLLECTION_CHOICES, FRAME_CHOICES, IMAGE_MODELS, VARIATION_CHOICES, modelById, modelUsage, sceneList, type ModelMode } from "../models";
import { AUTO_RU, nPlural, optionRu, W } from "../ru";
import { assigned, form, openSceneComposition, resolved, setModelMode } from "../store";
import AdvancedSettings from "./AdvancedSettings.vue";
import SummaryCard from "./SummaryCard.vue";

const modes = computed<{ id: ModelMode; label: string }[]>(() => [
  { id: "auto", label: "Автоподбор" },
  ...IMAGE_MODELS.map((m) => ({ id: `only:${m.id}` as ModelMode, label: `Только ${m.name}` })),
  { id: "custom", label: "Для каждого кадра" },
]);

const modeHint = computed(() => {
  const usage = modelUsage(assigned.value);
  if (form.modelMode === "custom") return "Выберите модель изображений для каждого кадра ниже.";
  if (form.modelMode.startsWith("only:")) return `Все кадры создаются моделью ${usage[0]?.model.name}.`;
  const parts = usage.map((u) => `${u.model.name}: ${sceneList(u.scenes).toLowerCase()}`).join(" · ");
  const unused = IMAGE_MODELS.filter((m) => !usage.some((u) => u.model.id === m.id)).map((m) => m.name);
  return `Распределение по порядку кадров — ${parts}.${unused.length ? ` ${unused.join(", ")} не используется при ${form.frames === 1 ? "одном кадре" : nPlural(form.frames, W.frame)}.` : ""}`;
});

const compSummary = (i: number) => {
  const s = resolved.value[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => optionRu(f, s[f]!));
  return parts.length ? parts.join(" · ") : AUTO_RU;
};

const variationHint = computed(() => (form.variations === 1 ? "Одно изображение на кадр" : `Лучший из ${form.variations} для каждого кадра`));
</script>

<template>
  <div class="create">
    <div class="main">
      <section class="card idea">
        <label class="eyebrow" for="theme">Тема / Идея</label>
        <textarea id="theme" v-model="form.theme" rows="2" maxlength="200" placeholder="Оставьте пустым — Codex сам придумает концепцию. Или опишите настроение, место, историю…" />
        <div class="meta"><span>Необязательно</span><span>{{ form.theme.length }}/200</span></div>
      </section>

      <section class="card shape" aria-label="Размер генерации">
        <div class="ctl">
          <span id="l-col" class="eyebrow">Коллекции</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-col">
            <button v-for="n in COLLECTION_CHOICES" :key="n" role="radio" :aria-checked="form.collections === n" :class="{ on: form.collections === n }" @click="form.collections = n">{{ n }}</button>
          </div>
          <small>Разные концепции, один запрос к Codex</small>
        </div>
        <div class="ctl">
          <span id="l-fr" class="eyebrow">Кадров в коллекции</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-fr">
            <button v-for="n in FRAME_CHOICES" :key="n" role="radio" :aria-checked="form.frames === n" :class="{ on: form.frames === n }" @click="form.frames = n">{{ n }}</button>
          </div>
          <small>Одна героиня и одна концепция во всех кадрах</small>
        </div>
        <div class="ctl">
          <span id="l-var" class="eyebrow">Вариантов на кадр</span>
          <div class="seg" role="radiogroup" aria-labelledby="l-var">
            <button v-for="n in VARIATION_CHOICES" :key="n" role="radio" :aria-checked="form.variations === n" :class="{ on: form.variations === n }" @click="form.variations = n">{{ n }}</button>
          </div>
          <small>{{ variationHint }}</small>
        </div>
      </section>

      <section class="card scenes">
        <div class="shead">
          <div>
            <h2>Кадры <span class="muted">· {{ form.frames }} в коллекции</span></h2>
            <p class="muted small">Модель изображений и композиция каждого кадра. Раскладка кадров одинакова во всех коллекциях.</p>
          </div>
          <div class="models">
            <span id="l-mm" class="eyebrow">Модели изображений</span>
            <div class="seg" role="radiogroup" aria-labelledby="l-mm">
              <button v-for="m in modes" :key="m.id" role="radio" :aria-checked="form.modelMode === m.id" :class="{ on: form.modelMode === m.id }" @click="setModelMode(m.id)">{{ m.label }}</button>
            </div>
          </div>
        </div>
        <p class="mhint">{{ modeHint }}</p>

        <div class="grid">
          <article v-for="i in form.frames" :key="i" class="scene" :style="{ '--mc': modelById(assigned[i - 1])?.color }">
            <header>
              <span class="num">{{ String(i).padStart(2, "0") }}</span>
              <span class="lbl">Кадр</span>
            </header>
            <label v-if="form.modelMode === 'custom'" class="field">
              <span>Модель изображений</span>
              <select v-model="form.custom[i - 1]" :aria-label="`Модель изображений для кадра ${i}`">
                <option v-for="m in IMAGE_MODELS" :key="m.id" :value="m.id">{{ m.name }}</option>
              </select>
            </label>
            <div v-else class="mfix">
              <span class="dot" :style="{ background: modelById(assigned[i - 1])?.color }" />
              {{ modelById(assigned[i - 1])?.name }}
              <span class="muted small">{{ form.modelMode === "auto" ? "· автоподбор" : "" }}</span>
            </div>
            <button class="comp" :title="`Изменить композицию кадра ${i}`" @click="openSceneComposition(i - 1)">
              <span class="k">Композиция</span>
              <span class="e">Изменить</span>
              <span class="v" :class="{ auto: compSummary(i - 1) === AUTO_RU }">{{ compSummary(i - 1) }}</span>
            </button>
          </article>
        </div>
      </section>

      <AdvancedSettings />
    </div>

    <aside class="side">
      <SummaryCard />
    </aside>
  </div>
</template>

<style scoped>
/* Wide-screen form: bounded so selects and lines do not stretch across a 2560 px monitor. */
.create { display: grid; grid-template-columns: minmax(0, 1fr) 420px; gap: 24px; align-items: start; max-width: 1880px; margin: 0 auto; }
.main { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.side { position: sticky; top: 88px; }

.idea { padding: 18px 22px; display: flex; flex-direction: column; gap: 8px; }
.idea textarea { font-size: 16px; padding: 12px 14px; min-height: 72px; background: var(--panel-2); }
.meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }

.shape { padding: 18px 22px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.ctl { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }
.ctl .seg button { min-width: 52px; }
.ctl small { color: var(--muted); font-size: 13px; }

.scenes { padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 14px; }
.shead { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
.shead h2 { font-size: 17px; }
.shead h2 .muted { font-weight: 400; }
.models { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.mhint { font-size: 14px; color: var(--text-2); margin-top: -2px; }

.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.scene { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; min-width: 0; }
.scene::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--mc, var(--line)); }
.scene header { display: flex; align-items: baseline; gap: 8px; }
.num { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.lbl { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; }
.mfix { display: flex; align-items: center; gap: 8px; font-weight: 500; min-height: 36px; padding: 0 2px; flex-wrap: wrap; }
.comp { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "k e" "v v"; gap: 3px 8px; text-align: left; padding: 9px 11px; border-radius: 9px; border: 1px dashed var(--line-2); background: transparent; min-height: 64px; align-content: start; }
.comp:hover { border-color: var(--accent); border-style: solid; background: var(--panel-3); }
.comp .k { grid-area: k; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.comp .e { grid-area: e; font-size: 12px; color: var(--accent-2); }
.comp .v { grid-area: v; font-size: 14px; color: var(--text); }
.comp .v.auto { color: var(--muted); }

@media (max-width: 1500px) {
  .create { grid-template-columns: minmax(0, 1fr) 340px; }
}
</style>
