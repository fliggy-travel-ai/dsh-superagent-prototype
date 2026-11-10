import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState } from "../server/notify/engine.ts";
import { loadState, saveState } from "../server/notify/store.ts";
test("状态文件原子持久化且权限受限，损坏状态不静默清空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paseo-events-"));
  try {
    const path = join(dir, "state.json");
    assert.deepEqual(await loadState(path), emptyState());
    const s = emptyState();
    s.pending["问题"] = {
      agentId: "主会话",
      requestId: "问题",
      at: 123,
      data: {},
    };
    await saveState(path, s);
    assert.deepEqual(await loadState(path), s);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(await readFile(path, "utf8"));
    await writeFile(path, "损坏");
    await assert.rejects(loadState(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
