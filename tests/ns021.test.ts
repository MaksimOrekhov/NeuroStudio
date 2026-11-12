import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { io, writeAtomic } from "../src/persistence.ts";
import { buildJobs, runCollection } from "../src/collection.ts";
import { readCollection } from "../server/collections.ts";
import { planV3 } from "./fixtures/strictPlan.ts";
import { deferred, errno, H, png, reliabilityEnv } from "./fixtures/reliability.ts";

const real = { ...io };
const restore = () => Object.assign(io, real);

for (const extension of ["png", "json"]) {
  test(`NS-021: failed second ${extension} write keeps the first image, current prompt_id and pending later frames`, async (t) => {
    const e = await reliabilityEnv(t);
    const dir = join(e.collectionsDir, "failed-write");
    const plan = planV3("Write failure", ["crimson-oath", "crimson-oath", "crimson-oath"]);
    io.writeFile = (async (file, data, ...args) => {
      if (String(file).includes(`scene-02.${extension}.`)) {
        await real.writeFile(file, "partial");
        throw errno("ENOSPC", `${extension} write failed`);
      }
      return real.writeFile(file, data, ...args);
    }) as typeof io.writeFile;
    try {
      await assert.rejects(runCollection({ plan, jobs: buildJobs(plan, e.graph, "test"), dir, client: e.client }), new RegExp(`${extension} write failed`));
    } finally { restore(); }
    const m = JSON.parse(await readFile(join(dir, "collection.json"), "utf8"));
    assert.equal(m.status, "failed");
    assert.deepEqual(m.frames.map((f: any) => f.status), ["done", "failed", "pending"]);
    assert.equal(m.frames[1].promptId, "pid-2");
    assert.match(m.frames[1].error, /ENOSPC/);
    assert.equal(m.frames[2].error, undefined);
    assert.equal(m.frames[2].promptId, undefined);
    assert.equal(m.frames[1].png, undefined);
    assert.deepEqual(e.fake.submits, ["pid-1", "pid-2"]);
    assert.deepEqual(await readFile(join(dir, "scene-01.png")), png);
    assert.equal(JSON.parse(await readFile(join(dir, "scene-01.json"), "utf8")).promptId, "pid-1");
    const c = (await readCollection(e.collectionsDir, "failed-write"))!;
    assert.equal(c.doneFrames, 1);
    assert.deepEqual(c.frames.filter((f) => f.image).map((f) => f.frame), [1]);
    assert.ok(!(await readdir(dir)).some((f) => f.endsWith(".tmp")));
  });
}

test("NS-021: a secondary manifest error cannot mask the original generation error or move it to another job", async (t) => {
  const e = await reliabilityEnv(t);
  const plan = planV3("Original error", ["crimson-oath", "crimson-oath"]);
  let pngFailed = false;
  io.rename = async (a, b) => {
    if (String(b).endsWith("scene-01.png")) { pngFailed = true; throw errno("ENOSPC", "original PNG failure"); }
    if (String(b).endsWith("collection.json") && pngFailed) throw errno("EIO", "secondary status failure");
    return real.rename(a, b);
  };
  try {
    await assert.rejects(runCollection({ plan, jobs: buildJobs(plan, e.graph, "test"), dir: join(e.collectionsDir, "secondary"), client: e.client }), (error: any) => {
      assert.match(error.message, /original PNG failure/);
      assert.equal(error.manifest.frames[0].promptId, "pid-1");
      assert.equal(error.manifest.frames[0].status, "failed");
      assert.equal(error.manifest.frames[1].status, "pending");
      return true;
    });
  } finally { restore(); }
  assert.equal(e.fake.submits.length, 1);
});

test("NS-021: simultaneous atomic writes own unique temporary files", async (t) => {
  const e = await reliabilityEnv(t);
  const target = join(e.root, "atomic.json");
  const paths: string[] = [];
  const both = deferred();
  io.writeFile = (async (file, data, ...args) => {
    paths.push(String(file));
    await real.writeFile(file, data, ...args);
    if (paths.length === 2) both.resolve();
    await both.promise;
  }) as typeof io.writeFile;
  try { await Promise.all([writeAtomic(target, "1"), writeAtomic(target, "2")]); }
  finally { restore(); }
  assert.equal(new Set(paths).size, 2);
  assert.ok(["1", "2"].includes(await readFile(target, "utf8")));
  assert.deepEqual(await readdir(e.root), ["atomic.json"]);
});

