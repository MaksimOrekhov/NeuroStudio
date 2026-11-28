<script setup lang="ts">
// NS-031: manual local repair. The user paints a mask over the image (brush / eraser, size, undo, clear), describes in English what the
// area should show, picks a preset (remove = denoise 1.0, fix = 0.65) and, if needed, the processing area (512 / 1024 px). The mask is
// kept as a list of strokes in IMAGE pixels, so undo is exact and cheap; it is exported at the image's own size (white = repair).
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { imageUrl } from "../api";
import { pad2 } from "../lib";
import { modelById } from "../models";
import { REPAIR_PRESETS, closeRepair, repair, running, setRepairDenoise, setRepairPreset, submitRepair } from "../store";
import ErrorNote from "./ErrorNote.vue";

interface Stroke {
  erase: boolean;
  size: number;
  points: [number, number][];
}

const view = ref<HTMLCanvasElement | null>(null);
const stage = ref<HTMLDivElement | null>(null);
const img = new Image();
const loaded = ref(false);
const tool = reactive({ erase: false, size: 40 });
const strokes = reactive<Stroke[]>([]);
const cursor = reactive({ x: 0, y: 0, on: false });
const stats = reactive({ px: 0, bbox: null as [number, number, number, number] | null });
let drawing: Stroke | null = null;
let mask: HTMLCanvasElement | null = null;
let tint: HTMLCanvasElement | null = null;

const info = computed(() => repair.info);
const model = computed(() => (info.value ? modelById(info.value.model) : undefined));
const blocked = computed(() => running.value || repair.submitting);
const envProblem = computed(() => (repair.status && !repair.status.ready ? repair.status : null));
const coverage = computed(() => (info.value && stats.px ? (100 * stats.px) / (info.value.width * info.value.height) : 0));
/** Same rule as the server: the painted area + its grow and feather border must fit in the processing area. */
const zone = computed(() => {
  const i = info.value;
  if (!i || !stats.bbox) return null;
  const m = i.growPx + i.featherPx + 1;
  const [x0, y0, x1, y1] = stats.bbox;
  return { w: Math.min(i.width, x1 + m) - Math.max(0, x0 - m), h: Math.min(i.height, y1 + m) - Math.max(0, y0 - m) };
});
const fits = (r: number) => !zone.value || (zone.value.w <= r && zone.value.h <= r);
const problem = computed(() => {
  const i = info.value;
  if (!i) return "";
  if (!stats.px) return "Закрасьте область, которую нужно исправить.";
  if (coverage.value > i.maxMaskFraction * 100) return `Маска закрывает ${coverage.value.toFixed(1)} % кадра — больше ${i.maxMaskFraction * 100} %. Такой объём лучше перегенерировать.`;
  if (!fits(repair.region)) return repair.region === 512 && fits(1024) ? "Маска с запасом не помещается в область 512 px — выберите 1024 px." : "Маска не помещается в область 1024 px — уменьшите её.";
  if (repair.text.trim().length < 3) return "Опишите на английском, что должно быть на месте маски.";
  if (/[Ѐ-ӿ]/.test(repair.text)) return "Описание нужно написать на английском.";
  return "";
});
const canStart = computed(() => !!info.value && !blocked.value && !envProblem.value && !problem.value);

// ---------- drawing ----------

