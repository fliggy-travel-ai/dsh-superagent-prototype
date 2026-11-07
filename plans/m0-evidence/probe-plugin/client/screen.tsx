import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { probeEnv } from "../shared/contracts";

export function ProbeScreen({ theme, layout }: PluginScreenProps) {
  const call = useRpc(probeEnv);
  const q = useQuery({ queryKey: ["probe-env"], queryFn: () => call({}) });
  return (
    <View style={{ flex: 1, padding: layout.compact ? 16 : 24, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground }}>全局订阅页（探针）</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>{JSON.stringify(q.data ?? q.error?.message ?? "loading")}</Text>
    </View>
  );
}
