// NS-027: Adaptive Depth Conditioning — the pure part (no Node imports: the web UI uses it too).
// Conditioning records, the reasons Depth was not applied, and a strict, fail-closed reading of a frame prompt
// (view, shot size, viewpoint, posture, side of the hand on the hip) against what one depth map supports.
import type { Settings } from "./composition.ts";

/** "off": the run is exactly as before NS-027 (default). "auto": apply a verified map when the planned pose and the frame fit it. */
export const DEPTH_MODES = ["off", "auto"] as const;
export type DepthMode = (typeof DEPTH_MODES)[number];

/** The untrusted `depthConditioning` request field. Absent = "off" (the pre-NS-027 request). "auto" needs the pose library mode. */
export function parseDepthMode(x: unknown, poseSelection: string): DepthMode {
  if (x === undefined || x === null) return "off";
  if (x !== "off" && x !== "auto") throw new Error('depthConditioning must be "off" or "auto"');
  if (x === "auto" && poseSelection !== "auto") throw new Error('depthConditioning "auto" needs poseSelection "auto"');
  return x;
}

/** Regeneration choice for a source made with a depth map. */
export type DepthChoice = "keep" | "drop";
export function parseDepthChoice(x: unknown): DepthChoice | undefined {
  if (x === undefined || x === null) return undefined;
  if (x !== "keep" && x !== "drop") throw new Error('depth must be "keep" or "drop"');
  return x;
}

export type Side = "left" | "right";

/** What a map supports, copied into every Depth record so a later edit can be checked without the library. */
export interface DepthSpec {
  /** Composition orientation option ids (src/composition.ts). */
  views: string[];
  /** Composition framing (shot size) option ids. */
  crops: string[];
  /** Composition viewpoint option ids. */
  viewpoints: string[];
  /** Composition pose option ids the map satisfies. */
  poses: string[];
  /** Body posture the map shows. */
  posture: "standing";
  /**
   * The hand resting on the hip/waist. anatomical = the heroine's own left/right; image = the side of the picture it appears on
   * (viewer's left/right). Both are stored because they differ for a figure facing the viewer.
   */
  handOnHip?: { anatomical: Side; image: Side };
}

/** Why a requested Depth map was not applied to a frame (text-only generation instead). Stable ids: stored on disk. */
export const DEPTH_REASONS = [
  "free-pose",
  "no-pose",
  "library-unavailable",
  "no-map",
  "map-invalid",
  "map-not-verified",
  "model-not-compatible",
  "booster-untested",
  "size-mismatch",
  "prompt-unstructured",
  "pose-mismatch",
  "pose-unclear",
  "view-mismatch",
  "view-unclear",
  "crop-mismatch",
  "crop-unclear",
  "viewpoint-mismatch",
  "composition-conflict",
  "gesture-mismatch",
  "gesture-unclear",
  "hand-side-conflict",
  "hand-side-ambiguous",
  "nodes-unavailable",
  "adapter-unavailable",
  "upload-failed",
  "map-unverified",
] as const;
export type DepthReason = (typeof DEPTH_REASONS)[number];

export const DEPTH_REASON_RU: Record<DepthReason, string> = {
  "free-pose": "поза придумана Codex, а не взята из библиотеки",
  "no-pose": "у кадра нет позы из библиотеки",
  "library-unavailable": "локальная Depth-библиотека недоступна",
  "no-map": "для этой позы нет Depth-карты",
  "map-invalid": "карта этой позы не прошла проверку (файл, хеш или размер)",
  "map-not-verified": "карта этой позы не одобрена для использования",
  "model-not-compatible": "карта не проверена с этой моделью изображения",
  "booster-untested": "Depth не проверен со Smooth Booster",
  "size-mismatch": "разрешение кадра не совпадает с картой",
  "prompt-unstructured": "промпт не в формате Creative Director, ракурс и крупность не определить",
  "pose-mismatch": "заданная поза не совпадает с картой",
  "pose-unclear": "по промпту нельзя однозначно определить позу",
  "view-mismatch": "ракурс кадра не совпадает с картой",
  "view-unclear": "по промпту нельзя однозначно определить ракурс",
  "crop-mismatch": "крупность кадра не совпадает с картой",
  "crop-unclear": "по промпту нельзя однозначно определить крупность",
  "viewpoint-mismatch": "высота точки съёмки не совпадает с картой",
  "composition-conflict": "промпт противоречит заданной композиции",
  "gesture-mismatch": "положение рук в промпте не совпадает с картой",
  "gesture-unclear": "по промпту нельзя установить положение рук",
  "map-unverified": "файл карты в ComfyUI не удалось сверить по SHA-256",
  "hand-side-conflict": "промпт задаёт другую руку на талии, чем карта",
  "hand-side-ambiguous": "промпт противоречиво описывает руку на талии",
  "nodes-unavailable": "в ComfyUI нет нод Anima LLLite",
  "adapter-unavailable": "адаптер Depth не установлен в ComfyUI",
  "upload-failed": "карту не удалось передать в ComfyUI",
};

