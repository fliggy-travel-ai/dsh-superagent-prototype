import type { PluginTheme } from '@getpaseo/plugin';
import type { PluginAgentPanelProps } from '@getpaseo/plugin/client';
import { Icon, Modal, useToast } from '@getpaseo/plugin/client/ui';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { Heartbeat } from '../../shared/heartbeats.ts';
import { SCHEDULE_PRESETS, describeCron, parseScheduleInput } from '../../shared/schedule-input.ts';
import { heartbeatErrorMessage, type HeartbeatStore } from './store.ts';

interface HeartbeatDraft {
  prompt: string;
  cron: string;
  timezone: string | null;
  maxRuns: number | null;
}

const REFRESH_INTERVAL_MS = 15_000;
const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function createHeartbeatsPanel(store: HeartbeatStore) {
  return function HeartbeatsPanel(props: PluginAgentPanelProps) {
    const agentId = props.params?.agentId ?? props.agentId;
    const { theme, layout } = props;
    const state = useSyncExternalStore(store.subscribe, store.getState);
    const view = state.agents.get(agentId) ?? {
      heartbeats: [],
      loading: true,
      loaded: false,
      error: null,
    };
    const toast = useToast();
    const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
    const [editing, setEditing] = useState<Heartbeat | null>(null);
    const [deleting, setDeleting] = useState<Heartbeat | null>(null);
    const [creating, setCreating] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [formVersion, setFormVersion] = useState(0);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      void store.loadAgent(agentId);
      const poll = setInterval(() => {
        void store.loadAgent(agentId);
      }, REFRESH_INTERVAL_MS);
      const clock = setInterval(() => setNow(Date.now()), 30_000);
      poll.unref?.();
      clock.unref?.();
      return () => {
        clearInterval(poll);
        clearInterval(clock);
      };
    }, [agentId]);

    const showSuccess = (message: string) => {
      toast.show(message, { variant: 'success' });
    };
    const showError = (message: string) => {
      if (typeof toast.error === 'function') toast.error(message);
      else toast.show(message, { variant: 'error' });
    };

    const handleCreate = async (draft: HeartbeatDraft) => {
      setCreating(true);
      try {
        await store.create({ agentId, ...draft });
        setFormVersion(value => value + 1);
        showSuccess('心跳已创建');
      } catch (error) {
        const message = heartbeatErrorMessage(error);
        showError(message);
        throw error;
      } finally {
        setCreating(false);
      }
    };

    const handleUpdate = async (id: string, draft: HeartbeatDraft) => {
      setUpdating(true);
      try {
        await store.update({ id, agentId, ...draft });
        setEditing(null);
        showSuccess('心跳已更新');
      } catch (error) {
        const message = heartbeatErrorMessage(error);
        showError(message);
        throw error;
      } finally {
        setUpdating(false);
      }
    };

    const handleDelete = async (id: string) => {
      setRemoving(true);
      try {
        await store.remove({ id, agentId });
        setDeleting(null);
        showSuccess('心跳已删除');
      } catch (error) {
        showError(heartbeatErrorMessage(error));
      } finally {
        setRemoving(false);
      }
    };

    const heartbeats = view.heartbeats;
    return (
      <View style={styles.screen}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={styles.headingRow}>
            <View style={styles.headingCopy}>
              <Text style={styles.title}>定时心跳</Text>
              <Text style={styles.body}>当前代理共 {heartbeats.length} 个心跳</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="刷新心跳列表"
              disabled={view.loading}
              onPress={() => void store.loadAgent(agentId)}
              style={[styles.iconButton, view.loading ? styles.disabled : null]}
            >
              <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>

          {!view.loaded && view.loading ? (
            <View style={styles.centered}>
              <Text style={styles.body}>正在加载心跳…</Text>
            </View>
          ) : view.error && heartbeats.length === 0 ? (
            <View style={styles.notice}>
              <Text style={styles.error}>{view.error}</Text>
              <SecondaryButton
                label="重试"
                icon="RefreshCw"
                theme={theme}
                styles={styles}
                onPress={() => void store.loadAgent(agentId)}
              />
            </View>
          ) : heartbeats.length === 0 ? (
            <View style={styles.notice}>
              <Icon name="HeartPulse" size={22} color={theme.colors.foregroundMuted} />
              <Text style={styles.body}>当前代理暂无定时心跳，可在下方新建。</Text>
            </View>
          ) : (
            <View style={styles.list}>
              {heartbeats.map(heartbeat =>
                editing?.id === heartbeat.id ? (
                  <HeartbeatForm
                    key={heartbeat.id}
                    initial={heartbeat}
                    title="编辑心跳"
                    submitLabel="保存修改"
                    busy={updating}
                    theme={theme}
                    styles={styles}
                    onCancel={() => setEditing(null)}
                    onSubmit={draft => handleUpdate(heartbeat.id, draft)}
                  />
                ) : (
                  <HeartbeatCard
                    key={heartbeat.id}
                    heartbeat={heartbeat}
                    now={now}
                    theme={theme}
                    styles={styles}
                    onEdit={() => setEditing(heartbeat)}
                    onDelete={() => setDeleting(heartbeat)}
                  />
                ),
              )}
            </View>
          )}

          <View style={styles.divider} />
          <HeartbeatForm
            key={formVersion}
            title="新建心跳"
            submitLabel="创建心跳"
            busy={creating}
            theme={theme}
            styles={styles}
            onSubmit={draft => handleCreate(draft)}
          />
        </ScrollView>

        <Modal
          title="删除心跳"
          icon={<Icon name="Trash2" size={18} color={theme.colors.statusDanger} />}
          open={deleting !== null}
          onOpenChange={open => {
            if (!open && !removing) setDeleting(null);
          }}
        >
          <Modal.Content>
            <View style={styles.modalContent}>
              <Text style={styles.body}>删除后该心跳将立即停止运行。</Text>
              {deleting ? (
                <Text numberOfLines={4} style={styles.modalPrompt}>
                  {deleting.prompt}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <SecondaryButton
                  label="取消"
                  theme={theme}
                  styles={styles}
                  disabled={removing}
                  onPress={() => setDeleting(null)}
                />
                <DangerButton
                  label={removing ? '正在删除…' : '确认删除'}
                  theme={theme}
                  styles={styles}
                  disabled={!deleting || removing}
                  onPress={() => {
                    if (deleting) void handleDelete(deleting.id);
                  }}
                />
              </View>
            </View>
          </Modal.Content>
        </Modal>
      </View>
    );
  };
}

