import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";

/** Injectable file operations shared by the existing atomic writers and their failure tests. */
export const io = { writeFile, rename, unlink };

/** Replace only after the complete write. Each call owns its temp file, including during cleanup. */
export async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(tmp, data, { flag: "wx" });
    for (let i = 0; ; i++) {
      try {
        await io.rename(tmp, file);
        return;
      } catch (e) {
        if (i >= 5 || !["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
  } catch (e) {
    await io.unlink(tmp).catch(() => {});
    throw e;
  }
}
