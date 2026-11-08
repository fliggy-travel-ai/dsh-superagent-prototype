import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { BluetoothSnapshot } from '../shared/bluetooth.ts';
import type { AgentDefaultRule } from '../shared/defaults.ts';
import type { Preferences } from '../shared/model.ts';
import { errorMessage } from './store.ts';
import { Btn, Chip, Notice, RuleNote, Segmented, useControlState, useStoreState, useUi } from './ui.tsx';

type BluetoothDevice = BluetoothSnapshot['devices'][number];

export type DrawerId =
  | 'claude-accounts'
  | 'add-claude'
  | 'browser'
  | 'add-browser'
  | 'claude-quota'
  | 'session-defaults'
  | 'provider-instance'
  | 'cloud'
  | 'antigravity'
  | 'qa-mode'
  | 'bluetooth'
  | 'escalation'
  | 'quiet-children'
  | 'speech'
  | 'approval'
  | 'github-config';

const DRAWER_TITLES: Record<DrawerId, string> = {
  'claude-accounts': 'Claude 账号',
  'add-claude': '添加 Claude 账号',
  browser: '网页版 claude.ai',
  'add-browser': '添加浏览器环境',
  'claude-quota': 'Claude 名称带额度',
  'session-defaults': '新建会话默认设置',
  'provider-instance': 'Provider 实例',
  cloud: '云端会话',
  antigravity: 'Antigravity 账号',
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

function ClaudeAccountsDrawer({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control } = useUi();
  const { claudeAccounts, claudeAccountsStatus, claudeAccountsError } = useControlState();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const accounts = claudeAccounts?.accounts ?? [];

  const saveLabel = async (providerId: string, fallback: string) => {
    const next = (labels[providerId] ?? fallback).trim();
    if (!next) return;
    setBusyId(providerId);
    setMsg(null);
    try {
      await control.renameClaudeAccount({ providerId, label: next });
      setMsg('名称已保存');
    } catch (error) {
      setMsg(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {claudeAccountsStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>Claude 账号与额度模块未启用（等待对应服务端模块合并或开启）。</Text>
        </Notice>
      ) : null}
      {claudeAccountsError || claudeAccounts?.error ? (
        <Notice tone="danger">
          <Text style={s.text}>{claudeAccountsError ?? claudeAccounts?.error}</Text>
        </Notice>
      ) : null}

      <SectionTitle>本机账号</SectionTitle>
      {accounts.length === 0 ? (
        <Text style={s.muted}>本机暂无已登记的 Claude 账号。</Text>
      ) : (
        <View>
          <TableRow first header cells={['名称', '邮箱', '状态', '剩余额度', '操作']} />
          {accounts.map(acc => (
            <TableRow
              key={acc.providerId}
              cells={[
                <TextInput
                  key="name"
                  style={[s.input, { paddingVertical: 4, minWidth: 80 }]}
                  value={labels[acc.providerId] ?? acc.label}
                  onChangeText={val => setLabels(prev => ({ ...prev, [acc.providerId]: val }))}
                  onSubmitEditing={() => void saveLabel(acc.providerId, acc.label)}
                />,
                <Text key="email" style={s.mono}>
                  {acc.email ?? '—'}
                </Text>,
                <Chip
                  key="status"
                  label={acc.needsRelogin ? '需要重新登录' : '正常'}
                  tone={acc.needsRelogin ? 'danger' : 'success'}
                />,
                <Text key="quota" style={s.mono}>
                  {acc.remainingPct !== null ? `${acc.remainingPct}%` : '—'}
                </Text>,
                acc.needsRelogin ? (
                  <Btn key="act" small primary label="重新登录" onPress={() => onOpenDrawer('add-claude')} />
                ) : (
                  <Btn
                    key="act"
                    small
                    label="保存名称"
                    busy={busyId === acc.providerId}
                    onPress={() => void saveLabel(acc.providerId, acc.label)}
                  />
                ),
              ]}
            />
          ))}
        </View>
      )}
      {msg ? <Text style={s.small}>{msg}</Text> : null}
      <View style={s.row}>
        <Btn primary label="添加 Claude 账号" onPress={() => onOpenDrawer('add-claude')} />
      </View>
      <RuleNote>本机只显示本机钥匙串里的账号。另一台主机的账号切换到对应主机查看。</RuleNote>
    </View>
  );
}

function AddClaudeDrawer() {
  const { s, control, theme } = useUi();
  const { claudeAccounts } = useControlState();
  const [providerId, setProviderId] = useState('claude-4');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'start' | 'submit' | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeFlow = claudeAccounts?.activeFlow;

  const start = async () => {
    setBusy('start');
    setError(null);
    setResultMsg(null);
    try {
      await control.startClaudeLogin({ providerId: providerId.trim() || undefined });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!code.trim()) return;
    setBusy('submit');
    setError(null);
    setResultMsg(null);
    try {
      await control.submitClaudeLoginCode({
        providerId: activeFlow?.providerId ?? (providerId.trim() || 'claude-4'),
        code: code.trim(),
      });
      setCode('');
      setResultMsg('已完成添加，并自动开启“名称带额度”和“自动继续默认值”。');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <StepRow num={1} title="填写账号标识">
        <TextInput
          accessibilityLabel="新账号标识"
          style={s.input}
          value={providerId}
          onChangeText={setProviderId}
          placeholder="例如 claude-4"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
      </StepRow>
      <StepRow num={2} title="打开授权页面">
        <View style={s.wrap}>
          <Btn primary label="生成登录链接" busy={busy === 'start'} onPress={() => void start()} />
          {activeFlow?.loginUrl ? (
            <Btn label="打开浏览器" onPress={() => void Linking.openURL(activeFlow.loginUrl!)} />
          ) : null}
        </View>
        {activeFlow?.loginUrl ? <Text style={s.mono}>{activeFlow.loginUrl}</Text> : null}
      </StepRow>
      <StepRow num={3} title="浏览器登录目标 Claude 账号并点 Authorize" />
      <StepRow num={4} title="粘贴页面显示的 code#state">
        <View style={s.row}>
          <TextInput
            accessibilityLabel="授权码 code#state"
            style={s.input}
            value={code}
            onChangeText={setCode}
            placeholder="code#state"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Btn
            primary
            label="完成添加"
            disabled={!code.trim()}
            busy={busy === 'submit'}
            onPress={() => void submit()}
          />
        </View>
      </StepRow>
      <StepRow num={5} title="插件向 Anthropic 换取令牌，写入本机钥匙串并记入账号表" />
      <StepRow num={6} title="自动开启“名称带额度”和“自动继续默认值”，刷新列表" />
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      {resultMsg ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{resultMsg}</Text> : null}
    </View>
  );
}

function BrowserDrawer({ onOpenDrawer }: { onOpenDrawer(id: DrawerId): void }) {
  const { s, control } = useUi();
  const { browser, automation } = useControlState();
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
                sessionCount: 1,
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
      <SectionTitle>已连接的浏览器环境</SectionTitle>
      {instances.length === 0 ? (
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

      <RuleNote>
        扩展默认在标签页可见且满 800 毫秒后只点 Allow once，永不点 Always allow 或 Deny；单卡最多点 4 次。网页提问转交到
        Paseo，在线时进待办，离线时自动选推荐项。
      </RuleNote>
    </View>
  );
}

function AddBrowserDrawer() {
  const { s, control } = useUi();
  const { browser } = useControlState();
  const [pairingInfo, setPairingInfo] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const extPath = browser?.extensionPath ?? '~/.paseo/plugins/github-subscriptions/extension';

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
      <StepRow
        num={1}
        title="在 AdsPower 打开目标浏览器环境，进入 chrome://extensions，打开右上角“开发者模式”。"
      />
      <StepRow num={2} title="点“加载已解压的扩展程序”，选择下面目录：">
        <View style={s.wrap}>
          <Text style={s.mono}>{extPath}</Text>
          <Btn
            small
            label={copiedPath ? '已复制路径' : '复制路径'}
            onPress={() => setCopiedPath(true)}
          />
        </View>
      </StepRow>
      <StepRow num={3} title="复制配对信息：">
        <Btn small primary label="生成并复制配对信息" onPress={() => void getPairing()} />
        {pairingInfo ? <Text style={s.mono}>{pairingInfo}</Text> : null}
      </StepRow>
      <StepRow
        num={4}
        title="打开扩展选项页，粘贴配对信息并填写 AdsPower 环境序号（如 27）。需要自动识别环境名称时，在 Paseo 设置 → 开发自动化 填写 AdsPower API key。"
      />
      <StepRow num={5} title="等待连接：状态变为“已连接”即完成。">
        <Chip
          label={browser?.connected ? '已连接' : '等待连接'}
          tone={browser?.connected ? 'success' : 'neutral'}
        />
      </StepRow>
    </View>
  );
}

function ClaudeQuotaDrawer() {
  const { s, control, theme } = useUi();
  const { claudeAccounts, claudeAccountsStatus } = useControlState();
  const showQuota = claudeAccounts?.quotaName.enabled ?? true;
  const autoCont = claudeAccounts?.quotaName.autoResumeDefault ?? true;

  const update = (patch: { labelWithQuota?: boolean; autoResumeDefault?: boolean }) => {
    void control.configureClaudeAccounts(patch).catch(() => {});
  };

  return (
    <View style={{ gap: 14 }}>
      {claudeAccountsStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>Claude 额度模块未启用（等待对应服务端模块合并或开启）。</Text>
        </Notice>
      ) : null}
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>在名称后显示剩余额度</Text>
        <Switch
          accessibilityLabel="在名称后显示剩余额度"
          value={showQuota}
          onValueChange={val => update({ labelWithQuota: val })}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>新建 Claude 会话默认开启自动继续</Text>
        <Switch
          accessibilityLabel="新建 Claude 会话默认开启自动继续"
          value={autoCont}
          onValueChange={val => update({ autoResumeDefault: val })}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      <RuleNote>
        开启后隐藏 Paseo 内置的单账号 Claude 额度来源，改按账号分别显示 5 小时和 7 天剩余百分比。
      </RuleNote>
    </View>
  );
}

const DEFAULT_RULES_PREVIEW: AgentDefaultRule[] = [
  { provider: 'claude*', apply: 'missing', modeId: 'bypassPermissions', features: { effort: 'xhigh' }, enabled: true },
  { provider: 'codex', apply: 'always', modeId: 'auto', features: { serviceTier: 'fast' }, enabled: true },
  { provider: 'opencode', apply: 'missing', features: { autoApprove: true }, enabled: true },
  { provider: 'glm', apply: 'missing', features: { autoApprove: true }, enabled: true },
  { provider: 'qoder', apply: 'missing', modeId: 'yolo', features: { autoApprove: true }, enabled: true },
];

function SessionDefaultsDrawer() {
  const { s, control, theme } = useUi();
  const { defaults } = useControlState();
  const [newProvider, setNewProvider] = useState('');
  const [newMode, setNewMode] = useState('');
  const [newAutoApprove, setNewAutoApprove] = useState(true);
  const [busy, setBusy] = useState(false);

  const rules = defaults?.rules && defaults.rules.length > 0 ? defaults.rules : DEFAULT_RULES_PREVIEW;

  const saveRules = async (next: AgentDefaultRule[]) => {
    setBusy(true);
    try {
      await control.saveDefaults({ enabled: defaults?.enabled ?? true, rules: next });
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    const p = newProvider.trim();
    if (!p) return;
    const rule: AgentDefaultRule = {
      provider: p,
      apply: 'missing',
      ...(newMode.trim() ? { modeId: newMode.trim() } : {}),
      ...(newAutoApprove ? { features: { autoApprove: true } } : {}),
      enabled: true,
    };
    setNewProvider('');
    setNewMode('');
    await saveRules([...rules, rule]);
  };

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>本机规则（保存在 machine.json）</SectionTitle>
      <View>
        <TableRow first header cells={['Provider', '模式', '自动授权', '额外设置', '启用']} />
        {rules.map((rule, idx) => {
          const providerText = Array.isArray(rule.provider) ? rule.provider.join(', ') : rule.provider;
          const features = rule.features ?? {};
          const extraEntries = Object.entries(features)
            .filter(([k]) => k !== 'autoApprove')
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(', ');
          return (
            <TableRow
              key={`${providerText}-${idx}`}
              cells={[
                <Text key="p" style={s.mono}>
                  {providerText}
                </Text>,
                <Text key="m" style={s.mono}>
                  {rule.modeId ?? '—'}
                </Text>,
                features.autoApprove ? '开启' : '—',
                extraEntries || '—',
                <Switch
                  key="sw"
                  accessibilityLabel={`规则 ${providerText}`}
                  value={rule.enabled !== false}
                  disabled={busy}
                  onValueChange={val => {
                    const next = rules.map((item, i) => (i === idx ? { ...item, enabled: val } : item));
                    void saveRules(next);
                  }}
                  trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
                  thumbColor={theme.colors.accentForeground}
                />,
              ]}
            />
          );
        })}
      </View>

      <SectionTitle>添加规则</SectionTitle>
      <View style={s.wrap}>
        <TextInput
          accessibilityLabel="Provider 匹配模式"
          style={s.input}
          value={newProvider}
          onChangeText={setNewProvider}
          placeholder="Provider（如 claude*）"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
        <TextInput
          accessibilityLabel="默认模式 ID"
          style={s.input}
          value={newMode}
          onChangeText={setNewMode}
          placeholder="模式（如 bypassPermissions）"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
        <Btn
          small
          label={newAutoApprove ? '自动授权：开启' : '自动授权：不改'}
          onPress={() => setNewAutoApprove(v => !v)}
        />
        <Btn primary label="添加规则" disabled={!newProvider.trim() || busy} onPress={() => void addRule()} />
      </View>

      <RuleNote>
        网页没有传值时按此表填入；网页显式传了值时以网页为准。Provider 结尾加 * 表示前缀匹配（如 claude* 匹配所有
        Claude 账号）。
      </RuleNote>
    </View>
  );
}

function ProviderInstanceDrawer() {
  const { s } = useUi();
  const { providerInstance } = useControlState();
  const running = providerInstance ? providerInstance.instanceState === 'running' || providerInstance.instanceState === 'legacy' : true;
  const providers = providerInstance?.providers.map(p => p.id).join(', ') || 'cloud-session, antigravity';
  const runningCount = providerInstance?.runningSessionsCount ?? 0;

  return (
    <View style={{ gap: 12 }}>
      <TableRow first cells={['状态', <Chip key="st" label={running ? '运行中' : '未运行'} tone={running ? 'success' : 'danger'} />]} />
      <TableRow cells={['状态目录', <Text key="dir" style={s.mono}>~/.paseo/providers</Text>]} />
      <TableRow cells={['承载的 Provider', <Text key="p" style={s.mono}>{providers}</Text>]} />
      <TableRow cells={['运行中的会话', `${runningCount} 个`]} />
      <RuleNote>
        为什么单独开一个实例：重载“开发自动化”插件（改界面、规则、GitHub 订阅）不会重启这个实例，正在跑的
        Antigravity 和云端会话不会中断。只有在更新 Provider 代码后、且当前没有运行中的会话时，才重载该实例。
      </RuleNote>
    </View>
  );
}

function CloudSessionDrawer() {
  const { s } = useUi();
  const { cloudSession, providerInstance } = useControlState();
  const status = cloudSession ?? providerInstance?.cloudSession;
  const onlineSessions = status?.onlineSessions ?? 0;
  const unacked = status?.unackedMessages ?? 0;

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>云端会话状态</SectionTitle>
      <TableRow first cells={['状态', <Chip key="st" label={status?.enabled !== false ? '已启用' : '未启用'} tone="success" />]} />
      <TableRow cells={['在线云端会话', `${onlineSessions} 个`]} />
      <TableRow cells={['未确认消息', `${unacked} 条`]} />
      <RuleNote>由本机 Provider 实例承载；主实例通过跨实例转发收发消息和提问。</RuleNote>
    </View>
  );
}

function AntigravityDrawer() {
  const { s, control, theme } = useUi();
  const { antigravity, antigravityStatus } = useControlState();
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [homeDir, setHomeDir] = useState('');
  const [busy, setBusy] = useState(false);

  const accounts = antigravity?.accounts ?? [];

  const addAccount = async () => {
    if (!providerId.trim() || !label.trim()) return;
    setBusy(true);
    try {
      await control.addAntigravityAccount({
        providerId: providerId.trim(),
        label: label.trim(),
        homeDir: homeDir.trim() || undefined,
      });
      setProviderId('');
      setLabel('');
      setHomeDir('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {antigravityStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>Antigravity 多账号模块未启用（等待对应服务端模块合并或开启）。</Text>
        </Notice>
      ) : null}
      <SectionTitle>本机 Antigravity 账号</SectionTitle>
      {accounts.length === 0 ? (
        <Text style={s.muted}>暂无已登记的 Antigravity 账号。</Text>
      ) : (
        <View>
          <TableRow first header cells={['账号标识', '名称', '目录', '启用']} />
          {accounts.map(acc => (
            <TableRow
              key={acc.providerId}
              cells={[
                <Text key="id" style={s.mono}>
                  {acc.providerId}
                </Text>,
                acc.label,
                <Text key="dir" style={s.mono}>
                  {acc.homeDir ?? '默认'}
                </Text>,
                <Switch
                  key="sw"
                  accessibilityLabel={`启用 ${acc.label}`}
                  value={acc.enabled}
                  onValueChange={val => void control.toggleAntigravityAccount({ providerId: acc.providerId, enabled: val })}
                  trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
                  thumbColor={theme.colors.accentForeground}
                />,
              ]}
            />
          ))}
        </View>
      )}
      <View style={s.wrap}>
        <TextInput
          accessibilityLabel="Antigravity 账号 ID"
          style={s.input}
          value={providerId}
          onChangeText={setProviderId}
          placeholder="标识（如 antigravity-3）"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
        />
        <TextInput
          accessibilityLabel="Antigravity 名称"
          style={s.input}
          value={label}
          onChangeText={setLabel}
          placeholder="显示名称（如 账号 C）"
          placeholderTextColor={theme.colors.foregroundMuted}
        />
        <Btn
          primary
          label="添加账号"
          disabled={!providerId.trim() || !label.trim() || busy}
          onPress={() => void addAccount()}
        />
      </View>
      <RuleNote>停用或移除账号不会中断已经用该账号启动的会话；新回合按剩余可用账号顺序选择。</RuleNote>
    </View>
  );
}

function QaModeDrawer() {
  const { s, control, theme } = useUi();
  const { presence } = useControlState();
  const settings = presence?.settings ?? { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null };

  return (
    <View style={{ gap: 12 }}>
      <Segmented
        options={[
          { value: 'online', label: '在线' },
          { value: 'offline', label: '离线' },
          { value: 'auto', label: '自动' },
        ]}
        value={settings.mode}
        onChange={mode => void control.configurePresence({ ...settings, mode })}
      />
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>暂停问答代答与转发</Text>
        <Switch
          accessibilityLabel="暂停问答代答与转发"
          value={settings.paused}
          onValueChange={paused => void control.configurePresence({ ...settings, paused })}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
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
  const { s, control } = useUi();
  const { presence } = useControlState();
  const settings = presence?.settings ?? { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null };
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDevices = async (hostId: string | null) => {
    setLoading(true);
    try {
      const res = await control.bluetoothDevices(hostId);
      setDevices(res.devices);
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDevices(settings.sourceHostId ?? null);
  }, [settings.sourceHostId]);

  const hosts = presence?.hosts ?? [];

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.text}>来源主机</Text>
        <View style={s.wrap}>
          <Btn
            small
            primary={!settings.sourceHostId}
            label="自动（任一主机在场即在线）"
            onPress={() => void control.configurePresence({ ...settings, sourceHostId: null })}
          />
          {hosts.map(h => (
            <Btn
              key={h.id}
              small
              primary={settings.sourceHostId === h.id}
              label={h.name}
              onPress={() => void control.configurePresence({ ...settings, sourceHostId: h.id })}
            />
          ))}
        </View>
      </View>

      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <SectionTitle>锚定设备</SectionTitle>
        <Btn small label="刷新设备" busy={loading} onPress={() => void loadDevices(settings.sourceHostId ?? null)} />
      </View>
      {devices.length === 0 ? (
        <Text style={s.small}>
          当前观测：{presence?.observation.reason ?? '已连接随身手机'}
        </Text>
      ) : (
        devices.map(dev => (
          <View key={`${dev.name}-${dev.address ?? ''}`} style={[s.row, { justifyContent: 'space-between' }]}>
            <Text style={s.text}>
              {dev.name} {dev.connected ? '（已连接）' : '（未连接）'}
            </Text>
            <Btn
              small
              label="设为锚定设备"
              onPress={() => void control.selectBluetooth(settings.sourceHostId ?? null, { name: dev.name, address: dev.address })}
            />
          </View>
        ))
      )}

      <RuleNote>
        两台主机任一检测到设备在场即判为在线；两台都确认离开（连续 2 次扫描未见或信号低于阈值）才判为离线；任一主机未知且无在场主机时判为未知（按在线处理）。
      </RuleNote>
    </View>
  );
}