function HeartbeatCard({
  heartbeat,
  now,
  theme,
  styles,
  onEdit,
  onDelete,
}: {
  heartbeat: Heartbeat;
  now: number;
  theme: PluginTheme;
  styles: Styles;
  onEdit(): void;
  onDelete(): void;
}) {
  const runs =
    heartbeat.maxRuns === null
      ? `${heartbeat.runCount} / 不限`
      : `${heartbeat.runCount} / ${heartbeat.maxRuns}`;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Icon name="HeartPulse" size={16} color={theme.colors.accent} />
          <Text style={styles.cardTitle} numberOfLines={1}>
            {heartbeat.name ?? '心跳'}
          </Text>
          {heartbeat.status === 'paused' ? <Text style={styles.paused}>已暂停</Text> : null}
        </View>
        <View style={styles.actions}>
          <SecondaryButton
            label="编辑"
            icon="Pencil"
            theme={theme}
            styles={styles}
            onPress={onEdit}
          />
          <SecondaryButton
            label="删除"
            icon="Trash2"
            danger
            theme={theme}
            styles={styles}
            onPress={onDelete}
          />
        </View>
      </View>
      <Text style={styles.prompt}>{heartbeat.prompt}</Text>
      <View style={styles.metadata}>
        <Metadata label="运行频率" value={describeCron(heartbeat.cron)} styles={styles} />
        <Metadata label="Cron" value={heartbeat.cron} mono styles={styles} />
        <Metadata label="时区" value={heartbeat.timezone ?? 'UTC'} styles={styles} />
        <Metadata
          label="下次运行"
          value={formatRunTime(heartbeat.nextRunAt, now)}
          styles={styles}
        />
        <Metadata label="已执行次数" value={runs} styles={styles} />
        <Metadata
          label="最大次数"
          value={heartbeat.maxRuns === null ? '不限' : String(heartbeat.maxRuns)}
          styles={styles}
        />
      </View>
    </View>
  );
}

