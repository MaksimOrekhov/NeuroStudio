<script setup lang="ts">
import { computed } from "vue";
import { COMPOSITION_FIELDS, COMPOSITION_OPTIONS } from "../../../../src/composition";
import { EFFORT_LABEL, MOCK_CODEX } from "../mock";
import { formula, modelUsage, sceneList } from "../models";
import { go, library, run, running, startDemoRun, ui } from "../store";

const pct = computed(() => (run.total ? Math.round((run.done / run.total) * 100) : 0));
const snap = computed(() => run.snapshot);

type StepState = "done" | "active" | "waiting" | "failed";
const steps = computed(() => {
  const s = run.status;
  const genDone = s === "completed";
  const planFailed = s === "failed" && !run.items.some((i) => i.id);
  const genFailed = s === "failed" && !planFailed;
  const st = (x: StepState) => x;
  return [
    { label: "ComfyUI check", detail: "Reachable, models available", state: st("done") },
    {
      label: "Planning with Codex",
      detail: snap.value ? `One call writes ${snap.value.collections} ${snap.value.collections === 1 ? "concept" : "concepts"} and all prompts` : "",
      state: st(s === "planning" ? "active" : planFailed ? "failed" : "done"),
    },
    {
      label: "Generating images",
      detail: s === "generating" ? `Collection ${run.current + 1} of ${run.items.length} · scene ${run.currentScene}${snap.value && snap.value.variations > 1 ? ` · v${run.currentVariant}` : ""}` : `${run.done} of ${run.total} images`,
      state: st(s === "generating" ? "active" : genFailed ? "failed" : genDone ? "done" : "waiting"),
    },
    { label: "Saved to Library", detail: genDone ? "All collections saved" : "Each collection is saved as soon as it finishes", state: st(genDone ? "done" : "waiting") },
  ];
});

const title = computed(() => {
  switch (run.status) {
    case "planning":
      return "Planning the batch";
    case "generating":
      return "Generating images";
    case "completed":
      return "Run completed";
    case "failed":
      return "Run stopped";
    default:
      return "No run in progress";
  }
});

const ITEM: Record<string, { text: string; cls: string }> = {
  waiting: { text: "Waiting", cls: "" },
  generating: { text: "Generating", cls: "run" },
  done: { text: "Saved", cls: "ok" },
  failed: { text: "Stopped · partial", cls: "bad" },
  not_started: { text: "Not started", cls: "" },
};

const codexLine = computed(() => {
  const s = snap.value;
  if (!s) return "";
  return `${MOCK_CODEX.models.find((m) => m.id === s.codexModel)?.name ?? "Default model"} · ${s.codexEffort ? EFFORT_LABEL[s.codexEffort] : "default effort"}`;
});
const compLine = computed(() => {
  const s = snap.value;
  if (!s) return "";
  const n = s.composition.filter((x) => Object.keys(x).length).length;
  return n ? `${n} of ${s.frames} scenes guided` : "Auto";
});
const compOf = (i: number) => {
  const s = snap.value?.composition[i] ?? {};
  const parts = COMPOSITION_FIELDS.filter((f) => s[f]).map((f) => COMPOSITION_OPTIONS[f].find((x) => x.id === s[f])?.label);
  return parts.length ? parts.join(" · ") : "Auto";
};
const savedCount = computed(() => run.items.filter((i) => i.status === "done").length);
const partial = computed(() => run.items.find((i) => i.status === "failed" && i.done > 0));
const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const titleOf = (id: string) => library.items.find((c) => c.id === id)?.title ?? id;
</script>

