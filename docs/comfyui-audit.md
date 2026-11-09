# ComfyUI audit (NS-001)

Дата аудита: 2026-11-09. Всё, кроме одной тестовой генерации и запуска сервера, выполнялось в режиме чтения.

## Установка

| Параметр | Значение |
|---|---|
| Тип | Comfy Desktop 2, standalone (`win-nvidia`, env `v0.20.1-env1`) |
| Приложение | `E:\ComfyUI\Comfy Desktop\Comfy Desktop.exe` |
| Каталог установки | `E:\Comfy-Desktop\ComfyUI-Installs\ComfyUI` |
| Код ComfyUI | `...\ComfyUI\ComfyUI` (git, `main.py`) |
| Версия ComfyUI | **0.44.2** (frontend 1.57.6) |
| Python / Torch | 3.13.12 / 2.10.0+cu130, venv `...\ComfyUI\ComfyUI\.venv` |
| GPU | RTX 5080, 16 303 MB VRAM, 32 GB RAM, DynamicVRAM включён |
| Аргументы Desktop | `--enable-manager`, `--enable-assets` (порт по умолчанию, `portConflict: auto`) |
| API | `http://127.0.0.1:8188` |

Рядом лежат старые установки (`E:\ComfyUI_windows_portable`, `E:\A1111`, `E:\sd5080`), в аудите не использовались; рабочая — Desktop 2 (последний запуск 2026-11-08, лог `...\logs\comfyui.log`).

## Каталоги

- Модели (общие): `E:\Comfy-Desktop\ComfyUI-Shared\models` (подключены через `%APPDATA%\Comfy Desktop\instance-model-paths\inst-*.yaml`)
- Результаты: `E:\Comfy-Desktop\ComfyUI-Shared\output` (~1858 файлов, префиксы `Anima_`, `Krea2_turbo_`, …)
- Input: `E:\Comfy-Desktop\ComfyUI-Shared\input`
- Сохранённые workflow (UI): `...\ComfyUI\user\default\workflows\` — только `image_krea2_turbo_t2i.json` (UI-формат, не Anima).
- **Рабочие Anima-графы лежат во встроенных метаданных PNG** (`prompt` = API-формат, `workflow` = UI-формат) в папке output. Именно оттуда взят проверенный API JSON.

## Модели

- checkpoints: `BSSEquinoxILSemi_v50`, `ltx-2.3-22b-dev-fp8`
- diffusion_models: `vetehineCrimsonOathILL_v02ANM`, `Duskrose v4 ANM`, `SunstoneGemAnima`, `animij_s1`, `pearlyPainterly_v1`, `waterbubbleAnima_v10`, `animosity_krea2Ver10Turbo`, `BSSEquinoxSemi_krea2Int8Convrot`
- text_encoders: `animij_s1_txt`, `gemma_3_12B_it_fp4_mixed`, `qwen3.5_9b_w4a8_gptq`, `qwen3vl_4b_fp8_scaled`, `minimax_music3_text_encoder_pruned_int8_convrot`
- vae: `qwen_image_vae`, `flux2-vae_small`, `minimax_music3_dav`
- loras: `Smooth_Booster_v5`, `depth-control-lora`, `Krea2_TextFusion_Refusal_Reduction`, `BreastSlider-KREA2`, `krea2_darkbrush`, `krea2_macromastia_clothed`, `krea2_thickness`, `gemma-3-12b-it-abliterated…`, `ltx_2.3_22b_distilled…`
- upscale_models: `4x-UltraSharp`, `ESRGAN_4x`, `Remacri 4x`

## Custom nodes

Только `custom_nodes/websocket_image_save.py` (`SaveImageWebsocket`, поставляется с ComfyUI). Сторонних custom nodes нет; `/object_info` отдаёт 1042 класса нод, все из ядра.

## Workflow Anima / Crimson Oath и Vetehine / Duskrose

Из метаданных PNG определено фактически:

| Модель (`UNETLoader`) | LoRA в графе | Картинок в output |
|---|---|---|
| `vetehineCrimsonOathILL_v02ANM` | Smooth_Booster_v5 (выключен переключателем) | 1171 (основной рабочий граф) |
| `Duskrose v4 ANM` | depth-control-lora / Smooth_Booster_v5 (выключены) | 21 |

Графы идентичны по структуре (шаблон «Anima»: 16 нод), различаются только `unet_name`. Подробности — в `comfyui-integration.md`.

## Зависимости

Для выбранного графа проверено по `/object_info`: все 14 классов нод установлены, все файлы моделей (`vetehineCrimsonOathILL_v02ANM`, `animij_s1_txt`, `qwen_image_vae`, `Smooth_Booster_v5`) присутствуют в списках опций. Скрипт повторяет эту проверку перед каждым запуском.

## Состояние на момент аудита и побочные эффекты

- ComfyUI не был запущен (Desktop закрыт, порт 8188 свободен). Для теста я запустил его в фоне тем же venv headless (`python main.py --listen 127.0.0.1 --port 8188 --extra-model-paths-config <копия yaml> --output-directory … --input-directory … --disable-auto-launch`, без manager/assets) и после теста остановил.
- Установка, модели, workflow и существующие изображения не менялись. Единственные записи: логи/БД ComfyUI при старте и один новый файл `output\NeuroStudio\smoke_00001_.png`.
