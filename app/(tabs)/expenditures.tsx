import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { EntitySwitcher } from '../../components/EntitySwitcher';
import { useDirectors, useDisbursements, useExpenditures } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { shortDate, statusLabel, statusTone } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Button, Empty, Loading, Money, Pill } from '../../components/ui';
import type { EntryStatus } from '../../lib/database.types';

type Lens = 'expenditures' | 'disbursements';

/**
 * Both lenses render the same row shape, so they are normalised here rather than
 * branching inside renderItem — which would leave FlatList with a union it
 * cannot narrow.
 */
type LedgerRow = {
  id: string;
  title: string;
  meta: string;
  amount: number;
  status: EntryStatus;
  missingReceipt: boolean;
  receiptCount: number | null;
};

export default function Ledger() {
  const router = useRouter();
  const { activeEntity } = useSession();
  const [lens, setLens] = useState<Lens>('expenditures');

  const expenditures = useExpenditures(activeEntity?.id);
  const disbursements = useDisbursements(activeEntity?.id);
  const { data: directors } = useDirectors();

  const nameOf = (id: string | null | undefined) =>
    directors?.find((d) => d.id === id)?.full_name ?? '—';

  const active = lens === 'expenditures' ? expenditures : disbursements;

  const rows = useMemo<LedgerRow[]>(() => {
    if (lens === 'expenditures') {
      return (expenditures.data ?? []).map((e) => ({
        id: e.id,
        title: e.payee,
        meta: `${e.category} · ${shortDate(e.spent_on)} · ${nameOf(e.entered_by)}`,
        amount: Number(e.amount),
        status: e.status,
        missingReceipt: e.receipt_count === 0 && e.status !== 'rejected',
        receiptCount: e.receipt_count,
      }));
    }

    return (disbursements.data ?? []).map((d) => ({
      id: d.id,
      title: nameOf(d.to_director_id),
      meta: `${d.method === 'cash' ? 'Cash' : `Bank · ${d.disbursed_to_ref}`} · ${shortDate(d.disbursed_on)}`,
      amount: Number(d.amount),
      status: d.status,
      missingReceipt: false,
      receiptCount: null,
    }));
    // nameOf closes over `directors`, which is the real dependency.
  }, [lens, expenditures.data, disbursements.data, directors]);

  const header = useMemo(
    () => (
      <View style={s.header}>
        <EntitySwitcher />

        <View style={s.lensRow}>
          {(['expenditures', 'disbursements'] as Lens[]).map((l) => (
            <Pressable
              key={l}
              onPress={() => setLens(l)}
              accessibilityRole="tab"
              accessibilityState={{ selected: lens === l }}
              style={[s.lens, lens === l && s.lensActive]}
            >
              <Text style={[s.lensText, lens === l && s.lensTextActive]}>
                {l === 'expenditures' ? 'Money spent' : 'Money advanced'}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button
          label={lens === 'expenditures' ? 'Log an expenditure' : 'Record a disbursement'}
          onPress={() =>
            router.push(lens === 'expenditures' ? '/expenditure/new' : '/disbursement/new')
          }
          style={{ marginTop: space.lg }}
        />
      </View>
    ),
    [lens, router],
  );

  if (active.isLoading) {
    return (
      <View style={s.screen}>
        {header}
        <Loading />
      </View>
    );
  }

  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.content}
      ListHeaderComponent={header}
      refreshControl={
        <RefreshControl refreshing={active.isFetching} onRefresh={() => void active.refetch()} />
      }
      data={rows}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={
        lens === 'expenditures' ? (
          <Empty
            title="Nothing spent yet"
            body="Expenditures logged against an advance will appear here, newest first."
          />
        ) : (
          <Empty
            title="Nothing advanced yet"
            body="Record a disbursement to a director to start the accountability trail."
          />
        )
      }
      renderItem={({ item }) => (
        <View style={s.item}>
          <View style={s.itemMain}>
            <Text style={s.itemTitle} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={s.itemMeta} numberOfLines={1}>
              {item.meta}
            </Text>
            <View style={s.itemTags}>
              <Pill label={statusLabel[item.status]} tone={statusTone[item.status]} />
              {item.missingReceipt ? (
                <Pill label="no receipt" tone="danger" />
              ) : item.receiptCount !== null ? (
                <Text style={s.receiptNote}>
                  {item.receiptCount} receipt{item.receiptCount === 1 ? '' : 's'}
                </Text>
              ) : null}
            </View>
          </View>
          <Money amount={item.amount} size="large" />
        </View>
      )}
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg },
  header: { marginBottom: space.lg },

  lensRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg },
  lens: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    backgroundColor: color.surface,
  },
  lensActive: { borderColor: color.accent, backgroundColor: color.accentSoft },
  lensText: { ...type.label, color: color.inkMuted },
  lensTextActive: { color: color.accent },

  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    padding: space.lg,
    marginBottom: space.sm,
  },
  itemMain: { flex: 1 },
  itemTitle: { ...type.body, color: color.ink, fontWeight: '600' },
  itemMeta: { ...type.caption, color: color.inkMuted, marginTop: 3 },
  itemTags: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  receiptNote: { ...type.caption, color: color.inkFaint },
});
