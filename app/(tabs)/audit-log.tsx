import { useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useAuditEvents, useAuditMonths, useChainIntegrity, useDirectors } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { dateTime, humanError } from '../../lib/format';
import { exportAuditPdf } from '../../lib/auditPdf';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Card, Empty, Loading, Pill } from '../../components/ui';

const TABLES = [
  { value: '', label: 'All' },
  { value: 'expenditures', label: 'Expenditures' },
  { value: 'disbursements', label: 'Disbursements' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'attachments', label: 'Receipts' },
  { value: 'budget_lines', label: 'Budgets' },
];

/** '2026-08' -> 'August 2026', for the month chips. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-PK', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AuditLog() {
  const { activeEntity, director } = useSession();
  const [table, setTable] = useState('');
  const [actorId, setActorId] = useState('');
  const [month, setMonth] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);

  const { data: months } = useAuditMonths(activeEntity?.id);

  const events = useAuditEvents(activeEntity?.id, {
    table: table || undefined,
    actorId: actorId || undefined,
    month: month || undefined,
  });
  const chain = useChainIntegrity();
  const { data: directors } = useDirectors();

  const nameOf = (id: string | null) =>
    id ? (directors?.find((d) => d.id === id)?.full_name ?? 'Unknown') : 'System';

  async function printReport() {
    if (!activeEntity) return;
    setPrinting(true);
    try {
      // The report states the chain result, so refresh it rather than printing a
      // cached verdict that may be minutes old.
      const fresh = await chain.refetch();

      await exportAuditPdf({
        entityName: activeEntity.name,
        entityLegalName: activeEntity.legal_name,
        events: events.data ?? [],
        directors: directors ?? [],
        chain: fresh.data ?? chain.data,
        generatedBy: director?.full_name ?? 'Unknown',
        filterNote: [
          month ? monthLabel(month) : 'All time',
          table ? TABLES.find((t) => t.value === table)?.label : null,
          actorId ? nameOf(actorId) : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      });
    } catch (e) {
      Alert.alert('Could not produce the PDF', humanError(e));
    } finally {
      setPrinting(false);
    }
  }

  const header = (
    <View style={s.header}>
      {months && months.length > 0 ? (
        <View style={s.filters}>
          <Pressable
            onPress={() => setMonth('')}
            style={[s.chip, month === '' && s.chipActive]}
          >
            <Text style={[s.chipText, month === '' && s.chipTextActive]}>All time</Text>
          </Pressable>
          {months.map((m) => (
            <Pressable
              key={m}
              onPress={() => setMonth(m)}
              style={[s.chip, month === m && s.chipActive]}
            >
              <Text style={[s.chipText, month === m && s.chipTextActive]}>
                {monthLabel(m)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Button
        label={
          printing
            ? 'Preparing…'
            : month
              ? `Print ${monthLabel(month)} audit (PDF)`
              : 'Print audit log (PDF)'
        }
        variant="secondary"
        onPress={() => void printReport()}
        loading={printing}
        disabled={(events.data ?? []).length === 0}
      />

      {chain.data ? (
        chain.data.ok ? (
          <Banner
            tone="positive"
            title="Chain intact"
            body={`All ${chain.data.checked} events verify against their hashes. Nothing in this log has been altered or removed since it was written.`}
          />
        ) : (
          <Banner
            tone="danger"
            title="Chain broken"
            body={`Verification failed at event #${chain.data.first_bad_id}. The audit log has been tampered with. Do not rely on these records — raise this with the consortium immediately.`}
          />
        )
      ) : null}

      <View style={s.filters}>
        {TABLES.map((t) => (
          <Pressable
            key={t.value}
            onPress={() => setTable(t.value)}
            style={[s.chip, table === t.value && s.chipActive]}
          >
            <Text style={[s.chipText, table === t.value && s.chipTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={s.filters}>
        <Pressable
          onPress={() => setActorId('')}
          style={[s.chip, !actorId && s.chipActive]}
        >
          <Text style={[s.chipText, !actorId && s.chipTextActive]}>Anyone</Text>
        </Pressable>
        {(directors ?? []).map((d) => (
          <Pressable
            key={d.id}
            onPress={() => setActorId(d.id)}
            style={[s.chip, actorId === d.id && s.chipActive]}
          >
            <Text style={[s.chipText, actorId === d.id && s.chipTextActive]} numberOfLines={1}>
              {d.full_name}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );

  if (events.isLoading) {
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
        <RefreshControl
          refreshing={events.isFetching}
          onRefresh={() => {
            void events.refetch();
            void chain.refetch();
          }}
        />
      }
      data={events.data ?? []}
      keyExtractor={(e) => String(e.id)}
      ListEmptyComponent={
        <Empty title="No matching events" body="Try widening the filters above." />
      }
      renderItem={({ item }) => {
        const isOpen = expanded === item.id;
        const tone =
          item.action === 'insert' ? 'positive' : item.action === 'delete' ? 'danger' : 'warning';

        return (
          <Pressable onPress={() => setExpanded(isOpen ? null : item.id)}>
            <Card style={s.event}>
              <View style={s.eventHead}>
                <Pill label={item.action} tone={tone} />
                <Text style={s.eventTable}>{item.table_name}</Text>
                <Text style={s.eventId}>#{item.id}</Text>
              </View>

              <Text style={s.eventActor}>{nameOf(item.actor_id)}</Text>
              <Text style={s.eventTime}>{dateTime(item.created_at)}</Text>

              {isOpen ? (
                <View style={s.detail}>
                  <Text style={s.detailLabel}>HASH</Text>
                  <Text style={s.hash} selectable>
                    {item.hash}
                  </Text>
                  <Text style={s.detailLabel}>PREVIOUS</Text>
                  <Text style={s.hash} selectable>
                    {item.prev_hash}
                  </Text>

                  {item.before ? (
                    <>
                      <Text style={s.detailLabel}>BEFORE</Text>
                      <Text style={s.json}>{JSON.stringify(item.before, null, 2)}</Text>
                    </>
                  ) : null}
                  {item.after ? (
                    <>
                      <Text style={s.detailLabel}>AFTER</Text>
                      <Text style={s.json}>{JSON.stringify(item.after, null, 2)}</Text>
                    </>
                  ) : null}
                </View>
              ) : (
                <Text style={s.tapHint}>Tap for the record and its hash</Text>
              )}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg },
  header: { marginBottom: space.md },

  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunken,
    maxWidth: 160,
  },
  chipActive: { backgroundColor: color.ink },
  chipText: { ...type.caption, color: color.inkMuted },
  chipTextActive: { color: '#fff', fontWeight: '600' },

  event: { marginBottom: space.sm, padding: space.md },
  eventHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  eventTable: { ...type.label, color: color.ink, flex: 1 },
  eventId: { ...type.caption, color: color.inkFaint, fontVariant: ['tabular-nums'] },
  eventActor: { ...type.body, color: color.ink, marginTop: space.sm },
  eventTime: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  tapHint: { ...type.caption, color: color.inkFaint, marginTop: space.sm },

  detail: { marginTop: space.md, borderTopWidth: 1, borderTopColor: color.border, paddingTop: space.md },
  detailLabel: { ...type.micro, color: color.inkFaint, marginTop: space.md, marginBottom: space.xs },
  hash: { fontSize: 11, color: color.inkMuted, fontFamily: 'monospace' },
  json: {
    fontSize: 11,
    color: color.ink,
    fontFamily: 'monospace',
    backgroundColor: color.surfaceSunken,
    padding: space.sm,
    borderRadius: radius.sm,
  },
});
