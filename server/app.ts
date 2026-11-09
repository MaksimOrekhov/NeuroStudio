import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { ComfyClient } from "../src/comfy.ts";
import { SelectionError, listCollections, readCollection, safeImagePath, setSelection } from "./collections.ts";
import { ExportError, planExport, zipStream } from "./export.ts";
import { parseCount, parseVariations } from "../src/promptPlan.ts";
import { RunError, type AutopilotRunner } from "./runner.ts";

export interface AppDeps {
  runner: AutopilotRunner;
  collectionsDir: string;
  comfyUrl: string;
  port: number;
  webDist?: string;
  /** For tests */
  statusClient?: Pick<ComfyClient, "systemStats" | "queue">;
}

export function buildApp(d: AppDeps) {
  const app = Fastify({ logger: false });
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

  app.post("/api/autopilot/start", async (req, reply) => {
    const body = (req.body ?? {}) as { theme?: unknown; collections?: unknown; variations?: unknown };
    let count: number;
    let variations: number;
    try {
      count = parseCount(body.collections);
      variations = parseVariations(body.variations);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const theme = typeof body.theme === "string" ? body.theme.trim().slice(0, 200) : "";
    try {
      return reply.code(202).send(await d.runner.start(theme || undefined, count, variations));
    } catch (e) {
      if (e instanceof RunError) return reply.code(e.httpStatus).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  const activeId = () => (d.runner.active ? d.runner.state.collectionId : undefined);

  app.get("/api/collections", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit) || 20, 50);
    return listCollections(d.collectionsDir, limit, activeId());
  });

  app.get("/api/collections/:id", async (req, reply) => {
    const c = await readCollection(d.collectionsDir, (req.params as { id: string }).id, activeId());
    return c ?? reply.code(404).send({ error: "collection not found" });
  });

  app.get("/api/collections/:id/export", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const c = await readCollection(d.collectionsDir, id, activeId());
    if (!c) return reply.code(404).send({ error: "collection not found" });
    try {
      const files = await planExport(d.collectionsDir, c);
      reply.type("application/zip").header("content-disposition", `attachment; filename="${basename(id)}-selected.zip"`);
      return reply.send(zipStream(files));
    } catch (e) {
      if (e instanceof ExportError) return reply.code(e.httpStatus).send({ error: e.message });
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
      if (e instanceof SelectionError) return reply.code(e.message === "collection not found" ? 404 : 400).send({ error: e.message });
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

  if (d.webDist) void app.register(fastifyStatic, { root: resolve(d.webDist) });
  return app;
}
