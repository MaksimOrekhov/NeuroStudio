import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execArgs, generateBatch } from "../src/codex.ts";
import { CodexSelectionError, effortLabel, loadCatalog, parseCatalog, resolveSelection, type Catalog } from "../src/codexModels.ts";
import { planV3 } from "./fixtures/strictPlan.ts";

const raw = {
  models: [
    { slug: "m-big", display_name: "Big", visibility: "list", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }, { effort: "ultra" }], secret: "x" },
    { slug: "m-small", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
    { slug: "hidden-one", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "bad slug; rm", visibility: "list" },
    null,
  ],
};
const catalog: Catalog = { models: parseCatalog(raw), source: "cache" };

test("catalog parsing: listed models only, display name fallback, real effort ids, no extra fields leaked", () => {
  assert.deepEqual(catalog.models, [
    { id: "m-big", name: "Big", efforts: ["low", "high", "xhigh", "ultra"], defaultEffort: "low" },
    { id: "m-small", name: "m-small", efforts: ["medium", "high"], defaultEffort: "medium" },
  ]);
  assert.equal(effortLabel("xhigh"), "Extra High");
  assert.equal(effortLabel("weird"), "weird");
  assert.throws(() => parseCatalog({}), /no models/);
});

test("catalog loading: cache first, bundled fallback, unavailable/corrupt -> Default with a diagnostic (never throws)", async () => {
  const good = JSON.stringify(raw);
  assert.equal((await loadCatalog({ readCache: async () => good })).source, "cache");
  const viaBundled = await loadCatalog({ readCache: async () => "{ not json", runBundled: async () => good });
  assert.equal(viaBundled.source, "bundled");
  assert.equal(viaBundled.models.length, 2);
  const none = await loadCatalog({ readCache: async () => Promise.reject(new Error("ENOENT")), runBundled: async () => Promise.reject(new Error("no codex")) });
  assert.equal(none.source, "none");
  assert.deepEqual(none.models, []);
  assert.match(none.error!, /unavailable.*ENOENT.*no codex/);
  // reads models_cache.json from a given CODEX_HOME, and nothing else
  const home = await mkdtemp(join(tmpdir(), "ns-codexhome-"));
  await writeFile(join(home, "models_cache.json"), good);
  await writeFile(join(home, "auth.json"), "SECRET");
  assert.equal((await loadCatalog({ codexHome: home })).models.length, 2);
});

test("selection: model/effort compatibility, no silent substitution, nothing verifiable without a catalog", () => {
  assert.deepEqual(resolveSelection(catalog, undefined, undefined), {});
  assert.deepEqual(resolveSelection(catalog, "", null), {});
  assert.deepEqual(resolveSelection(catalog, "m-big", "xhigh"), { model: "m-big", reasoningEffort: "xhigh" });
  assert.deepEqual(resolveSelection(catalog, undefined, "ultra"), { reasoningEffort: "ultra" }); // Default model: any listed effort
  for (const [m, e] of [["nope", undefined], ["m-small", "xhigh"], ["hidden-one", undefined], [5, undefined], ["m-big", 3], [undefined, "extra_high"]] as const) {
    assert.throws(() => resolveSelection(catalog, m, e), CodexSelectionError, `${m}/${e}`);
  }
  const empty: Catalog = { models: [], source: "none", error: "x" };
  assert.throws(() => resolveSelection(empty, "anything", undefined), /unavailable/);
  assert.throws(() => resolveSelection(empty, undefined, "high"), /unavailable/);
  assert.deepEqual(resolveSelection(empty, undefined, undefined), {});
});

test("CLI args: Default adds no overrides; explicit model beats CODEX_MODEL; effort is a -c override; shape otherwise unchanged", () => {
  const base = execArgs("s.json", "o.json", {}, {});
  assert.deepEqual(base, ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--json", "--output-schema", "s.json", "-o", "o.json", "-"]);
  assert.ok(!base.includes("-m") && !base.includes("-c"));
  assert.deepEqual(execArgs("s", "o", {}, { CODEX_MODEL: "env-model" }).slice(0, 3), ["exec", "-m", "env-model"]);
  const a = execArgs("s", "o", { model: "m-big", reasoningEffort: "xhigh" }, { CODEX_MODEL: "env-model" });
  assert.deepEqual(a.slice(0, 5), ["exec", "-m", "m-big", "-c", 'model_reasoning_effort="xhigh"']);
  assert.ok(!a.includes("env-model"));
  assert.deepEqual(execArgs("s", "o", { reasoningEffort: "low" }, {}).slice(0, 3), ["exec", "-c", 'model_reasoning_effort="low"']);
});

test("mock CLI receives the selection once per batch (no retry); without selection no override is passed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ns-mockcli-"));
  const log = join(dir, "args.log");
  const planFile = join(dir, "plan.json");
  await writeFile(planFile, JSON.stringify(planV3("Mock")));
  const script = `
    const fs = require("fs");
    fs.appendFileSync(process.env.NS_LOG, JSON.stringify(process.argv) + "\\n");
    const p = JSON.parse(fs.readFileSync(process.env.NS_PLAN, "utf8"));
    fs.writeFileSync(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ collections: [p] }));
    process.stdin.resume(); process.stdin.on("data", () => {});
  `;
  process.env.NS_LOG = log;
  process.env.NS_PLAN = planFile;
  const launcher = { command: process.execPath, args: ["-e", script, "--"] };
  await generateBatch({ count: 1, launcher, timeoutMs: 10_000, model: "m-big", reasoningEffort: "high" });
  await generateBatch({ count: 1, launcher, timeoutMs: 10_000 });
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.equal(calls.length, 2);
  const i = calls[0].indexOf("exec");
  assert.deepEqual(calls[0].slice(i, i + 5), ["exec", "-m", "m-big", "-c", 'model_reasoning_effort="high"']);
  assert.ok(!calls[1].includes("-c"));
});
