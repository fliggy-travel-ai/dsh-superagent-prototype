import * as presenceRpc from '../../../shared/presence.ts';
import * as bluetoothRpc from '../../../shared/bluetooth.ts';
import { readGuardPresence } from '../../guard-presence.ts';
import { listBluetoothTargets, saveBluetoothTarget } from '../../bluetooth-target.ts';
import { OWNER_ONLY_FALLBACK, OwnerOnlyConfigSchema, type OwnerOnlyConfig } from '../../questions.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 问答模式与蓝牙在场判定、语音提醒。 */
export const presenceModule: Module<OwnerOnlyConfig> = {
  id: 'answer.presence',
  label: '问答模式与蓝牙',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  config: {
    section: 'ownerOnly',
    spec: { schema: OwnerOnlyConfigSchema, fallback: OWNER_ONLY_FALLBACK },
  },
  register(context) {
    const { server, config } = context;
    const services = mainOf(context);
    if (config?.localKeywords) services.ownerOnlyKeywords = config.localKeywords;
    const ready = () => services.readyPresence();
    void ready().catch(() => {});
    server.handle(presenceRpc.presenceSnapshot, async () => (await ready()).snapshot());
    server.handle(presenceRpc.presenceConfigure, async input => (await ready()).configure(input));
    server.handle(presenceRpc.presenceAnswer, async input => (await ready()).answer(input));
    server.handle(presenceRpc.presenceLocal, async () => readGuardPresence());
    server.handle(presenceRpc.presenceLocalSpeech, async () => {
      const current = await ready();
      return { enabled: current.localSpeechEnabled(), configured: current.localSpeechConfigured() };
    });
    server.handle(presenceRpc.presenceConfigureLocalSpeech, async ({ enabled }) => (await ready()).configureLocalSpeech(enabled));
    server.handle(presenceRpc.presenceSpeak, async ({ id, text }) => {
      const current = await ready();
      if (!current.localSpeechEnabled()) {
        return { played: false, cancelled: true, detail: '本机语音提醒已关闭' };
      }
      return services.presenceHosts!.localSpeech(id, text);
    });
    server.handle(presenceRpc.presenceSpeakCancel, async ({ id }) => ({ cancelled: services.presenceHosts?.localCancel(id) ?? false }));
    server.handle(bluetoothRpc.bluetoothLocalList, async () => listBluetoothTargets());
    server.handle(bluetoothRpc.bluetoothLocalSelect, async input => saveBluetoothTarget(input));
    // 只读设备列表：按请求的主机读取，不因界面与设置短暂不一致而报错；选择设备时仍校验来源主机。
    server.handle(bluetoothRpc.bluetoothList, async ({ hostId }) => {
      await ready();
      return services.presenceHosts!.bluetooth(hostId);
    });
    server.handle(bluetoothRpc.bluetoothSelect, async ({ hostId, target }) => {
      const current = await ready();
      const hosts = services.presenceHosts!;
      return current.changeBluetoothTarget(hostId, (left, right) => hosts.sameHost(left, right), () => hosts.selectBluetooth(hostId, target));
    });
    const removeRequested = server.addHook('agent.permission.before', async () => { void ready().then(current => current.refresh()).catch(() => {}); });
    return () => { removeRequested(); };
  },
};
