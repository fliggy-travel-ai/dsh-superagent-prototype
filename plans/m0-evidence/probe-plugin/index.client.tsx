import type { PluginButtonContentProps, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { ProbeScreen } from "./client/screen";

function ProbeItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Github" label="GitHub 订阅" active={currentScreen?.screenId === "main"} onPress={() => openScreen({ screenId: "main" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "GitHub 订阅（探针）", Component: ProbeScreen });
  client.addSidebarHeaderItem({ id: "main", title: "GitHub 订阅", Component: ProbeItem });

  // 弹出层内容里直接用 contribute 闭包里的 client.openScreen，验证“胶囊弹出层能否打开插件页面”。
  function PillPopover({ theme, close }: PluginButtonContentProps) {
    return (
      <View style={{ padding: 12, gap: 8 }}>
        <Text style={{ color: theme.colors.foreground }}>本会话订阅：3 条（探针）</Text>
        <Pressable accessibilityRole="button" onPress={() => { close(); client.openScreen({ screenId: "main" }); }}>
          <Text style={{ color: theme.colors.accent }}>打开全局订阅页</Text>
        </Pressable>
      </View>
    );
  }

  const pills = new Map<string, { remove(): void }>();
  const ac = new AbortController();
  void (async () => {
    const { entries, subscription } = (await (client.paseo.agents.list as any)({ subscribe: {} })) as any;
    const sync = (agent: any) => {
      if (!agent.workspaceId || agent.archivedAt || pills.has(agent.id)) return;
      pills.set(
        agent.id,
        client.addComposerPill({
          id: "ghsub-probe",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: { title: "GitHub 订阅", label: "GitHub · 3", icon: "Github", behavior: { kind: "popover", Content: PillPopover } },
        }),
      );
    };
    for (const e of entries ?? []) sync(e.agent ?? e);
    subscription?.subscribe({
      snapshot: ({ entries }: any) => { for (const e of entries) sync(e.agent); },
      update: (m: any) => { if (m.type === "agent_update" && m.payload.kind === "upsert") sync(m.payload.agent); },
    });
  })();
  return () => { ac.abort(); for (const p of pills.values()) p.remove(); };
}
