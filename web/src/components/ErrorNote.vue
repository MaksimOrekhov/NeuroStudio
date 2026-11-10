<script setup lang="ts">
import type { UiError } from "../errors";

defineProps<{ error: UiError | null; tone?: "bad" | "warn" }>();
</script>

<template>
  <div v-if="error" class="note" :class="tone ?? 'bad'" role="alert">
    <p>{{ error.message }}</p>
    <details v-if="error.details">
      <summary>Подробности</summary>
      <pre>{{ error.code ? `${error.code}\n` : "" }}{{ error.details }}</pre>
    </details>
  </div>
</template>

<style scoped>
p { margin: 0; }
details { margin-top: 6px; font-size: 12px; }
summary { cursor: pointer; opacity: 0.85; }
pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, Consolas, monospace; opacity: 0.9; }
</style>
