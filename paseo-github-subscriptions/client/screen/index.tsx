import { useState } from 'react';
import { View } from 'react-native';
import { Segmented, useStoreState } from '../ui.tsx';
import { EventsTab } from './events.tsx';
import { StatusTab } from './status.tsx';
import { SubscriptionsTab } from './subscriptions.tsx';

export { EventsTab, StatusTab, SubscriptionsTab };

export type GitHubTab = 'subs' | 'events' | 'status';

function isTab(value: string | undefined): value is GitHubTab {
  return value === 'subs' || value === 'events' || value === 'status';
}

export function GitHubSubscriptionsViews(props: { initialTab?: string; onEditConfig?: () => void }) {
  const { snapshot } = useStoreState();
  const [tab, setTab] = useState<GitHubTab>(isTab(props.initialTab) ? props.initialTab : 'subs');
  const subCount = snapshot?.subscriptions.length ?? 0;
  const eventCount = snapshot?.events.length ?? 0;

  return (
    <View style={{ gap: 14 }}>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'subs', label: `订阅 (${subCount})` },
          { value: 'events', label: `事件 (${eventCount})` },
          { value: 'status', label: '监听状态' },
        ]}
      />
      {tab === 'subs' ? <SubscriptionsTab /> : tab === 'events' ? <EventsTab /> : <StatusTab onEditConfig={props.onEditConfig} />}
    </View>
  );
}