function EscalationDrawer() {
  const { s, control, openSettings } = useUi();
  const { escalation, escalationStatus } = useControlState();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const delivery = escalation?.delivery ?? 'live';
  const delayMinutes = escalation?.delayMinutes ?? 15;
  const windows = escalation?.immediate ?? [{ days: 'daily' as const, from: '00:00', to: '09:00' }];

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await control.testEscalationWebhook();
      setTestResult(res.sent ? `已发送测试通知：${res.message}` : `测试未通过：${res.message}`);
    } catch (error) {
      setTestResult(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      {escalationStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>升级通知模块未启用（等待对应服务端模块合并或开启）。</Text>
        </Notice>
      ) : null}
      <SectionTitle>时段规则（{escalation?.timezone ?? 'Asia/Singapore'}）</SectionTitle>
      <View>
        <TableRow first header cells={['规则', '时间范围', '等待策略']} />
        {windows.map((win, idx) => (
          <TableRow
            key={idx}
            cells={[
              win.days === 'daily'
                ? '每天免等时段'
                : win.days === 'weekdays'
                  ? '工作日'
                  : Array.isArray(win.days)
                    ? `周 ${win.days.join(',')}`
                    : '周末',
              <Text key="t" style={s.mono}>
                {win.from} – {win.to}
              </Text>,
              '立即升级通知',
            ]}
          />
        ))}
        <TableRow cells={['其余时段', '默认等待', `满 ${delayMinutes} 分钟未答后通知`]} />
      </View>

      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>投递模式</Text>
        <Segmented
          options={[
            { value: 'live', label: '实际发送' },
            { value: 'shadow', label: '影子（只记日志）' },
          ]}
          value={delivery}
          onChange={val => void control.configureEscalation({ delivery: val }).catch(() => {})}
        />
      </View>

      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <Text style={s.text}>
          Webhook 状态：<Text style={s.mono}>{escalation?.webhook.fingerprint ?? 'hooks.example.net/…9f2a'}</Text>
        </Text>
        <View style={s.wrap}>
          <Btn small label="发测试通知" busy={testing} onPress={() => void runTest()} />
          {openSettings ? (
            <Btn small label="去设置更换" onPress={() => openSettings('dev-automation')} />
          ) : null}
        </View>
      </View>
      {testResult ? <Text style={s.small}>{testResult}</Text> : null}

      <RuleNote>
        与代答独立计时：即使离线模式已在第 5 秒代答，只要本人一直未在 Paseo
        确认且到达时段等待时长，或者题目属于“必须本人确认”，仍会向 Grok 发送升级通知。同一问题只通知一次。
      </RuleNote>
    </View>
  );
}