/** The Depth conditioning actually put into this image's graph. */
export interface DepthApplied {
  mode: "depth";
  mapId: string;
  mapSha256: string;
  /** Planned catalog pose the map belongs to. */
  poseId: string;
  /** Image model id of the frame. */
  model: string;
  adapter: {
    file: string;
    /** Hash the library expects. Not a check of the installed file: */
    expectedSha256: string;
    /** ...only its presence in ComfyUI's ModelPatchLoader list was checked. */
    check: "listed-by-comfyui";
  };
  strength: number;
  startPercent: number;
  endPercent: number;
  libraryVersion: number;
  /** LoadImage value in the graph (subfolder/name in ComfyUI's input folder). */
  comfyImage: string;
  spec: DepthSpec;
  /** Regeneration only: the user explicitly kept the map. */
  userDecision?: "keep";
  /** Regeneration only: the edited prompt did not clearly fit the map, and the user kept it anyway. */
  conflict?: { reason: DepthReason; detail?: string };
}
/** Depth was requested for the run but this frame was generated from text only. */
export interface DepthNotApplied {
  mode: "text";
  depthRequested: true;
  reason: DepthReason;
  detail?: string;
}
/** Regeneration without the map of a Depth source (user's explicit choice). */
export interface DepthDropped {
  mode: "text";
  userDecision: "drop";
  droppedFrom: { mapId: string; mapSha256: string };
}
export type Conditioning = DepthApplied | DepthNotApplied | DepthDropped;

const isStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

function readSpec(x: unknown): DepthSpec | undefined {
  const s = x as DepthSpec;
  if (!s || typeof s !== "object" || !strs(s.views) || !strs(s.crops) || !strs(s.viewpoints) || !strs(s.poses) || s.posture !== "standing") return undefined;
  const h = s.handOnHip;
  const side = (v: unknown) => v === "left" || v === "right";
  if (h !== undefined && !(h && side(h.anatomical) && side(h.image))) return undefined;
  return { views: [...s.views], crops: [...s.crops], viewpoints: [...s.viewpoints], poses: [...s.poses], posture: "standing", ...(h ? { handOnHip: { anatomical: h.anatomical, image: h.image } } : {}) };
}

