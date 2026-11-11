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
    imageFeedback: {},
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
      title: "Сиеста в лимонной роще",
      description: "Неспешный средиземноморский день среди цитрусовых деревьев, льна и нагретого солнцем камня.",
      daysAgo: 0,
      hue: 42,
      frames: 4,
      variations: 2,
      summaries: [
        "Идёт между рядами лимонных деревьев с корзиной на руке, вид на уровне глаз.",
        "Сидит на низкой каменной ограде, повернувшись к свету, по пояс.",
        "Лежит на полосатом пледе в пятнистой тени, вид чуть сверху.",
        "Опирается на деревянную калитку в конце рощи, в полный рост, тёплый контровой свет.",
      ],
      status: "done",
      selections: { "1": 2, "3": 1 },
      feedback: { rating: 4, tags: ["beautiful_lighting", "original_concept"] },
      theme: "летний цитрусовый сад",
      codex: ["codex-model-a", "high"],
      composition: [{ framing: "full_body" }, { framing: "waist_up" }, { viewpoint: "slightly_elevated" }, {}],
    }),
    makeCollection({
      id: "2026-11-09-glasshouse-morning",
      title: "Утро в оранжерее",
      description: "Ботаническая оранжерея в час открытия: запотевшие стёкла, папоротники и бледно-зелёный свет.",
      daysAgo: 1,
      hue: 150,
      frames: 3,
      variations: 1,
      summaries: [
        "Стоит среди высоких папоротников, ракурс три четверти спереди, по грудь.",
        "Склонилась у стола для рассады, руки в земле, вид сбоку.",
        "Идёт по центральному проходу от зрителя, широкий кадр с окружением.",
      ],
      status: "done",
      theme: null,
    }),
    makeCollection({
      id: "2026-11-08-harbor-kite-day",
      title: "День воздушных змеев в гавани",
      description: "Ветреная набережная, яркие воздушные змеи и солёный воздух.",
      daysAgo: 2,
      hue: 200,
      frames: 2,
      variations: 4,
      models: ["duskrose", "duskrose"],
      summaries: ["Держит нить воздушного змея на фоне синего неба, низкий ракурс, в полный рост.", "Смеётся, ветер треплет волосы, голова и плечи."],
      status: "done",
      selections: { "1": 3, "2": 1 },
      feedback: { rating: 5, tags: ["beautiful_heroine", "good_composition"], note: "Сильное небо; вариант 3 в кадре 1 — лучший." },
      theme: "ветреный день у моря",
      codex: [null, "medium"],
      composition: [{ viewpoint: "low_angle", framing: "full_body" }, { framing: "head_and_shoulders" }],
    }),
    makeCollection({
      id: "2026-11-07-paper-lantern-study",
      title: "Этюд с бумажными фонарями",
      description: "Каллиграфическая студия в сумерках, освещённая бумажными фонарями.",
      daysAgo: 3,
      hue: 18,
      frames: 4,
      variations: 2,
      summaries: [
        "Сидит за низким столом с кистью в руке, вид сверху.",
        "Вешает фонарь, руки подняты, ракурс три четверти сзади.",
        "Опустилась на колени у открытой сёдзи, позади сад.",
        "Стоит в дверном проёме, силуэт на фоне света фонарей.",
      ],
      status: "failed",
      states: ["done", "done", "done", "done", "done", "failed", "pending", "pending"],
      error: "Ошибка выполнения в ComfyUI: CUDA out of memory (KSampler, узел 3)",
      selections: { "1": 1 },
      theme: "вечерняя каллиграфия",
    }),
    makeCollection({
      id: "2026-11-06-velvet-rain-terrace",
      title: "Бархатный дождь на террасе",
      description: "Терраса на крыше под тёплым летним дождём, бархатное платье и городская дымка.",
      daysAgo: 4,
      hue: 265,
      frames: 4,
      variations: 1,
      summaries: [
        "Под полосатым навесом смотрит на дождь, вид сбоку.",
        "Выходит под дождь с раскрытыми ладонями, низкий ракурс.",
        "Опирается на мокрые перила, позади город, взгляд через плечо.",
        "Сидит на скамье, плечи укутаны полотенцем.",
      ],
      status: "interrupted",
      states: ["done", "done", "timeout", "pending"],
    }),
    makeCollection({
      id: "2026-11-05-copper-hour",
      title: "Медный час",
      description: "Один портрет в медном свете позднего солнца на старой трамвайной платформе.",
      daysAgo: 5,
      hue: 28,
      frames: 1,
      variations: 2,
      summaries: ["Ждёт на платформе, крупный план лица, тёплый контровой свет."],
      status: "done",
      theme: "один портрет, трамвайная платформа",
      codex: ["codex-model-b", "low"],
    }),
  ];
}

/** Mock Codex catalog. In the real app this comes from GET /api/codex/models (NS-012). */
export const MOCK_CODEX = {
  source: "mock" as const,
  models: [
    { id: "codex-model-a", name: "Модель A (демо)", efforts: ["low", "medium", "high", "xhigh"] },
    { id: "codex-model-b", name: "Модель B (демо)", efforts: ["low", "medium", "high"] },
  ],
};

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
  { id: "run-1110", startedAt: "2026-11-10T09:30:00Z", theme: "летний цитрусовый сад", collections: 1, frames: 4, variations: 2, status: "completed", collectionIds: ["2026-11-10-lemon-grove-siesta"] },
  { id: "run-1109", startedAt: "2026-11-09T18:02:00Z", theme: null, collections: 1, frames: 3, variations: 1, status: "completed", collectionIds: ["2026-11-09-glasshouse-morning"] },
  { id: "run-1108", startedAt: "2026-11-08T12:44:00Z", theme: "ветреный день у моря", collections: 1, frames: 2, variations: 4, status: "completed", collectionIds: ["2026-11-08-harbor-kite-day"] },
  {
    id: "run-1107",
    startedAt: "2026-11-07T20:15:00Z",
    theme: "вечерняя каллиграфия",
    collections: 2,
    frames: 4,
    variations: 2,
    status: "failed",
    collectionIds: ["2026-11-07-paper-lantern-study"],
    error: "Ошибка выполнения в ComfyUI: CUDA out of memory (KSampler, узел 3)",
  },
];
