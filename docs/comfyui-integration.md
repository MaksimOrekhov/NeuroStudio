# ComfyUI integration (NS-001)

## API (проверено на ComfyUI 0.44.2, `http://127.0.0.1:8188`)

| Endpoint | Использование | Проверено |
|---|---|---|
| `GET /system_stats` | доступность, версия, VRAM | да |
| `GET /queue` | `queue_running` / `queue_pending` — перед отправкой должны быть пустыми | да |
| `GET /object_info` | список нод и доступных файлов моделей (проверка зависимостей) | да (1042 класса) |
| `GET /history/{id}` | статус: `status.completed`, `status.status_str == "error"`, `outputs` | да |
| `POST /prompt` | `{prompt: <graph>, client_id}` → `{prompt_id}`; при ошибке валидации HTTP 400 + `node_errors` | да |
| `GET /view?filename&subfolder&type` | скачивание PNG | да |

Ожидание завершения — опрос `/history/{prompt_id}` раз в секунду (WebSocket не нужен). Очередь скрипт не очищает и не прерывает: при непустой очереди он отказывается отправлять задание.

## Выбранный workflow

`workflows/anima-crimson-oath.api.json` — API-копия графа, извлечённая из метаданных `output/Anima_01485_.png` (основной рабочий граф: модель `vetehineCrimsonOathILL_v02ANM`). Оригиналы не менялись. Отличия копии от оригинала: положительный промпт заменён нейтральным тестовым, `seed=123456789`, `filename_prefix=NeuroStudio/smoke` (чтобы результаты шли в подпапку).

Граф Duskrose (`Duskrose v4 ANM`) имеет ту же структуру; для него достаточно подменить `90:78.unet_name`.

### Структура графа

```
UNETLoader 90:78 (vetehineCrimsonOathILL_v02ANM) ──┬─► ComfySwitch 90:84 ─► KSampler 90:76 ─► VAEDecode 90:73 ─► SaveImage 46
LoraLoaderModelOnly 90:83 (Smooth_Booster_v5) ──────┘          ▲  ▲  ▲
CLIPLoader 90:71 (animij_s1_txt) ─► CLIPTextEncode 90:77 (+) ──┘  │  └ EmptyLatentImage 90:74 ◄ ResolutionSelector 91
                                  └► CLIPTextEncode 90:75 (−) ────┘
PrimitiveBoolean 90:89 (false) переключает: steps 90:79=35 | 90:81=8, cfg 90:86=4.0 | 90:88=1.0, модель с LoRA | без
VAELoader 90:72 (qwen_image_vae)
```

Sampler: `er_sde`, scheduler `simple`, denoise 1.0. `90:89 = false` — обычный режим (35 шагов, CFG 4.0, без LoRA). Переключатель `true` включает быстрый режим Smooth Booster (8 шагов, CFG 1.0) — NeuroStudio его не трогает.

### Поля, которые NeuroStudio может менять

Единственное место соответствия — `FIELDS` в `src/comfy.ts`. Перед подстановкой проверяются id ноды, `class_type`, наличие поля и тип значения.

| Параметр | Нода.поле | Класс | Значение в копии |
|---|---|---|---|
| `positive` | `90:77.text` | CLIPTextEncode | тестовый промпт |
| `negative` | `90:75.text` | CLIPTextEncode | стандартный негатив пользователя |
| `seed` | `90:76.seed` | KSampler | целое 0…2^53−1 |
| `steps` | `90:79.value` | PrimitiveInt | 35 |
| `cfg` | `90:86.value` | PrimitiveFloat | 4.0 |
| `aspectRatio` | `91.aspect_ratio` | ResolutionSelector | `2:3 (Portrait Photo)` |
| `megapixels` | `91.megapixels` | ResolutionSelector | 3.0 (шаг `multiple` 20) |
| `filenamePrefix` | `46.filename_prefix` | SaveImage | `NeuroStudio/smoke` |

Остальное (модели, LoRA, sampler, scheduler, переключатель) — не изменять. Допустимые значения `aspect_ratio` брать из `/object_info/ResolutionSelector`.

## Запуск

Предусловия: запущен ComfyUI (Desktop или `main.py`) на `127.0.0.1:8188`, очередь пуста.

```bash
npm install
npm test            # 4 теста, без GPU
npm run typecheck
npm run smoke       # одна реальная генерация; COMFY_URL=... для другого адреса
```

Результат: `output/smoke/smoke-<prompt_id>.png` и `.json` (параметры, граф, ответ history, версия ComfyUI, время). Каталог `output/` в `.gitignore`.

## Результат реального прогона

2026-11-09: ComfyUI 0.44.2, `prompt_id=045a3f39-0e82-471a-ae2c-d845079ba6fd`, PNG 2.75 МБ (1440×2176, 2:3, 3 МП), 69.7 с с холодной загрузкой моделей (в логе Desktop повторная генерация — около 55 с). Одна генерация, повторов не было.

## Ограничения и заметки для NS-002

- Workflow в UI-формате отсутствует в `user/default/workflows` — API-граф получен из метаданных PNG. Для новых графов (Duskrose, Krea2 и др.) использовать тот же способ или «Export (API)».
- Метаданные PNG содержат полный промпт — не публиковать результаты без обработки метаданных, если это важно.
- Сид: ComfyUI принимает до 2^64, в TS используем безопасные целые до 2^53.
- Один рабочий граф на 16 ГБ VRAM: параллельные задания не нужны, очередь ComfyUI последовательная; клиент должен проверять очередь, так как пользователь может генерировать вручную.
- ComfyUI Desktop может не быть запущен: NS-002 должен либо ожидать запуск, либо запускать `main.py` самостоятельно (команда в `comfyui-audit.md`); решение за продуктом.
- `--enable-manager`/`--enable-assets` для API не нужны.
