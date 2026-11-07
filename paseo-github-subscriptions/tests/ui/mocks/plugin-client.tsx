// 预览用：替代 @getpaseo/plugin/client 的运行时 hook。

interface AgentSnapshotLike {
  id: string;
  workspaceId: string;
  provider: string;
  title: string | null;
  parentAgentId: string | null;
}

export function useAgent<T>(_agentId: string, _selector: (agent: AgentSnapshotLike) => T): T | null {
  throw new Error('Plugin state hooks must run inside a workspace panel');
}

export function useWorkspace<T>(_workspaceId: string, _selector: (workspace: never) => T): T | null {
  throw new Error('Plugin state hooks must run inside a workspace panel');
}
