import type { PluginRpcContract } from '@getpaseo/plugin';
import { pollNow, removeToken, saveToken, savePreferences, snapshot, unsubscribe } from '../../shared/contracts.ts';
import type { Snapshot } from '../../shared/model.ts';
import { makeSnapshot, type Scene } from './fixtures.ts';
import { makeAutomation, makeBrowser } from './control-fixtures.ts';
import type { SessionPolicy } from '../../shared/automation.ts';
import type { BrowserBindingInput, BrowserSettings } from '../../shared/browser.ts';

export interface RpcLogEntry {
  name: string;
  at: number;
  /** 令牌只记录长度，不记录内容。 */
  summary: string;
}

/** 内存里的假守护进程：用真实合约的 Zod 校验输入和输出。 */
export class FakeDaemon {
  automation = makeAutomation();
  browser = makeBrowser();
  adspowerApiKeyConfigured = false;
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
    const summary = contract.name === saveToken.name
      ? `token(${String((parsed as { token: string }).token.length)} 字符)`
      : contract.name === 'browser.usage.save_api_key'
        ? `apiKey(${String((parsed as { apiKey: string }).apiKey.length)} 字符)`
        : JSON.stringify(parsed).slice(0, 120);
    this.log.push({ name: contract.name, at: Date.now(), summary });
    if (this.down) throw new Error('插件服务未响应（fixture：模拟离线）');
    return contract.output.parse(this.handle(contract.name, parsed)) as O;
  }

  private handle(name: string, input: Record<string, unknown>): unknown {
    switch (name) {
      case 'automation.snapshot': return this.automation;
      case 'automation.pause': this.automation = { ...this.automation, paused: Boolean(input.paused) }; return this.automation;
      case 'automation.policy': {
        const policy = input as unknown as SessionPolicy;
        this.automation = { ...this.automation, policies: [...this.automation.policies.filter(item => item.agentId !== policy.agentId), policy] };
        return this.automation;
      }
      case 'browser.snapshot': return this.browser;
      case 'browser.configure': this.browser = { ...this.browser, settings: input as unknown as BrowserSettings, connected: Boolean(input.enabled) }; return this.browser;
      case 'browser.pairing': return { url: `http://127.0.0.1:${this.browser.settings.port}/sync`, token: '演示配对令牌，无实际权限' };
      case 'browser.usage.snapshot': return { adspowerApiKeyConfigured: this.adspowerApiKeyConfigured };
      case 'browser.usage.save_api_key': this.adspowerApiKeyConfigured = Boolean(String(input.apiKey ?? '').trim()); return { adspowerApiKeyConfigured: this.adspowerApiKeyConfigured };
      case 'browser.usage.remove_api_key': this.adspowerApiKeyConfigured = false; return { adspowerApiKeyConfigured: false };
      case 'browser.bind': {
        const binding = input as unknown as BrowserBindingInput;
        this.browser = { ...this.browser, bindings: this.browser.bindings.filter(item => item.instanceId !== binding.instanceId || item.sessionId !== binding.sessionId),
          sessions: this.browser.sessions.map(session => session.instanceId === binding.instanceId && session.sessionId === binding.sessionId
            ? { ...session, agentId: binding.agentId, groupTitle: this.automation.sessions.find(item => item.id === binding.agentId)?.title ?? session.title } : session) };
        if (binding.agentId) this.browser.bindings.push({ ...binding, agentId: binding.agentId });
        return this.browser;
      }
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
