// Screenshots of the production UI over FAKE test data (fake ComfyUI, fake Codex): drives headless Chrome through the
// DevTools protocol. Nothing real is started. Output: docs/screenshots/ns015-*.jpg
//   npm run build && npx tsx scripts/ui-screenshots.ts
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { createFakeApp, createFixture } from "../tests/fixtures/uiFixture.ts";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "docs/screenshots");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 8792;
const DEBUG = 9333;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fx = await createFixture();
const fake = await createFakeApp({ fx, port: PORT, behaviour: { imageMs: 1500 }, webDist: join(root, "web/dist") });
await fake.app.listen({ host: "127.0.0.1", port: PORT });
await mkdir(out, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), "ns15-chrome-"));
const chrome = spawn(CHROME, [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "--headless=new", "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
let tab: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !tab; i++) {
  await sleep(200);
  try {
    tab = ((await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page");
  } catch {
    /* not up yet */
  }
}
if (!tab) throw new Error("Chrome did not start");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const d = JSON.parse(String(m.data));
  if (d.id && pending.has(d.id)) pending.get(d.id)!(d);
};
const cdp = (method: string, params: object = {}) =>
  new Promise<any>((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const js = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

async function open(w: number, h: number, hash: string) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/${hash}` });
  await sleep(1500);
  await js(`location.reload()`);
  await sleep(1500);
}
const click = (text: string, sel = "button") =>
  js(`(() => { const e = [...document.querySelectorAll('${sel}')].find((b) => b.textContent.includes(${JSON.stringify(text)})); if (!e) return false; e.click(); return true; })()`);
const clickIn = (group: string, text: string) =>
  js(`(() => { const e = [...document.querySelectorAll('#${group} ~ * button, [aria-labelledby=${group}] button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
const typeTheme = (text: string) =>
  js(`(() => { const t = document.getElementById('theme'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
async function shot(name: string, fullPage = false) {
  const h = fullPage ? await js(`document.documentElement.scrollHeight`) : undefined;
  if (fullPage) await cdp("Emulation.setDeviceMetricsOverride", { width: await js(`innerWidth`), height: Math.min(h, 3000), deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  await sharp(Buffer.from(r.result.data, "base64")).jpeg({ quality: 82 }).toFile(join(out, `${name}.jpg`));
  console.log("saved", name);
}

for (const [w, h, tag] of [
  [2560, 1440, "2560"],
  [1920, 1080, "1920"],
] as const) {
  await open(w, h, "#create");
  await click("Дополнительные настройки");
  await click("Для каждого кадра");
  await shot(`26-ns015-create-${tag}`);
  await open(w, h, "#library");
  await shot(`27-ns015-library-${tag}`);
  await open(w, h, "#library/2026-11-10-ferry");
  await shot(`28-ns015-detail-4frames-${tag}`);
  await open(w, h, "#library/2026-11-10-ovation");
  await shot(`29-ns015-detail-1frame-${tag}`);
  await open(w, h, "#activity");
  await shot(`30-ns015-activity-history-${tag}`);
}

// Advanced settings with a composition for scene 1 and 2 frames (scenes 3-4 stay hidden and are not sent)
await open(2560, 1440, "#create");
await clickIn("l-fr", "2");
await typeTheme("тихий приморский городок ранней осенью");
await click("Дополнительные настройки");
await js(`document.getElementById('scene-comp-0').querySelector('button').click()`);
await sleep(300);
await shot("34-ns015-create-advanced-2560");

// Lightbox over a real PNG
await open(2560, 1440, "#library/2026-11-10-ferry");
await js(`document.querySelector('.img').click()`);
await sleep(600);
await shot("35-ns015-lightbox-2560");

// A real run through the fake backend, started with the real button: planning, generating.
await open(2560, 1440, "#create");
await clickIn("l-col", "2");
await clickIn("l-fr", "3");
await clickIn("l-var", "2");
await typeTheme("сад после дождя");
await click("Сгенерировать");
await js(`location.hash = '#activity'`);
await sleep(700);
await shot("31-ns015-activity-planning-2560");
await sleep(5000);
await shot("32-ns015-activity-generating-2560");
while (fake.runner.active) await sleep(500);
await sleep(2500);
fake.behaviour.planError = Object.assign(new Error("Codex exited with code 1: stream disconnected"), { name: "CodexError" });
const { CodexError } = await import("../src/codex.ts");
fake.behaviour.planError = new CodexError("Codex exited with code 1: stream disconnected");
await js(`fetch('/api/autopilot/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frames: 2 }) })`);
while (fake.runner.active) await sleep(300);
await sleep(2500);
await shot("33-ns015-activity-codex-failed-2560");

ws.close();
chrome.kill();
await fake.app.close();
process.exit(0);
