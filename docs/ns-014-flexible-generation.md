# NS-014 — Гибкий движок генерации

Backend и движок: коллекции из **1–4 кадров**, выбор модели изображения для каждого кадра, Prompt Plan v3 с русскими метаданными, история запусков и стабильные коды ошибок. Интерфейс NS-013 не подключался (это NS-015); `web/src/` и прототип не менялись по поведению.

## 1. Каталог моделей — `src/imageModels.ts`

Две модели: `crimson-oath` (`vetehineCrimsonOathILL_v02ANM.safetensors`) и `duskrose` (`Duskrose v4 ANM.safetensors`); у каждой id, имя, checkpoint, цвет. `MODELS` в `src/comfy.ts` теперь строится из каталога. `autoMix` — единственная реализация: прототип NS-013 импортирует её отсюда (поведение прототипа не изменилось).

| Кадров | Auto Mix |
|---|---|
| 1 | C |
| 2 | C, D |
| 3 | C, C, D |
| 4 | C, C, D, D |

`resolveImageModels(input, frames)` строго проверяет запрос; ошибки → HTTP 400, подмены на Auto Mix нет.

## 2. API

`POST /api/autopilot/start`:

```json
{ "theme": "summer garden", "collections": 2, "frames": 3, "variations": 2,
  "imageModels": { "mode": "custom", "perScene": ["crimson-oath", "duskrose", "crimson-oath"] },
  "composition": { "global": {}, "scenes": [] },
  "codexModel": "...", "codexReasoningEffort": "..." }
```

| Поле | Правило | По умолчанию |
|---|---|---|
| `collections` | 1–3 | 1 |
| `frames` | целое 1–4 | 4 |
| `variations` | 1 / 2 / 4 | 1 |
| `imageModels` | `{mode:"auto"}` · `{mode:"only", model}` · `{mode:"custom", perScene:[…ровно frames id…]}` | Auto Mix |
| `composition` | структура NS-011; `scenes.length` ≤ `frames` | нет |
| `codexModel`, `codexReasoningEffort` | без изменений | — |

Всё проверяется **до** обращения к ComfyUI и Codex. Старый запрос (без новых полей) даёт 4 кадра: 2 Crimson Oath + 2 Duskrose. Настройки запуска копируются и замораживаются при старте (`RunSettings`), поэтому позднее изменение формы или объекта запроса не влияет на текущий запуск.

Композиция для несуществующего кадра — ошибка (`composition.scenes has 3 entries but the collection has only 2 frames`). Для NS-015: форма должна обрезать скрытые кадры до `frames` перед отправкой.

Состояние запуска (`GET /api/status` → `run`) дополнено: `frames`, `imageModels`, `runId`, `errorCode`; `total = collections × frames × variations`.

## 3. Prompt Plan v3

`schemas/prompt-plan.schema.json` — шаблон v3; под конкретный запуск схему строит `planSchema(models)` (`src/codex.ts`): ровно N кадров, `frame ≤ N`, enum моделей = назначенные. Один batch = **один вызов Codex CLI**; отдельных запросов на перевод нет.

Обязательные поля нового плана: `concept.title/titleRu/description/descriptionRu/heroine`, у кадра `frame/model/summary/summaryRu/positive`. Positive prompt английский.

`validatePlan(plan, { models })` (и `validateBatch(x, count, { models })`): ровно N кадров, нумерация 1…N, модель каждого кадра равна назначенной сервером, русские поля заполнены и содержат кириллицу, prompts различаются; прежние правила (`adult woman`, возраст 21+, одна фраза `huge breast`, запрещённые слова) без изменений. Без `models` работает прежняя проверка (4 кадра, 2 + 2, русские поля необязательны) и режим `legacy`, поэтому старые планы читаются.

## 4. Creative Director v3

