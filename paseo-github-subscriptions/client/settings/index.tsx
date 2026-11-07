import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { Preferences } from '../../shared/model.ts';
import { until } from '../format.ts';
import { errorMessage } from '../store.ts';
import { Btn, Card, Chip, Notice, Segmented, useStoreState, useUi } from '../ui.tsx';

const ORG_PATTERN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const KNOWN_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
];

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  const { s } = useUi();
  return (
    <View style={s.stack}>
      <Text style={s.strong}>{props.label}</Text>
      {props.hint ? <Text style={s.muted}>{props.hint}</Text> : null}
      {props.children}
    </View>
  );
}

function SwitchRow(props: { label: string; hint: string; value: boolean; onChange(value: boolean): void }) {
  const { s, theme } = useUi();
  return (
    <View style={[s.row, { justifyContent: 'space-between' }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.strong}>{props.label}</Text>
        <Text style={s.muted}>{props.hint}</Text>
      </View>
      <Switch
        accessibilityLabel={props.label}
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
        thumbColor={theme.colors.accentForeground}
      />
    </View>
  );
}

/** 一个可增删的字符串列表：先在草稿里改，点“保存设置”才写入。 */
function ListEditor(props: { items: readonly string[]; placeholder: string; validate(value: string): string | null; onChange(items: string[]): void; empty: string }) {
  const { s, theme } = useUi();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    const invalid = props.validate(value);
    if (invalid) return setProblem(invalid);
    if (!props.items.includes(value)) props.onChange([...props.items, value]);
    setText('');
    setProblem(null);
  };
  return (
    <View style={{ gap: 8 }}>
      <View style={s.wrap}>
        {props.items.length === 0 ? <Text style={s.muted}>{props.empty}</Text> : null}
        {props.items.map((item) => (
          <View key={item} style={[s.chip, s.row, { gap: 6 }]}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{item}</Text>
            <Text
              accessibilityRole="button"
              accessibilityLabel={`移除 ${item}`}
              onPress={() => props.onChange(props.items.filter((other) => other !== item))}
              style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}
            >
              ×
            </Text>
          </View>
        ))}
      </View>
      <View style={s.row}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          onSubmitEditing={add}
          placeholder={props.placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Btn label="添加" onPress={add} disabled={!text.trim()} />
      </View>
      {problem ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{problem}</Text> : null}
    </View>
  );
}

function TokenCard() {
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
      toast.show(status.error ? `令牌已保存，但检查未通过：${status.error}` : '令牌已保存', { variant: status.error ? 'warning' : 'success' });
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
    <Card title="GitHub 令牌">
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
        <Btn primary label={token?.configured ? '更换令牌' : '保存令牌'} onPress={() => void save()} disabled={!value.trim()} busy={busy === 'save'} />
        {token?.configured ? <Btn label="重新检查" onPress={() => void run('check', () => store.pollNow())} busy={busy === 'check'} /> : null}
        {token?.configured ? <Btn danger label="移除令牌" onPress={() => void run('remove', () => store.removeToken())} busy={busy === 'remove'} /> : null}
      </View>
      <Text style={s.small}>令牌只保存在本机插件目录，仅本人可读。界面只显示前缀和账号，保存后输入框立即清空。</Text>
    </Card>
  );
}

