<script setup lang="ts">
import { computed } from "vue";
import { EFFORT_LABEL, MOCK_CODEX } from "../mock";
import { formula, modelUsage, sceneList } from "../models";
import { assigned, form, go, guided, run, running, startDemoRun, total, ui } from "../store";

const usage = computed(() => modelUsage(assigned.value));
const codex = computed(() => {
  const m = MOCK_CODEX.models.find((x) => x.id === form.codexModel)?.name ?? "Default model";
  return `${m} · ${form.codexEffort ? EFFORT_LABEL[form.codexEffort] : "default effort"}`;
});
const disabled = computed(() => running.value || ui.comfy === "down");
const pct = computed(() => (run.total ? Math.round((run.done / run.total) * 100) : 0));
</script>

<template>
  <div class="card summary">
    <p class="eyebrow">Generation summary</p>
    <div class="big"><b>{{ total }}</b> {{ total === 1 ? "image" : "images" }}</div>
    <p class="formula">{{ formula(form.collections, form.frames, form.variations) }}</p>

    <dl>
      <div>
        <dt>Theme</dt>
        <dd :class="{ muted: !form.theme.trim() }">{{ form.theme.trim() || "Codex invents the concept" }}</dd>
      </div>
      <div>
        <dt>Image models</dt>
        <dd>
          <span v-for="u in usage" :key="u.model.id" class="mline">
            <span class="dot" :style="{ background: u.model.color }" /> {{ u.model.name }} <span class="muted">— {{ sceneList(u.scenes) }}</span>
          </span>
        </dd>
      </div>
      <div>
        <dt>Prompt generation</dt>
        <dd>{{ codex }}</dd>
      </div>
      <div>
        <dt>Composition</dt>
        <dd :class="{ muted: !guided }">{{ guided ? `${guided} of ${form.frames} scenes guided` : "Auto — Codex decides" }}</dd>
      </div>
    </dl>

    <button class="btn primary go" :disabled="disabled" @click="startDemoRun">Generate <span class="tag">demo</span></button>
    <p class="demo">Demo mode: starts a simulated run with placeholder images. Nothing is sent to Codex or ComfyUI.</p>

    <p v-if="ui.comfy === 'down'" class="note bad">ComfyUI is not reachable. Start ComfyUI first — generation is disabled.</p>
    <div v-else-if="running" class="live">
      <div class="lrow">
        <span class="spinner" />
        <span>{{ run.status === "planning" ? "Codex is planning the batch…" : `Generating ${run.done} / ${run.total}` }}</span>
      </div>
      <div class="bar"><div :style="{ width: pct + '%' }" /></div>
      <p class="muted small">One run at a time. You can keep editing settings for the next run.</p>
      <button class="link" @click="go('activity')">Open Activity</button>
    </div>
  </div>
</template>

<style scoped>
.summary { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.big { font-size: 15px; color: var(--text-2); }
.big b { font-size: 40px; line-height: 1; color: var(--text); font-weight: 600; margin-right: 4px; font-variant-numeric: tabular-nums; }
.formula { font-size: 13px; color: var(--text-2); padding: 8px 10px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); font-variant-numeric: tabular-nums; }
dl { margin: 0; display: flex; flex-direction: column; gap: 10px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.mline { display: flex; align-items: center; gap: 6px; }
.go { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; margin-top: 4px; }
.tag { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; padding: 1px 6px; border-radius: 5px; background: rgba(255, 255, 255, 0.18); }
.demo { font-size: 12px; color: var(--muted); }
.live { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line); }
.lrow { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.live .link { align-self: flex-start; }
</style>