function strokePath(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = "round";
  if (s.points.length === 1) {
    ctx.beginPath();
    ctx.arc(s.points[0][0], s.points[0][1], s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(s.points[0][0], s.points[0][1]);
  for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
  ctx.stroke();
}
function rebuildMask() {
  if (!mask) return;
  const ctx = mask.getContext("2d")!;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, mask.width, mask.height);
  for (const s of strokes) strokePath(ctx, s);
  measure();
  render();
}
/** Painted pixel count and bounding box (alpha >= 50 %, the server's threshold). */
function measure() {
  if (!mask) return;
  const { data, width, height } = mask.getContext("2d")!.getImageData(0, 0, mask.width, mask.height);
  let px = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      px++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  stats.px = px;
  stats.bbox = px ? [x0, y0, x1 + 1, y1 + 1] : null;
}
let frame = 0;
function render() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const c = view.value;
    if (!c || !mask || !tint || !loaded.value) return;
    const ctx = c.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const t = tint.getContext("2d")!;
    t.globalCompositeOperation = "source-over";
    t.clearRect(0, 0, tint.width, tint.height);
    t.drawImage(mask, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = "rgb(255, 48, 72)";
    t.fillRect(0, 0, tint.width, tint.height);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint, 0, 0, c.width, c.height);
    ctx.globalAlpha = 1;
    if (cursor.on) {
      const k = c.width / img.naturalWidth;
      ctx.beginPath();
      ctx.arc(cursor.x * k, cursor.y * k, (tool.size / 2) * k, 0, Math.PI * 2);
      ctx.strokeStyle = tool.erase ? "rgba(255,255,255,0.9)" : "rgba(255,210,80,0.95)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(tool.erase ? [4, 3] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
}
function toImage(e: PointerEvent): [number, number] {
  const r = view.value!.getBoundingClientRect();
  return [((e.clientX - r.left) * img.naturalWidth) / r.width, ((e.clientY - r.top) * img.naturalHeight) / r.height];
}
function down(e: PointerEvent) {
  if (!loaded.value || blocked.value || e.button !== 0) return;
  view.value!.setPointerCapture(e.pointerId);
  drawing = { erase: tool.erase, size: tool.size, points: [toImage(e)] };
  strokes.push(drawing);
  strokePath(mask!.getContext("2d")!, drawing);
  render();
}
function move(e: PointerEvent) {
  [cursor.x, cursor.y] = toImage(e);
  cursor.on = true;
  if (drawing) {
    const p = toImage(e);
    const last = drawing.points[drawing.points.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1) return;
    drawing.points.push(p);
    const ctx = mask!.getContext("2d")!;
    strokePath(ctx, { ...drawing, points: [last, p] });
  }
  render();
}
function up() {
  if (!drawing) return;
  drawing = null;
  measure();
  render();
}
function leave() {
  cursor.on = false;
  render();
}
function undo() {
  if (!strokes.length || blocked.value) return;
  strokes.pop();
  rebuildMask();
}
function clear() {
  if (blocked.value) return;
  strokes.splice(0);
  rebuildMask();
}

/** The mask at the image's own size: black background, white strokes (red channel >= 50 % = repair on the server). */
function exportMask(): string {
  const out = document.createElement("canvas");
  out.width = mask!.width;
  out.height = mask!.height;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(mask!, 0, 0);
  return out.toDataURL("image/png");
}
async function start() {
  if (!canStart.value) return;
  await submitRepair(exportMask());
}

// ---------- layout ----------

function fit() {
  const c = view.value, s = stage.value;
  if (!c || !s || !img.naturalWidth) return;
  const k = Math.min(s.clientWidth / img.naturalWidth, s.clientHeight / img.naturalHeight);
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  render();
}
watch(
  () => info.value,
  (i) => {
    if (!i || !repair.target) return;
    loaded.value = false;
    strokes.splice(0);
    stats.px = 0;
    stats.bbox = null;
    img.onload = async () => {
      if (img.naturalWidth !== i.width || img.naturalHeight !== i.height) {
        repair.error = { message: "Размер изображения не совпадает с данными сервера. Обновите страницу." };
        return;
      }
      mask = Object.assign(document.createElement("canvas"), { width: i.width, height: i.height });
      tint = Object.assign(document.createElement("canvas"), { width: i.width, height: i.height });
      loaded.value = true;
      tool.size = Math.max(8, Math.round(Math.min(i.width, i.height) / 36));
      await nextTick();
      fit();
    };
    img.src = imageUrl(repair.target.id, repair.target.image);
  },
  { immediate: true },
);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeRepair();
  else if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
    e.preventDefault();
    undo();
  }
}
let ro: ResizeObserver | null = null;
onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (stage.value && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(fit);
    ro.observe(stage.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  ro?.disconnect();
  cancelAnimationFrame(frame);
});
defineExpose({ exportMask });
</script>

