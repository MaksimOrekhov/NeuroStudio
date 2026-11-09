import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import yazl from "yazl";
import { chooseScenes, exportStatus, safeImagePath, type CollectionView } from "./collections.ts";

export class ExportError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Validated list of the 4 files to put in the archive, or an ExportError. Reads nothing but file metadata. */
export async function planExport(dir: string, c: CollectionView): Promise<{ name: string; path: string }[]> {
  const st = exportStatus(c);
  if (!st.ready) throw new ExportError(st.message ?? "Export is not available", 409);
  const files: { name: string; path: string }[] = [];
  for (const choice of chooseScenes(c)) {
    const path = safeImagePath(dir, c.id, choice.image!);
    if (!path) throw new ExportError(`scene ${choice.frame}: invalid image path`, 409);
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
    } catch {
      throw new ExportError(`scene ${choice.frame}: image file ${choice.image} is missing on disk`, 409);
    }
    files.push({ name: `scene-0${choice.frame}.png`, path });
  }
  return files;
}

/** Streams a ZIP of the original PNG bytes (stored, no recompression); nothing is buffered or written to disk. */
export function zipStream(files: { name: string; path: string }[]): Readable {
  const zip = new yazl.ZipFile();
  for (const f of files) zip.addFile(f.path, f.name, { compress: false });
  zip.end();
  return zip.outputStream as unknown as Readable; // yazl types it as a generic stream; it is a Node Readable
}
