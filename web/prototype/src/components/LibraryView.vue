<script setup lang="ts">
import { computed, ref } from "vue";
import { badgeOf, exportState, finalOf, hasIssues, needsSelection, scenesOf, type ProtoCollection } from "../library";
import { modelById } from "../models";
import { go, library, ui } from "../store";
import CollectionDetail from "./CollectionDetail.vue";
import MockImage from "./MockImage.vue";

type Filter = "all" | "select" | "done" | "issues";
const filter = ref<Filter>("all");
const query = ref("");

const filters = computed(() => [
  { id: "all" as Filter, label: "All", n: library.items.length },
  { id: "select" as Filter, label: "Needs Best", n: library.items.filter(needsSelection).length },
  { id: "done" as Filter, label: "Ready to export", n: library.items.filter((c) => exportState(c).ready).length },
  { id: "issues" as Filter, label: "Issues", n: library.items.filter(hasIssues).length },
]);
const shown = computed(() =>
  library.items.filter((c) => {
    if (query.value.trim() && !c.title.toLowerCase().includes(query.value.trim().toLowerCase())) return false;
    if (filter.value === "select") return needsSelection(c);
    if (filter.value === "done") return exportState(c).ready;
    if (filter.value === "issues") return hasIssues(c);
    return true;
  }),
);
const open = computed(() => library.items.find((c) => c.id === ui.openCollection));

/** Thumbnail per scene: the final image, else the first finished variant, else the first variant (its state is shown). */
function cover(c: ProtoCollection) {
  return scenesOf(c).map((s) => ({ s, f: finalOf(c, s) ?? s.variants.find((v) => v.image) ?? s.variants[0], best: c.selections[String(s.frame)] !== undefined }));
}
const date = (iso: string) => new Date(iso).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <CollectionDetail v-if="open" :c="open" />
  <div v-else class="lib">
    <div class="toolbar">
      <div>
        <h1>Library</h1>
        <p class="muted small">{{ library.items.length }} collections · newest first</p>
      </div>
      <div class="tools">
        <input v-model="query" class="input search" type="search" placeholder="Search titles" aria-label="Search collection titles" />
        <div class="seg" role="radiogroup" aria-label="Filter collections">
          <button v-for="f in filters" :key="f.id" role="radio" :aria-checked="filter === f.id" :class="{ on: filter === f.id }" @click="filter = f.id">
            {{ f.label }} <span class="n">{{ f.n }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="!shown.length" class="empty card">
      <p v-if="!library.items.length">No collections yet.</p>
      <p v-else>No collections match this filter.</p>
      <button v-if="!library.items.length" class="btn primary" @click="go('create')">Create a collection</button>
      <button v-else class="btn" @click="(filter = 'all'), (query = '')">Show all</button>
    </div>

    <div class="rows">
      <button v-for="c in shown" :key="c.id" class="row card" :class="{ running: c.status === 'running' }" @click="go('library', c.id)">
        <div class="info">
          <div class="t">
            <h3>{{ c.title }}</h3>
            <span class="badge" :class="badgeOf(c).cls"><span v-if="c.status === 'running'" class="spinner" />{{ badgeOf(c).text }}</span>
          </div>
          <p class="muted small">{{ date(c.createdAt) }}<template v-if="c.demo"> · demo</template></p>
          <div class="chips">
            <span class="chip">{{ c.frameCount }} {{ c.frameCount === 1 ? "frame" : "frames" }}</span>
            <span v-if="c.variations > 1" class="chip">× {{ c.variations }} variations</span>
            <span v-if="c.feedback?.rating" class="chip stars" :title="`Rated ${c.feedback.rating} of 5`">{{ "★".repeat(c.feedback.rating) }}</span>
          </div>
        </div>
        <div class="strip" :class="`n${c.frameCount}`">
          <div v-for="{ s, f, best } in cover(c)" :key="s.frame" class="th" :class="{ best }">
            <MockImage v-if="f?.image" :hue="c.hue" :frame="s.frame" :variant="f.variant" />
            <div v-else class="ph" :class="f?.status">
              <span v-if="f?.status === 'submitted'" class="spinner" />
              <span>{{ f?.status === "pending" ? (c.status === "running" ? "Queued" : "Not generated") : f?.status === "submitted" ? "Generating" : f?.status === "timeout" ? "Unknown" : "Failed" }}</span>
            </div>
            <span class="sn">{{ s.frame }}</span>
            <span class="md" :style="{ background: modelById(s.model)?.color }" :title="modelById(s.model)?.name" />
            <span v-if="best" class="bst" title="Best selected">★</span>
          </div>
        </div>
        <div v-if="c.status !== 'running'" class="exp">
          <template v-if="exportState(c).ready"><span class="okline">✓ Ready to export</span></template>
          <template v-else-if="c.status === 'done'">
            <span>Best chosen {{ exportState(c).resolved }}/{{ exportState(c).total }}</span>
            <span class="bar mini"><span :style="{ width: (exportState(c).resolved / exportState(c).total) * 100 + '%' }" /></span>
          </template>
          <template v-else><span class="muted">{{ c.doneFrames }} of {{ c.frames.length }} images saved</span></template>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.lib { display: flex; flex-direction: column; gap: 16px; }
.toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 22px; }
.tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.search { width: 200px; }
.n { font-size: 11px; opacity: 0.7; margin-left: 2px; }
.empty { padding: 32px; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--text-2); }
.rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 460px), 1fr)); gap: 14px; }
.row { display: flex; flex-direction: column; gap: 12px; padding: 14px; text-align: left; transition: border-color 0.15s, background 0.15s; }
.row:hover { border-color: var(--line-2); background: #151821; }
.row:hover h3 { color: #fff; }
.row.running { border-color: rgba(124, 108, 255, 0.4); }
.info { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 2px; }
.t { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
h3 { font-size: 16px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.stars { color: #f5b942; letter-spacing: 1px; }
.exp { margin-top: auto; padding: 0 2px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-2); }
.okline { color: var(--ok); }
.bar.mini { display: block; width: 80px; height: 4px; border-radius: 99px; background: var(--panel-3); overflow: hidden; }
.bar.mini span { display: block; height: 100%; background: var(--accent-2); }
.strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.th { position: relative; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden; background: var(--panel-2); border: 1px solid var(--line); }
.th.best { border-color: var(--ok); }
.ph { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); background: repeating-linear-gradient(135deg, var(--panel-2) 0 8px, #1c1f29 8px 16px); }
.ph.failed { color: var(--bad); }
.ph.timeout { color: var(--warn); }
.sn { position: absolute; left: 6px; bottom: 6px; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 5px; background: rgba(10, 11, 15, 0.75); }
.md { position: absolute; right: 7px; bottom: 9px; width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(10, 11, 15, 0.7); }
.bst { position: absolute; top: 6px; left: 6px; font-size: 11px; color: var(--ok); background: rgba(10, 11, 15, 0.8); border-radius: 5px; padding: 0 6px; }
@media (max-width: 900px) {
  .search { width: 100%; }
  .tools { width: 100%; }
}
</style>
