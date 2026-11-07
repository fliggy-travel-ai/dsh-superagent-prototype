import type { PluginRpcContract } from '@getpaseo/plugin';
import { pollNow, removeToken, saveToken, savePreferences, snapshot, unsubscribe } from '../../shared/contracts.ts';
import type { Snapshot } from '../../shared/model.ts';
import { makeSnapshot, type Scene } from './fixtures.ts';

export interface RpcLogEntry {
  name: string;
  at: number;
  /** 令牌只记录长度，不记录内容。 */
  summary: string;
}

/** 内存里的假守护进程：用真实合约的 Zod 校验输入和输出。 */
export class FakeDaemon {
  state: Snapshot;
  readonly log: RpcLogEntry[] = [];
  latencyMs = 150;
  /** 为 true 时所有调用失败，模拟插件服务不可用。 */
  down = false;
  /** 令牌保存的下一次结果错误文字里会带上令牌，用来验证界面脱敏。 */
  constructor(scene: Scene) {
    this.state = makeSnapshot(scene);
    this.down = scene === 'offline';
  }

  async rpc<I, O>(contract: PluginRpcContract, input: I): Promise<O> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const parsed = contract.input.parse(input) as Record<string, unknown>;
    this.log.push({ name: contract.name, at: Date.now(), summary: contract.name === saveToken.name ? `token(${String((parsed as { token: string }).token.length)} 字符)` : JSON.stringify(parsed).slice(0, 120) });
    if (this.down) throw new Error('插件服务未响应（fixture：模拟离线）');
    return contract.output.parse(this.handle(contract.name, parsed)) as O;
  }

  private handle(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
      case snapshot.name:
      case pollNow.name:
        return this.state;
      case unsubscribe.name: {
        const before = this.state.subscriptions.length;
        this.state = { ...this.state, subscriptions: this.state.subscriptions.filter((item) => item.id !== input.id) };
        return { removed: this.state.subscriptions.length < before };
      }
      case savePreferences.name:
        this.state = { ...this.state, preferences: input as Snapshot['preferences'] };
        return this.state.preferences;
      case saveToken.name: {
        const token = String(input.token);
        if (token.startsWith('bad')) throw new Error(`GitHub 拒绝了令牌 ${token}（401）`);
        this.state = { ...this.state, token: { ...this.state.token, configured: true, prefix: `${token.slice(0, 5)}…`, login: 'bbm9527', error: null } };
        return this.state.token;
      }
      case removeToken.name:
        this.state = { ...this.state, token: { configured: false, prefix: null, login: null, remaining: null, resetAt: null, error: null } };
        return this.state.token;
      default:
        throw new Error(`未知调用 ${name}`);
    }
  }
}
