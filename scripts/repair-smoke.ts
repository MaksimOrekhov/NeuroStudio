// NS-031 end-to-end smoke test: ONE real local repair through the running NeuroStudio server and the real ComfyUI (one GPU job).
// It never retries and never installs anything. Run it only after the implementation review and after the Inpainting v2 adapter
// was installed in ComfyUI Desktop (with your consent and a SHA-256 check; see GET /api/repair/status for the steps).
//
//   npm start                                   (NeuroStudio on 127.0.0.1:8787, ComfyUI Desktop running)
//   npx tsx scripts/repair-smoke.ts --collection <id> --frame 1 --variant 1 --disc 640,1500,90 \
//       --text "the patterned woven rug continuing between her feet" [--preset remove|fix] [--region 1024|512] --confirm
//
// --disc x,y,r (repeatable) paints white discs at image coordinates; --mask <png> uses a ready mask (white = repair, image size).
// Afterwards the script checks on disk, independently of the server, that every pixel outside the feathered zone is unchanged.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const all = (k: string) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const server = arg("--server") ?? "http://127.0.0.1:8787";
const collectionsDir = arg("--collections") ?? resolve(import.meta.dirname, "..", "output/collections");
const id = arg("--collection");
const frame = Number(arg("--frame") ?? 1);
const variant = Number(arg("--variant") ?? 1);
const text = arg("--text");
const preset = (arg("--preset") ?? "remove") as "remove" | "fix";
const region = Number(arg("--region") ?? 1024);
const denoise = Number(arg("--denoise") ?? (preset === "fix" ? 0.65 : 1));

function die(msg: string): never {
  console.error(`repair-smoke: ${msg}`);
  process.exit(1);
}
if (!id || !text) die("--collection and --text are required");
if (!argv.includes("--confirm")) die("this starts ONE real GPU job in ComfyUI; add --confirm to run it");

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(server + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) die(`${init?.method ?? "GET"} ${path}: HTTP ${r.status} ${body.code ?? ""} ${body.error ?? ""}`);
  return body;
};

const status = await api("/api/repair/status");
if (!status.ready) die(`repair is not available in ComfyUI: ${status.problems.join("; ")}${status.instructions ? `\n${status.instructions}` : ""}`);
const info = await api(`/api/collections/${encodeURIComponent(id)}/frames/${frame}/variants/${variant}/repair`);
if (!info.available) die(`variant not repairable: ${info.code} ${info.reason}`);
const run0 = (await api("/api/status")).run;
if (run0.status === "planning" || run0.status === "generating") die("another generation is running; wait for it to finish");

let maskPng: Buffer;
if (arg("--mask")) maskPng = await readFile(arg("--mask")!);
else {
  const discs = all("--disc").map((d) => d.split(",").map(Number));
  if (!discs.length || discs.some((d) => d.length !== 3 || d.some((n) => !Number.isFinite(n)))) die("give --mask <png> or at least one --disc x,y,r");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}"><rect width="100%" height="100%" fill="#000"/>${discs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`).join("")}</svg>`;
  maskPng = await sharp(Buffer.from(svg)).png().toBuffer();
}

const t0 = Date.now();
const started = await api(`/api/collections/${encodeURIComponent(id)}/frames/${frame}/repair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sourceVariant: variant, mask: `data:image/png;base64,${maskPng.toString("base64")}`, text, denoise, region, preset }),
});
const made = started.regeneration;
console.log(`accepted: frame ${frame}, new variant ${made.variant} from variant ${made.sourceVariant}`);
let run = started;
while (run.status === "generating") {
  await new Promise((r) => setTimeout(r, 2000));
  run = (await api("/api/status")).run;
}
const seconds = (Date.now() - t0) / 1000;
if (run.status !== "completed") die(`repair ${run.status}: ${run.errorCode ?? ""} ${run.error ?? ""}`);

// Independent check on disk: source vs result outside the stored blend mask.
const cdir = join(collectionsDir, id);
const name = `scene-${String(frame).padStart(2, "0")}-v${String(made.variant).padStart(2, "0")}`;
const side = JSON.parse(await readFile(join(cdir, `${name}.json`), "utf8"));
const [src, out, blend] = await Promise.all([
  sharp(await readFile(join(cdir, side.repair.source.png))).raw().toBuffer({ resolveWithObject: true }),
  sharp(await readFile(join(cdir, `${name}.png`))).raw().toBuffer({ resolveWithObject: true }),
  sharp(await readFile(join(cdir, side.repair.files.blend))).raw().toBuffer({ resolveWithObject: true }),
]);
let outside = 0, inside = 0;
for (let i = 0; i < src.info.width * src.info.height; i++) {
  const same = [0, 1, 2].every((c) => src.data[i * src.info.channels + c] === out.data[i * out.info.channels + c]);
  if (!same) blend.data[i * blend.info.channels] === 0 ? outside++ : inside++;
}
console.log(JSON.stringify({ variant: made.variant, image: `${name}.png`, seconds, promptId: side.promptId, seed: side.seed, crop: side.repair.crop, region: side.repair.region, denoise: side.repair.denoise, changedOutsideZone: outside, changedInsideZone: inside, serverVerification: side.repair.verification }, null, 1));
if (outside) die(`${outside} pixels outside the repair zone differ`);
console.log("OK: one repair, pixels outside the zone unchanged. Look at the new variant in the library.");
