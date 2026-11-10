<script setup lang="ts">
import { computed } from "vue";
import { AUTO, COMPOSITION_FIELDS, COMPOSITION_OPTIONS, INHERIT, type CompositionField } from "../../../src/composition";
import { modelById } from "../models";
import { AUTO_RU, effortRu, FIELD_RU, INHERIT_RU, optionRu } from "../ru";
import { anyComposition, app, assigned, codexEfforts, codexModels, copySceneToAll, form, guided, resetComposition, resetScene, resolved, sceneOverrides, ui } from "../store";

const globalLabel = (f: CompositionField) => (form.global[f] === AUTO ? AUTO_RU : optionRu(f, form.global[f]));
const codexSummary = computed(() => {
  const m = codexModels.value.find((x) => x.id === form.codexModel)?.name ?? "по умолчанию";
  return form.codexEffort ? `${m} · ${effortRu(form.codexEffort).toLowerCase()}` : m;
});
const compSummary = computed(() => (guided.value ? `задана для ${guided.value} из ${form.frames}` : "всё авто"));
const effortLabel = (id: string) => effortRu(id);

/** Chips of the effective settings of a scene, marked by where each value comes from. */
function chips(i: number) {
  const r = resolved.value[i] ?? {};
  return COMPOSITION_FIELDS.filter((f) => r[f]).map((f) => ({ f, text: optionRu(f, r[f]!), own: form.scenes[i][f] !== INHERIT }));
}
function toggleScene(i: number) {
  ui.openScene = ui.openScene === i ? null : i;
}
const ownText = (n: number) => (n === 1 ? "1 своя настройка" : `${n} своих настройки`);
</script>

<template>
  <section class="card adv">
    <button class="head" :aria-expanded="ui.advancedOpen" aria-controls="adv-body" @click="ui.advancedOpen = !ui.advancedOpen">
      <span class="chev" :class="{ open: ui.advancedOpen }" aria-hidden="true">›</span>
      <span class="title">
        <b>Дополнительные настройки</b>
        <small>Генерация промптов · Композиция</small>
      </span>
      <span class="sum">
        <span class="chip">Codex: {{ codexSummary }}</span>
        <span class="chip" :class="{ on: guided }">Композиция: {{ compSummary }}</span>
      </span>
    </button>

    <div v-if="ui.advancedOpen" id="adv-body" class="body">
      <section class="block">
        <div class="bh">
          <h3>Генерация промптов</h3>
          <p class="muted small">Модель Codex, которая пишет концепции и промпты. На модели изображений не влияет. Сами промпты по-прежнему пишутся на английском.</p>
        </div>
        <div class="row2">
          <label class="field">
            <span>Модель Codex</span>
            <select v-model="form.codexModel" :disabled="!codexModels.length">
              <option value="">По умолчанию (настройки Codex)</option>
              <option v-for="m in codexModels" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
          </label>
          <label class="field">
            <span>Глубина рассуждений</span>
            <select v-model="form.codexEffort" :disabled="!codexModels.length">
              <option value="">По умолчанию</option>
              <option v-for="e in codexEfforts" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
        </div>
        <div v-if="app.codex && !codexModels.length" class="note warn">
          Список моделей Codex недоступен — будет использована модель по умолчанию из настроек Codex.
          <details v-if="app.codex.error"><summary>Подробности</summary><pre>{{ app.codex.error }}</pre></details>
        </div>
        <p v-else-if="app.codex" class="muted small">Список моделей — из установленного Codex CLI<template v-if="app.codex.source === 'bundled'"> (встроенный перечень: кэш Codex не найден)</template>. Выбранное передаётся Codex явно; настройки Codex всё же могут влиять на результат.</p>
        <p v-else class="muted small">Загрузка списка моделей Codex…</p>
      </section>

      <section class="block">
        <div class="bh split">
          <div>
            <h3>Композиция</h3>
            <p class="muted small">Общие настройки действуют на все кадры со значением «{{ INHERIT_RU }}». «{{ AUTO_RU }}» оставляет выбор за Codex.</p>
          </div>
          <button class="link" :disabled="!anyComposition" @click="resetComposition">Сбросить всё</button>
        </div>

        <div class="sub">Общие настройки</div>
        <div class="row4">
          <label v-for="f in COMPOSITION_FIELDS" :key="f" class="field">
            <span>{{ FIELD_RU[f] }}</span>
            <select v-model="form.global[f]" :class="{ set: form.global[f] !== AUTO }">
              <option :value="AUTO">{{ AUTO_RU }}</option>
              <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ optionRu(f, x.id) }}</option>
            </select>
          </label>
        </div>

        <div class="sub">Отдельные кадры</div>
        <div class="slist">
          <div v-for="i in form.frames" :id="`scene-comp-${i - 1}`" :key="i" class="srow" :class="{ open: ui.openScene === i - 1 }">
            <button class="srh" :aria-expanded="ui.openScene === i - 1" @click="toggleScene(i - 1)">
              <span class="chev" :class="{ open: ui.openScene === i - 1 }" aria-hidden="true">›</span>
              <span class="snum">Кадр {{ String(i).padStart(2, "0") }}</span>
              <span class="dot" :style="{ background: modelById(assigned[i - 1])?.color }" :title="modelById(assigned[i - 1])?.name" />
              <span class="chips">
                <template v-if="chips(i - 1).length">
                  <span v-for="c in chips(i - 1)" :key="c.f" class="vchip" :class="{ own: c.own }" :title="`${FIELD_RU[c.f]}: ${c.text}${c.own ? ' (задано для кадра)' : ' (из общих настроек)'}`">{{ c.text }}</span>
                </template>
                <span v-else class="auto">{{ AUTO_RU }}</span>
              </span>
              <span class="ovr">{{ sceneOverrides(i - 1) ? ownText(sceneOverrides(i - 1)) : INHERIT_RU }}</span>
            </button>
            <div v-if="ui.openScene === i - 1" class="sbody">
              <div class="row4">
                <label v-for="f in COMPOSITION_FIELDS" :key="f" class="field">
                  <span>{{ FIELD_RU[f] }}</span>
                  <select v-model="form.scenes[i - 1][f]" :class="{ set: form.scenes[i - 1][f] !== INHERIT }">
                    <option :value="INHERIT">{{ INHERIT_RU }} ({{ globalLabel(f) }})</option>
                    <option :value="AUTO">{{ AUTO_RU }} (решает Codex)</option>
                    <option v-for="x in COMPOSITION_OPTIONS[f]" :key="x.id" :value="x.id">{{ optionRu(f, x.id) }}</option>
                  </select>
                </label>
              </div>
              <div class="actions">
                <button class="btn sm" :disabled="form.frames < 2" @click="copySceneToAll(i - 1)">Скопировать во все кадры</button>
                <button class="btn sm ghost" :disabled="!sceneOverrides(i - 1)" @click="resetScene(i - 1)">Сбросить кадр</button>
              </div>
            </div>
          </div>
        </div>
        <p v-if="form.frames < 4" class="muted small">Настройки скрытых кадров сохраняются и вернутся, если увеличить число кадров. Пока кадр скрыт, его настройки не отправляются.</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.adv { overflow: hidden; }
