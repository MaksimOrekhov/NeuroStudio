import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { ComfyClient } from "../src/comfy.ts";
import { FeedbackError, ImageFeedbackError, ImageFeedbackFileError, SelectionError, setImageFeedback, listCollections, readCollection, safeImagePath, setFeedback, setSelection } from "./collections.ts";
import { ExportError, planExport, zipStream } from "./export.ts";
import { getThumbnail } from "./thumbs.ts";
import { parseComposition } from "../src/composition.ts";
import { loadCatalog, resolveSelection, CodexSelectionError, effortLabel, type Catalog } from "../src/codexModels.ts";
import { parseCount, parseFrames, parseVariations } from "../src/promptPlan.ts";
import { resolveImageModels } from "../src/imageModels.ts";
import type { ErrorCode } from "../src/errors.ts";
import { ComparisonError, readComparisons, setComparison } from "./comparisons.ts";
import { listRuns } from "./runs.ts";
import { RunError, type AutopilotRunner } from "./runner.ts";
import { RegenError, frameCountOf, loadSource, parseFrame, parseVariant } from "../src/regenerate.ts";

export interface AppDeps {
  runner: AutopilotRunner;
  collectionsDir: string;
  /** output/batches: source of GET /api/runs (default: ../batches next to the collections folder). */
  batchesDir?: string;
  comfyUrl: string;
  port: number;
  webDist?: string;
  /** Thumbnail cache (default: ../thumbs next to the collections folder, inside output/). */
  thumbsDir?: string;
  /** Local Codex model catalog (default: read from the installed Codex CLI). For tests. */
  loadCatalog?: () => Promise<Catalog>;
  /** For tests */
  statusClient?: Pick<ComfyClient, "systemStats" | "queue">;
}

