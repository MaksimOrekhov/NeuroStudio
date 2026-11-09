export interface Frame {
  frame: number;
  model: string;
  summary?: string;
  status: string;
  seed: number;
  promptId?: string;
  image?: string;
  error?: string;
}

export interface Collection {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  status: "running" | "done" | "failed" | "interrupted";
  doneFrames: number;
  frames: Frame[];
}

export interface RunState {
  status: "idle" | "planning" | "generating" | "completed" | "failed";
  theme?: string;
  collectionId?: string;
  title?: string;
  done: number;
  total: number;
  currentFrame?: number;
  error?: string;
}

export interface ApiStatus {
  comfy: { ok: boolean; version?: string; queueRunning?: number; queuePending?: number; error?: string };
  run: RunState;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

export const getStatus = () => json<ApiStatus>("/api/status");
export const getCollections = (limit = 8) => json<Collection[]>(`/api/collections?limit=${limit}`);
export const startRun = (theme: string) =>
  json<RunState>("/api/autopilot/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme }),
  });
export const imageUrl = (id: string, file: string, download = false) =>
  `/api/collections/${encodeURIComponent(id)}/images/${file}${download ? "?download=1" : ""}`;