.head { display: flex; align-items: center; gap: 14px; width: 100%; padding: 16px 22px; border: 0; background: none; text-align: left; flex-wrap: wrap; }
.head:hover { background: var(--panel-2); }
.chev { display: inline-block; color: var(--muted); font-size: 18px; line-height: 1; transition: transform 0.15s; width: 10px; }
.chev.open { transform: rotate(90deg); }
.title { display: flex; flex-direction: column; line-height: 1.3; }
.title b { font-size: 15px; }
.title small { color: var(--muted); font-size: 12px; }
.sum { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.sum .chip.on { border-color: rgba(124, 108, 255, 0.45); color: var(--accent-2); }
.body { border-top: 1px solid var(--line); padding: 4px 22px 22px; display: flex; flex-direction: column; }
.block { padding: 16px 0; display: flex; flex-direction: column; gap: 10px; }
.block + .block { border-top: 1px solid var(--line); }
.bh h3 { font-size: 15px; }
.bh.split { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.sub { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 6px; }
.row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 340px)); gap: 12px; }
/* Up to four selects per row, each at least 260 px so long Russian option names stay readable. */
.row4 { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
select.set { border-color: rgba(124, 108, 255, 0.55); }
.slist { display: flex; flex-direction: column; gap: 6px; }
.srow { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); scroll-margin: 110px; }
.srow.open { border-color: var(--line-2); }
.srh { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 14px; background: none; border: 0; text-align: left; border-radius: 10px; }
.srh:hover { background: var(--panel-3); }
.snum { font-weight: 600; white-space: nowrap; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; flex: 1; }
.vchip { font-size: 13px; padding: 1px 9px; border-radius: 6px; background: var(--panel-3); color: var(--text-2); white-space: nowrap; }
.vchip.own { background: var(--accent-soft); color: var(--accent-2); }
.auto { font-size: 13px; color: var(--muted); }
.ovr { font-size: 13px; color: var(--muted); white-space: nowrap; }
pre { margin: 6px 0 0; white-space: pre-wrap; font: 12px/1.45 ui-monospace, Consolas, monospace; }
.sbody { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 12px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
