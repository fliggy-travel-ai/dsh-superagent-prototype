import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import { useEffect, useState } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { BrowserUsageSettings } from '../../shared/browser-usage.ts';
import { until } from '../format.ts';
import { errorMessage } from '../store.ts';
import { Btn, Card, Chip, Notice, useControlState, useStoreState, useUi } from '../ui.tsx';

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

function MachineConfigCard() {
  const { s, control, theme } = useUi();
  const { machineSettings, modules } = useControlState();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupResult, setBackupResult] = useState<{ backupPath: string; files: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configPath = machineSettings?.configPath ?? modules?.config.path ?? '~/.paseo/github-subscriptions/machine.json';
  const hostLabel = machineSettings?.machine ?? (modules?.instance.role === 'provider' ? 'Provider 实例' : '本机');
  const configErrors = machineSettings?.errors ?? modules?.config.errors ?? [];
  const moduleItems =
    machineSettings?.modules ??
    (modules?.modules.map(m => ({
      id: m.id,
      label: m.label,
      enabled: m.state === 'running',
      state: m.state,
      reason: m.reason,
      reloadRequired: false,
    })) ?? []);

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    setError(null);
    try {
      await control.toggleModule(id, enabled);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyId(null);
    }
  };

  const runBackup = async () => {
    setBackupBusy(true);
    setError(null);
    try {
      const res = await control.exportBackup();
      setBackupResult({ backupPath: res.backupPath, files: res.files });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <Card
      title="机器配置（machine.json）"
      trailing={<Chip label={hostLabel} tone="neutral" />}
    >
      <View style={{ gap: 4 }}>
        <Text style={s.text}>配置文件路径：</Text>
        <Text style={s.mono}>{configPath}</Text>
      </View>
      {configErrors.length > 0 ? (
        <Notice tone="danger">
          {configErrors.map((err, idx) => (
            <Text key={idx} style={s.text}>
              {err}
            </Text>
          ))}
        </Notice>
      ) : (
        <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>配置文件格式校验通过。</Text>
      )}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}

      <View style={{ gap: 8, marginTop: 4 }}>
        <Text style={s.strong}>本机模块开关</Text>
        {moduleItems.length === 0 ? (
          <Text style={s.muted}>正在读取模块列表…</Text>
        ) : (
          moduleItems.map((item, idx) => (
            <View
              key={item.id}
              style={[
                s.row,
                {
                  justifyContent: 'space-between',
                  paddingVertical: 8,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: theme.colors.border,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <View style={s.wrap}>
                  <Text style={s.strong}>{item.label}</Text>
                  <Text style={s.mono}>{item.id}</Text>
                  <Chip
                    label={item.state === 'running' ? '运行中' : item.state === 'error' ? '出错' : '已关闭'}
                    tone={item.state === 'running' ? 'success' : item.state === 'error' ? 'danger' : 'neutral'}
                  />
                </View>
                {item.reason ? <Text style={s.small}>{item.reason}</Text> : null}
                {item.reloadRequired ? (
                  <Text style={s.small}>涉及 Provider 或额度来源注册，修改后在下次插件启动时生效。</Text>
                ) : null}
              </View>
              <Switch
                accessibilityLabel={`模块 ${item.label}`}
                value={item.enabled}
                disabled={busyId === item.id}
                onValueChange={val => void toggle(item.id, val)}
                trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
                thumbColor={theme.colors.accentForeground}
              />
            </View>
          ))
        )}
      </View>

      <View style={[s.wrap, { paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }]}>
        <Btn label="导出配置备份" onPress={() => void runBackup()} busy={backupBusy} />
        {backupResult ? (
          <Text style={s.small}>
            已导出 {backupResult.files.length} 个文件至 {backupResult.backupPath}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

function WebhookCredentialCard() {
  const { s, control, theme } = useUi();
  const { escalation, escalationStatus } = useControlState();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const webhook = escalation?.webhook;
  const disabled = escalationStatus === 'disabled';

  const save = async () => {
    if (!url.trim() || busy) return;
    setBusy('save');
    setError(null);
    setMessage(null);
    try {
      await control.configureEscalationWebhook({ url: url.trim(), auth: secret.trim() || undefined });
      setUrl('');
      setSecret('');
      setMessage('Webhook 凭据已保存（0600 权限）');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const testWebhook = async () => {
    if (busy) return;
    setBusy('test');
    setError(null);
    setMessage(null);
    try {
      const res = await control.testEscalationWebhook();
      setMessage(res.sent ? `测试发送已响应：${res.message}` : `测试未通过：${res.message}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Webhook 凭据状态（升级通知）"
      trailing={
        disabled ? (
          <Chip label="模块未启用" tone="neutral" />
        ) : (
          <Chip
            label={webhook?.configured ? '已配置' : '未配置'}
            tone={webhook?.configured ? 'success' : 'neutral'}
          />
        )
      }
    >
      {disabled ? (
        <Text style={s.muted}>
          升级通知模块（answer.escalation）当前未启用或服务端尚未合并。启用后可在此查看和更换 Webhook 凭据。
        </Text>
      ) : (
        <>
          <View style={{ gap: 4 }}>
            <Text style={s.text}>
              凭据文件：{webhook?.configured ? '已存在（0600 权限）' : '未创建'} · 目标域名：
              {webhook?.hostname ?? '—'}
            </Text>
            <Text style={s.text}>
              指纹：<Text style={s.mono}>{webhook?.fingerprint ?? '未配置'}</Text>
            </Text>
          </View>
          <TextInput
            accessibilityLabel="Webhook 地址"
            style={s.input}
            value={url}
            onChangeText={setUrl}
            placeholder={webhook?.configured ? '填写新的 Webhook 地址以更换' : '填写 Webhook 地址'}
            placeholderTextColor={theme.colors.foregroundMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
          <TextInput
            accessibilityLabel="Webhook 认证头"
            style={s.input}
            value={secret}
            onChangeText={setSecret}
            placeholder="可选：签名密钥或认证头（保存后不回显）"
            placeholderTextColor={theme.colors.foregroundMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
          {message ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{message}</Text> : null}
          <View style={s.wrap}>
            <Btn
              primary
              label={webhook?.configured ? '更换 Webhook 凭据' : '保存 Webhook 凭据'}
              disabled={!url.trim() || busy !== null}
              busy={busy === 'save'}
              onPress={() => void save()}
            />
            {webhook?.configured ? (
              <Btn label="发测试通知" disabled={busy !== null} busy={busy === 'test'} onPress={() => void testWebhook()} />
            ) : null}
          </View>
          <Text style={s.small}>
            Webhook 完整地址和密钥只保存在本机 0600 凭据文件中，界面与日志只显示域名和 8 位指纹。
          </Text>
        </>
      )}
    </Card>
  );
}

export function SettingsScreen(_props: PluginSurfaceProps) {
  const { s, openScreen } = useUi();

  return (
    <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
      <View style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.h1}>开发自动化设置</Text>
          <Text style={s.muted}>管理本机模块开关、配置文件、GitHub 令牌、AdsPower API key 与 Webhook 凭据。</Text>
        </View>
        <Btn label="打开开发自动化" onPress={() => openScreen({ screenId: 'main' })} />
      </View>

      <MachineConfigCard />
      <TokenCard />
      <AdsPowerKeyCard />
      <WebhookCredentialCard />
    </ScrollView>
  );
}