function Metadata({
  label,
  value,
  mono = false,
  styles,
}: {
  label: string;
  value: string;
  mono?: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.metadataItem}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text style={[styles.metadataValue, mono ? styles.mono : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

function HeartbeatForm({
  initial,
  title,
  submitLabel,
  busy,
  theme,
  styles,
  onSubmit,
  onCancel,
}: {
  initial?: Heartbeat;
  title: string;
  submitLabel: string;
  busy: boolean;
  theme: PluginTheme;
  styles: Styles;
  onSubmit(draft: HeartbeatDraft): Promise<unknown>;
  onCancel?(): void;
}) {
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [schedule, setSchedule] = useState(initial?.cron ?? '');
  const [maxRuns, setMaxRuns] = useState(
    initial?.maxRuns === null || initial?.maxRuns === undefined ? '' : String(initial.maxRuns),
  );
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => {
    try {
      return { value: parseScheduleInput(schedule), error: null };
    } catch (cause) {
      return { value: null, error: schedule.trim() ? heartbeatErrorMessage(cause) : null };
    }
  }, [schedule]);
  const suggestions = useMemo(() => {
    const query = schedule.trim().toLowerCase();
    if (!query) return SCHEDULE_PRESETS.slice(0, 6);
    const words = query.split(/\s+/);
    return SCHEDULE_PRESETS.filter(preset => {
      const haystack = `${preset.label} ${preset.value} ${preset.detail}`.toLowerCase();
      return words.every(word => haystack.includes(word));
    }).slice(0, 6);
  }, [schedule]);
  const effectiveMaxRuns = preview.value?.oneShot ? 1 : maxRuns.trim() ? Number(maxRuns) : null;

  async function submit() {
    setError(null);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError('请输入要发送给该代理的提示词。');
      return;
    }
    let parsed;
    try {
      parsed = parseScheduleInput(schedule);
    } catch (cause) {
      setError(heartbeatErrorMessage(cause));
      return;
    }
    let limit: number | null = null;
    if (!parsed.oneShot && maxRuns.trim()) {
      limit = Number.parseInt(maxRuns, 10);
      if (!/^\d+$/.test(maxRuns.trim()) || !Number.isSafeInteger(limit) || limit <= 0) {
        setError('最大运行次数必须是正整数，或留空表示不限。');
        return;
      }
    }
    try {
      await onSubmit({
        prompt: trimmedPrompt,
        cron: parsed.cron,
        timezone: parsed.oneShot ? 'UTC' : (initial?.timezone ?? parsed.timezone),
        maxRuns: parsed.oneShot ? 1 : limit,
      });
    } catch (cause) {
      setError(heartbeatErrorMessage(cause));
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>{title}</Text>
      <View style={styles.field}>
        <Text style={styles.label}>提示词</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="到时间后希望此代理检查或继续执行什么任务？"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          textAlignVertical="top"
          style={[styles.input, styles.promptInput]}
          editable={!busy}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>运行时间</Text>
        <TextInput
          value={schedule}
          onChangeText={setSchedule}
          placeholder="15m、每 15 分钟、every 15 minutes 或 */15 * * * *"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.mono]}
          editable={!busy}
        />
        {suggestions.length > 0 ? (
          <View style={styles.suggestions} accessibilityRole="list">
            {suggestions.map(preset => (
              <Pressable
                key={preset.value}
                accessibilityRole="button"
                accessibilityLabel={`${preset.label}，${preset.detail}`}
                disabled={busy}
                onPress={() => setSchedule(preset.value)}
                style={styles.suggestion}
              >
                <Text style={styles.suggestionLabel}>{preset.label}</Text>
                <Text
                  style={[
                    styles.suggestionDetail,
                    preset.detail.includes('*') ? styles.mono : null,
                  ]}
                >
                  {preset.detail}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {preview.value ? (
          <View style={styles.preview}>
            <Icon name="CalendarClock" size={15} color={theme.colors.foregroundMuted} />
            <Text style={styles.previewText}>
              {preview.value.description} · 下次运行{' '}
              {new Date(preview.value.nextRunAt).toLocaleString()}
            </Text>
          </View>
        ) : preview.error ? (
          <Text style={styles.error}>{preview.error}</Text>
        ) : null}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>最大运行次数</Text>
        <TextInput
          value={preview.value?.oneShot ? '1' : maxRuns}
          onChangeText={setMaxRuns}
          placeholder="不限"
          placeholderTextColor={theme.colors.foregroundMuted}
          keyboardType="number-pad"
          editable={!busy && !preview.value?.oneShot}
          style={[styles.input, styles.smallInput]}
        />
        <Text style={styles.help}>
          {preview.value?.oneShot
            ? '单次延迟（如 15m）固定只运行 1 次。'
            : '留空表示不限制运行次数。'}
        </Text>
      </View>
      {initial && (initial.prompt !== prompt.trim() || initial.maxRuns !== effectiveMaxRuns) ? (
        <Text style={styles.help}>
          修改提示词或最大运行次数会重建该心跳并重置历史运行计数。
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {onCancel ? (
          <SecondaryButton
            label="取消"
            theme={theme}
            styles={styles}
            disabled={busy}
            onPress={onCancel}
          />
        ) : null}
        <PrimaryButton
          label={busy ? '正在保存…' : submitLabel}
          styles={styles}
          disabled={busy}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function PrimaryButton({
  label,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.primaryButton, disabled ? styles.disabled : null]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  icon,
  danger = false,
  theme,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  icon?: string;
  danger?: boolean;
  theme: PluginTheme;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  const color = danger ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.secondaryButton,
        danger ? styles.dangerBorder : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={[styles.secondaryButtonText, danger ? styles.dangerText : null]}>{label}</Text>
    </Pressable>
  );
}

function DangerButton({
  label,
  theme,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  theme: PluginTheme;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <SecondaryButton
      label={label}
      icon="Trash2"
      danger
      theme={theme}
      styles={styles}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

function formatRunTime(value: string | null, now: number): string {
  if (!value) return '未排期';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const difference = timestamp - now;
  const absoluteMinutes = Math.max(1, Math.round(Math.abs(difference) / 60_000));
  let relative: string;
  if (absoluteMinutes < 60) relative = `${absoluteMinutes} 分钟`;
  else if (absoluteMinutes < 24 * 60) relative = `${Math.round(absoluteMinutes / 60)} 小时`;
  else relative = `${Math.round(absoluteMinutes / (24 * 60))} 天`;
  return `${new Date(timestamp).toLocaleString()}（${difference >= 0 ? `${relative}后` : `已超时 ${relative}`}）`;
}

function createStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    scroll: { flex: 1 },
    content: {
      width: '100%',
      maxWidth: 900,
      alignSelf: 'center',
      padding: compact ? 14 : 24,
      gap: compact ? 14 : 18,
      paddingBottom: 48,
    },
    headingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    headingCopy: { flex: 1, gap: 3 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 23, fontWeight: '700' },
    body: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
    iconButton: {
      width: 38,
      height: 38,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
    },
    centered: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
    notice: {
      minHeight: 96,
      padding: 18,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    list: { gap: 12 },
    card: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 13 : 16,
      gap: 13,
    },
    cardHeader: {
      flexDirection: compact ? 'column' : 'row',
      alignItems: compact ? 'stretch' : 'center',
      gap: 10,
    },
    cardTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { flex: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: '700' },
    paused: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: '700' },
    prompt: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
    metadata: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    metadataItem: {
      minWidth: compact ? '47%' : 150,
      flexGrow: 1,
      gap: 3,
      padding: 9,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    metadataLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: '600' },
    metadataValue: { color: theme.colors.foreground, fontSize: 12 },
    divider: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginVertical: 2,
    },
    form: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 14 : 18,
      gap: 15,
    },
    formTitle: { color: theme.colors.foreground, fontSize: 17, fontWeight: '700' },
    field: { gap: 7 },
    label: { color: theme.colors.foreground, fontSize: 13, fontWeight: '700' },
    input: {
      minHeight: 42,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 9,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
    promptInput: { minHeight: 100 },
    smallInput: { maxWidth: compact ? '100%' : 180 },
    mono: { fontFamily: monoFont },
    suggestions: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 9,
      overflow: 'hidden',
    },
    suggestion: {
      minHeight: 43,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    suggestionLabel: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: '600' },
    suggestionDetail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    preview: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    previewText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    help: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
    primaryButton: {
      minHeight: 38,
      paddingVertical: 9,
      paddingHorizontal: 15,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: '700' },
    secondaryButton: {
      minHeight: 36,
      paddingVertical: 8,
      paddingHorizontal: 11,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: '600' },
    dangerBorder: { borderColor: theme.colors.statusDanger },
    dangerText: { color: theme.colors.statusDanger },
    disabled: { opacity: 0.5 },
    modalContent: { gap: 14 },
    modalPrompt: {
      color: theme.colors.foreground,
      fontSize: 13,
      lineHeight: 19,
      padding: 11,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
  } satisfies Record<string, ViewStyle | TextStyle>;
}

type Styles = ReturnType<typeof createStyles>;
