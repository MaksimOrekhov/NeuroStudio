<script setup lang="ts">
import { computed, ref } from "vue";
import type { Collection } from "../api";
import { IMAGE_BAD_TAGS, IMAGE_GOOD_TAGS } from "../ru";
import { toggleImageTag, toggleVerdict } from "../store";

const props = defineProps<{ c: Collection; frame: number; variant: number; /** icons only (image cards); the full-screen viewer shows words */ compact?: boolean }>();
const fb = computed(() => props.c.imageFeedback?.[`${props.frame}-${props.variant}`]);
/** Reasons are collapsed by default; selected tags are kept (they live on the server) and counted on the toggle. */
const open = ref(false);
const count = computed(() => fb.value?.tags.length ?? 0);
const tags = computed(() => (fb.value?.verdict === "like" ? IMAGE_GOOD_TAGS : fb.value?.verdict === "dislike" ? IMAGE_BAD_TAGS : []));
</script>

<template>
  <div class="rate">
    <div class="vd" role="group" aria-label="Качество изображения">
      <button class="v like" :class="{ on: fb?.verdict === 'like' }" :aria-pressed="fb?.verdict === 'like'" aria-label="Нравится" title="Нравится" @click="toggleVerdict(c, frame, variant, 'like')">👍<template v-if="!compact"> Нравится</template></button>
      <button class="v dislike" :class="{ on: fb?.verdict === 'dislike' }" :aria-pressed="fb?.verdict === 'dislike'" aria-label="Не нравится" title="Не нравится" @click="toggleVerdict(c, frame, variant, 'dislike')">👎<template v-if="!compact"> Не нравится</template></button>
    </div>
    <button v-if="fb" class="why" :aria-expanded="open" @click="open = !open">Причины<template v-if="count"> · {{ count }}</template> {{ open ? "▴" : "▾" }}</button>
    <div v-if="fb && open" class="tg">
      <button v-for="[k, l] in tags" :key="k" class="t" :class="[fb!.verdict, { on: fb!.tags.includes(k) }]" :aria-pressed="fb!.tags.includes(k)" @click="toggleImageTag(c, frame, variant, k)">{{ l }}</button>
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
.why { align-self: flex-start; background: none; border: 0; padding: 0; font-size: 12px; color: var(--accent-2); }
.tg { display: flex; flex-wrap: wrap; gap: 4px; }
.t { padding: 1px 8px; font-size: 11px; border-radius: 99px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
.t.like.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.t.dislike.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
</style>