test("NS-021: concurrent Best requests preserve different frames; ordered replacement and clearing preserve other choices", async (t) => {
  const e = await reliabilityEnv(t);
  await e.make("best");
  const select = (frame: number, variant: number | null) => e.put("/api/collections/best/selection", { frame, variant });
  const results = await Promise.all([select(1, 1), select(2, 2), select(3, 1)]);
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
  assert.deepEqual((await e.get("/api/collections/best")).selections, { "1": 1, "2": 2, "3": 1 });
  await Promise.all([select(1, 2), select(1, 1), select(2, null)]);
  assert.deepEqual((await e.get("/api/collections/best")).selections, { "1": 1, "3": 1 });
});

for (const kind of ["selection", "feedback"]) {
  test(`NS-021: ${kind} write/rename failures preserve previous bytes, return an error and release the queue`, async (t) => {
    const e = await reliabilityEnv(t);
    const dir = await e.make(kind);
    const url = `/api/collections/${kind}/${kind}`;
    const beforeBody = kind === "selection" ? { frame: 1, variant: 1 } : { rating: 4, note: "before" };
    const afterBody = kind === "selection" ? { frame: 2, variant: 2 } : { rating: 5, note: "after" };
    assert.equal((await e.put(url, beforeBody)).statusCode, 200);
    const filename = kind === "selection" ? "selections.json" : "feedback.json";
    const file = join(dir, filename);
    const before = await readFile(file, "utf8");
    for (const stage of ["write", "rename"]) {
      io.writeFile = (async (f, data, ...args) => {
        if (stage === "write" && String(f).includes(`${filename}.`)) { await real.writeFile(f, "partial"); throw errno("ENOSPC"); }
        return real.writeFile(f, data, ...args);
      }) as typeof io.writeFile;
      io.rename = async (a, b) => {
        if (stage === "rename" && String(b) === file) throw errno("EIO");
        return real.rename(a, b);
      };
      try { assert.equal((await e.put(url, afterBody)).statusCode, 500); }
      finally { restore(); }
      assert.equal(await readFile(file, "utf8"), before);
      assert.ok(!(await readdir(dir)).some((f) => f.endsWith(".tmp")));
    }
    assert.equal((await e.put(url, afterBody)).statusCode, 200);
    assert.notEqual(await readFile(file, "utf8"), before);
  });
}

