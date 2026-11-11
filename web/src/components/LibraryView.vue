<script setup lang="ts">
import { computed, ref } from "vue";
import type { Collection } from "../api";
import { badgeOf, exportInfo, finalOf, hasIssues, needsSelection, scenesOf, titleOf, variantsLine } from "../lib";
import { modelById } from "../models";
import { COLLECTIONS_LIMIT } from "../api";
import { dateRu, nPlural, ofImages, W } from "../ru";
import { app, currentCollection, go, ui } from "../store";
import ErrorNote from "./ErrorNote.vue";
import CollectionDetail from "./CollectionDetail.vue";
import Thumb from "./Thumb.vue";

type Filter = "all" | "select" | "done" | "issues";
const filter = ref<Filter>("all");
const query = ref("");

const filters = computed(() => [
  { id: "all" as Filter, label: "Все", n: app.collections.length },
  { id: "select" as Filter, label: "Требуется выбор", n: app.collections.filter(needsSelection).length },
  { id: "done" as Filter, label: "Готово к экспорту", n: app.collections.filter((c) => c.export.ready).length },
  { id: "issues" as Filter, label: "С проблемами", n: app.collections.filter(hasIssues).length },
]);
const shown = computed(() =>
  app.collections.filter((c) => {
    if (query.value.trim() && ![c.titleRu, c.title].some((t) => t?.toLowerCase().includes(query.value.trim().toLowerCase()))) return false;
    if (filter.value === "select") return needsSelection(c);
    if (filter.value === "done") return c.export.ready;
    if (filter.value === "issues") return hasIssues(c);
    return true;
  }),
);
const open = computed(() => currentCollection.value);
const capped = computed(() => app.collections.length >= COLLECTIONS_LIMIT);

/** Thumbnail per scene: the final image, else the first finished variant, else the first variant (its state is shown). */
function cover(c: Collection) {
  return scenesOf(c).map((s) => ({ s, f: finalOf(c, s) ?? s.variants.find((v) => v.image) ?? s.variants[0], best: c.selections[String(s.frame)] !== undefined }));
}
const stateText = (status: string | undefined, running: boolean) =>
  status === "pending" ? (running ? "В очереди" : "Не создано") : status === "submitted" ? (running ? "Генерируется" : "Неизвестно") : status === "timeout" ? "Неизвестно" : "Ошибка";
</script>

