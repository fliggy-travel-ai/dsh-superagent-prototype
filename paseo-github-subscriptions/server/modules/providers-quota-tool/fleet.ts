import type { HostEntry } from '../../core/hosts.ts';
import { summarizeError } from '../../core/modules.ts';
import {
  LocalHostQuotasSchema,
  localProviderQuotas,
  mergeFleetQuotas,
  type FleetQuotas,
  type FleetQuotasInput,
  type HostCollectionInput,
  type LocalHostQuotas,
} from '../../../shared/provider-quota-tool.ts';

function isMissingRpcMethodError(error: unknown): boolean {
  if (error && typeof error === 'object' && error.constructor?.name === 'DeadlineError') return false;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/(?:timeout|timed out|超时|offline|离线|disconnected|transport|socket|connection|not connected|closed)/i.test(msg)) {
    return false;
  }
  return /does not contribute RPC|method not found|unknown (?:plugin )?(?:rpc|method)|no handler|unregistered|未知调用|未知接口|未注册|未实现/i.test(msg);
}

export interface FleetQuotasPort {
  hosts(): Promise<HostEntry[]>;
  selfId(): string;
  local(self: HostEntry, refresh: boolean): Promise<LocalHostQuotas>;
  remote(host: HostEntry, refresh: boolean): Promise<unknown>;
}

/**
 * 并行采集本机与所有已配对在线主机的 Provider 额度，按底层账号去重并汇总各主机支持情况。
 * 离线、超时或未升级插件的主机在 `hosts` 中显式报告错误，不静默忽略。
 */
export async function collectFleetQuotas(
  port: FleetQuotasPort,
  input: FleetQuotasInput & { now?: () => number } = {},
): Promise<FleetQuotas> {
  const now = input.now ?? Date.now;
  const refresh = input.refresh === true;
  const concurrencyTarget = input.concurrencyTarget ?? 3;

  const listed = await port.hosts();
  const selfId = listed[0]?.id ?? port.selfId();

  const settled: HostCollectionInput[] = await Promise.all(listed.map(async (host, index) => {
    const isSelf = index === 0 || host.id === selfId;
    if (isSelf) {
      try {
        const data = await port.local(host, refresh);
        return {
          serverId: host.id,
          hostName: host.name,
          isSelf: true,
          online: true,
          data,
          error: null,
        };
      } catch (error) {
        return {
          serverId: host.id,
          hostName: host.name,
          isSelf: true,
          online: true,
          data: null,
          error: `读取本机额度失败：${summarizeError(error)}`,
        };
      }
    }

    if (!host.online) {
      return {
        serverId: host.id,
        hostName: host.name,
        isSelf: false,
        online: false,
        data: null,
        error: '主机离线',
      };
    }

    try {
      const raw = await port.remote(host, refresh);
      const data = LocalHostQuotasSchema.parse(raw);
      return {
        serverId: host.id,
        hostName: host.name,
        isSelf: false,
        online: true,
        data,
        error: null,
      };
    } catch (error) {
      const reason = isMissingRpcMethodError(error)
        ? `目标主机插件未提供 ${localProviderQuotas.name}，请升级并重载目标主机插件`
        : summarizeError(error);
      return {
        serverId: host.id,
        hostName: host.name,
        isSelf: false,
        online: true,
        data: null,
        error: reason,
      };
    }
  }));

  return mergeFleetQuotas(settled, {
    collectedAt: new Date(now()).toISOString(),
    concurrencyTarget,
    kind: input.kind,
    includeUnavailable: input.includeUnavailable === true,
  });
}