<template>
  <div v-if="repair.target" class="back" role="dialog" aria-modal="true" aria-labelledby="rp-title" @click.self="closeRepair()">
    <div class="box card">
      <div ref="stage" class="stage">
        <p v-if="repair.loading" class="muted">Загрузка…</p>
        <canvas
          v-show="loaded"
          ref="view"
          class="cv"
          :class="{ erase: tool.erase }"
          aria-label="Изображение: закрасьте область, которую нужно исправить"
          @pointerdown="down"
          @pointermove="move"
          @pointerup="up"
          @pointercancel="up"
          @pointerleave="leave"
        />
      </div>

      <aside class="side">
        <h2 id="rp-title">Исправить область · Кадр {{ pad2(repair.target.frame) }} · Вариант {{ pad2(repair.target.variant) }}</h2>
        <ErrorNote :error="repair.error" />
        <template v-if="info">
          <p class="mdl">
            <span class="dot" :style="{ background: model?.color }" /> <b>{{ model?.name ?? info.model }}</b>
            <span class="muted small">· Inpainting v2 · {{ info.width }}×{{ info.height }}</span>
          </p>
          <div v-if="envProblem" class="note warn">
            <b>Исправление сейчас недоступно.</b>
            <span v-if="envProblem.error"> ComfyUI не отвечает: {{ envProblem.error }}</span>
            <span v-else> {{ envProblem.problems.join("; ") }}</span>
            <pre v-if="envProblem.instructions" class="ins">{{ envProblem.instructions }}</pre>
          </div>

          <div class="tools" role="group" aria-label="Инструменты маски">
            <div class="seg">
              <button :class="{ on: !tool.erase }" :aria-pressed="!tool.erase" @click="tool.erase = false">Кисть</button>
              <button :class="{ on: tool.erase }" :aria-pressed="tool.erase" @click="tool.erase = true">Ластик</button>
            </div>
            <label class="size">Размер <input v-model.number="tool.size" type="range" min="4" max="200" step="2" aria-label="Размер кисти" /> <span>{{ tool.size }} px</span></label>
            <div class="row">
              <button class="btn sm" :disabled="!strokes.length || blocked" title="Ctrl+Z" @click="undo()">Отменить</button>
              <button class="btn sm ghost" :disabled="!strokes.length || blocked" @click="clear()">Очистить</button>
              <span class="muted small cov">Маска: {{ coverage.toFixed(1) }} %</span>
            </div>
          </div>

          <div class="presets" role="radiogroup" aria-label="Режим исправления">
            <button role="radio" :aria-checked="repair.preset === 'remove'" :class="{ on: repair.preset === 'remove' }" :disabled="blocked" @click="setRepairPreset('remove')">
              <b>Удалить объект</b><small>Лишний предмет, фигура, конечность · denoise {{ REPAIR_PRESETS.remove.toFixed(2) }}</small>
            </button>
            <button role="radio" :aria-checked="repair.preset === 'fix'" :class="{ on: repair.preset === 'fix' }" :disabled="blocked" @click="setRepairPreset('fix')">
              <b>Локальное исправление</b><small>Сохраняет форму, правит детали · denoise {{ REPAIR_PRESETS.fix.toFixed(2) }}</small>
            </button>
          </div>

          <label class="lab" for="rp-text">Что должно быть на месте маски (на английском)</label>
          <textarea id="rp-text" v-model="repair.text" lang="en" spellcheck="false" rows="3" :maxlength="info.textMax" :disabled="blocked" placeholder="the patterned woven rug continuing between her feet" />
          <small class="muted">Опишите содержимое области и окружение рядом — не всю сцену и не героиню.</small>

          <details class="adv">
            <summary>Параметры</summary>
            <label class="size">denoise <input type="range" :min="info.denoiseMin" :max="info.denoiseMax" step="0.05" :value="repair.denoise" :disabled="blocked" aria-label="denoise" @input="setRepairDenoise(Number(($event.target as HTMLInputElement).value))" /> <span>{{ repair.denoise.toFixed(2) }}<template v-if="repair.preset === 'custom'"> · свой</template></span></label>
            <div class="seg reg" role="radiogroup" aria-label="Область обработки">
              <button v-for="r in [512, 1024] as const" :key="r" role="radio" :aria-checked="repair.region === r" :class="{ on: repair.region === r }" :disabled="blocked || !info.regions.includes(r)" @click="repair.region = r">{{ r }} px</button>
            </div>
            <small class="muted">512 px — небольшие детали (кисть, предмет), область увеличивается ×2. 1024 px — крупные области. Strength адаптера {{ info.strength.toFixed(1) }}, seed — новый случайный.</small>
          </details>

          <p class="muted small">Будет создан новый вариант кадра. Исходное изображение, оценки и выбор лучшего не меняются; пиксели за пределами области ремонта остаются байт в байт.</p>
          <p v-if="problem && loaded" class="note warn">{{ problem }}</p>
          <p v-if="running && !repair.submitting" class="note warn">Сейчас идёт другая генерация — одновременно выполняется только одна. Дождитесь её завершения.</p>
        </template>

        <div class="acts">
          <button class="btn" @click="closeRepair()">Закрыть</button>
          <button class="btn primary" :disabled="!canStart" @click="start()">{{ repair.submitting ? "Отправляется…" : "Исправить" }}</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.back { position: fixed; inset: 0; z-index: 50; background: rgba(5, 6, 9, 0.85); display: flex; align-items: center; justify-content: center; padding: 20px; }
