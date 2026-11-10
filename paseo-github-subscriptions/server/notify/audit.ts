import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export function createAuditWriter(path: string) {
  return async (entry: Record<string, unknown>) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(
      path,
      JSON.stringify({
        version: 1,
        recordedAt: new Date().toISOString(),
        ...entry,
      }) + "\n",
      { mode: 0o600 },
    );
  };
}
