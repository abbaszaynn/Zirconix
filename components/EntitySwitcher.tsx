import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../lib/session';
import { color, radius, space, type } from '../lib/theme';

/**
 * Several directors sit on both boards. Which company you are looking at governs
 * every figure on the screen, so it is shown as a persistent segmented control
 * rather than hidden in a menu — mistaking one company's budget for the other's
 * is the expensive error here.
 */
export function EntitySwitcher() {
  const { entities, activeEntity, setActiveEntity } = useSession();

  if (entities.length < 2) {
    return activeEntity ? (
      <View style={s.single}>
        <Text style={s.singleText}>{activeEntity.legal_name}</Text>
      </View>
    ) : null;
  }

  return (
    <View style={s.wrap} accessibilityRole="tablist">
      {entities.map((e) => {
        const active = e.id === activeEntity?.id;
        return (
          <Pressable
            key={e.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => setActiveEntity(e.id)}
            style={[s.tab, active && s.tabActive]}
          >
            <Text style={[s.tabText, active && s.tabTextActive]} numberOfLines={1}>
              {e.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
  },
  tab: {
    flex: 1,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: color.surface,
    shadowColor: '#0F1B2A',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tabText: { ...type.label, color: color.inkMuted },
  tabTextActive: { color: color.ink },
  single: { paddingVertical: space.sm },
  singleText: { ...type.label, color: color.inkMuted },
});
