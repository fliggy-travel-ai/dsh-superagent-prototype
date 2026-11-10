import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, StreamedText } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { quotaRetryStatus as retryStatus, quotaRow, quotaSetAutoResume as setAutoResume } from "../../shared/claude-accounts.ts";

function countdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}小时 ${String(minutes).padStart(2, "0")}分 ${String(remainder).padStart(2, "0")}秒`;
}

export function QuotaMessage({ item, agentId, theme, layout }: PluginTimelineItemProps<z.output<typeof quotaRow>>) {
  const readStatus = useRpc(retryStatus);
  const writeEnabled = useRpc(setAutoResume);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [unavailable, setUnavailable] = useState(false);
  // A status poll that started before a toggle must not overwrite the toggled value.
  const toggles = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const seen = toggles.current;
      try {
        const status = await readStatus({ agentId, text: item.data.text, messageId: item.data.messageId });
        if (!active) return;
        setRetryAt(status.retryAt);
        setUnavailable(false);
        if (seen === toggles.current) setEnabled(status.enabled);
      } catch {
        if (active) { setRetryAt(null); setUnavailable(true); }
      }
    };
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; clearInterval(poll); clearInterval(clock); };
  }, [agentId, item.data.text, item.data.messageId, readStatus]);

  const toggle = async () => {
    const next = !enabled;
    toggles.current += 1;
    setEnabled(next);
    setSaving(true);
    setSaveFailed(false);
    try {
      const result = await writeEnabled({ agentId, enabled: next });
      setEnabled(result.enabled);
    } catch {
      setEnabled(!next);
      setSaveFailed(true);
    } finally {
      toggles.current += 1;
      setSaving(false);
    }
  };

  const hint = !enabled ? "已关闭，这个会话不会自动继续"
    : retryAt !== null && retryAt > now ? `预计 ${countdown(retryAt - now)}后检查并继续`
    : "正在检查会话，准备继续";
  return <View style={{ gap: 8 }}>
    <StreamedText text={item.data.text} phase={item.data.phase} />
    {(retryAt !== null || unavailable) && <View style={{ backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10, padding: layout.compact ? 10 : 12, gap: 4 }}>
      {unavailable
        ? <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>无法确认自动继续状态</Text>
        : <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="额度恢复后自动继续"
            accessibilityState={{ checked: enabled, disabled: saving }}
            disabled={saving}
            hitSlop={8}
            onPress={() => void toggle()}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" }}
          >
            <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, alignItems: "center", justifyContent: "center", borderColor: enabled ? theme.colors.accent : theme.colors.border, backgroundColor: enabled ? theme.colors.accent : "transparent" }}>
              {enabled && <Icon name="Check" size={12} color={theme.colors.accentForeground} />}
            </View>
            <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>额度恢复后自动继续</Text>
          </Pressable>}
      {!unavailable && <Text style={{ color: theme.colors.foregroundMuted }}>{saveFailed ? "保存失败，请重试" : hint}</Text>}
    </View>}
  </View>;
}
