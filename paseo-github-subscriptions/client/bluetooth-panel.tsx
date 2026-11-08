import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { BluetoothSnapshot, BluetoothTarget } from '../shared/bluetooth.ts';
import { Btn, Card, Chip, Notice, useUi } from './ui.tsx';

export function BluetoothPanel({ hostId, busy }: { hostId: string | null; busy: boolean }) {
  const { control, s, theme } = useUi();
  const [snapshot, setSnapshot] = useState<BluetoothSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  async function refresh() {
    const version = ++generation.current;
    setLoading(true); setError(null);
    try {
      const result = await control.bluetoothDevices(hostId);
      if (version === generation.current) {
        setSnapshot(previous => result.error && previous ? { ...previous, target: result.target } : result);
        setError(result.error);
      }
    } catch (failure) { if (version === generation.current) setError(failure instanceof Error ? failure.message : '设备刷新失败，已保留当前选择'); }
    finally { if (version === generation.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [hostId]);
  async function choose(target: BluetoothTarget) {
    const version = ++generation.current;
    setSaving(true); setError(null); setMessage(null);
    try {
      const saved = await control.selectBluetooth(hostId, target);
      if (version === generation.current) {
        setSnapshot(previous => ({ target: saved, devices: previous?.devices ?? [], error: null }));
        setMessage('设备已保存。等待来源主机采样；稳定距离判定需要持续一至两分钟。');
      }
    } catch (failure) {
      if (version === generation.current) {
        setSaving(false);
        await refresh();
        if (generation.current === version + 1) setError(`保存结果未确认，已尝试重新读取当前设备：${failure instanceof Error ? failure.message : '请检查连接'}`);
      }
    }
    finally { if (version === generation.current) setSaving(false); }
  }
  const disabled = busy || loading || saving;
  const selected = (device: BluetoothTarget) => snapshot?.target.address ? device.address === snapshot.target.address : device.address === null && device.name === snapshot?.target.name;
  const detected = snapshot?.devices.some(device => snapshot.target.address ? device.address === snapshot.target.address : device.name === snapshot.target.name);
  return <Card title="蓝牙锚定设备">
    <Text style={s.muted}>选择你随身携带的设备，用信号强度判断是否离开。</Text>
    <View style={s.row}><Btn label={loading ? '正在读取设备…' : '刷新设备'} disabled={disabled} onPress={() => { void refresh(); }} /></View>
    {snapshot ? <View style={[s.row, { flexWrap: 'wrap' }]}><Text style={s.strong}>当前设备：{snapshot.target.name}{snapshot.target.address ? ` · ${snapshot.target.address.slice(-8)}` : ' · 按名称匹配'}</Text><Chip label={detected ? '已发现' : '未发现'} tone={detected ? 'success' : 'warning'} /></View> : <Text style={s.muted}>{loading ? '正在读取来源主机的蓝牙设备，最长约 25 秒。' : '尚未读取设备配置。'}</Text>}
    {error ? <Notice tone="warning"><Text style={s.text}>{error}</Text></Notice> : null}
    {message ? <Text style={s.muted}>{message}</Text> : null}
    {snapshot?.devices.map((device, index) => <View key={`${device.address ?? device.name}-${index}`} style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
      <View style={{ flexShrink: 1 }}><Text style={s.text}>{device.name}{device.address ? ` · ${device.address.slice(-8)}` : ''}</Text><Text style={s.muted}>{device.connected ? '已连接' : '未连接'} · {device.rssi === null ? '暂无信号强度' : `${device.rssi} dBm`}</Text></View>
      <Btn label={selected(device) ? '当前选择' : '选择设备'} disabled={disabled || selected(device)} onPress={() => { void choose({ name: device.name, address: device.address }); }} />
    </View>)}
    <Text style={s.strong}>手动输入设备完整名称</Text>
    <TextInput accessibilityLabel="蓝牙设备完整名称" placeholder="输入系统蓝牙列表中的完整名称" placeholderTextColor={theme.colors.foregroundMuted} value={name} onChangeText={setName} editable={!disabled} maxLength={200} style={[s.text, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 }]} />
    <Text style={s.muted}>按名称匹配时，同名设备有多台会无法判定。设备暂未发现时保留选择，不会自动更换设备。</Text>
    <Btn label={saving ? '正在保存…' : '按完整名称保存'} disabled={disabled || !name.trim()} onPress={() => { void choose({ name: name.trim(), address: null }); }} />
  </Card>;
}
