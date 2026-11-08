import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { BluetoothSnapshot, BluetoothTarget } from '../shared/bluetooth.ts';
import type { PresenceSnapshot } from '../shared/presence.ts';
import { Btn, Card, Chip, Notice, useUi } from './ui.tsx';

export function BluetoothPanel({ hostId, busy, mode, observation, onToggle }: {
  hostId: string | null; busy: boolean; mode: PresenceSnapshot['settings']['mode'];
  observation: PresenceSnapshot['observation']; onToggle(enabled: boolean): void;
}) {
  const { control, s, theme } = useUi();
  const [expanded, setExpanded] = useState(false);
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
        setMessage('手机已修改，等待新的距离判定。');
        setExpanded(false); setName('');
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
  const automatic = mode === 'auto';
  const age = observation.observedAt ? Date.now() - Date.parse(observation.observedAt) : NaN;
  const fresh = age >= -5000 && age < 120_000;
  const distance = !automatic ? '未启用' : !fresh ? '等待采样' : observation.source === 'manual' ? '手动覆盖'
    : observation.source !== 'bluetooth' || observation.mode === 'unknown' ? '未知' : observation.mode === 'online' ? '较近' : '较远';
  const selected = (device: BluetoothTarget) => snapshot?.target.address ? device.address === snapshot.target.address : device.address === null && device.name === snapshot?.target.name;
  const detected = snapshot?.devices.some(device => snapshot.target.address ? device.address === snapshot.target.address : device.name === snapshot.target.name);
  return <Card title="蓝牙自动判断" trailing={<Switch accessibilityLabel="按手机距离自动切换在线或离线" value={automatic} disabled={busy || saving} onValueChange={onToggle} />}>
    <Text style={s.muted}>通过手机蓝牙信号预判距离，自动切换在线或离线。</Text>
    <View style={[s.wrap, { gap: 8 }]}>
      <Text style={[s.strong, { flexShrink: 1 }]}>当前手机：{snapshot?.target.name ?? (loading ? '读取中…' : '暂未读取')}</Text>
      <Chip label={`距离预判：${distance}`} tone={distance === '较近' ? 'success' : distance === '较远' ? 'accent' : 'neutral'} />
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起设备选择' : '修改识别手机'} accessibilityState={{ expanded, disabled: busy || saving }} disabled={busy || saving}
        onPress={() => { setExpanded(!expanded); if (!expanded && !loading) void refresh(); }} style={[s.button, { paddingVertical: 4, paddingHorizontal: 8 }]}>
        <Text style={s.buttonText}>{expanded ? '收起设备选择' : '修改识别手机'}</Text>
      </Pressable>
    </View>
    {!automatic ? <Text style={s.small}>自动判断已关闭，当前为手动{mode === 'online' ? '在线' : '离线'}。</Text> : null}
    {error ? <Notice tone="warning"><Text style={s.text}>{error}</Text></Notice> : null}
    {message ? <Text style={s.muted}>{message}</Text> : null}
    {expanded ? <View style={{ gap: 10, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 10 }}>
      <View style={s.wrap}><Btn small label={loading ? '正在识别蓝牙设备…' : '刷新设备'} disabled={disabled} onPress={() => { void refresh(); }} />
        {snapshot ? <Chip label={detected ? '当前手机已发现' : '当前手机未发现'} tone={detected ? 'success' : 'warning'} /> : null}
      </View>
      <Text style={s.small}>选择随身携带的手机。信号仅用于预判远近，不表示准确距离。</Text>
      <ScrollView accessibilityLabel="可选蓝牙设备" nestedScrollEnabled style={{ maxHeight: 280 }} contentContainerStyle={{ gap: 10 }}>
        {snapshot?.devices.map((device, index) => <View key={`${device.address ?? device.name}-${index}`} style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
          <View style={{ flexShrink: 1 }}><Text style={s.text}>{device.name}{device.address ? ` · ${device.address.slice(-8)}` : ''}</Text><Text style={s.muted}>{device.connected ? '已连接' : '未连接'} · {device.rssi === null ? '暂无信号强度' : `${device.rssi} dBm`}</Text></View>
          <Btn small label={selected(device) ? '当前选择' : '选择手机'} disabled={disabled || selected(device)} onPress={() => { void choose({ name: device.name, address: device.address }); }} />
        </View>)}
      </ScrollView>
      {snapshot && !snapshot.devices.length && !loading ? <Text style={s.muted}>未发现蓝牙设备，可以刷新或输入手机完整名称。</Text> : null}
      <Text style={s.strong}>手动输入设备完整名称</Text>
      <TextInput accessibilityLabel="蓝牙设备完整名称" placeholder="输入系统蓝牙列表中的完整名称" placeholderTextColor={theme.colors.foregroundMuted} value={name} onChangeText={setName} editable={!disabled} maxLength={200} style={[s.text, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10 }]} />
      <Text style={s.muted}>按名称匹配时，同名设备有多台会无法判定。设备暂未发现时保留选择，不会自动更换设备。</Text>
      <Btn label={saving ? '正在保存…' : '按完整名称保存'} disabled={disabled || !name.trim()} onPress={() => { void choose({ name: name.trim(), address: null }); }} />
    </View> : null}
  </Card>;
}
