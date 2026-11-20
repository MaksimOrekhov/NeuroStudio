import { flatten, INSTRUCTIVE } from "../src/untrustedText.ts";

const MATCHERS = {
  pose: {
    standing: /\b(?:standing|stands)\b(?!\s+(?:lamp|light|desk)\b)/i,
    sitting: /\b(?:sitting|seated|sits)\b(?!\s+room\b)/i,
    reclining: /\b(?:reclining|lying down|lying on (?:her|the) |lies on)\b/i,
    kneeling: /\b(?:kneeling|kneels)\b/i,
    crouching: /\b(?:crouching|crouches|squatting)\b/i,
    walking: /\b(?:walking|walks|mid-stride)\b/i,
    running: /\b(?:running|runs)\b(?!\s+(?:water|through the fabric)\b)/i,
  },
  angle: {
    "front view": /\b(?:front(?:al)? view|straight[- ]on (?:view|angle))\b/i,
    "three-quarter view": /\b(?:three[- ]quarter|3\/4) (?:view|angle)\b/i,
    "rear three-quarter view": /\brear (?:three[- ]quarter|3\/4) (?:view|angle)\b/i,
    "side view": /\b(?:side view|profile (?:view|shot)|in profile)\b/i,
    "rear view": /\b(?:rear view|back view|view(?:ed)? from behind)\b/i,
    "high angle": /\b(?:high[- ]angle|view(?:ed)? from above|elevated view|overhead (?:view|shot)|top-down view)\b/i,
    "low angle": /\b(?:low[- ]angle|view(?:ed)? from below)\b/i,
    "eye level": /\beye[- ]level\b/i,
  },
  shot: {
    "full body": /\b(?:full[- ]body|head[- ]to[- ]toe|full[- ]length (?:view|shot))\b/i,
    "waist up": /\b(?:waist[- ]up|from the waist up)\b/i,
    "chest up": /\b(?:chest[- ]up|bust shot)\b/i,
    "head to mid-thigh": /\b(?:head[- ]to[- ]mid[- ]thigh|from (?:the )?head to mid[- ]thigh)\b/i,
    "close-up": /\bclose[- ]up\b/i,
    "wide shot": /\b(?:wide|long|establishing) shot\b/i,
  },
  gesture: {
    "hand-object contact": /\b(?:hold(?:s|ing)\b|grasp(?:s|ing)\b|grip(?:s|ping)\b|clutch(?:es|ing)\b|(?:hand|hands|fingers) (?:rest(?:s|ing)? on|touch(?:es|ing)?|wrap(?:s|ped)? around))\s+(?:(?:a|an|the|her)\s+)?(?:[\w-]+\s+){0,3}(?:cup|mug|book|bag|umbrella|rope|rail(?:ing)?|handle|sword|hat|flower|basket|bottle|glass|lantern|phone|instrument|letter|key|camera|door|table)\b/i,
    "hand gesture": /\b(?:waving|pointing with (?:a|her) finger|raised hand|hand raised|hand (?:on (?:her|one) hip|against her cheek))\b/i,
  },
  limbs: {
    "crossed arms": /\b(?:arms crossed|crossed arms|arms folded across)\b/i,
    "crossed legs": /\b(?:legs crossed|crossed legs|cross[- ]legged|ankles crossed)\b/i,
    "overhead arms": /\b(?:arms? (?:raised |extended )?(?:above (?:her |the )?head|overhead)|both hands behind her head)\b/i,
    "interlaced fingers": /\b(?:fingers interlaced|interlaced fingers)\b/i,
  },
  setting: {
    "natural landscape": /\b(?:forest|woodland|meadow|beach|coast|waterfall|mountain(?:s|side)?|desert|riverbank)\b/i,
    "urban exterior": /\b(?:street|alley|city square|sidewalk|crosswalk|city rooftop|urban rooftop)\b/i,
    "garden or park": /\b(?:garden|park|orchard|greenhouse)\b/i,
    "built interior": /\b(?:room|library|studio|kitchen|bedroom|hallway|apartment|café|cafe|atelier|gallery|interior|workshop)\b/i,
    "plain background": /\b(?:(?:plain|neutral|solid|seamless) (?:background|backdrop))\b/i,
  },
} satisfies Record<string, Record<string, RegExp>>;

export type Feature = keyof typeof MATCHERS;
export type PromptFeatures = Partial<Record<Feature, string[]>> & { scene?: string };

function matchClauses(text: string, choices: Record<string, RegExp>): string[] {
  const clauses = text.split(/[,\n;]+/).filter((s) => !/\b(?:no|not|without|avoid|instead of)\b/i.test(s));
  return Object.entries(choices).filter(([, pattern]) => clauses.some((s) => pattern.test(s))).map(([name]) => name);
}

/** Use the pose, place and view blocks when the house structure is present. Otherwise use only explicit phrases. */
export function extractPromptFeatures(raw: string): PromptFeatures {
  if (INSTRUCTIVE.test(flatten(raw))) return {};
  const blocks = raw.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean);
  const house = (blocks.length === 6 || blocks.length === 7) && /^solo female\b/i.test(blocks[1]);
  const pose = house ? blocks[blocks.length - 4] : raw;
  const place = house ? blocks[blocks.length - 2] : raw;
  const view = house ? blocks[blocks.length - 1] : raw;
  const source = { pose, angle: view, shot: view, gesture: pose, limbs: pose, setting: place };
  const features: PromptFeatures = {};
  for (const key of Object.keys(MATCHERS) as Feature[]) {
    const hits = matchClauses(source[key], MATCHERS[key]);
    if (key === "angle") {
      const directions = hits.filter((s) => s.endsWith("view") && !(s === "three-quarter view" && hits.includes("rear three-quarter view")));
      const elevations = hits.filter((s) => !s.endsWith("view"));
      const clear = [...(directions.length === 1 ? directions : []), ...(elevations.length === 1 ? elevations : [])];
      if (clear.length) features.angle = clear;
    } else if (hits.length && (hits.length === 1 || key === "gesture" || key === "limbs")) features[key] = hits;
  }
  const scene = flatten(house ? place : place.split(/[,\n;]+/).find((part) => matchClauses(part, MATCHERS.setting).length > 0) ?? "");
  if (scene && scene.length <= 140) features.scene = scene;
  return features;
}
