// NS-013A: Russian UI labels. The interface is Russian only (no i18n library, no language switch).
// Technical ids stay as they are: the UI shows "Сидя на стуле", the request carries "sitting_on_a_chair".
import { COMPOSITION_OPTIONS, type CompositionField } from "../../../src/composition";

export const FIELD_RU: Record<CompositionField, string> = { pose: "Поза", orientation: "Поворот", framing: "Кадрирование", viewpoint: "Ракурс" };

/** Russian display names for every option id of the shared catalog (src/composition.ts). */
export const OPTION_RU: Record<CompositionField, Record<string, string>> = {
  pose: {
    standing_naturally: "Стоя, естественно",
    standing_with_weight_on_one_leg: "Стоя, с опорой на одну ногу",
    walking: "В движении, шаг",
    sitting_on_a_chair: "Сидя на стуле",
    sitting_on_a_bench_or_ledge: "Сидя на скамье или выступе",
    sitting_on_the_floor: "Сидя на полу",
    leaning_against_a_wall: "Прислонившись к стене",
    leaning_on_a_surface: "Опираясь на поверхность",
    leaning_forward: "Наклонившись вперёд",
    slightly_bending_forward: "Слегка наклонившись вперёд",
    reclining_with_support: "Полулёжа с опорой",
    lying_on_the_back: "Лёжа на спине",
    lying_on_the_side: "Лёжа на боку",
    kneeling: "На коленях",
    crouching: "На корточках",
    turning_naturally: "В естественном повороте",
  },
  orientation: {
    direct_front_view: "Анфас",
    front_three_quarter_view: "Три четверти спереди",
    left_side_profile: "Профиль слева",
    right_side_profile: "Профиль справа",
    rear_three_quarter_view: "Три четверти со спины",
    direct_rear_view: "Со спины",
    over_the_shoulder_view: "Через плечо",
    slightly_turned_away: "Слегка отвернувшись",
  },
  framing: {
    face_close_up: "Крупный план лица",
    head_and_shoulders: "Голова и плечи",
    chest_up: "По грудь",
    waist_up: "По пояс",
    head_to_mid_thigh: "До середины бедра",
    knee_up: "По колено",
    full_body: "В полный рост",
    wide_environmental_composition: "Общий план с окружением",
  },
  viewpoint: {
    eye_level: "На уровне глаз",
    slightly_elevated: "Чуть сверху",
    high_angle: "Сверху",
    directly_overhead: "Строго сверху",
    slightly_low_angle: "Чуть снизу",
    low_angle: "Снизу",
    diagonal_perspective: "Диагональная перспектива",
  },
};

/** Russian label of a composition option; falls back to the English catalog label. */
export const optionRu = (f: CompositionField, id: string) => OPTION_RU[f][id] ?? COMPOSITION_OPTIONS[f].find((x) => x.id === id)?.label ?? id;

export const AUTO_RU = "Авто";
export const INHERIT_RU = "Как в общих";

export const EFFORT_RU: Record<string, string> = { low: "Низкая", medium: "Средняя", high: "Высокая", xhigh: "Очень высокая", max: "Максимальная" };
export const effortRu = (id: string) => EFFORT_RU[id] ?? id;

/** Feedback tags: ids are stored (feedback.json), labels are shown. Same ids as NS-010. */
export const GOOD_TAGS = [
  ["beautiful_heroine", "Красивая героиня"],
  ["great_outfit", "Отличный наряд"],
  ["good_composition", "Удачная композиция"],
  ["beautiful_lighting", "Красивый свет"],
  ["original_concept", "Оригинальная идея"],
] as const;
export const BAD_TAGS = [
  ["bad_anatomy", "Плохая анатомия"],
  ["inconsistent_heroine", "Героиня не похожа между кадрами"],
  ["poor_outfit", "Неудачный наряд"],
  ["repetitive_composition", "Однообразная композиция"],
  ["weak_concept", "Слабая идея"],
] as const;

/** Russian plural: forms = [1, 2–4, 5+], e.g. ["кадр", "кадра", "кадров"]. */
export function ruPlural(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}
export const nPlural = (n: number, forms: readonly [string, string, string]) => `${n} ${ruPlural(n, forms)}`;

export const W = {
  collection: ["коллекция", "коллекции", "коллекций"],
  frame: ["кадр", "кадра", "кадров"],
  variant: ["вариант", "варианта", "вариантов"],
  image: ["изображение", "изображения", "изображений"],
  scene: ["кадр", "кадра", "кадров"],
} as const;

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const DATE_FULL = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const dateRu = (iso: string) => DATE.format(new Date(iso));
export const dateFullRu = (iso: string) => DATE_FULL.format(new Date(iso));

/** "1 мин 16 с", "38 с" */
export const secondsRu = (s?: number) => (s === undefined ? "—" : s >= 60 ? `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с` : `${Math.round(s)} с`);

/** After "из": genitive — "из 1 изображения", "из 4 изображений", "из 21 изображения". */
export const ofImages = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "изображения" : "изображений"}`;
