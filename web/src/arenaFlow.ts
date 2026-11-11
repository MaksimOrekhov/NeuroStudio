// The Arena's screen logic (NS-019), separate from the Vue template so it can be tested: which pair is shown, what the buttons and
// keys may do while a verdict is being saved, and what happens after a failed save.
import { computed, reactive, ref } from "vue";
import { donePairs, openPairs, pairKey, statsOf } from "./arena";
import { arena, closeArena, loadArena, submitComparison } from "./store";

export function createArenaFlow(opts: { id: string; frame: number; variants: () => number[] }) {
  const { id, frame } = opts;
  const open = computed(() => openPairs(opts.variants(), frame, arena.history));
  const done = computed(() => donePairs(opts.variants(), frame, arena.history));
  const stats = computed(() => statsOf(opts.variants(), frame, arena.history));

  /** The pair on screen (a < b), whether the images are shown swapped, and the pairs skipped in this session (they stay open). */
  const current = ref<[number, number] | null>(null);
  const swapped = ref(false);
  const skipped = reactive(new Set<string>());
  const editing = ref(false);

  const left = computed(() => (current.value ? current.value[swapped.value ? 1 : 0] : 0));
  const right = computed(() => (current.value ? current.value[swapped.value ? 0 : 1] : 0));
  const existing = computed(() => (current.value ? arena.history[pairKey(frame, current.value[0], current.value[1])] : undefined));
  const skippedLeft = computed(() => open.value.filter(([a, b]) => skipped.has(pairKey(frame, a, b))).length);

  function show(pair: [number, number] | null) {
    current.value = pair;
    swapped.value = Math.random() < 0.5; // the side carries no meaning: the winner is stored by variant number
  }
  /** Next open pair that was not skipped in this session; null = nothing left to offer. */
  function advance() {
    editing.value = false;
    show(open.value.find(([a, b]) => !skipped.has(pairKey(frame, a, b))) ?? null);
  }

  /** One rule for buttons AND keys: while a verdict is being saved (or the history is loading) the current pair cannot change. */
  const locked = () => arena.saving || arena.loading;

  async function start() {
    await loadArena(id);
    if (!arena.error) advance();
  }
  function dispose() {
    closeArena();
  }

  /** Saves the verdict for the pair on screen. On failure the pair stays on screen so the user can repeat it. */
  async function choose(winner: number | null): Promise<boolean> {
    const p = current.value;
    if (!p || locked()) return false;
    const ok = await submitComparison(id, frame, p[0], p[1], winner);
    if (ok && current.value === p) advance();
    return ok;
  }
  function skip() {
    const p = current.value;
    if (!p || locked()) return;
    if (!existing.value) skipped.add(pairKey(frame, p[0], p[1])); // nothing is saved
    advance();
  }
  function reopen(a: number, b: number) {
    if (locked()) return;
    editing.value = true;
    show([a, b]);
  }
  function retrySkipped() {
    if (locked()) return;
    skipped.clear();
    advance();
  }
  /** Keyboard shortcuts (Escape is handled by the caller). Same restrictions as the buttons. */
  function onKey(key: string, code: string) {
    if (!current.value || locked()) return;
    if (key === "ArrowLeft") void choose(left.value);
    else if (key === "ArrowRight") void choose(right.value);
    else if (key === "ArrowDown") void choose(null);
    else if (code === "KeyS") skip();
  }

  return { open, done, stats, current, swapped, skipped, editing, left, right, existing, skippedLeft, advance, start, dispose, choose, skip, reopen, retrySkipped, onKey };
}
