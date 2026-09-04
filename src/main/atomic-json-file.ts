import { randomUUID } from "node:crypto";
import { mkdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function resolveWriteTarget(filePath: string): Promise<string> {
  let target = filePath;
  for (let depth = 0; depth < 40; depth += 1) {
    let link: string;
    try {
      link = await readlink(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINVAL" || code === "ENOENT") return target;
      throw error;
    }
    target = resolve(await realpath(dirname(target)), link);
  }
  throw new Error("Too many configuration symlink levels.");
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const target = await resolveWriteTarget(filePath);
  await mkdir(dirname(target), { recursive: true });
  const temporaryPath = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
    await rename(temporaryPath, target);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