function QuietChildrenDrawer() {
  const { s, control, theme } = useUi();
  const { quiet, quietStatus } = useControlState();
  const forwardEvents = quiet?.forwardEvents ?? true;
  const recent = quiet?.recentHandled ?? [];

  return (
    <View style={{ gap: 12 }}>
      {quietStatus === 'disabled' ? (
        <Notice tone="neutral">
          <Text style={s.text}>子会话免提醒模块未启用（等待对应服务端模块合并或开启）。</Text>
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
          value={forwardEvents}
          onValueChange={val => void control.configureQuiet({ forwardEvents: val }).catch(() => {})}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>

      <SectionTitle>最近处理的子会话</SectionTitle>
      {recent.length === 0 ? (
        <Text style={s.muted}>暂无最近处理的子会话记录（置顶工作区数：{quiet?.pinnedWorkspaceCount ?? 3}）。</Text>
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
  const { presence } = useControlState();
  const settings = presence?.settings ?? { mode: 'auto', paused: false, speechEnabled: true, sourceHostId: null };

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>开启语音提醒</Text>
        <Switch
          accessibilityLabel="开启语音提醒"
          value={settings.speechEnabled}
          onValueChange={speechEnabled => void control.configurePresence({ ...settings, speechEnabled })}
          trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
          thumbColor={theme.colors.accentForeground}
        />
      </View>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>播报主机</Text>
        <Chip label={presence?.hostName || '跟随在场主机'} tone="neutral" />
      </View>
      <RuleNote>
        只在判定在线且有新提问或停滞会话时播报；优先使用专用晓晓语音环境，不可用时回退系统语音；你在任一端回答后立即停止播报。
      </RuleNote>
    </View>
  );
}

function ApprovalDrawer() {
  const { s, control } = useUi();
  const { automation } = useControlState();
  const policies = automation?.policies ?? [];
  const sessions = automation?.sessions ?? [];

  return (
    <View style={{ gap: 12 }}>
      <SectionTitle>本机策略</SectionTitle>
      {policies.length === 0 ? (
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

function GithubConfigDrawer() {
  const { s, store, openSettings, theme } = useUi();
  const { snapshot } = useStoreState();
  const base: Preferences = snapshot?.preferences ?? {
    enabled: true,
    shadow: false,
    organization: 'fliggy-travel-ai',
    excludedRepos: [],
    extraRepos: [],
    providerPolicies: { claude: 'interrupt', codex: 'interrupt', opencode: 'skip' },
  };
  const [draft, setDraft] = useState<Preferences>(base);
  const [excludedText, setExcludedText] = useState(base.excludedRepos.join(', '));
  const [extraText, setExtraText] = useState(base.extraRepos.join(', '));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
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
      setMsg('GitHub 订阅设置已保存');
    } catch (error) {
      setMsg(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.text}>投递模式</Text>
        <Segmented
          options={[
            { value: 'live', label: '实际发送' },
            { value: 'shadow', label: '影子（只记日志）' },
          ]}
          value={draft.shadow ? 'shadow' : 'live'}
          onChange={val => setDraft(prev => ({ ...prev, shadow: val === 'shadow' }))}
        />
      </View>
      <View style={s.stack}>
        <Text style={s.text}>组织</Text>
        <TextInput
          accessibilityLabel="GitHub 组织"
          style={s.input}
          value={draft.organization}
          onChangeText={organization => setDraft(prev => ({ ...prev, organization }))}
          autoCapitalize="none"
        />
      </View>
      <View style={s.stack}>
        <Text style={s.text}>排除仓库（逗号分隔）</Text>
        <TextInput
          accessibilityLabel="排除仓库"
          style={s.input}
          value={excludedText}
          onChangeText={setExcludedText}
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
          onChangeText={setExtraText}
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
              onChange={policy =>
                setDraft(prev => ({
                  ...prev,
                  providerPolicies: { ...prev.providerPolicies, [provider]: policy },
                }))
              }
            />
          </View>
        );
      })}

      <View style={s.wrap}>
        <Btn primary label="保存设置" busy={saving} onPress={() => void save()} />
        {openSettings ? (
          <Btn label="去设置更换令牌" onPress={() => openSettings('dev-automation')} />
        ) : null}
      </View>
      {msg ? <Text style={s.small}>{msg}</Text> : null}
      <RuleNote>GitHub 令牌在 Paseo 设置 → 开发自动化 填写和更换。</RuleNote>
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
      case 'claude-accounts':
        return <ClaudeAccountsDrawer onOpenDrawer={onOpenDrawer} />;
      case 'add-claude':
        return <AddClaudeDrawer />;
      case 'browser':
        return <BrowserDrawer onOpenDrawer={onOpenDrawer} />;
      case 'add-browser':
        return <AddBrowserDrawer />;
      case 'claude-quota':
        return <ClaudeQuotaDrawer />;
      case 'session-defaults':
        return <SessionDefaultsDrawer />;
      case 'provider-instance':
        return <ProviderInstanceDrawer />;
      case 'cloud':
        return <CloudSessionDrawer />;
      case 'antigravity':
        return <AntigravityDrawer />;
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
