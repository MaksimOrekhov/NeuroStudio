<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IMAGE_NOTE_MAX } from "../../../src/imageFeedback";
import type { Collection } from "../api";
import { IMAGE_BAD_GROUPS, IMAGE_GOOD_TAGS } from "../ru";
import { imageFbBusy, imageFbError, saveImageNote, toggleImageTag, toggleVerdict } from "../store";

const props = defineProps<{ c: Collection; frame: number; variant: number; /** icons only (image cards); the full-screen viewer shows words */ compact?: boolean }>();
const fb = computed(() => props.c.imageFeedback?.[`${props.frame}-${props.variant}`]);
/** Reasons are collapsed by default; selected tags are kept (they live on the server) and counted on the toggle. */
const open = ref(false);
const count = computed(() => fb.value?.tags.length ?? 0);
const groups = computed(() => fb.value?.verdict === "dislike" ? IMAGE_BAD_GROUPS : [["", IMAGE_GOOD_TAGS]] as const);
const target = computed(() => `${props.c.id}/${props.frame}-${props.variant}`);
const draft = ref<string | null>(null);
const note = computed({
  get: () => draft.value ?? fb.value?.note ?? "",
  set: (value: string) => { draft.value = value; },
});
watch(target, () => { open.value = false; draft.value = null; });
watch(fb, (value) => { if (!value) draft.value = null; });
async function saveNote() {
  const id = target.value;
  const sent = note.value;
  await saveImageNote(props.c, props.frame, props.variant, sent);
  if (target.value === id && draft.value === sent && !imageFbError[props.c.id]) draft.value = null;
}
</script>

<template>
  <div class="rate">
    <div class="vd" role="group" aria-label="Качество изображения">
      <button class="v like" :class="{ on: fb?.verdict === 'like' }" :aria-pressed="fb?.verdict === 'like'" aria-label="Нравится" title="Нравится" @click="toggleVerdict(c, frame, variant, 'like')">👍<template v-if="!compact"> Нравится</template></button>
      <button class="v dislike" :class="{ on: fb?.verdict === 'dislike' }" :aria-pressed="fb?.verdict === 'dislike'" aria-label="Не нравится" title="Не нравится" @click="toggleVerdict(c, frame, variant, 'dislike')">👎<template v-if="!compact"> Не нравится</template></button>
    </div>
    <button v-if="fb" class="why" :aria-expanded="open" @click="open = !open">Причины<template v-if="count"> · {{ count }}</template><template v-if="fb.note"> · есть комментарий</template> {{ open ? "▴" : "▾" }}</button>
    <div v-if="fb && open" class="reasons">
      <fieldset v-for="[label, tags] in groups" :key="label">
        <legend v-if="label">{{ label }}</legend>
        <div class="tg">
          <button v-for="[k, l] in tags" :key="k" class="t" :class="[fb.verdict, { on: fb.tags.includes(k) }]" :aria-pressed="fb.tags.includes(k)" @click="toggleImageTag(c, frame, variant, k)">{{ l }}</button>
        </div>
      </fieldset>
      <form class="note-form" @submit.prevent="saveNote">
        <label>Комментарий к изображению
          <textarea v-model="note" class="image-note" :maxlength="IMAGE_NOTE_MAX" rows="2" @keydown.stop />
        </label>
        <button class="t" type="submit" :disabled="imageFbBusy[c.id] || note.trim() === (fb.note ?? '')">Сохранить комментарий</button>
      </form>
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
.reasons, .note-form { display: grid; gap: 6px; }
fieldset { min-width: 0; border: 0; margin: 0; padding: 0; }
legend, .note-form label { font-size: 11px; color: var(--text-2); }
.image-note { display: block; width: 100%; box-sizing: border-box; resize: vertical; margin-top: 3px; }
.note-form button { justify-self: start; }
.tg { display: flex; flex-wrap: wrap; gap: 4px; }
.t { padding: 1px 8px; font-size: 11px; border-radius: 99px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
.t.like.on { background: var(--ok-soft); color: var(--ok); border-color: var(--ok); }
.t.dislike.on { background: var(--bad-soft); color: var(--bad); border-color: var(--bad); }
</style>
