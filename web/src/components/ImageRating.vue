<script setup lang="ts">
import { computed } from "vue";
import type { Collection } from "../api";
import { IMAGE_BAD_TAGS, IMAGE_GOOD_TAGS } from "../ru";
import { imageFbBusy, toggleImageTag, toggleVerdict } from "../store";

const props = defineProps<{ c: Collection; frame: number; variant: number; /** icons only (image cards); the full-screen viewer shows words */ compact?: boolean }>();
const fb = computed(() => props.c.imageFeedback?.[`${props.frame}-${props.variant}`]);
const tags = computed(() => (fb.value?.verdict === "like" ? IMAGE_GOOD_TAGS : fb.value?.verdict === "dislike" ? IMAGE_BAD_TAGS : []));
</script>

<template>
  <div class="rate">
    <div class="vd" role="group" aria-label="Качество изображения">
      <button class="v like" :class="{ on: fb?.verdict === 'like' }" :aria-pressed="fb?.verdict === 'like'" aria-label="Нравится" title="Нравится" :disabled="imageFbBusy[c.id]" @click="toggleVerdict(c, frame, variant, 'like')">👍<template v-if="!compact"> Нравится</template></button>
      <button class="v dislike" :class="{ on: fb?.verdict === 'dislike' }" :aria-pressed="fb?.verdict === 'dislike'" aria-label="Не нравится" title="Не нравится" :disabled="imageFbBusy[c.id]" @click="toggleVerdict(c, frame, variant, 'dislike')">👎<template v-if="!compact"> Не нравится</template></button>
    </div>
    <div v-if="tags.length" class="tg">
      <button v-for="[k, l] in tags" :key="k" class="t" :class="[fb!.verdict, { on: fb!.tags.includes(k) }]" :aria-pressed="fb!.tags.includes(k)" :disabled="imageFbBusy[c.id]" @click="toggleImageTag(c, frame, variant, k)">{{ l }}</button>
    </div>
  </div>
</template>

<style scoped>
.rate { display: flex; flex-direction: column; gap: 6px; }
.vd { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.v { min-width: 0; padding: 4px 6px; font-size: 12px; border-radius: 8px; background: var(--panel-2); color: var(--text-2); border: 1px solid var(--line); white-space: nowrap; }
.v:hover:not(:disabled) { border-color: var(--line-2); color: var(--text); }
.v.like.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.v.dislike.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
.tg { display: flex; flex-wrap: wrap; gap: 4px; }
.t { padding: 1px 8px; font-size: 11px; border-radius: 99px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
.t.like.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.t.dislike.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
</style>
