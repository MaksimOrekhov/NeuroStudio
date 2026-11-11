<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { getVariantPrompt, imageUrl, type VariantPrompt } from "../api";
import { donePairs, openPairs, pairKey, statsOf, variantsOfFrame } from "../arena";
import { describeError } from "../errors";
import { pad2, titleOf } from "../lib";
import { modelById } from "../models";
import { arena, loadArena, submitComparison } from "../store";
import ErrorNote from "./ErrorNote.vue";

const props = defineProps<{ c: import("../api").Collection; frame: number }>();
const emit = defineEmits<{ close: [] }>();

const variants = computed(() => variantsOfFrame(props.c, props.frame));
const history = computed(() => arena.history);
const open = computed(() => openPairs(variants.value, props.frame, history.value));
const done = computed(() => donePairs(variants.value, props.frame, history.value));
const stats = computed(() => statsOf(variants.value, props.frame, history.value));

/** The pair on screen (a < b), whether the images are shown swapped, and the pairs skipped in this session (they stay open). */
const current = ref<[number, number] | null>(null);
const swapped = ref(false);
const skipped = reactive(new Set<string>());
const editing = ref(false);
const showList = ref(false);

const slot = (v: number) => props.c.frames.find((f) => f.frame === props.frame && f.variant === v);
const left = computed(() => (current.value ? current.value[swapped.value ? 1 : 0] : 0));
const right = computed(() => (current.value ? current.value[swapped.value ? 0 : 1] : 0));
const existing = computed(() => (current.value ? history.value[pairKey(props.frame, current.value[0], current.value[1])] : undefined));
const skippedLeft = computed(() => open.value.filter(([a, b]) => skipped.has(pairKey(props.frame, a, b))).length);

function show(pair: [number, number] | null) {
  current.value = pair;
  swapped.value = Math.random() < 0.5; // the side carries no meaning: the winner is always stored by variant number
}
/** Next open pair that was not skipped in this session; null = nothing left to offer. */
function advance() {
  editing.value = false;
  show(open.value.find(([a, b]) => !skipped.has(pairKey(props.frame, a, b))) ?? null);
}

onMounted(async () => {
  await loadArena(props.c.id);
  if (!arena.error) advance();
});
// A variant that appears later (regeneration finished) adds its pairs; the screen only moves on when nothing is being decided.
watch(
  () => variants.value.join(","),
  () => {
    if (!current.value && !editing.value && !arena.loading && !arena.error) advance();
  },
);

async function choose(winner: number | null) {
  const p = current.value;
  if (!p || arena.saving) return;
  if (await submitComparison(props.c.id, props.frame, p[0], p[1], winner)) advance();
}
function skip() {
  const p = current.value;
  if (!p) return;
  if (!existing.value) skipped.add(pairKey(props.frame, p[0], p[1])); // nothing is saved
  advance();
}
function reopen(a: number, b: number) {
  editing.value = true;
  show([a, b]);
}
function retrySkipped() {
  skipped.clear();
  advance();
}

// ---- prompts (the actual positive prompt of each variant, from the NS-017 endpoint) ----
const showPrompts = ref(false);
const prompts = reactive<Record<number, VariantPrompt | "error">>({});
async function loadPrompt(v: number) {
  if (prompts[v]) return;
  try {
    prompts[v] = await getVariantPrompt(props.c.id, props.frame, v);
  } catch (e) {
    prompts[v] = "error";
    void describeError(e);
  }
}
watch([showPrompts, left, right], () => {
  if (showPrompts.value && current.value) {
    void loadPrompt(left.value);
    void loadPrompt(right.value);
  }
});
const promptText = (v: number) => {
  const p = prompts[v];
  if (!p) return "Загрузка…";
  if (p === "error" || !p.available) return "Промпт недоступен: сохранённые данные генерации не найдены. Сравнить изображения всё равно можно.";
  return p.positive;
};
const differ = computed(() => {
  const a = prompts[left.value];
  const b = prompts[right.value];
  return !!a && !!b && a !== "error" && b !== "error" && a.available && b.available && a.positive !== b.positive;
});

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (!current.value) return;
  else if (e.key === "ArrowLeft") void choose(left.value);
  else if (e.key === "ArrowRight") void choose(right.value);
  else if (e.key === "ArrowDown") void choose(null);
  else if (e.code === "KeyS") skip();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const verdictText = (c: { variantA: number; variantB: number; winnerVariant: number | null }) => (c.winnerVariant === null ? "равны" : `лучше v${pad2(c.winnerVariant)}`);
const progress = computed(() => `${done.value.length} из ${done.value.length + open.value.length}`);
</script>

