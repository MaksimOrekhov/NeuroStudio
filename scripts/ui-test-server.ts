// Isolated TEST server for looking at the production UI (NS-015): the real API and web/dist over FAKE data,
// a fake ComfyUI and a fake Codex. It never starts ComfyUI or Codex and never touches output/.
//   npm run build && npx tsx scripts/ui-test-server.ts [--port 8791] [--slow]
import { join, resolve } from "node:path";
import { createFakeApp, createFixture } from "../tests/fixtures/uiFixture.ts";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8791);
const fx = await createFixture();
const { app } = await createFakeApp({ fx, port, behaviour: { imageMs: argv.includes("--slow") ? 4000 : 400 }, webDist: join(root, "web/dist") });
await app.listen({ host: "127.0.0.1", port });
console.log(`UI TEST SERVER (fake data, fake ComfyUI, fake Codex): http://127.0.0.1:${port}\ndata: ${fx.dir}`);
