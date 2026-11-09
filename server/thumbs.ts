import { mkdir, rename, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";

export const THUMB_WIDTH = 512;

const inflight = new Map<string, Promise<string>>();

/**
 * Returns the path of the WebP thumbnail of `srcPath`, creating it on first use.
 * A cached thumbnail is reused while its mtime equals the source mtime; otherwise it is rebuilt.
 * Identical concurrent requests share one conversion. The source PNG is only read.
 */
export async function getThumbnail(thumbsDir: string, id: string, srcPath: string): Promise<string> {
  const out = join(thumbsDir, id, basename(srcPath, ".png") + ".webp");
  const src = await stat(srcPath); // throws ENOENT if the original is gone
  try {
    const cached = await stat(out);
    if (Math.abs(cached.mtimeMs - src.mtimeMs) < 2) return out;
  } catch {
    /* not cached yet */
  }
  let job = inflight.get(out);
  if (!job) {
    job = (async () => {
      await mkdir(join(thumbsDir, id), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      await sharp(srcPath).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toFile(tmp);
      await utimes(tmp, src.atimeMs / 1000, src.mtimeMs / 1000); // mtime marks which source version this was made from
      await rename(tmp, out);
      return out;
    })().finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}