/** A conditioning record read from disk, or undefined when absent or malformed. Never throws. */
export function readConditioning(x: unknown): Conditioning | undefined {
  const c = x as Record<string, unknown>;
  if (!c || typeof c !== "object") return undefined;
  if (c.mode === "depth") {
    const a = c.adapter as DepthApplied["adapter"];
    const spec = readSpec(c.spec);
    if (!isStr(c.mapId) || !isStr(c.mapSha256) || !isStr(c.poseId) || !isStr(c.model) || !isStr(c.comfyImage) || !spec) return undefined;
    if (!a || !isStr(a.file) || !isStr(a.expectedSha256) || a.check !== "listed-by-comfyui") return undefined;
    if (!isNum(c.strength) || !isNum(c.startPercent) || !isNum(c.endPercent) || !Number.isInteger(c.libraryVersion)) return undefined;
    const conflict = c.conflict as DepthApplied["conflict"];
    return {
      mode: "depth", mapId: c.mapId, mapSha256: c.mapSha256, poseId: c.poseId, model: c.model,
      adapter: { file: a.file, expectedSha256: a.expectedSha256, check: "listed-by-comfyui" },
      strength: c.strength, startPercent: c.startPercent, endPercent: c.endPercent, libraryVersion: c.libraryVersion as number, comfyImage: c.comfyImage, spec,
      ...(c.userDecision === "keep" ? { userDecision: "keep" as const } : {}),
      ...(conflict && (DEPTH_REASONS as readonly string[]).includes(conflict.reason) ? { conflict: { reason: conflict.reason, ...(isStr(conflict.detail) ? { detail: conflict.detail } : {}) } } : {}),
    };
  }
  if (c.mode === "text") {
    if (c.userDecision === "drop") {
      const d = c.droppedFrom as DepthDropped["droppedFrom"];
      return d && isStr(d.mapId) && isStr(d.mapSha256) ? { mode: "text", userDecision: "drop", droppedFrom: { mapId: d.mapId, mapSha256: d.mapSha256 } } : undefined;
    }
    if (c.depthRequested === true && (DEPTH_REASONS as readonly string[]).includes(c.reason as string)) {
      return { mode: "text", depthRequested: true, reason: c.reason as DepthReason, ...(isStr(c.detail) ? { detail: c.detail } : {}) };
    }
  }
  return undefined;
}

// ---------- Reading a frame prompt (strict: anything unclear is reported, never guessed) ----------

/** Clauses of a text; clauses that negate something ("no ...", "without ...") are dropped, like server/promptFeatures.ts. */
const clauses = (text: string) => text.split(/[,;\n]+|\.(?=\s|$)/).map((s) => s.trim()).filter((s) => s && !/\b(?:no|not|without|avoid|instead of)\b/i.test(s));
const any = (cl: string[], re: RegExp) => cl.some((c) => re.test(c));

/** Declared view in the view block. */
const VIEW = {
  frontThreeQuarter: /\bfront(?:al)?[- ]three[- ]quarters?\b|\bthree[- ]quarters? front(?:al)?\b/i,
  threeQuarter: /\bthree[- ]quarters? (?:view|angle)\b|\b3\/4 (?:view|angle)\b/i,
  rearThreeQuarter: /\b(?:rear|back)[- ]three[- ]quarters?\b|\bthree[- ]quarters? (?:rear|back)\b/i,
  front: /\b(?:direct |straight[- ]on )?front(?:al)? view\b|\bstraight[- ]on (?:view|angle)\b/i,
  side: /\bside view\b|\bprofile (?:view|shot)\b|\bin (?:full )?profile\b|\bside profile\b/i,
  rear: /\b(?:direct )?(?:rear|back) view\b|\b(?:viewed|seen|shown) from behind\b/i,
};
/** Body-direction cues anywhere in the prompt that contradict a front three-quarter view. */
const AWAY = [
  /\b(?:her )?back (?:is )?(?:turned|facing) (?:to|toward|towards) the viewer\b|\bback to the viewer\b|\bwith her back to\b/i,
  /\bturned away\b|\bfacing away\b|\bfacing the (?:wall|window|sea|horizon)\b/i,
  /\bover[- ]the[- ]shoulder (?:view|glance|look|shot)\b|\b(?:look(?:s|ing)?|glanc(?:es|ing)|gaz(?:es|ing)|peek(?:s|ing)|turn(?:s|ing))(?: back)? over (?:her|the|one|a) (?:bare )?(?:left |right )?shoulder\b|\blooking back\b/i,
  /\bside-on\b|\bturned sideways\b/i,
];