<template>
  <div class="act">
    <div class="cols">
      <div class="main">
        <section class="card current" :class="run.status">
          <div class="ch">
            <div>
              <p class="eyebrow">Current run</p>
              <h1>
                <span v-if="running" class="spinner" />
                {{ title }}
              </h1>
              <p v-if="snap" class="muted small">Started {{ time(run.startedAt) }} · {{ formula(snap.collections, snap.frames, snap.variations) }}</p>
            </div>
            <span v-if="run.status !== 'idle'" class="pct">{{ run.done }}<small> / {{ run.total }}</small></span>
          </div>

          <template v-if="run.status === 'idle'">
            <p class="muted">Start a run from Create. Progress, errors and saved collections appear here, and you can keep browsing the Library meanwhile.</p>
            <div class="row">
              <button class="btn primary" @click="go('create')">Go to Create</button>
              <button class="btn" :disabled="ui.comfy === 'down'" @click="startDemoRun">Start simulated run</button>
            </div>
          </template>

          <template v-else>
            <div class="bar" :class="{ ok: run.status === 'completed', bad: run.status === 'failed' }"><div :style="{ width: pct + '%' }" /></div>

            <ol class="steps">
              <li v-for="s in steps" :key="s.label" :class="s.state">
                <span class="ic" aria-hidden="true">
                  <span v-if="s.state === 'active'" class="spinner" />
                  <template v-else-if="s.state === 'done'">✓</template>
                  <template v-else-if="s.state === 'failed'">!</template>
                </span>
                <div>
                  <b>{{ s.label }}</b>
                  <p class="muted small">{{ s.detail }}</p>
                </div>
              </li>
            </ol>

            <div v-if="run.status === 'failed'" class="note bad">
              <b>The run stopped:</b> {{ run.error }}
              <p class="fx">
                <template v-if="savedCount || partial">
                  Saved: {{ savedCount }} complete {{ savedCount === 1 ? "collection" : "collections" }}<template v-if="partial">, plus {{ partial.done }} of {{ partial.total }} images of “{{ partial.title }}”</template>.
                </template>
                <template v-else>No images were generated.</template>
                Nothing is resumed or resubmitted automatically. Review what was saved in the Library and start a new run when ready.
              </p>
              <p v-if="ui.comfy === 'down'" class="fx">ComfyUI is unavailable. An image that ComfyUI had already accepted may still finish there — its prompt_id is shown on the collection.</p>
            </div>

            <div class="items">
              <div v-for="(it, i) in run.items" :key="i" class="item">
                <span class="idx">{{ i + 1 }}</span>
                <div class="it">
                  <b :class="{ muted: !it.id }">{{ it.id ? it.title : run.status === "planning" ? "Concept is being written…" : it.title }}</b>
                  <div class="bar slim" :class="{ ok: it.status === 'done', bad: it.status === 'failed' }"><div :style="{ width: (it.done / it.total) * 100 + '%' }" /></div>
                </div>
                <span class="cnt">{{ it.done }}/{{ it.total }}</span>
                <span class="badge" :class="ITEM[it.status].cls">{{ ITEM[it.status].text }}</span>
                <button class="btn sm" :disabled="!it.id" @click="go('library', it.id!)">Open</button>
              </div>
            </div>
          </template>
        </section>

        <section class="card hist">
          <h2>Recent runs</h2>
          <ul>
            <li v-for="r in library.runs" :key="r.id">
              <span class="badge" :class="r.status === 'completed' ? 'ok' : 'bad'">{{ r.status === "completed" ? "Completed" : "Stopped" }}</span>
              <div class="hi">
                <b>{{ r.theme ?? "No theme" }}</b>
                <p class="muted small">{{ time(r.startedAt) }} · {{ formula(r.collections, r.frames, r.variations) }}</p>
                <p v-if="r.error" class="err small">{{ r.error }}</p>
              </div>
              <div class="links">
                <button v-for="id in r.collectionIds" :key="id" class="link" @click="go('library', id)">{{ titleOf(id) }}</button>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <aside class="side">
        <section class="card panel">
          <h3>ComfyUI</h3>
          <p class="cst" :class="ui.comfy"><span class="dot" /> {{ ui.comfy === "ok" ? "Connected · v0.3 (mock) · queue empty" : "Not reachable" }}</p>
          <p v-if="ui.comfy === 'down'" class="muted small">Start ComfyUI, then come back — the status refreshes automatically. Generate stays disabled until then.</p>
          <p v-else class="muted small">Checked every few seconds. Generation is blocked while ComfyUI is unavailable.</p>
        </section>

        <section v-if="snap" class="card panel">
          <h3>Run settings</h3>
          <dl>
            <div><dt>Theme</dt><dd :class="{ muted: !snap.theme }">{{ snap.theme || "Codex invents the concept" }}</dd></div>
            <div>
              <dt>Image models</dt>
              <dd>
                <span v-for="u in modelUsage(snap.models)" :key="u.model.id" class="ml"><span class="dot" :style="{ background: u.model.color }" /> {{ u.model.name }} <span class="muted">— {{ sceneList(u.scenes) }}</span></span>
              </dd>
            </div>
            <div><dt>Prompt generation</dt><dd>{{ codexLine }}</dd></div>
            <div>
              <dt>Composition</dt>
              <dd>
                {{ compLine }}
                <ol v-if="compLine !== 'Auto'" class="cl">
                  <li v-for="i in snap.frames" :key="i"><b>{{ String(i).padStart(2, "0") }}</b> <span class="muted">{{ compOf(i - 1) }}</span></li>
                </ol>
              </dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; align-items: start; }
