# NS-003 — First end-to-end Autopilot

`Codex CLI → Prompt Plan JSON → validation → ComfyUI → 4 PNG → collection`

## Запуск

```bash
npm run autopilot                       # Dry run (по умолчанию): сохранённый план, без Codex и ComfyUI
npm run autopilot -- --execute          # Codex сам придумывает концепцию, ComfyUI генерирует 4 кадра
npm run autopilot -- --execute --theme "rainy night market"   # необязательная тема
npm run autopilot -- --execute --plan path/to/plan.json       # свой план, без вызова Codex
```

Перед `--execute` должны быть: запущенный ComfyUI на `127.0.0.1:8188` (`COMFY_URL` для другого адреса) и вход в Codex (`codex login status`, актуальная версия CLI). Переменные: `CODEX_MODEL`, `CODEX_TIMEOUT_MS` (по умолчанию 300000), `CODEX_BIN`.

## Как устроено

- `src/codex.ts` — один вызов `codex exec --output-schema --json` без shell (на Windows запускается `node …/@openai/codex/bin/codex.js`, промпт идёт через stdin). Таймаут, никаких повторов; ошибки — `CodexError`. Токены берутся из события `turn.completed`.
- `src/comfy.ts` — добавлено поле `unet` (`90:78.unet_name`) и таблица `MODELS`: `crimson-oath` → `vetehineCrimsonOathILL_v02ANM`, `duskrose` → `Duskrose v4 ANM`. Граф один, `workflows/anima-crimson-oath.api.json`; оригинальные workflow не менялись.
- `src/collection.ts` — `buildJobs` (4 задания, свой seed у каждого, порядок выполнения сгруппирован по модели, чтобы реже перезагружать checkpoint) и `runCollection` (строго последовательно; проверка нод и моделей до старта; очередь ComfyUI не трогается, занятая очередь просто ждёт).
- Ошибка или таймаут кадра останавливают прогон. Принятое задание не отправляется повторно, его `prompt_id` остаётся в `collection.json` со статусом `failed`/`timeout`.

## Результат

`output/collections/<дата>-<slug>-<id>/` (в `.gitignore`): `collection.json` (манифест, статусы, seed, prompt_id, время, токены Codex), `prompt-plan.json`, `scene-NN.png` и `scene-NN.json` (параметры, полный граф, history). Копия PNG также остаётся в output ComfyUI в `NeuroStudio/<slug>/`.

## Реальный прогон (2026-11-09)

Коллекция «The Saltglass Conservatory», 4 кадра, 2 × Crimson Oath + 2 × Duskrose. Всего 266 с: Codex 30 с (20 360 токенов: 18 961 вход, из них 17 792 из кэша, 1 399 выход), ComfyUI 236 с (56–65 с на кадр, 1440×2176). Ошибок и повторов не было.

## Наблюдения для следующих задач

- Codex без темы снова выбрал «Saltglass Conservatory», как в NS-002: у вызовов нет памяти. Для разнообразия коллекций нужно передавать список уже использованных концепций или случайный seed-тема.
- Цвет волос героини между моделями слегка расходится (auburn → burgundy): визуальная целостность держится на тексте промпта.
- Модель Codex берётся из пользовательского `~/.codex/config.toml` (сейчас `gpt-6-luna`, reasoning `xhigh`); при смене конфига изменятся время и расход лимитов.
