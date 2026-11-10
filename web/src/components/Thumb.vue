<script setup lang="ts">
import { ref, watch } from "vue";
import { thumbUrl } from "../api";

const props = defineProps<{ id: string; file: string; alt?: string; eager?: boolean }>();
/** A file that cannot be loaded (deleted from disk) shows a placeholder instead of a broken image. */
const broken = ref(false);
watch(() => [props.id, props.file], () => (broken.value = false));
</script>

<template>
  <img v-if="!broken" :src="thumbUrl(id, file)" :alt="alt ?? ''" :loading="eager ? 'eager' : 'lazy'" decoding="async" @error="broken = true" />
  <span v-else class="missing">Файл отсутствует</span>
</template>

<style scoped>
img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missing { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: var(--bad); background: repeating-linear-gradient(135deg, var(--panel-2) 0 8px, #1c1f29 8px 16px); text-align: center; padding: 4px; }
</style>
