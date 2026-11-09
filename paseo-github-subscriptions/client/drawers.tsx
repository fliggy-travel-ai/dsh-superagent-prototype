import { useToast } from '@getpaseo/plugin/client/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { BluetoothSnapshot } from '../shared/bluetooth.ts';
import type { BrowserUsageSettings } from '../shared/browser-usage.ts';
import type { EscalationSnapshot } from '../shared/escalation.ts';
import type { Preferences } from '../shared/model.ts';
import { ago, until } from './format.ts';
import { errorMessage } from './store.ts';
import { Btn, Card, Chip, Notice, RuleNote, Segmented, useControlState, useStoreState, useUi } from './ui.tsx';

type BluetoothDevice = BluetoothSnapshot['devices'][number];
type ImmediateWindow = EscalationSnapshot['immediate'][number];

export type DrawerId =
  | 'browser'
  | 'add-browser'
  | 'cloud'
  | 'qa-mode'
  | 'bluetooth'
  | 'escalation'
  | 'quiet-children'
  | 'speech'
  | 'approval'
  | 'github-config';

const DRAWER_TITLES: Record<DrawerId, string> = {
  browser: '网页版 claude.ai',
  'add-browser': '添加浏览器环境',
  cloud: '云端会话',
  'qa-mode': '问答模式',
  bluetooth: '蓝牙在场判定',
  escalation: '升级通知',
  'quiet-children': '子会话免提醒',
  speech: '语音提醒',
  approval: '精确授权',
  'github-config': 'GitHub 订阅设置',
};

function SectionTitle({ children }: { children: ReactNode }) {
  const { s } = useUi();
  return <Text style={[s.muted, { fontSize: 12, fontWeight: '600', marginTop: 6 }]}>{children}</Text>;
}

function TableRow(props: { cells: ReactNode[]; header?: boolean; first?: boolean }) {
  const { s, theme } = useUi();
  return (
    <View
      style={[
        s.row,
        {
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          borderTopWidth: props.first ? 1 : 0,
          borderTopColor: theme.colors.border,
          flexWrap: 'wrap',
        },
      ]}
    >
      {props.cells.map((cell, idx) => (
        <View key={idx} style={{ flex: idx === 0 ? 1.3 : 1, minWidth: 64, paddingRight: 6 }}>
          {typeof cell === 'string' ? (
            <Text style={props.header ? [s.small, { fontWeight: '600' }] : s.text}>{cell}</Text>
          ) : (
            cell
          )}
        </View>
      ))}
    </View>
  );
}

