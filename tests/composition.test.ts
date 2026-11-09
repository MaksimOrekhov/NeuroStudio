import { test } from "node:test";
import assert from "node:assert/strict";
import { CompositionError, COMPOSITION_FIELDS, COMPOSITION_OPTIONS, compositionPrompt, parseComposition, resolveComposition } from "../src/composition.ts";
import { planPrompt } from "../src/codex.ts";
import { BANNED } from "../src/promptPlan.ts";

test("resolution: scene value > scene Auto > Inherit Global > global Auto", () => {
  const r = resolveComposition({
    global: { pose: "walking", framing: "full_body", viewpoint: "eye_level" },
    scenes: [
      { framing: "waist_up" }, // explicit value beats global; pose/viewpoint inherit
      { pose: "auto", viewpoint: "inherit" }, // explicit Auto cancels global pose; viewpoint inherits
      {},
      { pose: "auto", orientation: "auto", framing: "auto", viewpoint: "auto" }, // fully free
    ],
  });
  assert.deepEqual(r[0], { pose: "walking", framing: "waist_up", viewpoint: "eye_level" });
  assert.deepEqual(r[1], { framing: "full_body", viewpoint: "eye_level" });
  assert.deepEqual(r[2], { pose: "walking", framing: "full_body", viewpoint: "eye_level" });
  assert.deepEqual(r[3], {});
});

test("nothing configured: no composition block, request identical to the old one", () => {
  for (const c of [undefined, {}, { global: { pose: "auto" }, scenes: [{}, { framing: "inherit" }] }]) assert.equal(compositionPrompt(c), "");
  assert.equal(planPrompt("I", "t", [], 3, {}), planPrompt("I", "t", [], 3));
});

test("Codex request lists only resolved, non-Auto settings; free scene is stated; no banned words in our wording", () => {
  const c = {
    global: { orientation: "front_three_quarter_view" },
    scenes: [{ pose: "standing_naturally", framing: "waist_up", viewpoint: "eye_level" }, { pose: "slightly_bending_forward", orientation: "rear_three_quarter_view" }, { pose: "sitting_on_a_chair", orientation: "auto" }, { orientation: "auto" }],
  };
  const p = planPrompt("INSTR", undefined, [], 3, c);
  assert.ok(p.startsWith("INSTR"));
  assert.match(p, /Scene 01:\n- Pose: standing naturally\n- Body orientation: front three-quarter view\n- Shot size: waist-up\n- View height and direction: eye level/);
  assert.match(p, /Scene 02:\n- Pose: slightly bending forward\n- Body orientation: rear three-quarter view\n(?!- )/);
  assert.match(p, /Scene 03:\n- Pose: sitting on a chair\n\nScene 04:\n- Artistic direction is up to you\./);
  assert.match(p, /EVERY collection/);
  // the only mentions of the banned words are the explicit prohibitions
  const block = compositionPrompt(c);
  assert.equal(block.match(/camera|framing/gi)?.length, 2);
  assert.doesNotMatch(block.replace(/never use the words "camera" or "framing"/, ""), /camera|framing/i);
});

test("validation: unknown keys/values and wrong types throw; inherit is not allowed globally", () => {
  const bad: unknown[] = [
    "x", [], { foo: 1 }, { global: { pose: "flying" } }, { global: { pose: "inherit" } }, { global: { colour: "auto" } }, { global: { pose: 5 } },
    { scenes: "x" }, { scenes: [{}, {}, {}, {}, {}] }, { scenes: [{ framing: "waist-up" }] }, { scenes: [null] }, { scenes: [{ pose: "camera" }] },
  ];
  for (const b of bad) assert.throws(() => parseComposition(b), CompositionError, JSON.stringify(b));
  assert.equal(parseComposition(undefined), undefined);
  assert.deepEqual(parseComposition({ global: { pose: "auto" }, scenes: [{ pose: "inherit", framing: "knee_up" }] }), { global: { pose: "auto" }, scenes: [{ pose: "inherit", framing: "knee_up" }] });
});

test("catalog: no duplicate ids, no banned words in any label, every field has options", () => {
  for (const f of COMPOSITION_FIELDS) {
    const ids = COMPOSITION_OPTIONS[f].map((x) => x.id);
    assert.ok(ids.length > 5);
    assert.equal(new Set(ids).size, ids.length);
    for (const x of COMPOSITION_OPTIONS[f]) for (const w of BANNED) assert.ok(!x.label.toLowerCase().includes(w), `${x.label} / ${w}`);
  }
});