export function SettingsScreen(_props: PluginScreenProps) {
  const { s, store, openScreen, theme } = useUi();
  const toast = useToast();
  const { snapshot, error } = useStoreState();
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [customProvider, setCustomProvider] = useState('');

  if (!snapshot) {
    return (
      <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
        <Text style={s.h1}>GitHub 订阅设置</Text>
        {error ? (
          <Notice tone="danger">
            <Text style={s.text}>无法读取设置：{error}</Text>
          </Notice>
        ) : (
          <Text style={s.muted}>正在读取…</Text>
        )}
      </ScrollView>
    );
  }

  const base = snapshot.preferences;
  const view = draft ?? base;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(base);
  const change = (patch: Partial<Preferences>) => setDraft({ ...view, ...patch });
  const orgValid = ORG_PATTERN.test(view.organization);
  const providerIds = [...new Set([...KNOWN_PROVIDERS.map((p) => p.id), ...Object.keys(view.providerPolicies)])];
  const providerLabel = (id: string) => KNOWN_PROVIDERS.find((p) => p.id === id)?.label ?? id;
  const setPolicy = (id: string, policy: 'interrupt' | 'skip') => change({ providerPolicies: { ...view.providerPolicies, [id]: policy } });

  const save = async () => {
    if (!orgValid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await store.savePreferences(view);
      setDraft(null);
      toast.show('设置已保存', { variant: 'success' });
    } catch (failure) {
      setSaveError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={s.page} contentContainerStyle={s.pageContent}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.h1}>GitHub 订阅设置</Text>
          <Text style={s.muted}>监听组织仓库的 GitHub 事件，按会话订阅直接发到会话。轮询间隔固定 {snapshot.intervalSeconds} 秒。</Text>
        </View>
        <Btn label="返回订阅页" onPress={() => openScreen({ screenId: 'main' })} />
      </View>

      <Card title="运行方式">
        <SwitchRow label="启用监听" hint="关闭后不再轮询 GitHub，订阅保留。" value={view.enabled} onChange={(enabled) => change({ enabled })} />
        <SwitchRow
          label="影子模式"
          hint={view.shadow ? '开启中：事件只记日志，不发给任何会话。用来先观察事件是否正确。' : '已关闭：事件会实际发送到订阅的会话。'}
          value={view.shadow}
          onChange={(shadow) => change({ shadow })}
        />
        {!view.shadow ? (
          <Notice tone="warning">
            <Text style={s.text}>关闭影子模式并保存后，订阅的会话会立即收到消息，包括正在运行的会话。</Text>
          </Notice>
        ) : null}
      </Card>

      <TokenCard />

      <Card title="会话工具">
        {snapshot.toolInjection ? (
          <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>“给会话注入 MCP 工具”已打开。所有会话都能用订阅工具。</Text>
        ) : (
          <>
            <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>“给会话注入 MCP 工具”未打开，会话看不到订阅工具，无法订阅。</Text>
            <Text style={s.muted}>修复：打开 Paseo 设置 → 守护进程 → “给会话注入 MCP 工具”，然后重启守护进程。已打开的会话会在下一次空闲时重开并拿到工具。</Text>
          </>
        )}
        <View style={s.row}>
          <Btn label="重新检查" onPress={() => void store.refresh()} />
        </View>
      </Card>

      <Card title="监听范围">
        <Field label="组织" hint="组织里新建的仓库默认会被监听。">
          <TextInput
            style={s.input}
            value={view.organization}
            onChangeText={(organization) => change({ organization })}
            placeholder="组织名"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!orgValid ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>组织名只能包含字母、数字和连字符。</Text> : null}
        </Field>
        <Field label="排除的仓库" hint="这些仓库不监听。填写仓库名，不含组织。">
          <ListEditor
            items={view.excludedRepos}
            empty="没有排除的仓库"
            placeholder="仓库名，例如 rea"
            validate={(value) => (/^[\w.-]+$/.test(value) ? null : '仓库名只能包含字母、数字、点、下划线和连字符。')}
            onChange={(excludedRepos) => change({ excludedRepos })}
          />
        </Field>
        <Field label="额外仓库" hint="组织以外要监听的仓库，格式 owner/repo。">
          <ListEditor
            items={view.extraRepos}
            empty="无"
            placeholder="owner/repo"
            validate={(value) => (REPO_PATTERN.test(value) ? null : '请输入 owner/repo。')}
            onChange={(extraRepos) => change({ extraRepos })}
          />
        </Field>
      </Card>

      <Card title="会话忙时（按提供方）">
        <Text style={s.muted}>
          “立即发送”：会话忙或空闲都立即发送；提供方不支持插入当前回合时，Paseo 会中断当前回合。“跳过本轮”：会话忙时不发送这一批事件，也不排队补发。
        </Text>
        {providerIds.map((id) => (
          <View key={id} style={[s.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
            <Text style={s.strong}>{providerLabel(id)}</Text>
            <Segmented
              value={view.providerPolicies[id] ?? 'interrupt'}
              onChange={(policy) => setPolicy(id, policy)}
              options={[
                { value: 'interrupt', label: '立即发送' },
                { value: 'skip', label: '跳过本轮' },
              ]}
            />
          </View>
        ))}
        <View style={s.row}>
          <TextInput
            style={s.input}
            value={customProvider}
            onChangeText={setCustomProvider}
            placeholder="其他提供方名称（小写英文），例如 gemini"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Btn
            label="添加"
            disabled={!customProvider.trim()}
            onPress={() => {
              const id = customProvider.trim();
              if (id && !(id in view.providerPolicies)) setPolicy(id, 'interrupt');
              setCustomProvider('');
            }}
          />
        </View>
      </Card>

      {saveError ? (
        <Notice tone="danger">
          <Text style={s.text}>保存失败：{saveError}</Text>
        </Notice>
      ) : null}
      <View style={s.row}>
        <Btn primary label="保存设置" onPress={() => void save()} disabled={!dirty || !orgValid} busy={saving} />
        {dirty ? <Btn label="放弃修改" onPress={() => setDraft(null)} /> : null}
        {dirty ? <Chip label="有未保存的修改" tone="warning" /> : null}
      </View>
    </ScrollView>
  );
}
