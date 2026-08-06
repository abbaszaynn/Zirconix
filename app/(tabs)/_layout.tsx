import { useEffect } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Text, Pressable } from 'react-native';

import { useRealtimeSync, useTransferVotes } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { registerForPush } from '../../lib/push';
import { color, type } from '../../lib/theme';

/**
 * Emoji tab glyphs keep the pilot free of an icon-font dependency. Swap for a
 * proper icon set before any wider rollout.
 */
function Glyph({ char, focused }: { char: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.45 }}>{char}</Text>;
}

export default function TabsLayout() {
  const { activeEntity, director } = useSession();
  const { data: pending } = useTransferVotes(activeEntity?.id, true);
  const router = useRouter();

  // Every director's screens follow the database, so a transfer recorded on one
  // phone updates the badge and the dashboard on the other seven without anyone
  // pulling to refresh.
  useRealtimeSync(!!director);

  // Fails soft: no token on a simulator or the web build, and none if the
  // director declines. In-app notifications are written either way.
  useEffect(() => {
    if (director) void registerForPush();
  }, [director]);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: color.surface },
        headerTitleStyle: { color: color.ink, fontWeight: '700' },
        tabBarActiveTintColor: color.accent,
        tabBarInactiveTintColor: color.inkFaint,
        tabBarStyle: { backgroundColor: color.surface, borderTopColor: color.border },
        tabBarLabelStyle: { ...type.micro, letterSpacing: 0 },
        sceneStyle: { backgroundColor: color.canvas },
        headerRight: () => (
          <Pressable
            onPress={() => router.push('/profile')}
            style={{ marginRight: 16, padding: 8 }}
          >
            <Text style={{ fontSize: 18 }}>👤</Text>
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Budget',
          tabBarIcon: ({ focused }) => <Glyph char="▤" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="expenditures"
        options={{
          title: 'My spending',
          tabBarIcon: ({ focused }) => <Glyph char="≡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ({ focused }) => <Glyph char="✓" focused={focused} />,
          tabBarBadge: pending?.length ? pending.length : undefined,
          tabBarBadgeStyle: { backgroundColor: color.warning },
        }}
      />
      <Tabs.Screen
        name="audit-log"
        options={{
          title: 'Audit',
          tabBarIcon: ({ focused }) => <Glyph char="⛓" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