.main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.current { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.current.failed { border-color: rgba(240, 80, 110, 0.35); }
.current.completed { border-color: rgba(62, 207, 142, 0.3); }
.ch { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
h1 { font-size: 20px; display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.pct { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pct small { font-size: 15px; color: var(--muted); font-weight: 400; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.steps li { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
.steps li.active { border-color: rgba(124, 108, 255, 0.5); }
.steps li.waiting { opacity: 0.55; }
.steps li.failed { border-color: rgba(240, 80, 110, 0.45); }
.ic { width: 22px; height: 22px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; background: var(--panel-3); color: var(--muted); }
.steps li.done .ic { background: var(--ok-soft); color: var(--ok); }
.steps li.failed .ic { background: var(--bad-soft); color: var(--bad); }
.steps li.active .ic { background: transparent; }
.steps b { font-size: 13px; }
.fx { margin-top: 6px; }
.items { display: flex; flex-direction: column; gap: 8px; }
.item { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto auto auto; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); }
.idx { color: var(--muted); font-variant-numeric: tabular-nums; }
.it { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.it b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar.slim { height: 4px; }
.cnt { font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.item .badge:not(.ok):not(.run):not(.bad) { background: var(--panel-3); color: var(--muted); }
.hist { padding: 18px 20px; }
.hist h2 { font-size: 15px; margin-bottom: 8px; }
.hist ul { list-style: none; margin: 0; padding: 0; }
.hist li { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.hist li:first-child { border-top: 0; }
.hist .badge { justify-self: start; }
.err { color: #f58aa0; }
.links { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.side { display: flex; flex-direction: column; gap: 14px; position: sticky; top: 76px; }
.panel { padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.panel h3 { font-size: 14px; }
.cst { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.cst .dot { background: var(--ok); }
.cst.down { color: #f58aa0; }
.cst.down .dot { background: var(--bad); }
dl { margin: 0; display: flex; flex-direction: column; gap: 8px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; font-size: 13px; }
.ml { display: flex; align-items: center; gap: 6px; }
.cl { margin: 4px 0 0; padding: 0; list-style: none; font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
@media (max-width: 1100px) {
  .cols { grid-template-columns: 1fr; }
  .side { position: static; }
  .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .steps { grid-template-columns: 1fr; }
  .item { grid-template-columns: 20px minmax(0, 1fr) auto; }
  .item .cnt { display: none; }
  .item .btn { grid-column: 2 / -1; justify-self: start; }
  .hist li { grid-template-columns: 1fr; gap: 6px; }
  .links { align-items: flex-start; }
}
</style>
