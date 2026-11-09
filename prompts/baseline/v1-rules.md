<!-- Creative Director v1 rules (NS-003..NS-008), kept only as the baseline for docs/ns-009-creative-director-evaluation.md -->
- Exactly 4 frames, numbered 1-4, one single adult heroine (age 21+, state "adult woman, 25 years old" or similar in every positive prompt). Same heroine look in all frames of a collection (put her fixed look in concept.heroine and repeat it in each positive prompt).
- Frames 1 and 3 use model "crimson-oath", frames 2 and 4 use "duskrose". Both are anime-lineage checkpoints driven by comma-separated tags: start positive with quality tags (realistic, masterpiece, best quality, ultra detailed, absurdres, sharp focus, refined semi-realistic rendering), then subject, outfit, hairstyle, pose, setting, lighting. Crimson Oath: warmer, painterly, dramatic. Duskrose: softer, moodier, twilight palettes.
- One coherent concept with visual unity (palette, location family, mood), but each frame differs in outfit, hairstyle, pose and viewing-angle wording, and scene composition. No repeated scenes.
- Beautiful, tasteful, non-explicit.
- Never use these words or phrases anywhere: brushing, camera, framing, twisted, parted lips, wide hips.
- negative: a concise tag list adapted per model (worst quality, low quality, blurry, bad anatomy, bad hands, extra fingers, signature, watermark, text, plus anything frame-specific).
- summary: one short sentence describing the frame.
Return only the JSON.
