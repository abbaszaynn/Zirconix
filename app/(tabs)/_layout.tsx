import { Tabs } from 'expo-router';
import { Text } from 'react-native';

import { usePendingApprovals } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { color, type } from '../../lib/theme';

/**
 * Emoji tab glyphs keep the pilot free of an icon-font dependency. Swap for a
 * proper icon set before any wider rollout.
 */
function Glyph({ char, focused }: { char: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.45 }}>{char}</Text>;
}

export default function TabsLayout() {
  const { activeEntity } = useSession();
  const { data: pending } = usePendingApprovals(activeEntity?.id);

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
          title: 'Ledger',
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