function StepRow(props: { num: number; title: string; children?: ReactNode }) {
  const { s, theme } = useUi();
  return (
    <View
      style={[
        s.row,
        {
          alignItems: 'flex-start',
          gap: 10,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: theme.colors.surface2,
          borderWidth: 1,
          borderColor: theme.colors.border,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text style={[s.small, { color: theme.colors.accent, fontWeight: '700' }]}>{props.num}</Text>
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={s.text}>{props.title}</Text>
        {props.children}
      </View>
    </View>
  );
}

function BrowserDrawer({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control, theme } = useUi();
  const { browser, browserError, automation, claudeAccounts, claudeAccountsStatus, claudeAccountsError } = useControlState();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [pairingText, setPairingText] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const instances =
    browser?.instances && browser.instances.length > 0
      ? browser.instances
      : Array.from(
          new Map(
            (browser?.sessions ?? []).map(sess => [
              sess.instanceId,
              {
                instanceId: sess.instanceId,
                instanceName: sess.instanceName,
                connected: Boolean(browser?.connected),
                lastSeenAt: sess.lastSeenAt,
              },
            ]),
          ).values(),
        );

  const loadPairing = async () => {
    setBusy(true);
    try {
      const res = await control.pairing();
      setPairingText(`${res.url} · 令牌已就绪（${res.token.slice(0, 6)}…）`);
    } catch (error) {
      setPairingText(`读取失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {browserError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{browserError}</Text>
        </Notice>
      ) : null}
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>新建 Claude 会话默认开启自动继续</Text>
        <Switch accessibilityLabel="新建 Claude 会话默认开启自动继续"
          disabled={claudeAccountsStatus !== 'ready' || !claudeAccounts?.enabled || Boolean(claudeAccountsError || claudeAccounts?.error)}
          value={claudeAccounts?.quotaName.autoResumeDefault ?? false}
          onValueChange={autoResumeDefault => void control.configureClaudeAccounts({ autoResumeDefault }).catch(e => setResumeError(errorMessage(e)))}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }} thumbColor={theme.colors.accentForeground} />
      </View>
      {resumeError || claudeAccountsError || claudeAccounts?.error ? <Text style={s.small}>{resumeError ?? claudeAccountsError ?? claudeAccounts?.error}</Text> : null}
      <SectionTitle>已连接的浏览器环境</SectionTitle>
      {browserError ? (
        <Text style={s.muted}>读取失败：{browserError}</Text>
      ) : !browser ? (
        <Text style={s.muted}>正在读取浏览器环境…</Text>
      ) : instances.length === 0 ? (
        <Text style={s.muted}>当前没有已上报的浏览器环境。</Text>
      ) : (
        <View>
          <TableRow first header cells={['环境', '扩展状态', '权限点击', '提问转交']} />
          {instances.map(inst => (
            <TableRow
              key={inst.instanceId}
              cells={[
                inst.instanceName,
                <Chip
                  key="st"
                  label={inst.connected ? '已连接' : '未连接'}
                  tone={inst.connected ? 'success' : 'neutral'}
                />,
                '自动点击 Allow once',
                '开启',
              ]}
            />
          ))}
        </View>
      )}
      <View style={s.wrap}>
        <Btn primary label="添加浏览器环境" onPress={() => onOpenDrawer('add-browser')} />
        <Btn label="复制配对地址和令牌" busy={busy} onPress={() => void loadPairing()} />
      </View>
      {pairingText ? <Text style={s.mono}>{pairingText}</Text> : null}

      <Pressable onPress={() => setShowAdvanced(prev => !prev)} style={{ paddingVertical: 6 }}>
        <Text style={s.muted}>{showAdvanced ? '▾' : '▸'} 高级：网页会话与 Paseo 会话绑定</Text>
      </Pressable>
      {showAdvanced ? (
        <View style={{ gap: 8 }}>
          <Text style={s.small}>把浏览器里的 claude.ai 会话关联到 Paseo 会话，便于跳回原会话。</Text>
          {(browser?.sessions ?? []).map(sess => (
            <View key={`${sess.instanceId}:${sess.sessionId}`} style={[s.row, { justifyContent: 'space-between' }]}>
              <Text style={s.small}>
                {sess.instanceName} · {sess.title}
              </Text>
              <View style={s.wrap}>
                {(automation?.sessions ?? []).slice(0, 2).map(target => (
                  <Btn
                    key={target.id}
                    small
                    primary={sess.agentId === target.id}
                    label={sess.agentId === target.id ? `已绑定 ${target.title}` : `绑定 ${target.title}`}
                    onPress={() =>
                      void control.bind({
                        instanceId: sess.instanceId,
                        sessionId: sess.sessionId,
                        agentId: sess.agentId === target.id ? null : target.id,
                      })
                    }
                  />
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <AdsPowerKeyCard />

      <RuleNote>
        扩展默认在标签页可见且满 800 毫秒后只点 Allow once，永不点 Always allow 或 Deny；单卡最多点 4 次。网页提问转交到
        Paseo，在线时进待办，离线时自动选推荐项。
      </RuleNote>
    </View>
  );
}

export function AdsPowerKeyCard() {
  const { s, control, theme } = useUi();
  const [settings, setSettings] = useState<BrowserUsageSettings | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    control
      .usageSettings()
      .then(res => {
        if (active) setSettings(res);
      })
      .catch(() => {
        if (active) setSettings({ adspowerApiKeyConfigured: false, adspowerApiKeySource: 'none' });
      });
    return () => {
      active = false;
    };
  }, [control]);

  const save = async () => {
    const candidate = value.trim();
    if (!candidate || busy) return;
    setBusy('save');
    setError(null);
    try {
      const res = await control.saveAdsPowerApiKey(candidate);
      setValue('');
      setSettings(res);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove');
    setError(null);
    try {
      const res = await control.removeAdsPowerApiKey();
      setValue('');
      setSettings(res);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const isConfigured = Boolean(settings?.adspowerApiKeyConfigured);
  const isFromEnv = settings?.adspowerApiKeySource === 'env';
  const canClear = isConfigured && !isFromEnv;
  const statusLabel =
    settings === null
      ? '读取中'
      : isFromEnv
        ? '已配置（来自环境变量）'
        : isConfigured
          ? '已配置'
          : '未配置';

  return (
    <Card
      title="额度设置（AdsPower API key）"
      trailing={<Chip label={statusLabel} tone={isConfigured ? 'success' : 'neutral'} />}
    >
      <Text style={s.text}>当前状态：{settings === null ? '正在读取…' : statusLabel}</Text>
      <Text style={s.muted}>
        用于通过本机 AdsPower 本地 API（默认 http://127.0.0.1:50325）查询浏览器环境的名称。API key
        只保存在本机插件状态里（文件权限 0600），不写日志，不返回给前端；保留环境变量
        PASEO_ADSPOWER_API_KEY / ADSPOWER_API_KEY 作为后备来源。
      </Text>
      <Text style={s.muted}>
        要准确显示浏览器环境名称，请在浏览器扩展选项页填写一次环境序号；单环境自动识别只在单个活跃环境且单个扩展上报时生效。
      </Text>
      <TextInput
        accessibilityLabel="AdsPower API key"
        style={s.input}
        value={value}
        onChangeText={setValue}
        placeholder={isConfigured ? '重新填写 AdsPower API key 以更换' : '填写 AdsPower API key'}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        contextMenuHidden
      />
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      <View style={s.wrap}>
        <Btn
          primary
          label={isConfigured ? '重新填写并保存' : '保存 API key'}
          disabled={!value.trim() || busy !== null}
          busy={busy === 'save'}
          onPress={() => void save()}
        />
        {canClear ? (
          <Btn
            danger
            label="清除 API key"
            disabled={busy !== null}
            busy={busy === 'remove'}
            onPress={() => void remove()}
          />
        ) : null}
      </View>
    </Card>
  );
}

function AddBrowserDrawer() {
  const { s, control } = useUi();
  const { browser, browserError } = useControlState();
  const [pairingInfo, setPairingInfo] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const extPath = browserError
    ? `读取失败：${browserError}`
    : browser?.extensionPath ?? '正在读取扩展目录…';

  const getPairing = async () => {
    try {
      const res = await control.pairing();
      setPairingInfo(`配对地址 ${res.url}（令牌长度 ${res.token.length}）`);
    } catch (error) {
      setPairingInfo(`获取配对信息失败：${errorMessage(error)}`);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      {browserError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{browserError}</Text>
        </Notice>
      ) : null}
      <StepRow
        num={1}
        title="在 AdsPower 打开目标浏览器环境，进入 chrome://extensions，打开右上角“开发者模式”。"
      />
      <StepRow num={2} title="点“加载已解压的扩展程序”，选择下面目录：">
        <View style={s.wrap}>
          <Text style={s.mono}>{extPath}</Text>
          {browser?.extensionPath ? (
            <Btn
              small
              label={copiedPath ? '已复制路径' : '复制路径'}
              onPress={() => setCopiedPath(true)}
            />
          ) : null}
        </View>
      </StepRow>
      <StepRow num={3} title="复制配对信息：">
        <Btn small primary label="生成并复制配对信息" onPress={() => void getPairing()} />
        {pairingInfo ? <Text style={s.mono}>{pairingInfo}</Text> : null}
      </StepRow>
      <StepRow
        num={4}
        title="打开扩展选项页，粘贴配对信息并填写 AdsPower 环境序号（如 27）。需要自动识别环境名称时，在“网页版 claude.ai”编辑面板填写 AdsPower API key。"
      />
      <StepRow num={5} title="等待连接：状态变为“已连接”即完成。">
        <Chip
          label={browserError ? '读取失败' : browser?.connected ? '已连接' : '等待连接'}
          tone={browserError ? 'danger' : browser?.connected ? 'success' : 'neutral'}
        />
      </StepRow>
    </View>
  );
}

const CONFIGURABLE_PROVIDERS = ['claude*', 'codex', 'opencode', 'glm*', 'qoder'] as const;

function CloudSessionDrawer() {
  const { s } = useUi();
  const { cloudSession, cloudSessionError, providerInstance } = useControlState();
  const status = cloudSession ?? providerInstance?.cloudSession;

  return (
    <View style={{ gap: 12 }}>
      {cloudSessionError && !status ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{cloudSessionError}</Text>
        </Notice>
      ) : null}
      <SectionTitle>云端会话状态</SectionTitle>
      <TableRow
        first
        cells={[
          '状态',
          cloudSessionError && !status ? (
            <Chip key="st" label="读取失败" tone="danger" />
          ) : !status ? (
            <Chip key="st" label="正在读取" tone="neutral" />
          ) : (
            <Chip key="st" label="始终开启" tone="success" />
          ),
        ]}
      />
      <TableRow cells={['在线云端会话', status ? `${status.onlineSessions} 个` : '—']} />
      <TableRow cells={['未确认消息', status ? `${status.unackedMessages} 条` : '—']} />
      <RuleNote>
        把 claude.ai 网页中运行的云端 Claude Code 会话接入 Paseo。由本机 Provider 实例承载；主实例通过跨实例转发收发消息和提问。
      </RuleNote>
    </View>
  );
}

function QaModeDrawer() {
  const { s, control, theme } = useUi();
  const { presence, presenceError } = useControlState();
  const settings = presence?.settings ?? null;
  const [err, setErr] = useState<string | null>(null);

  return (
    <View style={{ gap: 12 }}>
      {presenceError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{presenceError}</Text>
        </Notice>
      ) : null}
      {settings ? (
        <Segmented
          options={[
            { value: 'online', label: '在线' },
            { value: 'offline', label: '离线' },
            { value: 'auto', label: '自动' },
          ]}
          value={settings.mode}
          onChange={mode =>
            void control.configurePresence({ ...settings, mode }).catch(e => setErr(errorMessage(e)))
          }
        />
      ) : (
        <Text style={s.muted}>{presenceError ? `读取失败：${presenceError}` : '正在读取问答设置…'}</Text>
      )}
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>暂停问答代答与转发</Text>
        <Switch
          accessibilityLabel="暂停问答代答与转发"
          disabled={!settings}
          value={settings?.paused ?? false}
          onValueChange={paused => {
            if (!settings) return;
            void control.configurePresence({ ...settings, paused }).catch(e => setErr(errorMessage(e)));
          }}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      {err ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{err}</Text> : null}
      <SectionTitle>三种模式怎么工作</SectionTitle>
      <View style={{ gap: 6 }}>
        <Text style={s.small}>
          • <Text style={s.strong}>在线</Text>：网页提问进入待办总览并语音提醒；原生提问由 Paseo 原生界面处理。
        </Text>
        <Text style={s.small}>
          • <Text style={s.strong}>离线</Text>：插件在满 5 秒后自动选择带“(Recommended)”的选项；选择结果记入待办总览“代答未读”。
        </Text>
        <Text style={s.small}>
          • <Text style={s.strong}>自动</Text>：按蓝牙在场判定切换在线或离线；蓝牙未知时按在线处理，不盲目代答。
        </Text>
      </View>
      <RuleNote>
        必须本人确认的题目（涉及生产环境、删除数据、架构变更、安全凭据或没有推荐项）无论在线离线都不代答，直接触发升级通知。
      </RuleNote>
    </View>
  );
}

function BluetoothDrawer() {
  const { s, control, theme } = useUi();
  const { presence, presenceError } = useControlState();
  const settings = presence?.settings ?? null;
  const hostId = settings?.sourceHostId ?? null;
  const [snapshot, setSnapshot] = useState<BluetoothSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const loadDevices = async (target: string | null) => {
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const res = await control.bluetoothDevices(target);
      if (version !== generation.current) return;
      setSnapshot(res);
      setError(res.error);
    } catch (failure) {
      if (version === generation.current) setError(`设备读取失败：${errorMessage(failure)}`);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    setSnapshot(null);
    setMessage(null);
    void loadDevices(hostId);
  }, [hostId]);

  const choose = async (device: BluetoothDevice) => {
    const version = ++generation.current;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await control.selectBluetooth(hostId, { name: device.name, address: device.address });
      if (version !== generation.current) return;
      setSnapshot(previous => ({ target: saved, devices: previous?.devices ?? [], error: null }));
      setMessage(`锚定设备已修改为“${saved.name}”，等待来源主机重新判定在场。`);
    } catch (failure) {
      if (version === generation.current) setError(`保存失败：${errorMessage(failure)}`);
    } finally {
      if (version === generation.current) setSaving(false);
    }
  };

  const hosts = presence?.hosts ?? [];
  const target = snapshot?.target ?? null;
  const isAnchor = (device: BluetoothDevice) =>
    Boolean(target) && (target!.address ? device.address === target!.address : device.address === null && device.name === target!.name);
  const devices = snapshot?.devices ?? [];
  const detected = devices.some(isAnchor);

  return (
    <View style={{ gap: 12 }}>
      {presenceError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{presenceError}</Text>
        </Notice>
      ) : null}
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.text}>来源主机</Text>
        <View style={s.wrap}>
          <Btn
            small
            disabled={!settings}
            primary={Boolean(settings && !settings.sourceHostId)}
            label="自动（任一主机在场即在线）"
            onPress={() => {
              if (!settings) return;
              void control.configurePresence({ ...settings, sourceHostId: null });
            }}
          />
          {hosts.map(h => (
            <Btn
              key={h.id}
              small
              disabled={!settings}
              primary={settings?.sourceHostId === h.id}
              label={h.name}
              onPress={() => {
                if (!settings) return;
                void control.configurePresence({ ...settings, sourceHostId: h.id });
              }}
            />
          ))}
        </View>
      </View>

      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <SectionTitle>锚定设备</SectionTitle>
        <Btn small label="刷新设备" busy={loading} disabled={saving} onPress={() => void loadDevices(hostId)} />
      </View>
      <View style={s.wrap}>
        <Text style={s.strong}>当前锚定设备：{target?.name ?? (loading ? '读取中…' : '暂未读取')}</Text>
        {snapshot ? <Chip label={detected ? '已发现' : '未发现'} tone={detected ? 'success' : 'warning'} /> : null}
      </View>
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{message}</Text> : null}
      {devices.length === 0 ? (
        <Text style={s.small}>
          {presenceError
            ? `读取失败：${presenceError}`
            : !presence
              ? '正在读取在场观测…'
              : `当前观测：${presence.observation.reason || '未配置蓝牙设备'}`}
        </Text>
      ) : (
        devices.map(dev => (
          <View key={`${dev.name}-${dev.address ?? ''}`} style={[s.row, { justifyContent: 'space-between' }]}>
            <View style={{ flexShrink: 1 }}>
              <Text style={s.text}>
                {dev.name}
                {dev.address ? ` · ${dev.address.slice(-8)}` : ''}
              </Text>
              <Text style={s.small}>
                {dev.connected ? '已连接' : '未连接'} · {dev.rssi === null ? '暂无信号强度' : `信号 ${dev.rssi} dBm`}
              </Text>
            </View>
            {isAnchor(dev) ? (
              <Btn small label="已锚定" disabled onPress={() => {}} />
            ) : (
              <Btn small label="设为锚定设备" busy={saving} disabled={saving || loading} onPress={() => void choose(dev)} />
            )}
          </View>
        ))
      )}

      <RuleNote>
        按信号强度判定在场，不要求设备处于“已连接”状态；手机通常显示“未连接”但有信号强度。两台主机任一检测到设备在场即判为在线；两台都确认离开（连续 2 次扫描未见或信号低于阈值）才判为离线；任一主机未知且无在场主机时判为未知（按在线处理）。
      </RuleNote>
    </View>
  );
}

function EscalationDrawer() {
  const { s, control, theme } = useUi();
  const { escalation, escalationStatus, escalationError, machineSettings, modules } = useControlState();
  const escMsMod = machineSettings?.modules.find(m => m.id === 'answer.escalation');
  const escLiveMod = modules?.modules.find(m => m.id === 'answer.escalation');
  const escModOff =
    escalationStatus === 'disabled' ||
    (escMsMod ? !escMsMod.enabled || escMsMod.state === 'off' : escLiveMod ? escLiveMod.state === 'off' : false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookBusy, setWebhookBusy] = useState<'save' | 'test' | null>(null);
  const [webhookMsg, setWebhookMsg] = useState<string | null>(null);
  const [newDays, setNewDays] = useState<'daily' | 'weekdays'>('daily');
  const [newFrom, setNewFrom] = useState('01:00');
  const [newTo, setNewTo] = useState('09:30');
  const [delayInput, setDelayInput] = useState(() => String(escalation?.delayMinutes ?? 0));
  const [prevDelay, setPrevDelay] = useState<number | undefined>(escalation?.delayMinutes);
  // 每处保存都在原位置给出结果：哪一处、成功还是失败、原因。
  const [scheduleBusy, setScheduleBusy] = useState<ScheduleTarget | null>(null);
  const [scheduleMsg, setScheduleMsg] = useState<{ target: ScheduleTarget; ok: boolean; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (escalation?.delayMinutes !== prevDelay) {
    setPrevDelay(escalation?.delayMinutes);
    if (escalation?.delayMinutes !== undefined) {
      setDelayInput(String(escalation.delayMinutes));
    }
  }

  useEffect(() => {
    if (escalation?.delayMinutes !== undefined) {
      setDelayInput(String(escalation.delayMinutes));
    }
  }, [escalation?.delayMinutes]);

  const delayMinutes = escalation?.delayMinutes ?? 0;
  const windows = escalation?.immediate ?? [];
  const webhook = escalation?.webhook;
  const delayText = (minutes: number) => (minutes === 0 ? '立即通知' : `满 ${minutes} 分钟未答后通知`);

  const saveSchedule = async (target: ScheduleTarget, nextWindows: ImmediateWindow[], nextDelay: number, success: string) => {
    if (scheduleBusy) return;
    setScheduleBusy(target);
    setScheduleMsg(null);
    try {
      const normalized = nextWindows.map(w => ({ days: w.days, from: w.from, to: w.to }));
      await control.configureEscalation({ immediate: normalized, delayMinutes: nextDelay });
      setScheduleMsg({ target, ok: true, text: success });
    } catch (failure) {
      setScheduleMsg({ target, ok: false, text: `保存失败：${errorMessage(failure)}` });
    } finally {
      setScheduleBusy(null);
    }
  };

  const addWindow = async () => {
    if (!escalation) return;
    const from = newFrom.trim();
    const to = newTo.trim();
    if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) {
      setScheduleMsg({ target: 'window', ok: false, text: '请按 01:00 的格式填写开始和结束时间' });
      return;
    }
    await saveSchedule('window', [...windows, { days: newDays, from, to }], delayMinutes, `已添加免等时段：${from} – ${to}`);
  };

  const removeWindow = async (idx: number) => {
    if (!escalation) return;
    await saveSchedule('remove', windows.filter((_, i) => i !== idx), delayMinutes, '已删除免等时段');
  };

  const applyDelay = async () => {
    if (!escalation) return;
    const value = delayInput.trim();
    if (!/^\d+$/.test(value)) {
      setScheduleMsg({ target: 'delay', ok: false, text: '请填写 0 或正整数分钟' });
      return;
    }
    const parsed = Number.parseInt(value, 10);
    await saveSchedule('delay', windows, parsed, `已保存：其余时段${delayText(parsed)}`);
  };

  const saveWebhook = async () => {
    if (!webhookUrl.trim() || webhookBusy) return;
    setWebhookBusy('save');
    setErr(null);
    setWebhookMsg(null);
    try {
      await control.configureEscalationWebhook({
        url: webhookUrl.trim(),
        auth: webhookSecret.trim() || undefined,
      });
      setWebhookUrl('');
      setWebhookSecret('');
      setWebhookMsg('地址已保存');
    } catch (failure) {
      setErr(errorMessage(failure));
    } finally {
      setWebhookBusy(null);
    }
  };

  const runTest = async () => {
    if (webhookBusy) return;
    setWebhookBusy('test');
    setErr(null);
    setWebhookMsg(null);
    try {
      const res = await control.testEscalationWebhook();
      setWebhookMsg(res.sent ? `已发送测试通知：${res.message}` : `测试未通过：${res.message}`);
    } catch (error) {
      setErr(errorMessage(error));
    } finally {
      setWebhookBusy(null);
    }
  };

  const message = (target: ScheduleTarget) =>
    scheduleMsg?.target === target ? (
      <Text style={{ color: scheduleMsg.ok ? theme.colors.statusSuccess : theme.colors.statusDanger, fontSize: 13 }}>{scheduleMsg.text}</Text>
    ) : null;
  const timeInput = [s.input, { width: 96, minWidth: 96, flexGrow: 0 }];

  return (
    <View style={{ gap: 12 }}>
      {escModOff ? (
        <Notice tone="neutral">
          <Text style={s.text}>升级通知模块未启用，请使用卡片开关开启。</Text>
        </Notice>
      ) : escalation?.blockedReason ? (
        <Notice tone="danger">
          <View style={{ gap: 4 }}>
            <Text style={s.strong}>旧插件仍启用，先停用</Text>
            <Text style={s.small}>{escalation.blockedReason}</Text>
          </View>
        </Notice>
      ) : escalationStatus === 'error' || escalationError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{escalationError ?? '无法读取升级通知设置'}</Text>
        </Notice>
      ) : null}
      <SectionTitle>时段规则（{escalation?.timezone ?? '—'}）</SectionTitle>
      {!escalation ? (
        <Text style={s.muted}>{escalationError ? `读取失败：${escalationError}` : '正在读取时段规则…'}</Text>
      ) : (
        <View style={{ gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={s.text}>免等时段：这些时间内有提问未答，立即通知。</Text>
            {windows.length === 0 ? <Text style={s.muted}>没有免等时段。</Text> : null}
            {windows.map((win, idx) => (
              <View key={idx} style={[s.wrap, { justifyContent: 'space-between' }]}>
                <Text style={s.text}>
                  {win.days === 'daily'
                    ? '每天'
                    : win.days === 'weekdays'
                      ? '工作日'
                      : Array.isArray(win.days)
                        ? `周 ${win.days.join(',')}`
                        : '周末'}{' '}
                  <Text style={s.mono}>{win.from} – {win.to}</Text>
                </Text>
                <Btn small danger label="删除" disabled={scheduleBusy !== null} onPress={() => void removeWindow(idx)} />
              </View>
            ))}
            {message('remove')}
          </View>

          <View style={{ gap: 6 }}>
            <Text style={s.text}>其余时段：{delayText(delayMinutes)}</Text>
            <View style={s.wrap}>
              <TextInput
                accessibilityLabel="其余时段等待分钟数"
                style={timeInput}
                value={delayInput}
                onChangeText={setDelayInput}
                onSubmitEditing={() => void applyDelay()}
                keyboardType="number-pad"
              />
              <Text style={s.text}>分钟（0 表示立即通知）</Text>
              <Btn small primary label="保存等待时间" busy={scheduleBusy === 'delay'} disabled={scheduleBusy !== null} onPress={() => void applyDelay()} />
            </View>
            {message('delay')}
          </View>

          <View style={{ gap: 6 }}>
            <Text style={s.text}>添加免等时段</Text>
            <View style={s.wrap}>
              <Btn
                small
                label={newDays === 'daily' ? '范围：每天' : '范围：工作日'}
                onPress={() => setNewDays(d => (d === 'daily' ? 'weekdays' : 'daily'))}
              />
              <TextInput
                accessibilityLabel="免等开始时间"
                style={timeInput}
                value={newFrom}
                onChangeText={setNewFrom}
                placeholder="01:00"
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <Text style={s.text}>至</Text>
              <TextInput
                accessibilityLabel="免等结束时间"
                style={timeInput}
                value={newTo}
                onChangeText={setNewTo}
                placeholder="09:30"
                placeholderTextColor={theme.colors.foregroundMuted}
              />
              <Btn small primary label="添加免等时段" busy={scheduleBusy === 'window'} disabled={scheduleBusy !== null} onPress={() => void addWindow()} />
            </View>
            {message('window')}
          </View>
        </View>
      )}

      <Card
        title="Grok bot 类个人机器人通知 Webhook"
        trailing={
          escModOff ? (
            <Chip label="模块未启用" tone="neutral" />
          ) : (
            <Chip
              label={webhook?.configured ? '已设置' : '未设置'}
              tone={webhook?.configured ? 'success' : 'neutral'}
            />
          )
        }
      >
        {escModOff ? (
          <Text style={s.muted}>
            升级通知模块未启用，请先使用卡片开关开启，再设置 Webhook 地址。
          </Text>
        ) : (
          <>
            <View style={{ gap: 4 }}>
              <Text style={s.text}>通知发到这个 Webhook 地址，例如 Grok bot 等个人机器人。</Text>
              <Text style={s.text}>
                地址：{webhook?.configured ? '已保存' : '未设置'} · 域名：{webhook?.hostname ?? '—'}
              </Text>
              <Text style={s.text}>
                识别码：<Text style={s.mono}>{webhook?.fingerprint ?? '—'}</Text>
              </Text>
            </View>
            <TextInput
              accessibilityLabel="Webhook 地址"
              style={s.input}
              value={webhookUrl}
              onChangeText={setWebhookUrl}
              placeholder={webhook?.configured ? '填写新的 Webhook 地址以更换' : '填写 Webhook 地址'}
              placeholderTextColor={theme.colors.foregroundMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
            />
            <TextInput
              accessibilityLabel="Webhook 鉴权信息"
              style={s.input}
              value={webhookSecret}
              onChangeText={setWebhookSecret}
              placeholder="可选：鉴权信息，例如 Authorization: Bearer …（保存后不显示）"
              placeholderTextColor={theme.colors.foregroundMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
            />
            {webhookMsg ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{webhookMsg}</Text> : null}
            <View style={s.wrap}>
              <Btn
                primary
                label={webhook?.configured ? '更换地址' : '保存地址'}
                disabled={!webhookUrl.trim() || webhookBusy !== null}
                busy={webhookBusy === 'save'}
                onPress={() => void saveWebhook()}
              />
              {webhook?.configured ? (
                <Btn
                  label="发测试通知"
                  disabled={webhookBusy !== null}
                  busy={webhookBusy === 'test'}
                  onPress={() => void runTest()}
                />
              ) : null}
            </View>
            <Text style={s.small}>
              完整地址和鉴权信息只保存在本机，页面和日志只显示域名和 8 位识别码。
            </Text>
          </>
        )}
      </Card>

      {err ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{err}</Text> : null}

      <RuleNote>
        主会话有提问未回答时，按时段规则通知 Grok（不代答）。同一问题只通知一次。通知记录在“待办总览”的处理记录中查看。
      </RuleNote>
    </View>
  );
}

type ScheduleTarget = 'delay' | 'window' | 'remove';

function QuietChildrenDrawer() {
  const { s, control, theme } = useUi();
  const { quiet, quietStatus, quietError } = useControlState();
  const recent = quiet?.recentHandled ?? [];
  const [err, setErr] = useState<string | null>(null);

  return (
    <View style={{ gap: 12 }}>
      {quietStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>子会话免提醒模块未启用（等待对应服务端模块合并或开启）。</Text>
        </Notice>
      ) : quietStatus === 'error' || quietError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{quietError ?? '无法读取免提醒设置'}</Text>
        </Notice>
      ) : null}
      <RuleNote>
        主会话怎么判：Paseo 侧栏“已置顶”工作区里的顶层会话是主会话；没有父会话链接但不在置顶工作区里的会话（如 p2p
        派出的开发会话）按子会话处理，不直接提醒你。
      </RuleNote>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>将子会话异常与提问归并到主会话</Text>
        <Switch
          accessibilityLabel="将子会话异常与提问归并到主会话"
          disabled={!quiet || quietStatus !== 'ready'}
          value={quiet?.forwardEvents ?? false}
          onValueChange={val =>
            void control.configureQuiet({ forwardEvents: val }).catch(e => setErr(errorMessage(e)))
          }
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      {err ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{err}</Text> : null}

      <SectionTitle>最近处理的子会话</SectionTitle>
      {quietError ? (
        <Text style={s.muted}>读取失败：{quietError}</Text>
      ) : !quiet ? (
        <Text style={s.muted}>正在读取免提醒状态…</Text>
      ) : recent.length === 0 ? (
        <Text style={s.muted}>暂无最近处理的子会话记录（置顶工作区数：{quiet.pinnedWorkspaceCount}）。</Text>
      ) : (
        <View>
          <TableRow first header cells={['子会话', '事件', '归并结果']} />
          {recent.map(item => (
            <TableRow
              key={item.id}
              cells={[
                item.sessionTitle,
                item.eventKind === 'failed' ? '运行失败' : '已完成',
                <Chip
                  key="r"
                  label={item.forwardStatus === 'forwarded' ? '已归并到主会话' : '已静默清除提醒'}
                  tone="neutral"
                />,
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function SpeechDrawer() {
  const { s, control, theme } = useUi();
  const { presence, presenceError } = useControlState();
  const settings = presence?.settings ?? null;
  const [err, setErr] = useState<string | null>(null);

  return (
    <View style={{ gap: 12 }}>
      {presenceError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{presenceError}</Text>
        </Notice>
      ) : null}
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>开启语音提醒</Text>
        <Switch
          accessibilityLabel="开启语音提醒"
          disabled={!settings}
          value={settings?.speechEnabled ?? false}
          onValueChange={speechEnabled => {
            if (!settings) return;
            void control.configurePresence({ ...settings, speechEnabled }).catch(e => setErr(errorMessage(e)));
          }}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>播报主机</Text>
        <Chip
          label={presenceError ? '读取失败' : !presence ? '正在读取' : presence.hostName || '跟随在场主机'}
          tone={presenceError ? 'danger' : 'neutral'}
        />
      </View>
      {err ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{err}</Text> : null}
      <RuleNote>
        只在判定在线且有新提问或停滞会话时播报；优先使用专用晓晓语音环境，不可用时回退系统语音；你在任一端回答后立即停止播报。
      </RuleNote>
    </View>
  );
}

function ApprovalDrawer() {
  const { s, control } = useUi();
  const { automation, automationError } = useControlState();
  const policies = automation?.policies ?? [];
  const sessions = automation?.sessions ?? [];

  return (
    <View style={{ gap: 12 }}>
      {automationError ? (
        <Notice tone="danger">
          <Text style={s.text}>读取失败：{automationError}</Text>
        </Notice>
      ) : null}
      <SectionTitle>本机策略</SectionTitle>
      {automationError ? (
        <Text style={s.muted}>读取失败：{automationError}</Text>
      ) : !automation ? (
        <Text style={s.muted}>正在读取授权策略…</Text>
      ) : policies.length === 0 ? (
        <Text style={s.muted}>当前没有配置跨重启精确授权策略。</Text>
      ) : (
        <View>
          <TableRow first header cells={['会话', '允许的工具', '状态', '操作']} />
          {policies.map(pol => {
            const sess = sessions.find(item => item.id === pol.agentId);
            const tools = [
              pol.tools.length ? pol.tools.join(', ') : null,
              pol.commands.length ? `Bash (${pol.commands.join(', ')})` : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <TableRow
                key={pol.agentId}
                cells={[
                  sess?.title ?? pol.agentId,
                  <Text key="t" style={s.mono}>
                    {tools || '未启用'}
                  </Text>,
                  <Chip key="st" label={pol.enabled ? '生效中' : '已停用'} tone={pol.enabled ? 'success' : 'neutral'} />,
                  <Btn
                    key="rm"
                    small
                    danger
                    label="移除"
                    onPress={() =>
                      void control.policy({
                        ...pol,
                        enabled: false,
                        tools: [],
                        commands: [],
                      })
                    }
                  />,
                ]}
              />
            );
          })}
        </View>
      )}
      {sessions.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SectionTitle>为运行中会话开启文件读取授权</SectionTitle>
          <View style={s.wrap}>
            {sessions.map(sess => (
              <Btn
                key={sess.id}
                small
                label={`授权 ${sess.title}`}
                onPress={() =>
                  void control.policy({
                    agentId: sess.id,
                    enabled: true,
                    tools: ['Read', 'Glob', 'Grep'],
                    commands: [],
                  })
                }
              />
            ))}
          </View>
        </View>
      ) : null}
      <RuleNote>
        普通工具审批请在 Paseo 会话输入框顶部切换模式。此处只保留按命令名或工作区路径限制的跨重启策略。
      </RuleNote>
    </View>
  );
}

export function TokenCard() {
  const { s, store, now, theme } = useUi();
  const toast = useToast();
  const { snapshot } = useStoreState();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'check' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const token = snapshot?.token;

  const save = async () => {
    const candidate = value.trim();
    if (!candidate) return;
    setBusy('save');
    setFailure(null);
    try {
      const status = await store.saveToken(candidate);
      setValue('');
      toast.show(status.error ? `令牌已保存，但检查未通过：${status.error}` : '令牌已保存', {
        variant: status.error ? 'warning' : 'success',
      });
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'remove' | 'check', action: () => Promise<void>) => {
    setBusy(kind);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="GitHub 令牌"
      trailing={
        <Chip
          label={token?.configured ? '已保存' : '未配置'}
          tone={token?.configured ? (token.error ? 'warning' : 'success') : 'warning'}
        />
      }
    >
      {token?.configured ? (
        <View style={{ gap: 4 }}>
          <Text style={s.mono}>{token.prefix ?? '已保存'}（已保存）</Text>
          <Text style={s.text}>
            {token.login ? `账号 ${token.login}` : '账号未知'}
            {token.remaining !== null ? ` · 本小时剩余 ${token.remaining}` : ''}
            {until(token.resetAt, now) ? ` · ${until(token.resetAt, now)}` : ''}
          </Text>
          {token.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{token.error}</Text> : null}
        </View>
      ) : (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>还没有保存令牌。</Text>
      )}
      <TextInput
        accessibilityLabel="GitHub 令牌"
        style={s.input}
        value={value}
        onChangeText={setValue}
        placeholder={token?.configured ? '填写新令牌以更换' : '粘贴 GitHub 细粒度令牌'}
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        contextMenuHidden
      />
      {failure ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{failure}</Text> : null}
      <View style={s.wrap}>
        <Btn
          primary
          label={token?.configured ? '更换令牌' : '保存令牌'}
          onPress={() => void save()}
          disabled={!value.trim()}
          busy={busy === 'save'}
        />
        {token?.configured ? (
          <Btn label="重新检查" onPress={() => void run('check', () => store.pollNow())} busy={busy === 'check'} />
        ) : null}
        {token?.configured ? (
          <Btn
            danger
            label="移除令牌"
            onPress={() => void run('remove', () => store.removeToken())}
            busy={busy === 'remove'}
          />
        ) : null}
      </View>
      <Text style={s.small}>
        令牌只保存在本机插件目录（文件权限 0600），仅本人可读。界面只显示前缀和账号，保存后输入框立即清空。
      </Text>
    </Card>
  );
}

function GithubConfigDrawer() {
  const { s, store, theme } = useUi();
  const { snapshot, error } = useStoreState();
  const prefs = snapshot?.preferences ?? null;
  const serializedPrefs = prefs ? JSON.stringify(prefs) : '';
  const [prevSerialized, setPrevSerialized] = useState(serializedPrefs);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Preferences | null>(prefs);
  const [excludedText, setExcludedText] = useState(prefs ? prefs.excludedRepos.join(', ') : '');
  const [extraText, setExtraText] = useState(prefs ? prefs.extraRepos.join(', ') : '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (serializedPrefs && serializedPrefs !== prevSerialized) {
    setPrevSerialized(serializedPrefs);
    if (!dirty && prefs) {
      setDraft(prefs);
      setExcludedText(prefs.excludedRepos.join(', '));
      setExtraText(prefs.extraRepos.join(', '));
    }
  }

  useEffect(() => {
    if (prefs && !dirty) {
      setDraft(prefs);
      setExcludedText(prefs.excludedRepos.join(', '));
      setExtraText(prefs.extraRepos.join(', '));
    }
  }, [serializedPrefs, dirty]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      const next: Preferences = {
        ...draft,
        excludedRepos: excludedText
          .split(',')
          .map(x => x.trim())
          .filter(Boolean),
        extraRepos: extraText
          .split(',')
          .map(x => x.trim())
          .filter(Boolean),
      };
      await store.savePreferences(next);
      setDirty(false);
      setMsg('GitHub 订阅设置已保存');
    } catch (failure) {
      setMsg(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return (
      <View style={{ gap: 12 }}>
        <TokenCard />
        <Notice tone={error ? 'danger' : 'neutral'}>
          <Text style={s.text}>{error ? `读取失败：${error}` : '正在读取 GitHub 订阅设置…'}</Text>
        </Notice>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <TokenCard />
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>投递模式</Text>
        <Segmented
          options={[
            { value: 'live', label: '实际发送' },
            { value: 'shadow', label: '影子（只记日志）' },
          ]}
          value={draft.shadow ? 'shadow' : 'live'}
          onChange={val => {
            setDirty(true);
            setDraft(prev => (prev ? { ...prev, shadow: val === 'shadow' } : prev));
          }}
        />
      </View>
      <View style={s.stack}>
        <Text style={s.text}>组织</Text>
        <TextInput
          accessibilityLabel="GitHub 组织"
          style={s.input}
          value={draft.organization}
          onChangeText={organization => {
            setDirty(true);
            setDraft(prev => (prev ? { ...prev, organization } : prev));
          }}
          autoCapitalize="none"
        />
      </View>
      <View style={s.stack}>
        <Text style={s.text}>排除仓库（逗号分隔）</Text>
        <TextInput
          accessibilityLabel="排除仓库"
          style={s.input}
          value={excludedText}
          onChangeText={text => {
            setDirty(true);
            setExcludedText(text);
          }}
          placeholder="例如 archive-repo"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
      </View>
      <View style={s.stack}>
        <Text style={s.text}>额外仓库（owner/repo，逗号分隔）</Text>
        <TextInput
          accessibilityLabel="额外仓库"
          style={s.input}
          value={extraText}
          onChangeText={text => {
            setDirty(true);
            setExtraText(text);
          }}
          placeholder="例如 org/repo"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
      </View>

      <SectionTitle>会话忙时策略</SectionTitle>
      {(['claude', 'codex', 'opencode'] as const).map(provider => {
        const current = draft.providerPolicies[provider] ?? 'interrupt';
        return (
          <View key={provider} style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={s.mono}>{provider}</Text>
            <Segmented
              options={[
                { value: 'interrupt', label: '立即发送' },
                { value: 'skip', label: '跳过本轮' },
              ]}
              value={current}
              onChange={policy => {
                setDirty(true);
                setDraft(prev =>
                  prev
                    ? {
                        ...prev,
                        providerPolicies: { ...prev.providerPolicies, [provider]: policy },
                      }
                    : prev,
                );
              }}
            />
          </View>
        );
      })}

      <View style={s.wrap}>
        <Btn primary label="保存设置" busy={saving} onPress={() => void save()} />
      </View>
      {msg ? <Text style={s.small}>{msg}</Text> : null}
    </View>
  );
}

export function DrawerOverlay(props: {
  drawerId: DrawerId | null;
  onClose(): void;
  onOpenDrawer(id: DrawerId): void;
}) {
  const { s, theme, compact } = useUi();
  const { drawerId, onClose, onOpenDrawer } = props;
  if (!drawerId) return null;

  const renderContent = () => {
    switch (drawerId) {
      case 'browser':
        return <BrowserDrawer onOpenDrawer={onOpenDrawer} />;
      case 'add-browser':
        return <AddBrowserDrawer />;
      case 'cloud':
        return <CloudSessionDrawer />;
      case 'qa-mode':
        return <QaModeDrawer />;
      case 'bluetooth':
        return <BluetoothDrawer />;
      case 'escalation':
        return <EscalationDrawer />;
      case 'quiet-children':
        return <QuietChildrenDrawer />;
      case 'speech':
        return <SpeechDrawer />;
      case 'approval':
        return <ApprovalDrawer />;
      case 'github-config':
        return <GithubConfigDrawer />;
    }
  };

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭抽屉背景"
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }}
      />
      <View
        style={{
          width: compact ? '100%' : 500,
          maxWidth: '100%',
          height: '100%',
          backgroundColor: theme.colors.surface1,
          borderLeftWidth: 1,
          borderLeftColor: theme.colors.border,
        }}
      >
        <View
          style={[
            s.row,
            {
              justifyContent: 'space-between',
              paddingHorizontal: 18,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            },
          ]}
        >
          <Text style={s.h2}>{DRAWER_TITLES[drawerId]}</Text>
          <Btn small label="关闭" onPress={onClose} />
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 14 }}>
          {renderContent()}
        </ScrollView>
      </View>
    </View>
  );
}