.box { width: min(1320px, 100%); height: min(940px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 18px; padding: 18px; box-shadow: var(--shadow); }
.stage { min-width: 0; min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--panel-2); border-radius: 12px; overflow: hidden; }
.cv { display: block; touch-action: none; cursor: crosshair; }
.cv.erase { cursor: cell; }
.side { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
h2 { font-size: 17px; margin: 0; }
p { margin: 0; }
.mdl { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.tools { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.seg { display: flex; border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden; }
.seg button { flex: 1; padding: 6px 10px; background: var(--panel-2); color: var(--text-2); border: 0; }
.seg button + button { border-left: 1px solid var(--line-2); }
.seg button.on { background: var(--accent-soft); color: var(--accent-2); }
.seg button:disabled { opacity: 0.45; }
.size { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.size input { flex: 1; accent-color: var(--accent); }
.size span { min-width: 62px; text-align: right; font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; gap: 6px; }
.cov { margin-left: auto; }
.presets { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.presets button { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--text); }
.presets button small { color: var(--muted); font-size: 11px; }
.presets button.on { border-color: var(--accent); background: var(--accent-soft); }
.lab { font-size: 13px; color: var(--text-2); }
textarea { width: 100%; resize: vertical; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--line-2); background: var(--panel-2); color: var(--text); font: 13px/1.45 ui-monospace, Consolas, monospace; }
.adv { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.adv[open] { padding-bottom: 4px; }
.adv > * + * { margin-top: 8px; }
summary { cursor: pointer; color: var(--accent-2); }
.reg { max-width: 220px; }
.ins { white-space: pre-wrap; font-size: 12px; margin: 6px 0 0; }
.acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: auto; padding-top: 6px; }
@media (max-width: 980px) {
  .box { grid-template-columns: 1fr; height: auto; max-height: 100%; overflow: auto; }
  .stage { height: 60vh; }
}
</style>
