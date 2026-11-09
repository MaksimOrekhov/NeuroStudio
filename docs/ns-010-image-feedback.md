# NS-010 Image Feedback v1

Optional per-collection feedback, collected for a future Prompt Evolution. Nothing is learned or changed automatically.

- Storage: `<collection>/feedback.json` (atomic write; deleted when everything is cleared). Old collections without it work unchanged.
- Shape: `{ version: 1, rating: 1-5 | null, tags: [...], note: <=500 chars, updatedAt }`.
- Tags: `beautiful_heroine, great_outfit, good_composition, beautiful_lighting, original_concept` (positive);
  `bad_anatomy, inconsistent_heroine, poor_outfit, repetitive_composition, weak_concept` (negative).
- API: `PUT /api/collections/:id/feedback` with `{ rating, tags, note }`; `GET` collection returns `feedback` (or `null`).
- Linked to the Prompt Plan and Best picks (`selections.json`) only via the collection id; no prompts or PNG paths are copied.
- Rating = subjective verdict on the whole collection. Best = relative pick among seed variants of one prompt. Don't derive model quality from a single rating.
- PNGs, `collection.json`, `prompt-plan.json` and `selections.json` are never modified. Data stays local.
