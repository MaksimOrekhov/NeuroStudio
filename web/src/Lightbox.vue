<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { imageUrl, type Collection } from "./api";

const props = defineProps<{ collection: Collection; frame: number; variant: number }>();
const emit = defineEmits<{ close: [] }>();

const f = computed(() => props.collection.frames.find((x) => x.frame === props.frame && x.variant === props.variant));
const isBest = computed(() => props.collection.selections[String(props.frame)] === props.variant);
const onKey = (e: KeyboardEvent) => e.key === "Escape" && emit("close");
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="f?.image" class="back" @click.self="emit('close')">
    <div class="box">
      <img :src="imageUrl(collection.id, f.image)" :alt="f.summary" />
      <div class="bar">
        <div>
          <b>{{ collection.title }} · scene {{ f.frame }}<template v-if="collection.variations > 1"> · v{{ f.variant }}</template><template v-if="isBest"> · ★ Best</template></b>
          <p>{{ f.summary }}</p>
        </div>
        <a :href="imageUrl(collection.id, f.image, true)">Download PNG</a>
        <button @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { position: fixed; inset: 0; background: rgba(5, 6, 9, 0.88); display: grid; place-items: center; z-index: 10; padding: 16px; }
.box { max-height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 12px; max-width: 900px; }
img { max-width: 100%; max-height: calc(100vh - 140px); margin: 0 auto; border-radius: 12px; object-fit: contain; }
.bar { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
p { margin: 2px 0 0; color: var(--muted); font-size: 14px; }
a, button { color: #fff; background: var(--accent); border: 0; border-radius: 8px; padding: 8px 14px; text-decoration: none; cursor: pointer; white-space: nowrap; }
button { background: var(--panel-2); }
</style>
