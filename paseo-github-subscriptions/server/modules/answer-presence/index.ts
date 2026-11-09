import * as presenceRpc from '../../../shared/presence.ts';
import * as bluetoothRpc from '../../../shared/bluetooth.ts';
import { readGuardPresence } from '../../guard-presence.ts';
import { listBluetoothTargets, saveBluetoothTarget } from '../../bluetooth-target.ts';
import { isMainInstance, mainOf, type Module } from '../types.ts';

/** 问答模式与蓝牙在场判定、语音提醒。 */
export const presenceModule: Module = {
  id: 'answer.presence',
  label: '问答模式与蓝牙',
  defaultEnabled: true,
  appliesTo: isMainInstance,
  register(context) {
    const { server } = context;
    const services = mainOf(context);
    const ready = () => services.readyPresence();
    void ready().catch(() => {});
    server.handle(presenceRpc.presenceSnapshot, async () => (await ready()).snapshot());
    server.handle(presenceRpc.presenceConfigure, async input => (await ready()).configure(input));
    server.handle(presenceRpc.presenceAnswer, async input => (await ready()).answer(input));
    server.handle(presenceRpc.presenceRead, async input => (await ready()).markRead(input));
    server.handle(presenceRpc.presenceLocal, async () => readGuardPresence());
    server.handle(presenceRpc.presenceLocalSpeech, async () => {
      const current = await ready();
      return { enabled: current.localSpeechEnabled(), configured: current.localSpeechConfigured() };
    });
    server.handle(presenceRpc.presenceConfigureLocalSpeech, async ({ enabled }) => (await ready()).configureLocalSpeech(enabled));
    server.handle(presenceRpc.presenceSpeak, async ({ id, text }) => { await ready(); return services.presenceHosts!.localSpeech(id, text); });
    server.handle(presenceRpc.presenceSpeakCancel, async ({ id }) => ({ cancelled: services.presenceHosts?.localCancel(id) ?? false }));
    server.handle(bluetoothRpc.bluetoothLocalList, async () => listBluetoothTargets());
    server.handle(bluetoothRpc.bluetoothLocalSelect, async input => saveBluetoothTarget(input));
    server.handle(bluetoothRpc.bluetoothList, async ({ hostId }) => {
      const current = await ready();
      const hosts = services.presenceHosts!;
      if (!hosts.sameHost(hostId, current.snapshot().settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
      const result = await hosts.bluetooth(hostId);
      if (!hosts.sameHost(hostId, current.snapshot().settings.sourceHostId)) throw new Error('来源主机已变化，请刷新');
      return result;
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
