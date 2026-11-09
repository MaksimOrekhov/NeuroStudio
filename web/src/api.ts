export interface Frame {
  frame: number;
  variant: number;
  model: string;
  summary?: string;
  status: string;
  seed: number;
  promptId?: string;
  image?: string;
  error?: string;
}

export interface Feedback {
  version: 1;
  rating: number | null;
  tags: string[];
  note: string;
  updatedAt: string;
}

export interface Collection {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  status: "running" | "done" | "failed" | "interrupted";
  doneFrames: number;
  frames: Frame[];
  variations: number;
  selections: Record<string, number>;
  feedback: Feedback | null;
  export: ExportStatus;
}

export interface ExportStatus {
  ready: boolean;
  resolved: number;
  message?: string;
}

export interface RunState {
  status: "idle" | "planning" | "generating" | "completed" | "failed";
  theme?: string;
  collectionId?: string;
  title?: string;
  done: number;
  total: number;
  collection: number;
  collections: number;
  variations: number;
  finished: string[];
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
export const startRun = (theme: string, collections: number, variations: number) =>
  json<RunState>("/api/autopilot/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme, collections, variations }),
  });
export const imageUrl = (id: string, file: string, download = false) =>
  `/api/collections/${encodeURIComponent(id)}/images/${file}${download ? "?download=1" : ""}`;
export const selectBest = (id: string, frame: number, variant: number | null) =>
  json<{ selections: Record<string, number>; export: ExportStatus }>(`/api/collections/${encodeURIComponent(id)}/selection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frame, variant }),
  });
export const thumbUrl = (id: string, file: string) => `/api/collections/${encodeURIComponent(id)}/thumbs/${file}`;
export const exportUrl = (id: string) => `/api/collections/${encodeURIComponent(id)}/export`;
export const saveFeedback = (id: string, fb: { rating: number | null; tags: string[]; note: string }) =>
  json<{ feedback: Feedback | null }>(`/api/collections/${encodeURIComponent(id)}/feedback`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fb),
  });
