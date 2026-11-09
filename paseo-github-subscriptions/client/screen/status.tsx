import { Text, View } from 'react-native';
import { ago, until } from '../format.ts';
import { Btn, Card, Chip, Notice, useStoreState, useUi } from '../ui.tsx';

const HOUR_MS = 3_600_000;

function Stat(props: { label: string; value: string; unit?: string; detail?: string }) {
  const { s } = useUi();
  return (
    <View style={[s.card, { flex: 1, minWidth: 200, padding: 14, gap: 4 }]}>
      <Text style={s.muted}>{props.label}</Text>
      <Text style={s.h1}>
        {props.value}
        {props.unit ? <Text style={s.muted}> {props.unit}</Text> : null}
      </Text>
      {props.detail ? <Text style={s.small}>{props.detail}</Text> : null}
    </View>
  );
}

export function StatusTab({ onEditConfig }: { onEditConfig?: () => void } = {}) {
  const { s, now, theme, openScreen, compact } = useUi();
  const { snapshot, error } = useStoreState();
  if (!snapshot) return <Text style={s.muted}>正在读取监听状态…</Text>;
  const { repositories, token, preferences } = snapshot;
  const failing = repositories.filter((repo) => repo.error);
  const hourDeliveries = snapshot.deliveries.filter((d) => now - Date.parse(d.at) < HOUR_MS);
  const count = (status: string) => hourDeliveries.filter((d) => d.status === status).length;
  const healthy = !error && !snapshot.error && failing.length === 0 && token.configured;
  const nextIn = snapshot.lastPollAt ? Math.max(0, snapshot.intervalSeconds - Math.round((now - Date.parse(snapshot.lastPollAt)) / 1000)) : null;

  return (
    <View style={{ gap: 12 }}>
      {error ? (
        <Notice tone="danger">
          <Text style={s.text}>无法读取插件状态：{error}</Text>
        </Notice>
      ) : null}
      {snapshot.error ? (
        <Notice tone="danger">
          <Text style={s.text}>{snapshot.error}</Text>
        </Notice>
      ) : null}
      <View style={{ flexDirection: compact ? 'column' : 'row', gap: 12 }}>
        <Stat
          label="监听"
          value={!preferences.enabled ? '已暂停' : healthy ? '正常' : '有问题'}
          detail={`上一轮 ${ago(snapshot.lastPollAt, now)}${nextIn !== null ? ` · 下一轮约 ${nextIn} 秒后` : ''}${snapshot.polling ? ' · 轮询中' : ''}`}
        />
        <Stat
          label="本小时请求额度（账号剩余）"
          value={token.remaining === null ? '—' : String(token.remaining)}
          detail={[token.login ? `账号 ${token.login}` : null, until(token.resetAt, now)].filter(Boolean).join(' · ') || undefined}
        />
        <Stat
          label="本小时送达"
          value={String(hourDeliveries.length)}
          unit="条"
          detail={`失败 ${count('failed')} · 可能已送达 ${count('unknown')} · 跳过 ${count('skipped')} · 影子 ${count('shadow')}`}
        />
      </View>
      <Card title="监听的仓库" flush trailing={<Text style={s.muted}>组织 {preferences.organization}</Text>}>
        {repositories.length === 0 ? (
          <Text style={[s.muted, { padding: 16 }]}>暂无监听的仓库。请先在设置页保存 GitHub 令牌。</Text>
        ) : (
          repositories.map((repo, index) => (
            <View key={repo.repo} style={[s.item, index === 0 ? s.firstItem : null]}>
              <View style={[s.row, { justifyContent: 'space-between' }]}>
                <Text style={s.strong}>{repo.repo}</Text>
                <Text style={{ color: repo.error ? theme.colors.statusDanger : theme.colors.statusSuccess, fontSize: 13 }}>{repo.error ? '出错' : '正常'}</Text>
              </View>
              <Text style={s.small}>
                最后一次轮询 {ago(repo.lastPollAt, now)}
                {repo.remaining !== null ? ` · 剩余额度 ${repo.remaining}` : ''}
              </Text>
              {repo.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{repo.error}</Text> : null}
            </View>
          ))
        )}
      </Card>
      <Card title="会话工具">
        {snapshot.toolInjection ? (
          <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>“给会话注入 MCP 工具”已打开，新会话可以用订阅工具。</Text>
        ) : (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>“给会话注入 MCP 工具”未打开，会话看不到订阅工具。</Text>
        )}
      </Card>
      <Card
        title="排除的仓库"
        trailing={
          <Btn
            small
            label="编辑设置"
            onPress={() => {
              if (onEditConfig) onEditConfig();
              else openScreen({ screenId: 'main', params: { page: 'github', drawer: 'github-config' } });
            }}
          />
        }
      >
        <View style={s.wrap}>
          {preferences.excludedRepos.length === 0 ? <Text style={s.muted}>没有排除的仓库</Text> : preferences.excludedRepos.map((repo) => <Chip key={repo} label={repo} />)}
        </View>
      </Card>
    </View>
  );
}