`prompts/CREATIVE_DIRECTOR.md`: количество кадров и модель каждого кадра задаёт запрос; одна героиня во всех кадрах; для 1 кадра — одна самодостаточная выразительная композиция, для 2–4 разнообразие поз и ракурсов сохраняется; добавлены `titleRu/descriptionRu/summaryRu`; Composition Controls имеют приоритет. Hard constraints, quality prefix, правила анатомии и творческий раздел C не менялись. Запрос к Codex (`framesPrompt`) перечисляет «Frame N: model».

## 5. Генерация и хранение

- Изображений: `collections × frames × variations` (например, 3 × 2 × 4 = 24).
- Один positive prompt на кадр, уникальные seed; задания группируются по модели (порядок моделей — порядок каталога), нумерация файлов и порядок в галерее/ZIP — по номеру кадра.
- Ошибка задания останавливает партию, повторной отправки нет, `prompt_id` и созданные PNG остаются. Параметры sampler/CFG/размер/negative и workflow не менялись; параллельной отправки нет.
- `batch-plan.json` дополнен: `frames`, `imageModels {mode, models}`, итоговая `composition` по кадрам (после наследования), `errorCode` (+ прежние `count`, `variations`, `codex`, `collectionIds`, `status`, `error`).
- `collection.json` дополнен: `frameCount`, `generation { theme, imageModels, composition }`. Prompt Plan в манифест не дублируется (русские тексты читаются из `prompt-plan.json`).
- `CollectionView`: `frameCount`, `titleRu`, `descriptionRu`, `frames[].summaryRu`, `generation` (+ прежние `codex`, `comfySeconds`). Нет `frameCount` → 4. Нет русских полей → клиент показывает исходные английские. Старые папки не мигрируются и не переписываются (проверено тестом).

## 6. Best и ZIP

`chooseScenes`, `exportStatus`, `setSelection` используют `frameCount` (сообщение «Select best images: 1/2»). Один кадр с одним вариантом готов к экспорту сразу; при нескольких вариантах нужен Best. ZIP: по одному исходному PNG на кадр, имена `scene-0N.png`, порядок по кадрам, без перекодирования. Feedback NS-010 не менялся.

## 7. История запусков

`GET /api/runs?limit=` (по умолчанию 20, максимум 50) читает `output/batches/*/batch-plan.json` (без базы и очередей): `id, createdAt, status (running|completed|failed|interrupted), theme, collections, frames, variations, totalImages, imageModels|null, collectionIds, error?, errorCode?, codex?`. Старые файлы без новых полей: `frames` берётся из планов (иначе 4), `imageModels = null`. Нечитаемые папки пропускаются и не расходуют лимит. Запуск, который ещё планируется Codex, в списке не виден (файл пишется после плана): для него есть `GET /api/status`.

## 8. Коды ошибок — `src/errors.ts`

Тело ошибки: `{ "error": "<техническое сообщение, без изменений>", "code": "<КОД>" }`; для запусков то же в `run.error` / `run.errorCode` и `batch-plan.json`. Русские тексты формирует NS-015.

| Код | Когда |
|---|---|
| `INVALID_GENERATION_SETTINGS` | 400: кадры, модели, композиция, Codex-настройки, количества |
| `ALREADY_RUNNING` | 409 |
| `COMFY_UNREACHABLE` | 503 при старте; ошибка запуска, если ComfyUI пропал |
| `CODEX_FAILED` | Codex не запустился, таймаут, нет/невалидный ответ |
| `PLAN_INVALID` | план не прошёл проверку |
| `GENERATION_FAILED` | ошибка/таймаут ComfyUI, нет зависимостей |
| `EXPORT_INCOMPLETE` | 409: ZIP ещё недоступен |
| `COLLECTION_NOT_FOUND` / `INVALID_REQUEST` | 404 / 400 для коллекции, Best, Feedback |

Было `already_running` / `comfy_unavailable` (строчные) — теперь `ALREADY_RUNNING` / `COMFY_UNREACHABLE`. Старый UI эти значения не читает.

## 9. CLI

