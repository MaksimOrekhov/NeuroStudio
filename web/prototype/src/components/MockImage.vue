<script setup lang="ts">
// Placeholder artwork for mock collections (2:3 portrait). Deterministic per collection hue, scene and seed variant.
import { computed } from "vue";

const props = defineProps<{ hue: number; frame: number; variant: number }>();
const uid = `mi${Math.random().toString(36).slice(2, 10)}`;

const p = computed(() => {
  const h = (props.hue + props.variant * 9) % 360;
  const pose = (props.frame - 1) % 4;
  // scene → scale/position (rough "framing" variety); variant → small shifts
  const scale = [1, 1.6, 0.8, 1.25][pose];
  const x = [100, 92, 120, 80][pose] + (props.variant - 1) * 6;
  const y = [190, 168, 214, 182][pose];
  return {
    top: `hsl(${h} 62% 70%)`,
    mid: `hsl(${(h + 25) % 360} 48% 46%)`,
    low: `hsl(${(h + 40) % 360} 42% 20%)`,
    sun: `hsl(${(h + 12) % 360} 90% 86%)`,
    hill: `hsl(${(h + 200) % 360} 22% 16%)`,
    hill2: `hsl(${(h + 210) % 360} 26% 24%)`,
    fig: `hsl(${(h + 230) % 360} 30% 11%)`,
    sunX: 50 + ((props.frame * 37 + props.variant * 23) % 110),
    sunY: 70 + ((props.frame * 13) % 40),
    scale,
    x,
    y,
    sit: pose === 2,
  };
});
</script>

<template>
  <svg class="mock" viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Placeholder artwork">
    <defs>
      <linearGradient :id="`${uid}s`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="p.top" />
        <stop offset="0.55" :stop-color="p.mid" />
        <stop offset="1" :stop-color="p.low" />
      </linearGradient>
      <radialGradient :id="`${uid}l`">
        <stop offset="0" :stop-color="p.sun" stop-opacity="0.95" />
        <stop offset="1" :stop-color="p.sun" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect width="200" height="300" :fill="`url(#${uid}s)`" />
    <circle :cx="p.sunX" :cy="p.sunY" r="70" :fill="`url(#${uid}l)`" />
    <path d="M0 220 C 50 196 90 214 130 202 S 190 190 200 196 V300 H0Z" :fill="p.hill2" />
    <path d="M0 246 C 60 232 120 254 200 236 V300 H0Z" :fill="p.hill" />
    <g :transform="`translate(${p.x} ${p.y}) scale(${p.scale})`" :fill="p.fig">
      <circle cx="0" cy="-62" r="9.5" />
      <path d="M-3 -54 h6 l1 6 h-8z" />
      <path v-if="!p.sit" d="M-9 -48 C -14 -30 -12 -14 -17 6 L -22 40 H 22 L 17 6 C 12 -14 14 -30 9 -48 Z" />
      <path v-else d="M-9 -48 C -14 -30 -12 -18 -14 -6 L -16 6 H 26 L 30 18 H 36 L 30 0 H 10 C 12 -20 14 -32 9 -48 Z" />
      <path v-if="!p.sit" d="M-8 40 L -9 62 h4 L -2 40 Z M 8 40 L 9 62 h-4 L 2 40 Z" />
      <path d="M-9 -46 L -18 -14 L -15 -13 L -6 -40 Z M 9 -46 L 18 -14 L 15 -13 L 6 -40 Z" />
    </g>
  </svg>
</template>

<style scoped>
.mock { display: block; width: 100%; height: 100%; }
</style>
