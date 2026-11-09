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
