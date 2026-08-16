import { useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { useMyAdvances, useMyExpenditures, useDirectors } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { money, shortDate } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Card, Empty, Loading, Money, Pill, SectionTitle } from '../../components/ui';

export default function DirectorExpenditures() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { activeEntity } = useSession();

  const { data: directors } = useDirectors();
  const nameOf = (directorId: string | null) => {
    return directors?.find((d) => d.id === directorId)?.full_name ?? 'Unknown';
  };

  const advances = useMyAdvances(activeEntity?.id, id);
  const spending = useMyExpenditures(activeEntity?.id, id);

  const holding = useMemo(() => {
    const rows = advances.data ?? [];
    return {
      advanced: rows.reduce((n, r) => n + Number(r.advanced), 0),
      spent: rows.reduce((n, r) => n + Number(r.spent), 0),
      remaining: rows.reduce((n, r) => n + Number(r.remaining), 0),
      count: rows.length,
    };
  }, [advances.data]);

  if (advances.isLoading || spending.isLoading) return <Loading />;

  const hasAdvance = holding.count > 0;
  const rows = spending.data ?? [];

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.scroll}
      refreshControl={
        <RefreshControl
          refreshing={spending.isFetching}
          onRefresh={() => void spending.refetch()}
        />
      }
    >
      <Text style={s.title}>{nameOf(id)}'s spending</Text>

      {hasAdvance ? (
        <Card style={s.hero}>
          <Text style={s.heroLabel}>STILL TO ACCOUNT FOR</Text>
          <Money
            amount={holding.remaining}
            size="display"
            tone={holding.remaining > 0 ? 'warning' : 'positive'}
            align="left"
          />
          <Text style={s.heroMeta}>
            {money(holding.spent)} receipted of {money(holding.advanced)} advanced ·{' '}
            {holding.count} {holding.count === 1 ? 'advance' : 'advances'}
          </Text>
        </Card>
      ) : null}

      {!hasAdvance ? (
        <Empty
          title="No advance yet"
          body="Money must be advanced to this director before they can log any spending."
        />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing logged yet"
          body="No expenditures have been recorded by this director."
        />
      ) : (
        <>
          <SectionTitle note="Most recent first">Logged</SectionTitle>
          <Card>
            {rows.map((e, i) => (
              <View key={e.id} style={[s.row, i > 0 && s.rowDivider]}>
                <View style={s.rowMain}>
                  <Text style={s.payee} numberOfLines={1}>
                    {e.payee}
                  </Text>
                  <Text style={s.meta}>
                    {e.category} · {shortDate(e.spent_on)}
                  </Text>
                  {e.note ? (
                    <Text style={s.meta} numberOfLines={1}>
                      {e.note}
                    </Text>
                  ) : null}
                </View>
                <View style={s.rowRight}>
                  <Money amount={e.amount} />
                  <Pill
                    label={
                      e.receipt_count === 0
                        ? 'no receipt'
                        : `${e.receipt_count} receipt${e.receipt_count === 1 ? '' : 's'}`
                    }
                    tone={e.receipt_count === 0 ? 'danger' : 'positive'}
                  />
                </View>
              </View>
            ))}
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  scroll: { padding: space.lg, paddingBottom: space.xxl * 2, gap: space.md },
  title: { ...type.display, color: color.ink, marginBottom: space.xs },
  hero: { gap: space.xs },
  heroLabel: { ...type.caption, color: color.inkMuted, letterSpacing: 1 },
  heroMeta: { ...type.caption, color: color.inkMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  rowDivider: { borderTopWidth: 1, borderTopColor: color.border },
  rowMain: { flex: 1, gap: 2 },
  rowRight: { alignItems: 'flex-end', gap: space.xs },
  payee: { ...type.body, color: color.ink },
  meta: { ...type.caption, color: color.inkMuted },
});
