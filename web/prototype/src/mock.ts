// NS-013 prototype: mock collections, runs and Codex catalog. Nothing here talks to the server.
import type { Feedback, Frame } from "../../src/api";
import type { Settings } from "../../../src/composition";
import { pad2, type ProtoCollection } from "./library";
import { autoMix } from "./models";

type FrameState = Frame["status"];

interface Spec {
  id: string;
  title: string;
  description: string;
  daysAgo: number;
  hue: number;
  frames: number;
  variations: number;
  models?: string[];
  summaries: string[];
  status: ProtoCollection["status"];
  /** Per variant state in generation order (scene by scene); default "done". */
  states?: FrameState[];
  selections?: Record<string, number>;
  feedback?: Partial<Feedback>;
  theme?: string | null;
  codex?: [string | null, string | null];
  composition?: Settings[];
  error?: string;
}

let seedCounter = 418_207_331;
const nextSeed = () => (seedCounter = (seedCounter * 48_271) % 2_147_483_647);

export function makeCollection(s: Spec): ProtoCollection {
  const models = s.models ?? autoMix(s.frames);
  const frames: Frame[] = [];
  let k = 0;
  for (let f = 1; f <= s.frames; f++) {
    for (let v = 1; v <= s.variations; v++) {
      const status = s.states?.[k++] ?? "done";
      const file = s.variations === 1 ? `scene-${pad2(f)}` : `scene-${pad2(f)}-v${pad2(v)}`;
      frames.push({
        frame: f,
        variant: v,
        model: models[f - 1],
        summary: s.summaries[f - 1],
        status,
        seed: nextSeed(),
        promptId: status === "pending" ? undefined : `${s.id.slice(0, 4)}${pad2(f)}${pad2(v)}-7c1e-4b9a-a3f0-${(nextSeed() % 1e12).toString(16).padStart(12, "0")}`,
        image: status === "done" ? `${file}.png` : undefined,
        error: status === "failed" ? s.error : undefined,
      });
    }
  }
  const created = new Date(Date.UTC(2026, 10, 10, 9, 30) - s.daysAgo * 86_400_000);
  const fb = s.feedback;
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    createdAt: created.toISOString(),
    status: s.status,
    doneFrames: frames.filter((f) => f.status === "done").length,
    frames,
    variations: s.variations,
    selections: s.selections ?? {},
    feedback: fb ? { version: 1, rating: fb.rating ?? null, tags: fb.tags ?? [], note: fb.note ?? "", updatedAt: created.toISOString() } : null,
    export: { ready: false, resolved: 0 },
    frameCount: s.frames,
    hue: s.hue,
    meta: {
      theme: s.theme ?? null,
      codexModel: s.codex?.[0] ?? null,
      codexEffort: s.codex?.[1] ?? null,
      codexSeconds: 74 + (s.hue % 40),
      comfySeconds: frames.filter((f) => f.status === "done").length * 38,
      composition: s.composition ?? Array.from({ length: s.frames }, () => ({})),
    },
  };
}

