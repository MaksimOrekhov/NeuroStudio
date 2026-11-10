<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { pad2, type ProtoCollection } from "../library";
import { modelById } from "../models";
import { selectBest } from "../store";
import MockImage from "./MockImage.vue";

const props = defineProps<{ c: ProtoCollection; frame: number; variant: number }>();
const emit = defineEmits<{ close: []; move: [frame: number, variant: number]; download: [frame: number, variant: number] }>();

/** All finished images in reading order: scene by scene, variant by variant. */
const images = computed(() => props.c.frames.filter((f) => f.image).sort((a, b) => a.frame - b.frame || a.variant - b.variant));
const idx = computed(() => images.value.findIndex((f) => f.frame === props.frame && f.variant === props.variant));
const f = computed(() => images.value[idx.value]);
const best = computed(() => props.c.selections[String(props.frame)] === props.variant);
const siblings = computed(() => props.c.frames.filter((x) => x.frame === props.frame).length);

function step(d: number) {
  const n = images.value[(idx.value + d + images.value.length) % images.value.length];
  if (n) emit("move", n.frame, n.variant);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.code === "KeyB") selectBest(props.c, props.frame, props.variant);
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="f" class="back" role="dialog" aria-modal="true" :aria-label="`${c.title}, кадр ${frame}`" @click.self="emit('close')">
    <button class="nav" aria-label="Предыдущее изображение" @click="step(-1)">‹</button>
    <div class="box">
      <div class="pic" :class="{ best }"><MockImage :hue="c.hue" :frame="f.frame" :variant="f.variant" /></div>
      <div class="info">
        <div class="it">
          <b>{{ c.title }} · кадр {{ pad2(f.frame) }}<template v-if="siblings > 1"> · вариант {{ f.variant }} из {{ siblings }}</template></b>
          <p><span class="dot" :style="{ background: modelById(f.model)?.color }" /> {{ modelById(f.model)?.name }} · seed {{ f.seed }}</p>
          <p v-if="f.summary" class="muted">{{ f.summary }}</p>
        </div>
        <div class="acts">
          <button class="btn" :class="{ ok: best }" @click="selectBest(c, f.frame, f.variant)">{{ best ? "✓ Лучший" : "Выбрать лучшим" }} <kbd>B</kbd></button>
          <button class="btn" @click="emit('download', f.frame, f.variant)">PNG</button>
          <button class="btn ghost" @click="emit('close')">Закрыть <kbd>Esc</kbd></button>
        </div>
      </div>
      <p class="muted small pos">{{ idx + 1 }} / {{ images.length }} · ← → — листать</p>
    </div>
    <button class="nav" aria-label="Следующее изображение" @click="step(1)">›</button>
  </div>
</template>

<style scoped>
.back { position: fixed; inset: 0; z-index: 40; background: rgba(5, 6, 9, 0.93); display: flex; align-items: center; justify-content: center; gap: 24px; padding: 24px; }
.box { display: flex; flex-direction: column; gap: 14px; max-height: 100%; }
.pic { aspect-ratio: 2 / 3; height: calc(100vh - 200px); margin: 0 auto; border-radius: 14px; overflow: hidden; border: 2px solid transparent; }
.pic.best { border-color: var(--ok); }
.info { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; width: calc((100vh - 200px) * 2 / 3); min-width: 560px; margin: 0 auto; }
.it { min-width: 0; flex: 1; }
.it p { font-size: 14px; display: flex; align-items: center; gap: 6px; }
.acts { display: flex; gap: 6px; flex: none; }
kbd { font: 11px/1 inherit; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--line-2); color: var(--muted); }
.pos { text-align: center; }
.nav { flex: none; width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--line-2); background: var(--panel); color: var(--text); font-size: 28px; line-height: 1; }
.nav:hover { border-color: var(--accent); }
</style>