<template>
  <div class="arena-back" role="dialog" aria-modal="true" :aria-label="`Сравнение, кадр ${frame}`" @click.self="emit('close')">
    <div class="box">
      <header>
        <div>
          <h2>Сравнение · Кадр {{ pad2(frame) }}</h2>
          <p class="muted small">{{ titleOf(c) }}</p>
        </div>
        <div class="hr">
          <span class="muted small prog" aria-live="polite">Сравнений: {{ progress }}</span>
          <button class="btn" @click="emit('close')">Закрыть <kbd>Esc</kbd></button>
        </div>
      </header>

      <ErrorNote :error="arena.error" />
      <p v-if="arena.loading" class="muted">Загрузка сравнений…</p>

      <template v-else-if="!arena.error">
        <p v-if="variants.length < 2" class="muted">Для сравнения нужно хотя бы два готовых варианта этого кадра.</p>

        <div v-else-if="current" class="stage" :class="{ tight: showPrompts || showList }">
          <figure v-for="(v, i) in [left, right]" :key="`${i}-${v}`">
            <div class="pic"><img v-if="slot(v)?.image" :src="imageUrl(c.id, slot(v)!.image!)" :alt="`Вариант ${v}`" /></div>
            <figcaption>
              <b>Вариант {{ pad2(v) }}</b>
              <span class="dot" :style="{ background: modelById(slot(v)?.model ?? '')?.color }" /> {{ modelById(slot(v)?.model ?? "")?.name ?? slot(v)?.model }} · seed {{ slot(v)?.seed }}
              <span v-if="slot(v)?.promptEdited" class="tagc">Промпт изменён</span>
            </figcaption>
          </figure>
        </div>

        <div v-if="variants.length >= 2 && current" class="ctl">
          <button class="btn big" :class="{ on: existing && existing.winnerVariant === left }" :disabled="arena.saving" @click="choose(left)">← Левое лучше</button>
          <button class="btn big" :class="{ on: existing && existing.winnerVariant === null }" :disabled="arena.saving" @click="choose(null)">Равны</button>
          <button class="btn big" :class="{ on: existing && existing.winnerVariant === right }" :disabled="arena.saving" @click="choose(right)">Правое лучше →</button>
          <button class="btn ghost" :disabled="arena.saving" @click="skip()">{{ editing ? "Отмена" : "Пропустить" }}</button>
        </div>
        <p v-if="editing && current" class="muted small">Вы пересматриваете сохранённое решение: новое заменит прежнее.</p>

        <div v-if="variants.length >= 2 && !current" class="fin">
          <h3 v-if="!open.length">Все пары сравнены</h3>
          <h3 v-else>Остались только пропущенные пары</h3>
          <p v-if="open.length" class="muted">Пропущено: {{ skippedLeft }}. Они ничего не сохраняют и остаются доступными.</p>
          <button v-if="open.length" class="btn primary" @click="retrySkipped()">Вернуться к пропущенным</button>
        </div>

        <section v-if="variants.length >= 2" class="more">
          <button class="link" :aria-expanded="showPrompts" @click="showPrompts = !showPrompts">{{ showPrompts ? "Скрыть промпты" : "Показать промпты" }}</button>
          <span v-if="showPrompts && differ" class="tagc">Промпты отличаются</span>
          <div v-if="showPrompts && current" class="pr">
            <div v-for="v in [left, right]" :key="v">
              <p class="muted small">Вариант {{ pad2(v) }}</p>
              <pre>{{ promptText(v) }}</pre>
            </div>
          </div>

          <button class="link" :aria-expanded="showList" @click="showList = !showList">{{ showList ? "Скрыть итоги и сравнения" : "Итоги и сравнения" }} ({{ done.length }})</button>
          <div v-if="showList || (!current && !open.length)" class="sum">
            <template v-if="done.length">
              <table>
                <thead><tr><th>Вариант</th><th>Победы</th><th>Поражения</th><th>Ничьи</th><th>Сравнений</th></tr></thead>
                <tbody>
                  <tr v-for="r in stats" :key="r.variant"><td>v{{ pad2(r.variant) }}</td><td>{{ r.wins }}</td><td>{{ r.losses }}</td><td>{{ r.ties }}</td><td>{{ r.total }}</td></tr>
                </tbody>
              </table>
              <p class="muted small">Это только счёт по вашим сравнениям: при малом числе пар он ничего не доказывает.</p>
              <ul class="list">
                <li v-for="d in done" :key="`${d.variantA}-${d.variantB}`">
                  <span>v{{ pad2(d.variantA) }} против v{{ pad2(d.variantB) }} — {{ verdictText(d) }}</span>
                  <button class="link" @click="reopen(d.variantA, d.variantB)">Изменить</button>
                </li>
              </ul>
            </template>
            <p v-else class="muted small">Сохранённых сравнений пока нет.</p>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.arena-back { position: fixed; inset: 0; z-index: 45; background: rgba(5, 6, 9, 0.95); padding: 16px 24px; display: flex; }
.box { margin: 0 auto; width: min(1700px, 100%); display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
h2 { font-size: 20px; margin: 0; }
p { margin: 0; }
.hr { display: flex; gap: 12px; align-items: center; }
.stage { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 6px; min-height: 0; min-width: 0; }
/* The images get all the remaining height; contain = never cropped. */
.pic { flex: none; height: calc(100vh - 330px); min-height: 220px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel-2); overflow: hidden; }
.tight .pic { height: calc(100vh - 560px); min-height: 220px; }
.pic img { width: 100%; height: 100%; object-fit: contain; display: block; }
figcaption { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; justify-content: center; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.tagc { font-size: 11px; padding: 1px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-2); }
.ctl { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.btn.big { min-width: 180px; padding: 10px 18px; font-size: 15px; }
.btn.on { background: var(--ok-soft); border-color: var(--ok); color: var(--ok); }
.fin { text-align: center; padding: 28px 0; display: flex; flex-direction: column; gap: 10px; align-items: center; }
.more { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding-bottom: 8px; }
.pr { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; width: 100%; }
pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; max-height: 110px; overflow: auto; font: 12px/1.45 ui-monospace, Consolas, monospace; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.sum { width: 100%; max-width: 720px; display: flex; flex-direction: column; gap: 8px; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 4px 14px; border-bottom: 1px solid var(--line); text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
.list li { display: flex; gap: 14px; align-items: baseline; }
kbd { font: 11px/1 inherit; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--line-2); color: var(--muted); }
.prog { white-space: nowrap; }
</style>