export function mockCollections(): ProtoCollection[] {
  return [
    makeCollection({
      id: "2026-11-10-lemon-grove-siesta",
      title: "Lemon Grove Siesta",
      description: "A slow Mediterranean afternoon between citrus trees, linen and sun-warmed stone.",
      daysAgo: 0,
      hue: 42,
      frames: 4,
      variations: 2,
      summaries: [
        "Walking between rows of lemon trees, basket on her arm, seen from eye level.",
        "Sitting on a low stone wall, turning towards the light, waist-up.",
        "Reclining on a striped blanket in dappled shade, seen slightly from above.",
        "Leaning on a wooden gate at the end of the grove, full body, warm backlight.",
      ],
      status: "done",
      selections: { "1": 2, "3": 1 },
      feedback: { rating: 4, tags: ["beautiful_lighting", "original_concept"] },
      theme: "summer citrus orchard",
      codex: ["codex-model-a", "high"],
      composition: [{ framing: "full_body" }, { framing: "waist_up" }, { viewpoint: "slightly_elevated" }, {}],
    }),
    makeCollection({
      id: "2026-11-09-glasshouse-morning",
      title: "Glasshouse Morning",
      description: "Botanical glasshouse at opening hour; fogged panes, ferns and pale green light.",
      daysAgo: 1,
      hue: 150,
      frames: 3,
      variations: 1,
      summaries: [
        "Standing among tall ferns, front three-quarter view, chest-up.",
        "Kneeling by a potting table, hands in soil, side profile.",
        "Walking down the central aisle away from the viewer, wide environmental composition.",
      ],
      status: "done",
      theme: null,
    }),
    makeCollection({
      id: "2026-11-08-harbor-kite-day",
      title: "Harbor Kite Day",
      description: "Windy seaside promenade, bright kites and salt air.",
      daysAgo: 2,
      hue: 200,
      frames: 2,
      variations: 4,
      models: ["duskrose", "duskrose"],
      summaries: ["Holding a kite string against a blue sky, low angle, full body.", "Laughing with wind in her hair, head and shoulders."],
      status: "done",
      selections: { "1": 3, "2": 1 },
      feedback: { rating: 5, tags: ["beautiful_heroine", "good_composition"], note: "Strong sky; v3 of scene 1 is the keeper." },
      theme: "windy day by the sea",
      codex: [null, "medium"],
      composition: [{ viewpoint: "low_angle", framing: "full_body" }, { framing: "head_and_shoulders" }],
    }),
    makeCollection({
      id: "2026-11-07-paper-lantern-study",
      title: "Paper Lantern Study",
      description: "A calligraphy studio lit by paper lanterns at dusk.",
      daysAgo: 3,
      hue: 18,
      frames: 4,
      variations: 2,
      summaries: [
        "Sitting at a low desk, brush in hand, seen from above.",
        "Hanging a lantern, arms raised, rear three-quarter view.",
        "Kneeling by an open screen door, garden behind her.",
        "Standing in the doorway, silhouette against lantern light.",
      ],
      status: "failed",
      states: ["done", "done", "done", "done", "done", "failed", "pending", "pending"],
      error: "ComfyUI execution error: CUDA out of memory (KSampler, node 3)",
      selections: { "1": 1 },
      theme: "evening calligraphy",
    }),
    makeCollection({
      id: "2026-11-06-velvet-rain-terrace",
      title: "Velvet Rain Terrace",
      description: "Rooftop terrace during a warm summer rain, velvet dress and city haze.",
      daysAgo: 4,
      hue: 265,
      frames: 4,
      variations: 1,
      summaries: [
        "Under a striped awning watching the rain, side profile.",
        "Stepping into the rain with open palms, low angle.",
        "Leaning on the wet railing, city behind, over-the-shoulder view.",
        "Sitting on a bench with a towel around her shoulders.",
      ],
      status: "interrupted",
      states: ["done", "done", "timeout", "pending"],
    }),
    makeCollection({
      id: "2026-11-05-copper-hour",
      title: "Copper Hour",
      description: "One portrait in late copper sunlight on an old tram platform.",
      daysAgo: 5,
      hue: 28,
      frames: 1,
      variations: 2,
      summaries: ["Waiting on the platform, face close-up, warm rim light."],
      status: "done",
      theme: "single portrait, tram platform",
      codex: ["codex-model-b", "low"],
    }),
  ];
}

/** Mock Codex catalog. In the real app this comes from GET /api/codex/models (NS-012). */
export const MOCK_CODEX = {
  source: "mock" as const,
  models: [
    { id: "codex-model-a", name: "Codex Model A", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "codex-model-b", name: "Codex Model B", efforts: ["low", "medium", "high"] },
  ],
};
export const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };

export interface RunRecord {
  id: string;
  startedAt: string;
  theme: string | null;
  collections: number;
  frames: number;
  variations: number;
  status: "completed" | "failed";
  collectionIds: string[];
  error?: string;
}

export const mockRuns = (): RunRecord[] => [
  { id: "run-1110", startedAt: "2026-11-10T09:30:00Z", theme: "summer citrus orchard", collections: 1, frames: 4, variations: 2, status: "completed", collectionIds: ["2026-11-10-lemon-grove-siesta"] },
  { id: "run-1109", startedAt: "2026-11-09T18:02:00Z", theme: null, collections: 1, frames: 3, variations: 1, status: "completed", collectionIds: ["2026-11-09-glasshouse-morning"] },
  { id: "run-1108", startedAt: "2026-11-08T12:44:00Z", theme: "windy day by the sea", collections: 1, frames: 2, variations: 4, status: "completed", collectionIds: ["2026-11-08-harbor-kite-day"] },
  {
    id: "run-1107",
    startedAt: "2026-11-07T20:15:00Z",
    theme: "evening calligraphy",
    collections: 2,
    frames: 4,
    variations: 2,
    status: "failed",
    collectionIds: ["2026-11-07-paper-lantern-study"],
    error: "ComfyUI execution error: CUDA out of memory (KSampler, node 3)",
  },
];
