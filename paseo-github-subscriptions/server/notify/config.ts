/** 通知引擎的运行配置。由各模块根据 machine.json 和会话角色生成，引擎运行中会改动 mains 和 children。 */
export interface Target {
  agentId: string;
  serverId?: string;
  machine?: string;
}

export interface NotifyConfig {
  hostId: string;
  machine: string;
  delivery: 'shadow' | 'live';
  /** 主会话 ID，由会话角色（置顶工作区）维护。 */
  mains: string[];
  /** 子会话 ID 到转发目标（所属主会话）的映射，由父会话标签维护。 */
  children: Record<string, Target>;
  coalesceWindowSeconds?: number;
  /** 返回 true 表示问题还要继续等待，暂不升级。 */
  hold?: (firstSeenAt: number, now: number) => boolean;
}
