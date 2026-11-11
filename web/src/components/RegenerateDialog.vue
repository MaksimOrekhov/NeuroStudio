<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { pad2 } from "../lib";
import { modelById } from "../models";
import { closeRegen, regen, resetRegenText, running, submitRegen } from "../store";
import ErrorNote from "./ErrorNote.vue";

const model = computed(() => modelById(regen.model));
const changed = computed(() => regen.text.trim() !== regen.original.trim());
/** Another operation (or this very request) holds the single generation lock. */
const blocked = computed(() => running.value || regen.submitting);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeRegen();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="regen.target" class="back" role="dialog" aria-modal="true" aria-labelledby="rg-title" @click.self="closeRegen()">
    <div class="box card">
      <h2 id="rg-title">Перегенерация · Кадр {{ pad2(regen.target.frame) }} · Вариант {{ pad2(regen.target.variant) }}</h2>

      <p v-if="regen.loading" class="muted">Загрузка промпта…</p>
      <template v-else>
        <ErrorNote :error="regen.error" />
        <template v-if="regen.available">
          <p class="mdl">
            <span class="muted">Модель изображения:</span>
            <span class="dot" :style="{ background: model?.color }" /> <b>{{ model?.name ?? regen.model }}</b>
          </p>
          <label class="lab" for="rg-text">Positive prompt<span v-if="regen.edited" class="tagc">Промпт изменён</span></label>
          <textarea id="rg-text" v-model="regen.text" lang="en" spellcheck="false" rows="9" :disabled="blocked" />
          <p class="muted small">Будет создан новый вариант с новым seed. Остальные варианты, выбор лучшего и оценка не меняются.</p>
          <p v-if="running && !regen.submitting" class="note warn">Сейчас идёт другая генерация — одновременно выполняется только одна. Дождитесь её завершения.</p>
        </template>
      </template>

      <div class="acts">
        <button class="btn ghost" :disabled="!regen.available || !changed || blocked" @click="resetRegenText()">Сбросить изменения</button>
        <span class="sp" />
        <button class="btn" @click="closeRegen()">Закрыть</button>
        <button class="btn primary" :disabled="!regen.available || blocked" @click="submitRegen()">{{ regen.submitting ? "Перегенерируется…" : "Перегенерировать" }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { position: fixed; inset: 0; z-index: 50; background: rgba(5, 6, 9, 0.8); display: flex; align-items: center; justify-content: center; padding: 24px; }
.box { width: min(640px, 100%); max-height: 100%; overflow: auto; padding: 22px; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow); }
h2 { font-size: 18px; margin: 0; }
.mdl { display: flex; align-items: center; gap: 6px; margin: 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.lab { font-size: 13px; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
.tagc { font-size: 11px; padding: 1px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-2); }
textarea { width: 100%; resize: vertical; min-height: 140px; padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); color: var(--text); font: 13px/1.5 ui-monospace, Consolas, monospace; }
.acts { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.sp { flex: 1; }
p { margin: 0; }
</style>
