import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useMarkNotificationsRead, useNotifications } from '../lib/queries';
import { useSession } from '../lib/session';
import { dateTime } from '../lib/format';
import { getWebPushPermission, registerWebPush, type WebPushPermission } from '../lib/webPush';
import { color, radius, space, type } from '../lib/theme';
import { Banner, Button, Card, Empty, Loading } from '../components/ui';
import type { Notification } from '../lib/database.types';

/**
 * Every director's own inbox — transfers needing a vote, votes cast, outcomes,
 * and expenditures logged. Fed by database triggers (0010/0011/0012) and kept
 * live by the realtime subscription in the tab shell; this screen just reads
 * and marks-read, it does not need its own polling.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const { director } = useSession();

  const notifications = useNotifications(director?.id);
  const markRead = useMarkNotificationsRead();

  // The tab shell already tries this once, automatically, right after sign-in
  // — but Safari (and some Chrome/Firefox configurations) only honour
  // Notification.requestPermission() when it is called directly from a click,
  // not from a background effect. This button is that click, for whoever's
  // browser suppressed the automatic ask, and for anyone who dismissed it the
  // first time and changed their mind.
  const [webPushPermission, setWebPushPermission] = useState<WebPushPermission>('unsupported');
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    setWebPushPermission(getWebPushPermission());
  }, []);

  async function enableWebPush() {
    setEnabling(true);
    try {
      await registerWebPush();
    } finally {
      setWebPushPermission(getWebPushPermission());
      setEnabling(false);
    }
  }

  const unreadIds = useMemo(
    () => (notifications.data ?? []).filter((n) => !n.read_at).map((n) => n.id),
    [notifications.data],
  );

  function open(n: Notification) {
    if (!n.read_at) markRead.mutate([n.id]);

    // A notification about a transfer is almost always "go vote on it"; one
    // about an expenditure is "go see what was logged." Anything without
    // either just gets marked read in place.
    if (n.disbursement_id) {
      router.push('/(tabs)/approvals');
    } else if (n.expenditure_id) {
      router.push('/(tabs)/expenditures');
    }
  }

  const rows = notifications.data ?? [];

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.scroll}
      refreshControl={
        <RefreshControl
          refreshing={notifications.isFetching}
          onRefresh={() => void notifications.refetch()}
        />
      }
    >
      {Platform.OS === 'web' && webPushPermission === 'default' ? (
        <Banner
          tone="neutral"
          title="Turn on browser notifications"
          body="Get notified the moment a transfer needs your vote or money is spent — even with this tab closed."
          action={
            <Button label="Enable" variant="ghost" onPress={() => void enableWebPush()} loading={enabling} />
          }
        />
      ) : Platform.OS === 'web' && webPushPermission === 'denied' ? (
        <Banner
          tone="warning"
          title="Notifications are blocked"
          body="You'll need to allow notifications for this site in your browser's own settings to turn this back on."
        />
      ) : null}

      {unreadIds.length > 0 ? (
        <Button
          label={`Mark all ${unreadIds.length} read`}
          variant="ghost"
          onPress={() => markRead.mutate(unreadIds)}
          loading={markRead.isPending}
        />
      ) : null}

      {notifications.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing yet"
          body="You'll see it here the moment a transfer needs your vote, a vote is cast, or money is spent."
        />
      ) : (
        <Card style={s.card}>
          {rows.map((n, i) => (
            <Pressable
              key={n.id}
              onPress={() => open(n)}
              style={[s.row, i > 0 && s.rowDivider]}
            >
              <View style={[s.dot, !n.read_at && s.dotUnread]} />
              <View style={s.rowMain}>
                <Text style={[s.title, !n.read_at && s.titleUnread]}>{n.title}</Text>
                <Text style={s.body}>{n.body}</Text>
                <Text style={s.meta}>{dateTime(n.created_at)}</Text>
              </View>
            </Pressable>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  scroll: { padding: space.lg, paddingBottom: space.xxl * 2, gap: space.md },
  card: { padding: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: space.sm, padding: space.md },
  rowDivider: { borderTopWidth: 1, borderTopColor: color.border },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    backgroundColor: 'transparent',
  },
  dotUnread: { backgroundColor: color.accent },
  rowMain: { flex: 1, gap: 2 },
  title: { ...type.body, color: color.ink },
  titleUnread: { fontWeight: '700' },
  body: { ...type.caption, color: color.inkMuted },
  meta: { ...type.micro, color: color.inkFaint, marginTop: 2 },
});