`npm run autopilot` сохранён (dry run, `--execute`, `--plan`, `--variations`); добавлен `--frames 1-4` (Auto Mix). `--plan` принимает и планы v3 любой длины, и старые. `--execute` теперь просит у Codex план v3.

## 10. Примеры

```bash
# 1 кадр
curl -X POST http://127.0.0.1:8787/api/autopilot/start -H "content-type: application/json" -d '{"theme":"quiet theatre","frames":1}'
# 2 кадра × 2 варианта × 2 коллекции, обе на Duskrose = 8 PNG
-d '{"collections":2,"frames":2,"variations":2,"imageModels":{"mode":"only","model":"duskrose"}}'
# 4 кадра, свой выбор моделей, 3 коллекции × 4 варианта = 48 PNG
-d '{"collections":3,"frames":4,"variations":4,"imageModels":{"mode":"custom","perScene":["crimson-oath","duskrose","duskrose","crimson-oath"]}}'
```

## 11. Проверка Codex (один реальный вызов, без GPU)

Одна коллекция, 1 кадр (`crimson-oath`, Auto Mix), тема не задана, история — реальные названия коллекций; Codex CLI с настройками по умолчанию. Результат: `output/director-eval/ns014-single.json` (в Git не попадает).

- Время **78.0 с**, токены: input 18 713, cached 0, output 1 641, всего 20 354.
- Строгая проверка плана пройдена (в том числе `adult woman`, 31 год, ровно одна `huge breast`, нет запрещённых слов, русские поля с кириллицей, модель = назначенной).
- Оценка вручную: «Аплодисменты для себя» — «A Private Ovation»: одинокая героиня в пустом театре с конфетти; одна завершённая композиция (три четверти сверху, диагональ прохода, дневной свет через боковую дверь), а не первый кадр серии. Положительный prompt английский, формат дома соблюдён.
- Ограничения: одна выборка (1 кадр, одна модель) — не статистика; качество 2–4 кадров с Custom и русских текстов на разных темах не оценивалось; изображения не генерировались, поэтому «красота» результата не проверена. Дополнительных вызовов не делалось.

## 12. Риски и ограничения

- Структурированный вывод Codex не может задать «модель кадра i» в схеме (нет tuple), поэтому схема сужает enum, а точное соответствие назначению проверяет `validatePlan`. Неверный ответ ломает партию без повторного вызова (как и прежние нарушения).
- Русские поля обязаны содержать кириллицу; ответ без неё считается невалидным. Для коллекций, созданных старым кодом, русских текстов нет.
- `generateBatch`/`generatePlan` без `models` теперь тоже просят план v3 (4 кадра, Auto Mix). Старые тесты и скрипты, подменявшие Codex планом без русских полей, пришлось обновить.
- Смена кодов `RunError` (регистр) — единственное видимое изменение существующих ответов, кроме добавленных полей.
- Композиция для кадра сверх `frames` отклоняется (по ТЗ); клиенту NS-015 нужно обрезать скрытые кадры.
- Состояние запуска живёт в памяти; после перезапуска сервера запуск со статусом `running` на диске показывается как `interrupted`.
- Один Codex-вызов на партию с `frames` ≠ 4 пока не оценён по качеству так же подробно, как NS-009 (для 1 кадра — одна проверка выше).

## 13. Проверка

`npm test` — 81 тест (24 новых в `tests/ns014.test.ts`: каталог и Auto Mix, Only/Custom и ошибки, схемы и валидация v3 для 1–4 кадров, запрос к Codex, mock Codex, jobs, API-валидация до запуска, старый запрос, примеры 1/2/4 кадров, снимок настроек, остановка при сбое без повторов, коды ошибок, `/api/runs` со старыми файлами, ZIP для 1–4 кадров с побайтовым сравнением, совместимость старых коллекций). `npm run typecheck`, `npm run build`, `npm run build:prototype` — без ошибок. ComfyUI не запускался.
