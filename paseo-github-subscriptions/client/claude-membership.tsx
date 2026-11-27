import type { PluginClientContext } from '@getpaseo/plugin/client';
import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  claudeMembershipList, claudeMembershipSet, MembershipRenewalSchema,
  type MembershipAccount, type MembershipRenewal,
} from '../shared/claude-membership.ts';
import { modulesStatus } from '../shared/modules.ts';
import { Btn, Card, Notice, useUi } from './ui.tsx';

type MembershipRpc = Pick<PluginClientContext, 'rpc'>;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function AccountRow({ account, save }: {
  account: MembershipAccount;
  save(renewal: MembershipRenewal | null): Promise<MembershipRenewal | null>;
}) {
  const { s, theme } = useUi();
  const [renewal, setRenewal] = useState(account.renewal);
  const [day, setDay] = useState(renewal ? String(renewal.day) : '');
  const [time, setTime] = useState(renewal?.time ?? '');
  const [pending, setPending] = useState<'save' | 'clear' | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const editable = account.label !== null;

  async function update(action: 'save' | 'clear') {
    const parsed = MembershipRenewalSchema.safeParse({ day: /^[0-9]{1,2}$/.test(day) ? Number(day) : NaN, time });
    if (action === 'save' && !parsed.success) {
      setMessage({ text: '请输入 1–31 的续费日和 24 小时制时间（HH:MM）。', error: true });
      return;
    }
    setPending(action);
    setMessage(null);
    try {
      const saved = await save(action === 'save' && parsed.success ? parsed.data : null);
      setRenewal(saved);
      setDay(saved ? String(saved.day) : '');
      setTime(saved?.time ?? '');
      setMessage({ text: saved ? '已保存' : '已清除', error: false });
    } catch (error) {
      setMessage({ text: errorText(error), error: true });
    } finally {
      setPending(null);
    }
  }

  return (
    <Card>
      <View style={s.stack}>
        <Text style={s.strong}>{account.label ?? '账号已不在本机'}</Text>
        <Text style={s.muted} selectable>{account.email}</Text>
      </View>
      {editable ? <View style={s.wrap}>
        <View style={[s.stack, { width: 92 }]}>
          <Text style={s.small}>续费日</Text>
          <TextInput accessibilityLabel="续费日" value={day} onChangeText={value => { setDay(value); setMessage(null); }}
            keyboardType="number-pad" placeholder="1–31" placeholderTextColor={theme.colors.foregroundMuted}
            style={[s.input, { minWidth: 0 }]} editable={!pending} />
        </View>
        <View style={[s.stack, { width: 108 }]}>
          <Text style={s.small}>续费时间</Text>
          <TextInput accessibilityLabel="续费时间" value={time} onChangeText={value => { setTime(value); setMessage(null); }}
            placeholder="HH:MM" placeholderTextColor={theme.colors.foregroundMuted}
            style={[s.input, { minWidth: 0 }]} editable={!pending} />
        </View>
      </View> : <Text style={s.small}>每月 {day} 日 {time}（北京时间）</Text>}
      <View style={s.wrap}>
        {editable ? <Btn label="保存" primary busy={pending === 'save'} disabled={!!pending || (!day && !time)} onPress={() => void update('save')} /> : null}
        <Btn label="清除" busy={pending === 'clear'} disabled={!!pending || !renewal} onPress={() => void update('clear')} />
      </View>
      {message ? (
        <Text accessibilityRole={message.error ? 'alert' : undefined} accessibilityLiveRegion="polite"
          style={[s.small, { color: message.error ? theme.colors.statusDanger : theme.colors.statusSuccess }]}>{message.text}</Text>
      ) : null}
    </Card>
  );
}

export function createMembershipScreen(client: MembershipRpc) {
  return function MembershipScreen() {
    const { s } = useUi();
    const [reload, setReload] = useState(0);
    const [accounts, setAccounts] = useState<MembershipAccount[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      let active = true;
      void client.rpc(modulesStatus, {}).then(({ instance, modules }) => {
        if (instance.role !== 'main' || !modules.some(module => module.id === 'usage.claudeAccounts' && module.state === 'running')) {
          throw new Error('额度模块未在本主机运行，无法设置会员到期');
        }
        return client.rpc(claudeMembershipList, {});
      }).then(
        result => { if (active) setAccounts(result); },
        cause => { if (active) setError(errorText(cause)); },
      );
      return () => { active = false; };
    }, [reload]);

    return (
      <ScrollView style={s.page} contentContainerStyle={[s.pageContent, { maxWidth: 700 }]} keyboardShouldPersistTaps="handled">
        <Text style={s.muted}>填写每月续费日和时间（北京时间）。插件将在额度卡片上显示下一次续费的倒计时。</Text>
        {!accounts && !error ? <Text style={s.muted}>正在读取本机账号…</Text> : null}
        {error ? <Notice tone="danger"><Text style={s.text}>{error}</Text></Notice> : null}
        {accounts?.length === 0 ? <Text style={s.muted}>本机暂未发现带邮箱的 Claude 账号。</Text> : null}
        {error || accounts?.length === 0 ? (
          <View style={s.wrap}><Btn label="重新读取" onPress={() => { setAccounts(null); setError(null); setReload(value => value + 1); }} /></View>
        ) : null}
        {accounts?.map(account => (
          <AccountRow key={account.email} account={account} save={async renewal => {
            const saved = await client.rpc(claudeMembershipSet, { email: account.email, renewal });
            if (saved === null && account.label === null) {
              setAccounts(current => current?.filter(item => item.email !== account.email) ?? null);
            }
            return saved;
          }} />
        ))}
      </ScrollView>
    );
  };
}