<template>
  <CollectionDetail v-if="open" :c="open" />
  <div v-else-if="ui.openCollection" class="lib"><button class="btn ghost sm" @click="go('library')">← Библиотека</button><p class="muted">Коллекция загружается или не найдена.</p></div>
  <div v-else class="lib">
    <div class="toolbar">
      <div>
        <h1>Библиотека</h1>
        <p class="muted small">{{ nPlural(app.collections.length, W.collection) }} · сначала новые<template v-if="capped"> · показаны последние {{ COLLECTIONS_LIMIT }}, более ранние не отображаются</template></p>
      </div>
      <div class="tools">
        <input v-model="query" class="input search" type="search" placeholder="Поиск по названию" aria-label="Поиск по названию коллекции" />
        <div class="seg" role="radiogroup" aria-label="Фильтр коллекций">
          <button v-for="f in filters" :key="f.id" role="radio" :aria-checked="filter === f.id" :class="{ on: filter === f.id }" @click="filter = f.id">
            {{ f.label }} <span class="n">{{ f.n }}</span>
          </button>
        </div>
      </div>
    </div>

    <ErrorNote :error="app.collectionsError" />

    <div v-if="!shown.length && app.collectionsLoaded" class="empty card">
      <p v-if="!app.collections.length">Коллекций пока нет.</p>
      <p v-else>Нет коллекций, подходящих под фильтр.</p>
      <button v-if="!app.collections.length" class="btn primary" @click="go('create')">Создать коллекцию</button>
      <button v-else class="btn" @click="(filter = 'all'), (query = '')">Показать все</button>
    </div>

    <div class="rows">
      <button v-for="c in shown" :key="c.id" class="row card" :class="{ running: c.status === 'running' }" :aria-label="`Открыть коллекцию «${titleOf(c)}»`" @click="go('library', c.id)">
        <div class="info">
          <div class="t">
            <h3>{{ titleOf(c) }}</h3>
            <span class="badge" :class="badgeOf(c).cls"><span v-if="c.status === 'running'" class="spinner" />{{ badgeOf(c).text }}</span>
          </div>
          <div class="chips">
            <span class="muted small">{{ dateRu(c.createdAt) }}</span>
            <span class="chip">{{ nPlural(c.frameCount, W.frame) }}</span>
            <span v-if="variantsLine(c)" class="chip">{{ variantsLine(c) }}</span>
            <span v-if="c.feedback?.rating" class="chip stars" :title="`Оценка ${c.feedback.rating} из 5`">{{ "★".repeat(c.feedback.rating) }}</span>
          </div>
        </div>
        <div class="strip">
          <div v-for="{ s, f, best } in cover(c)" :key="s.frame" class="th" :class="{ best }">
            <Thumb v-if="f?.image" :id="c.id" :file="f.image" :alt="`Кадр ${s.frame}`" />
            <div v-else class="ph" :class="f?.status">
              <span v-if="f?.status === 'submitted' && c.status === 'running'" class="spinner" />
              <span>{{ stateText(f?.status, c.status === "running") }}</span>
            </div>
            <span class="sn">{{ s.frame }}</span>
            <span class="md" :style="{ background: modelById(s.model)?.color }" :title="modelById(s.model)?.name" />
            <span v-if="best" class="bst" title="Выбран лучшим">★</span>
          </div>
        </div>
        <div class="exp">
          <template v-if="c.status === 'running'"><span class="muted">Идёт генерация…</span></template>
          <template v-else-if="c.export.ready"><span class="okline">✓ Выбрано для экспорта: {{ c.export.resolved }}</span></template>
          <template v-else-if="c.status === 'done'">
            <span class="muted">{{ exportInfo(c).message }}</span>
          </template>
          <template v-else><span class="muted">Сохранено {{ c.doneFrames }} из {{ ofImages(c.frames.length) }}</span></template>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.lib { display: flex; flex-direction: column; gap: 20px; }
.toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 24px; }
.tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search { width: 260px; }
.n { font-size: 11px; opacity: 0.7; margin-left: 2px; }
.empty { padding: 40px; display: flex; flex-direction: column; align-items: center; gap: 12px; color: var(--text-2); }
/* 2560 px → 4 columns, 1920 px → 3 columns. */
.rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(470px, 1fr)); gap: 16px; }
.row { display: flex; flex-direction: column; gap: 12px; padding: 16px; text-align: left; transition: border-color 0.15s, background 0.15s; min-width: 0; }
.row:hover { border-color: var(--line-2); background: #151821; }
.row:hover h3 { color: #fff; }
.row.running { border-color: rgba(124, 108, 255, 0.4); }
.info { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.t { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
h3 { font-size: 17px; overflow-wrap: anywhere; }
.chips { display: flex; gap: 6px 8px; flex-wrap: wrap; align-items: center; }
.stars { color: #f5b942; letter-spacing: 1px; }
.exp { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-2); min-height: 22px; }
.okline { color: var(--ok); }
.bar.mini { display: block; width: 90px; height: 4px; border-radius: 99px; background: var(--panel-3); overflow: hidden; }
.bar.mini span { display: block; height: 100%; background: var(--accent-2); }
.strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.th { position: relative; aspect-ratio: 2 / 3; border-radius: 9px; overflow: hidden; background: var(--panel-2); border: 1px solid var(--line); }
.th.best { border-color: var(--ok); }
.ph { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; font-size: 12px; color: var(--muted); text-align: center; padding: 4px; background: repeating-linear-gradient(135deg, var(--panel-2) 0 8px, #1c1f29 8px 16px); }
.ph.failed { color: var(--bad); }
.ph.timeout { color: var(--warn); }
.sn { position: absolute; left: 6px; bottom: 6px; font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 5px; background: rgba(10, 11, 15, 0.75); }
.md { position: absolute; right: 7px; bottom: 9px; width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 2px rgba(10, 11, 15, 0.7); }
.bst { position: absolute; top: 6px; left: 6px; font-size: 11px; color: var(--ok); background: rgba(10, 11, 15, 0.8); border-radius: 5px; padding: 0 6px; }
</style>
