import type { ComponentType } from 'react';

type AnyComponent = ComponentType<never>;

export interface ScreenEntry {
  id: string;
  title: string | ((params: Record<string, string>) => string);
  Component: AnyComponent;
}
export interface SidebarEntry {
  id: string;
  title: string;
  Component: AnyComponent;
}
export interface PillButton {
  title: string;
  label?: string;
  icon: unknown;
  visible?: boolean;
  disabled?: boolean;
  behavior: { kind: 'action'; onPress(): void | Promise<void> } | { kind: 'popover'; Content: AnyComponent } | { kind: 'menu'; items: readonly unknown[] };
}
export interface PillEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  button: PillButton;
}

/** 假宿主的注册表：行为对齐真实宿主（重复注册同一目标会抛错；移除幂等）。 */
export class Registry {
  readonly screens = new Map<string, ScreenEntry>();
  readonly sidebar = new Map<string, SidebarEntry>();
  readonly pills = new Map<string, PillEntry>();
  /** 记录所有注册、更新、移除，用来验收清理是否完整。 */
  readonly events: string[] = [];
  version = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  private bump() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  addScreen(entry: ScreenEntry) {
    if (this.screens.has(entry.id)) throw new Error(`重复的页面 ${entry.id}`);
    this.screens.set(entry.id, entry);
    this.events.push(`screen+ ${entry.id}`);
    this.bump();
    return () => {
      if (this.screens.delete(entry.id)) this.events.push(`screen- ${entry.id}`);
      this.bump();
    };
  }
  addSidebar(entry: SidebarEntry) {
    if (this.sidebar.has(entry.id)) throw new Error(`重复的侧边栏项 ${entry.id}`);
    this.sidebar.set(entry.id, entry);
    this.events.push(`sidebar+ ${entry.id}`);
    this.bump();
    return () => {
      if (this.sidebar.delete(entry.id)) this.events.push(`sidebar- ${entry.id}`);
      this.bump();
    };
  }
  addPill(entry: PillEntry) {
    // 真实宿主的重复判定：同一安装、位置、id、工作区和会话。不同会话可以共用同一个 id。
    const key = `${entry.workspaceId}:${entry.agentId}:${entry.id}`;
    if (this.pills.has(key)) throw new Error(`重复的胶囊 ${key}`);
    if (!entry.button.title) throw new Error('胶囊 title 不能为空');
    this.pills.set(key, entry);
    this.events.push(`pill+ ${entry.agentId}`);
    this.bump();
    let removed = false;
    return {
      update: (patch: Partial<PillButton>) => {
        if (removed) return;
        this.pills.set(key, { ...entry, button: { ...this.pills.get(key)!.button, ...patch } });
        this.events.push(`pill~ ${entry.agentId} ${patch.label ?? ''}`);
        this.bump();
      },
      remove: () => {
        if (removed) return;
        removed = true;
        this.pills.delete(key);
        this.events.push(`pill- ${entry.agentId}`);
        this.bump();
      },
    };
  }
}
