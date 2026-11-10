# NeuroStudio

Локальная система автоматической генерации коллекций изображений для NeuroDreams поверх ComfyUI.

Состояние: NS-001 — аудит ComfyUI и smoke test программной генерации.

- Отчёт об установке: [docs/comfyui-audit.md](docs/comfyui-audit.md)
- API и структура workflow, инструкция запуска: [docs/comfyui-integration.md](docs/comfyui-integration.md)

```bash
npm install
npm test
npm run smoke   # нужен запущенный ComfyUI на 127.0.0.1:8188 и пустая очередь
```

NS-003: `npm run autopilot` — CLI, см. [docs/ns-003-autopilot.md](docs/ns-003-autopilot.md).
NS-004: `npm start` — веб-интерфейс на http://127.0.0.1:8787, см. [docs/ns-004-web-mvp.md](docs/ns-004-web-mvp.md).
NS-005: выбор 1–3 коллекций за один запуск, один вызов Codex на партию — [docs/ns-005-multi-collection.md](docs/ns-005-multi-collection.md).
NS-006: 1/2/4 seed-варианта на сцену и выбор лучшего — [docs/ns-006-seed-variations.md](docs/ns-006-seed-variations.md).
NS-007: скачивание выбранных 4 PNG в ZIP — [docs/ns-007-collection-export.md](docs/ns-007-collection-export.md).
NS-008: превью WebP в галерее (кеш в `output/thumbs`) — [docs/ns-008-gallery-thumbnails.md](docs/ns-008-gallery-thumbnails.md).
NS-009: Creative Director v2 (`prompts/CREATIVE_DIRECTOR.md`) — [docs/ns-009-creative-director-evaluation.md](docs/ns-009-creative-director-evaluation.md).
NS-013: интерактивный UX-прототип нового интерфейса (русский, только десктоп 2560×1440 / 1920×1080) на mock-данных — `npm run dev:prototype` (http://127.0.0.1:5174), см. [docs/ns-013-ux-design.md](docs/ns-013-ux-design.md).
NS-014: движок гибкой генерации (backend) — коллекции из 1–4 кадров, модель на кадр, Prompt Plan v3, `GET /api/runs`, коды ошибок; UI подключается в NS-015 — [docs/ns-014-flexible-generation.md](docs/ns-014-flexible-generation.md).
NS-015: рабочий русский интерфейс (Создание / Библиотека / Запуски) на реальном API — [docs/ns-015-production-ui.md](docs/ns-015-production-ui.md). Просмотр без Codex и ComfyUI: `npx tsx scripts/ui-test-server.ts`.