const CROPS: [string, RegExp][] = [
  ["head_to_mid_thigh", /\b(?:from (?:the )?)?head[- ]to[- ]mid[- ]thighs?\b|\bmid[- ]thigh (?:composition|shot|crop|view|length|portrait)\b|\b(?:cropped|cut(?: off)?) at (?:the )?mid[- ]thighs?\b/i],
  ["knee_up", /\bknee[- ]up\b|\bhead[- ]to[- ](?:the )?knees?\b|\bknee[- ]length (?:shot|composition|view)\b|\bthree[- ]quarter[- ]length\b|\bthigh[- ]up\b/i],
  ["full_body", /\bfull[- ](?:body|length|figure)\b|\bhead[- ]to[- ]toe\b|\bwhole figure\b/i],
  ["waist_up", /\bwaist[- ]up\b|\bhead[- ]to[- ]waist\b|\bhalf[- ]body\b|\bupper[- ]body (?:shot|portrait|composition)\b/i],
  ["chest_up", /\bchest[- ]up\b|\bbust (?:shot|portrait)\b|\bhead[- ]to[- ](?:upper )?chest\b|\bhead and shoulders\b/i],
  ["face_close_up", /\bclose[- ]up\b|\bportrait\b|\bclose (?:shot|crop)\b/i],
  ["wide_environmental_composition", /\bwide (?:shot|composition|view)\b|\benvironmental composition\b|\b(?:long|establishing) shot\b/i],
];
/** Outside the view block only unambiguous shot terms count ("full-length gown" or "skirt ending mid-thigh" are clothing). */
const STRICT_CROPS: [string, RegExp][] = [
  ["head_to_mid_thigh", /\bhead[- ]to[- ]mid[- ]thighs?\b|\bmid[- ]thigh (?:composition|shot|crop)\b/i],
  ["knee_up", /\bknee[- ]up\b|\bhead[- ]to[- ](?:the )?knees?\b/i],
  ["full_body", /\bfull[- ]body (?:shot|view|composition)\b|\bhead[- ]to[- ]toe\b/i],
  ["waist_up", /\bwaist[- ]up\b/i],
  ["chest_up", /\bchest[- ]up\b|\bhead and shoulders\b/i],
  ["face_close_up", /\bclose[- ]up\b/i],
];

const ELEVATION = /\b(?:slightly |very )?(?:high|low)[- ]angle\b|\belevated (?:view|angle|viewpoint|perspective|vantage)\b|\bview(?:ed)? from (?:slightly |directly )?(?:above|below)\b|\b(?:bird|worm)'?s[- ]eye\b|\boverhead (?:view|shot|angle)\b|\btop[- ]down\b|\bfrom a (?:high|low|raised|lowered) (?:vantage|viewpoint|angle|position)\b|\bdiagonal perspective\b|\bdutch angle\b|\blooking (?:up|down) at her\b/i;
/** In a view clause ("... view", "... angle", "... composition") any height word counts: "three-quarter view from slightly above". */
const VIEW_CLAUSE = /\b(?:view|angle|perspective|vantage|viewpoint|composition|shot)\b/i;
const HEIGHT_WORD = /\b(?:above|below|overhead|elevated|raised|lowered|high|low|upward|downward)\b/i;
/**
 * Viewpoint phrases without a view noun: "seen from slightly above", a bare "from above" or "slightly elevated", "looks up ... from below".
 * Clauses about light or a place are left alone ("sunlight pours from above", "elevated rail platform", "a balcony above her").
 */
const VIEW_HEIGHT = /\b(?:seen|viewed|shot|observed|pictured|captured)\s+from\s+(?:slightly\s+|directly\s+|just\s+|far\s+)?(?:above|below|overhead)\b|^(?:from\s+)?(?:slightly\s+|directly\s+|just\s+|far\s+)?(?:above|below|overhead)$|^(?:slightly\s+|very\s+)?(?:elevated|raised|lowered)$|\blook(?:s|ing)?\s+(?:up|down)\b.*\bfrom\s+(?:slightly\s+)?(?:above|below)\b/i;
const LIGHT_OR_PLACE = /\b(?:light|lights|lighting|lit|sun|sunlight|sunbeams?|moon|moonlight|lamps?|lanterns?|glow|glows|glowing|spotlights?|shines?|shining|beams?|rays?|illuminat\w*|reflections?|shadows?|skylight|candles?|balcony|platform|walkway|terrace|shelf|shelves|ceiling|windows?)\b/i;

const STANDING = /\bstand(?:s|ing)\b(?!\s+(?:lamp|light|desk|mirror|fan))/i;
const OTHER_POSTURE = /\b(?:sit(?:s|ting)?|seated|perched|kneel(?:s|ing)?|lying|lies|lie down|reclin(?:es|ing)|lounging|crouch(?:es|ing)?|squat(?:s|ting)?|walk(?:s|ing)?|mid-stride|strid(?:es|ing)|lean(?:s|ing)?)\b/i;