export function buildApp(d: AppDeps) {
  const app = Fastify({ logger: false });
  const thumbsDir = d.thumbsDir ?? join(dirname(resolve(d.collectionsDir)), "thumbs");
  const catalog = d.loadCatalog ?? (() => loadCatalog());
  const batchesDir = d.batchesDir ?? join(dirname(resolve(d.collectionsDir)), "batches");
  const status = d.statusClient ?? new ComfyClient(d.comfyUrl, fetch, 2000);
  const allowedHosts = new Set([`127.0.0.1:${d.port}`, `localhost:${d.port}`, "127.0.0.1:5173", "localhost:5173"]);

  // Local-only hardening: block DNS rebinding (Host header) and cross-site POSTs (Origin header).
  app.addHook("onRequest", async (req, reply) => {
    if (!allowedHosts.has(String(req.headers.host))) return reply.code(403).send({ error: "forbidden host" });
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
      return reply.code(403).send({ error: "forbidden origin" });
    }
  });

  app.get("/api/status", async () => {
    let comfy: Record<string, unknown>;
    try {
      const [s, q] = await Promise.all([status.systemStats(), status.queue()]);
      comfy = { ok: true, version: s.system.comfyui_version, queueRunning: q.queue_running.length, queuePending: q.queue_pending.length };
    } catch (e) {
      comfy = { ok: false, error: (e as Error).message };
    }
    return { comfy, run: d.runner.state };
  });

  /** Error body: `error` = technical message (unchanged), `code` = stable machine code (src/errors.ts). */
  const fail = (reply: FastifyReply, status: number, code: ErrorCode, error: string) => reply.code(status).send({ error, code });

  app.post("/api/autopilot/start", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let count: number;
    let frames: number;
    let variations: number;
    let images: ReturnType<typeof resolveImageModels>;
    let composition: ReturnType<typeof parseComposition>;
    let codex: ReturnType<typeof resolveSelection>;
    // Everything is validated here, before ComfyUI is contacted and before Codex is started.
    try {
      count = parseCount(body.collections);
      frames = parseFrames(body.frames);
      variations = parseVariations(body.variations);
      images = resolveImageModels(body.imageModels, frames);
      composition = parseComposition(body.composition, frames);
      codex = body.codexModel == null && body.codexReasoningEffort == null ? {} : resolveSelection(await catalog(), body.codexModel, body.codexReasoningEffort); // old calls never touch the catalog
    } catch (e) {
      return fail(reply, 400, "INVALID_GENERATION_SETTINGS", (e as Error).message);
    }
    const theme = typeof body.theme === "string" ? body.theme.trim().slice(0, 200) : "";
    try {
      return reply.code(202).send(await d.runner.start(theme || undefined, count, variations, composition, codex, images));
    } catch (e) {
      if (e instanceof RunError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  app.get("/api/codex/models", async () => {
    const c = await catalog();
    return { source: c.source, error: c.error, models: c.models.map((m) => ({ ...m, efforts: m.efforts.map((id) => ({ id, label: effortLabel(id) })) })) };
  });

  app.get("/api/runs", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 20, 50);
    return listRuns(batchesDir, limit, d.runner.active ? d.runner.state.runId : undefined);
  });

  const activeId = () => (d.runner.active ? d.runner.state.collectionId : undefined);

  app.get("/api/collections", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 20, 50);
    return listCollections(d.collectionsDir, limit, activeId());
  });

  app.get("/api/collections/:id", async (req, reply) => {
    const c = await readCollection(d.collectionsDir, (req.params as { id: string }).id, activeId());
    return c ?? fail(reply, 404, "COLLECTION_NOT_FOUND", "collection not found");
  });

  app.get("/api/collections/:id/export", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const c = await readCollection(d.collectionsDir, id, activeId());
    if (!c) return fail(reply, 404, "COLLECTION_NOT_FOUND", "collection not found");
    try {
      const files = await planExport(d.collectionsDir, c);
      reply.type("application/zip").header("content-disposition", `attachment; filename="${basename(id)}-selected.zip"`);
      return reply.send(zipStream(files));
    } catch (e) {
      if (e instanceof ExportError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  /** The positive prompt a variant was actually generated with, and whether it can be regenerated. Reads only saved files of that collection. */
  app.get("/api/collections/:id/frames/:frame/variants/:variant/prompt", async (req, reply) => {
    const p = req.params as { id: string; frame: string; variant: string };
    try {
      const frame = parseFrame(p.frame, await frameCountOf(d.collectionsDir, p.id));
      const variant = parseVariant(p.variant);
      try {
        const s = await loadSource(d.collectionsDir, p.id, frame, variant);
        return { frame, variant, model: s.model, positive: s.positive, promptEdited: s.promptEdited, available: true };
      } catch (e) {
        if (e instanceof RegenError && e.code === "SOURCE_UNAVAILABLE") return { frame, variant, available: false, code: e.code, reason: e.message };
        throw e;
      }
    } catch (e) {
      if (e instanceof RegenError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  /** Creates ONE new variant of one frame (no Codex). 202 = accepted and running in the background; 409 ALREADY_RUNNING while anything else runs. */
  app.post("/api/collections/:id/frames/:frame/regenerate", async (req, reply) => {
    const p = req.params as { id: string; frame: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const state = await d.runner.startRegeneration({ collectionId: p.id, frame: p.frame, sourceVariant: body.sourceVariant, positive: body.positive });
      return reply.code(202).send(state);
    } catch (e) {
      if (e instanceof RunError || e instanceof RegenError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  app.put("/api/collections/:id/selection", async (req, reply) => {
    const { frame, variant } = (req.body ?? {}) as { frame?: unknown; variant?: unknown };
    try {
      const id = (req.params as { id: string }).id;
      const selections = await setSelection(d.collectionsDir, id, frame, variant);
      return { selections, export: (await readCollection(d.collectionsDir, id, activeId()))?.export };
    } catch (e) {
      if (e instanceof SelectionError) return e.message === "collection not found" ? fail(reply, 404, "COLLECTION_NOT_FOUND", e.message) : fail(reply, 400, "INVALID_REQUEST", e.message);
      throw e;
    }
  });

  /** NS-018: quality verdict + reasons for one image. { verdict: "like"|"dislike"|null, tags?: string[] }; null removes it. */
  app.put("/api/collections/:id/frames/:frame/variants/:variant/feedback", async (req, reply) => {
    const p = req.params as { id: string; frame: string; variant: string };
    const num = (s: string) => (/^\d{1,3}$/.test(s) ? Number(s) : NaN);
    try {
      return { frame: num(p.frame), variant: num(p.variant), feedback: await setImageFeedback(d.collectionsDir, p.id, num(p.frame), num(p.variant), req.body ?? {}) };
    } catch (e) {
      if (e instanceof ImageFeedbackFileError) return fail(reply, 409, "FEEDBACK_FILE_UNREADABLE", e.message);
      if (e instanceof ImageFeedbackError) return e.message === "collection not found" ? fail(reply, 404, "COLLECTION_NOT_FOUND", e.message) : fail(reply, 400, "INVALID_REQUEST", e.message);
      throw e;
    }
  });

  app.get("/api/collections/:id/image-feedback", async (req, reply) => {
    const c = await readCollection(d.collectionsDir, (req.params as { id: string }).id, activeId());
    return c ? { images: c.imageFeedback } : fail(reply, 404, "COLLECTION_NOT_FOUND", "collection not found");
  });

  /** NS-019 Image Arena: pairwise verdicts between variants of one frame. */
  app.get("/api/collections/:id/comparisons", async (req, reply) => {
    try {
      return { comparisons: await readComparisons(d.collectionsDir, (req.params as { id: string }).id) };
    } catch (e) {
      if (e instanceof ComparisonError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  app.put("/api/collections/:id/frames/:frame/comparisons", async (req, reply) => {
    const p = req.params as { id: string; frame: string };
    try {
      return { comparison: await setComparison(d.collectionsDir, p.id, /^\d{1,3}$/.test(p.frame) ? Number(p.frame) : NaN, req.body ?? {}) };
    } catch (e) {
      if (e instanceof ComparisonError) return fail(reply, e.httpStatus, e.code, e.message);
      throw e;
    }
  });

  app.put("/api/collections/:id/feedback", async (req, reply) => {
    try {
      return { feedback: await setFeedback(d.collectionsDir, (req.params as { id: string }).id, req.body ?? {}) };
    } catch (e) {
      if (e instanceof FeedbackError) return e.message === "collection not found" ? fail(reply, 404, "COLLECTION_NOT_FOUND", e.message) : fail(reply, 400, "INVALID_REQUEST", e.message);
      throw e;
    }
  });

  app.get("/api/collections/:id/images/:file", async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const p = safeImagePath(d.collectionsDir, id, file);
    if (!p) return reply.code(404).send({ error: "not found" });
    try {
      await stat(p);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    reply.type("image/png").header("cache-control", "private, max-age=3600");
    if ((req.query as { download?: string }).download) {
      reply.header("content-disposition", `attachment; filename="${basename(id)}-${file}"`);
    }
    return reply.send(createReadStream(p));
  });

  app.get("/api/collections/:id/thumbs/:file", async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const p = safeImagePath(d.collectionsDir, id, file);
    if (!p) return reply.code(404).send({ error: "not found" });
    try {
      await stat(p);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      reply.type("image/webp").header("cache-control", "private, max-age=3600");
      return reply.send(createReadStream(await getThumbnail(thumbsDir, id, p)));
    } catch {
      // Thumbnail failed: serve the untouched original instead.
      reply.type("image/png").header("x-thumbnail", "fallback");
      return reply.send(createReadStream(p));
    }
  });

  if (d.webDist) void app.register(fastifyStatic, { root: resolve(d.webDist) });
  return app;
}
