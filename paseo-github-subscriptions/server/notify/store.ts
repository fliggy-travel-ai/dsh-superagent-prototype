import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyState, type State } from "./engine.ts";
export async function loadState(path: string): Promise<State> {
  try {
    const s = JSON.parse(await readFile(path, "utf8")) as State;
    if (!s.pending || !Array.isArray(s.outbox) || !s.seen)
      throw Error("通知状态文件损坏");
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw e;
  }
}
export async function saveState(path: string, state: State) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