/** A clause about a hand/arm resting on the hip or waist. */
const HIP_CLAUSE = /\b(?:hand|hands|palm|palms|arm|arms|elbow|fist|fingers)\b.*\b(?:hip|hips|waist)\b|\bakimbo\b|\b(?:hip|waist)\b.*\b(?:hand|palm|elbow)\b/i;
const BOTH_HIPS = /\b(?:both hands|hands|both palms|palms) (?:resting |placed |planted )?on (?:her |both )?hips\b|\bakimbo\b|\bboth (?:hands|arms) (?:on|at) (?:her |the )?(?:hips|waist)\b/i;
const ANAT = /\b(left|right) (?:hand|palm|arm|elbow|fist)\b|\bon (?:her )?(left|right) (?:hip|waist)\b/gi;
const IMAGE_SIDE = /\b(?:image|frame|picture)[- ](left|right)\b|\b(?:on|at|to(?:ward|wards)?) the (left|right)(?: side)? of the (?:image|frame|picture|composition)\b|\b(?:viewer'?s|our) (left|right)\b|\b(?:screen|camera)[- ](left|right)\b/i;
const HANGING = /\b(left|right) (?:arm|hand)\b.*\b(?:hang(?:s|ing)?|relaxed (?:at|by|along) her side|(?:loosely|down|relaxed) (?:at|by) her side|along her (?:side|body)|by her side|at her side)\b/i;
const opposite = (s: Side): Side => (s === "left" ? "right" : "left");
/** ONE hand (singular) resting on the hip or waist: "her right hand resting flat on her hip", "one hand on the hip". */
const ONE_ON_HIP = /\b(?:hand|palm|fist)\b[^,;]*?\b(?:on|against|at) (?:her |the |one )?(?:left |right )?(?:hip|waist)\b|\bhand[- ]on[- ]hip\b/i;
/** Gestures that are not the map's: both arms down, arms crossed or folded, hands in pockets. */
const ARMS_DOWN = /\b(?:both (?:arms|hands)|(?:her )?arms|(?:her )?hands)\b[^,;]*?\b(?:at|by|along|down (?:at|by)) (?:her|both) sides\b|\b(?:both )?arms (?:hanging |resting |relaxed )?(?:loosely |straight )?down\b/i;
const CROSSED = /\b(?:arms|hands) (?:loosely |tightly )?(?:crossed|folded)\b|\b(?:crossed|folded) arms\b|\bcrossing her arms\b|\bfolding her arms\b/i;
const POCKETS = /\b(?:hand|hands|thumbs?)\b[^,;]*?\bin (?:her |the |its |his )?(?:\w+ )?pockets?\b/i;
const NEGATION = /\b(?:no|not|without|instead of|never|nor)\b/i;
const rawClauses = (text: string) => text.split(/[,;\n]+|\.(?=\s|$)/).map((s) => s.trim()).filter(Boolean);

export interface PromptReading {
  /** Creative Director house format (blocks separated by blank lines, block 2 starts with "solo female"). */
  structured: boolean;
  /** Orientation option id when exactly one direction is stated and nothing contradicts it; null otherwise. */
  view: string | null;
  viewNote?: string;
  /** Framing option id when exactly one shot size is stated; null when none or several. */
  crop: string | null;
  cropNote?: string;
  /** "eye_level" (also when no elevation is mentioned: the house default), "other" when any elevation term is present. */
  viewpoint: "eye_level" | "other";
  posture: "standing" | "other" | null;
  /** Sides of the hand on the hip the prompt states (anatomical / picture), and whether both hands are on the hips. */
  hand: { anatomical: Side[]; image: Side[]; both: boolean };
  /**
   * The arm gesture as far as a depth map with ONE hand on the hip cares (conservative, not general language understanding):
   * oneOnHip = a single hand is placed on the hip/waist; the other flags are gestures that contradict such a map.
   */
  gesture: { oneOnHip: boolean; armsDown: boolean; crossed: boolean; pockets: boolean; negatedHip: boolean };
}

/** Reads what a frame prompt says about the composition a depth map fixes. Pure, deterministic. */
export function readPrompt(positive: string): PromptReading {
  const blocks = positive.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  const structured = (blocks.length === 6 || blocks.length === 7) && /^solo female\b/i.test(blocks[1] ?? "");
  const viewBlock = structured ? blocks[blocks.length - 1] : positive;
  const rest = structured ? blocks.slice(0, -1).join("\n") : "";
  const vc = clauses(viewBlock);
  const all = clauses(positive);

  // View: the declared direction comes from the view block; any other direction cue anywhere makes it unclear.
  const declared: string[] = [];
  const f3 = any(vc, VIEW.frontThreeQuarter) || (any(vc, VIEW.threeQuarter) && !any(vc, VIEW.rearThreeQuarter) && !vc.some((c) => VIEW.threeQuarter.test(c) && /\b(?:rear|back)\b/i.test(c)));
  if (f3) declared.push("front_three_quarter_view");
  if (any(vc, VIEW.rearThreeQuarter)) declared.push("rear_three_quarter_view");
  if (any(vc, VIEW.front)) declared.push("direct_front_view");
  if (any(vc, VIEW.side)) declared.push("side_profile");
  if (any(vc, VIEW.rear)) declared.push("direct_rear_view");
  const cues: string[] = [];
  const restCl = clauses(rest);
  if (any(restCl, VIEW.rearThreeQuarter) || any(restCl, VIEW.rear)) cues.push("rear view mentioned");
  if (any(restCl, VIEW.side)) cues.push("profile mentioned");
  if (any(restCl, VIEW.front)) cues.push("direct front view mentioned");
  for (const re of AWAY) if (any(all, re)) cues.push(`body direction: "${all.find((c) => re.test(c))}"`);
  let view: string | null = null;
  let viewNote: string | undefined;
  if (declared.length === 1 && !cues.length) view = declared[0];
  else if (!declared.length) viewNote = "no view stated";
  else viewNote = [...(declared.length > 1 ? [`several views: ${declared.join(", ")}`] : []), ...cues].join("; ");

  // Shot size: the view block decides; strict shot terms elsewhere must agree.
  const found = new Set(CROPS.filter(([, re]) => any(vc, re)).map(([id]) => id));
  if (structured) for (const [id, re] of STRICT_CROPS) if (any(restCl, re)) found.add(id);
  const crop = found.size === 1 ? [...found][0] : null;
  const cropNote = found.size > 1 ? `several shot sizes: ${[...found].join(", ")}` : found.size === 0 ? "no shot size stated" : undefined;

  // Eye level is the house default: an explicit "eye level" and no mention at all read the same; any elevation term does not.
  const viewpoint =
    any(all, ELEVATION) || vc.some((c) => (VIEW_CLAUSE.test(c) && HEIGHT_WORD.test(c)) || (VIEW_HEIGHT.test(c) && !LIGHT_OR_PLACE.test(c))) ? "other" : "eye_level";

  const standing = any(all, STANDING);
  const other = any(all, OTHER_POSTURE);
  const posture = standing && !other ? "standing" : other ? "other" : null;

  const anatomical = new Set<Side>();
  const image = new Set<Side>();
  let both = false;
  for (const c of all) {
    if (BOTH_HIPS.test(c)) both = true;
    if (HIP_CLAUSE.test(c)) {
      for (const m of c.matchAll(ANAT)) anatomical.add((m[1] ?? m[2]).toLowerCase() as Side);
      const im = c.match(IMAGE_SIDE);
      if (im) image.add((im.slice(1).find(Boolean) as string).toLowerCase() as Side);
    } else {
      const h = c.match(HANGING);
      if (h) anatomical.add(opposite(h[1].toLowerCase() as Side));
    }
  }
  // Negated clauses are dropped above; a negated hand-on-hip ("no hand on her hip") is itself a statement about the gesture.
  const negatedHip = rawClauses(positive).some((c) => NEGATION.test(c) && /\b(?:hip|hips|waist)\b/i.test(c) && /\b(?:hand|hands|palm|palms|arm|arms|elbow|fist)\b/i.test(c));
  const gesture = { oneOnHip: any(all, ONE_ON_HIP), armsDown: any(all, ARMS_DOWN), crossed: any(all, CROSSED), pockets: any(all, POCKETS), negatedHip };
  return {
    structured, view, ...(viewNote ? { viewNote } : {}), crop, ...(cropNote ? { cropNote } : {}), viewpoint, posture,
    hand: { anatomical: [...anatomical].sort(), image: [...image].sort(), both },
    gesture,
  };
}

export interface Mismatch {
  reason: DepthReason;
  detail?: string;
}

/**
 * Does this frame (its explicit composition requirements and its prompt) fit the map? null = it fits.
 * Order: what the user required, then what the prompt says, then whether the two agree, then the hand side.
 */
export function promptMismatch(spec: DepthSpec, positive: string, req: Settings = {}): Mismatch | null {
  if (req.pose && !spec.poses.includes(req.pose)) return { reason: "pose-mismatch", detail: `required pose ${req.pose}` };
  if (req.orientation && !spec.views.includes(req.orientation)) return { reason: "view-mismatch", detail: `required view ${req.orientation}` };
  if (req.framing && !spec.crops.includes(req.framing)) return { reason: "crop-mismatch", detail: `required shot size ${req.framing}` };
  if (req.viewpoint && !spec.viewpoints.includes(req.viewpoint)) return { reason: "viewpoint-mismatch", detail: `required viewpoint ${req.viewpoint}` };

  const r = readPrompt(positive);
  if (!r.structured) return { reason: "prompt-unstructured" };
  if (r.posture === null) return { reason: "pose-unclear", detail: "no posture stated" };
  if (r.posture !== spec.posture) return { reason: "pose-mismatch", detail: `the prompt does not describe a ${spec.posture} pose only` };
  if (!r.view) return { reason: "view-unclear", detail: r.viewNote };
  if (!spec.views.includes(r.view)) return { reason: "view-mismatch", detail: `prompt view ${r.view}` };
  if (!r.crop) return { reason: "crop-unclear", detail: r.cropNote };
  if (!spec.crops.includes(r.crop)) return { reason: "crop-mismatch", detail: `prompt shot size ${r.crop}` };
  if (r.viewpoint === "other") return { reason: "viewpoint-mismatch", detail: "the prompt states a raised or lowered viewpoint" };
  if (!spec.viewpoints.includes("eye_level")) return { reason: "viewpoint-mismatch", detail: "the map is not approved for eye level" };

  if (req.orientation && req.orientation !== r.view) return { reason: "composition-conflict", detail: `required ${req.orientation}, prompt ${r.view}` };
  if (req.framing && req.framing !== r.crop) return { reason: "composition-conflict", detail: `required ${req.framing}, prompt ${r.crop}` };
  if (req.viewpoint && req.viewpoint !== r.viewpoint) return { reason: "composition-conflict", detail: `required ${req.viewpoint}, prompt ${r.viewpoint}` };

  const h = spec.handOnHip;
  if (h) {
    // The gesture first: the map shows exactly one hand on the hip and the other arm hanging.
    const g = r.gesture;
    if (g.negatedHip) return { reason: "gesture-mismatch", detail: "the prompt says the hand is not on the hip" };
    if (r.hand.both) return { reason: "gesture-mismatch", detail: "both hands on the hips; the map has one" };
    if (g.crossed) return { reason: "gesture-mismatch", detail: "arms crossed or folded" };
    if (g.pockets) return { reason: "gesture-mismatch", detail: "hands in pockets" };
    if (g.armsDown) return { reason: "gesture-mismatch", detail: "both arms down at her sides" };
    if (!g.oneOnHip) return { reason: "gesture-unclear", detail: "the prompt does not place one hand on the hip" };
    if (r.hand.anatomical.length > 1) return { reason: "hand-side-ambiguous", detail: "both her left and her right hand are described on the hip" };
    if (r.hand.image.length > 1) return { reason: "hand-side-ambiguous", detail: "the hand on the hip is placed on both sides of the picture" };
    if (r.hand.anatomical.length && r.hand.anatomical[0] !== h.anatomical) return { reason: "hand-side-conflict", detail: `prompt: her ${r.hand.anatomical[0]} hand; map: her ${h.anatomical} hand` };
    if (r.hand.image.length && r.hand.image[0] !== h.image) return { reason: "hand-side-conflict", detail: `prompt: picture ${r.hand.image[0]}; map: picture ${h.image}` };
  }
  return null;
}