test("NS-021: concurrent feedback replacements/deletion run in order; old collections need no migration", async (t) => {
  const e = await reliabilityEnv(t);
  const dir = await e.make("legacy");
  const file = join(dir, "collection.json");
  const m = JSON.parse(await readFile(file, "utf8"));
  delete m.frameCount; delete m.variations;
  await writeFile(file, JSON.stringify(m));
  const before = await readFile(file, "utf8");
  const url = "/api/collections/legacy/feedback";
  const results = await Promise.all([{ rating: 3 }, {}, { rating: 5, tags: ["great_outfit"], note: "last" }].map((b) => e.put(url, b)));
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
  const fb = (await e.get("/api/collections/legacy")).feedback;
  assert.deepEqual([fb.version, fb.rating, fb.tags, fb.note], [1, 5, ["great_outfit"], "last"]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("NS-021: feedback deletion ignores only ENOENT and cannot report success on EACCES", async (t) => {
  const e = await reliabilityEnv(t);
  const dir = await e.make("delete");
  const url = "/api/collections/delete/feedback";
  assert.equal((await e.put(url, {})).statusCode, 200);
  await e.put(url, { rating: 5 });
  const before = await readFile(join(dir, "feedback.json"), "utf8");
  io.unlink = async () => { throw errno("EACCES"); };
  try { assert.equal((await e.put(url, {})).statusCode, 500); }
  finally { restore(); }
  assert.equal(await readFile(join(dir, "feedback.json"), "utf8"), before);
  assert.equal((await e.put(url, {})).statusCode, 200);
  await assert.rejects(stat(join(dir, "feedback.json")), { code: "ENOENT" });
});

test("NS-021: corrupt feedback/Best data are never silently replaced or deleted", async (t) => {
  const e = await reliabilityEnv(t);
  const dir = await e.make("corrupt");
  for (const [filename, route, body] of [["feedback.json", "feedback", { rating: 5 }], ["selections.json", "selection", { frame: 1, variant: 1 }]] as const) {
    for (const bad of ["{bad", "null", "[]", '{"rating":"5","1":"1"}', '{"version":2}']) {
      await writeFile(join(dir, filename), bad);
      assert.equal((await e.put(`/api/collections/corrupt/${route}`, body)).statusCode, 400);
      if (route === "feedback") assert.equal((await e.put(`/api/collections/corrupt/${route}`, {})).statusCode, 400);
      assert.equal(await readFile(join(dir, filename), "utf8"), bad);
    }
  }
});

test("NS-021: snapshot failure is failed in status AND persisted history, with no planning or submit", async (t) => {
  const e = await reliabilityEnv(t);
  io.rename = async (a, b) => {
    if (String(b).endsWith("preference-context.json")) throw errno("ENOSPC", "snapshot failed");
    return real.rename(a, b);
  };
  try {
    assert.equal((await e.app.inject({ method: "POST", url: "/api/autopilot/start", headers: H, payload: { promptEvolution: true } })).statusCode, 202);
    await e.settle();
  } finally { restore(); }
  const status = (await e.get("/api/status")).run;
  const [history] = await e.get("/api/runs");
  assert.equal(status.status, "failed");
  assert.equal(history.status, "failed");
  assert.equal(history.error, status.error);
  assert.match(history.error, /snapshot failed/);
  assert.equal(history.errorCode, status.errorCode);
  assert.equal(e.fake.plans.length, 0);
  assert.equal(e.fake.submits.length, 0);
});

test("NS-021: a secondary run-status write failure preserves the original planning error and previous complete batch file", async (t) => {
  const e = await reliabilityEnv(t);
  e.fake.planError = new Error("original planning failure");
  io.rename = async (a, b) => {
    if (String(b).endsWith("batch-plan.json") && e.fake.plans.length) throw errno("EIO", "secondary history failure");
    return real.rename(a, b);
  };
  try { await e.runner.start(undefined); await e.settle(); }
  finally { restore(); }
  assert.equal(e.runner.state.status, "failed");
  assert.equal(e.runner.state.error, "original planning failure");
  const [id] = await readdir(e.batchesDir);
  assert.equal(JSON.parse(await readFile(join(e.batchesDir, id, "batch-plan.json"), "utf8")).status, "running");
  assert.ok(!(await readdir(join(e.batchesDir, id))).some((f) => f.endsWith(".tmp")));
  assert.equal(e.fake.plans.length, 1);
  assert.equal(e.fake.submits.length, 0);
});

test("NS-021: a snapshot is required even with Evolution off; failure still records the failed run", async (t) => {
  const e = await reliabilityEnv(t);
  io.rename = async (a, b) => {
    if (String(b).endsWith("preference-context.json")) throw errno("EIO", "disabled snapshot failure");
    return real.rename(a, b);
  };
  try { await e.runner.start(undefined); await e.settle(); }
  finally { restore(); }
  const [run] = await e.get("/api/runs");
  assert.equal(run.status, "failed");
  assert.match(run.error, /disabled snapshot failure/);
  assert.equal(e.fake.plans.length, 0);
});

test("NS-021: failure saving a validated plan is persisted as failed before any GPU work", async (t) => {
  const e = await reliabilityEnv(t);
  let failed = false;
  io.rename = async (a, b) => {
    if (!failed && String(b).endsWith("batch-plan.json") && e.fake.plans.length) {
      failed = true;
      throw errno("EIO", "cannot store validated plan");
    }
    return real.rename(a, b);
  };
  try { await e.runner.start(undefined); await e.settle(); }
  finally { restore(); }
  const [run] = await e.get("/api/runs");
  assert.equal(run.status, "failed");
  assert.equal(run.error, e.runner.state.error);
  assert.match(run.error, /cannot store validated plan/);
  assert.equal(e.fake.plans.length, 1);
  assert.equal(e.fake.submits.length, 0);
});
