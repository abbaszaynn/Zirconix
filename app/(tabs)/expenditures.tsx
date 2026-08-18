import { useMemo, useState } from 'react';
import { Alert, Linking, RefreshControl, ScrollView, StyleSheet, Text, View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';

import { useMyAdvances, useMyExpenditures, useReplaceReceipt } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { useReceiptPicker } from '../../lib/useReceiptPicker';
import { signedReceiptUrl, uploadReceipt } from '../../lib/receipts';
import { money, shortDate, humanError } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Button, Card, Empty, Loading, Money, Pill, SectionTitle } from '../../components/ui';

/**
 * A director's own spending.
 *
 * Deliberately his own and not the whole board's: this is the screen he opens at
 * the end of the day to enter what he spent, so the only thing that matters is
 * what he still has to account for. The consortium-wide picture lives on the
 * dashboard.
 */
export default function MyExpenditures() {
  const router = useRouter();
  const { activeEntity, director } = useSession();

  const advances = useMyAdvances(activeEntity?.id, director?.id);
  const spending = useMyExpenditures(activeEntity?.id, director?.id);

  const { promptUpload, preparing, error, setError } = useReceiptPicker();
  const replaceReceipt = useReplaceReceipt();
  const [replacingId, setReplacingId] = useState<string | null>(null);

  const onReplace = (expenditureId: string, oldAttachmentId: string) => {
    promptUpload(async (receipt) => {
      setReplacingId(expenditureId);
      try {
        const uploaded = await uploadReceipt(activeEntity!.id, receipt);
        await replaceReceipt.mutateAsync({
          entityId: activeEntity!.id,
          expenditureId,
          oldAttachmentId,
          newReceipt: uploaded,
          directorId: director!.id,
        });
      } catch (e) {
        setError(humanError(e));
      } finally {
        setReplacingId(null);
      }
    });
  };

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
      <Text style={s.title}>My expenditures</Text>

      {hasAdvance ? (
        <Card style={s.hero}>
          <Text style={s.heroLabel}>STILL TO ACCOUNT FOR</Text>
          <Money
            amount={holding.remaining}
            size="display"
            tone={holding.remaining > 0 ? 'warning' : 'positive'}
          />
          <Text style={s.heroMeta}>
            {money(holding.spent)} receipted of {money(holding.advanced)} advanced ·{' '}
            {holding.count} {holding.count === 1 ? 'advance' : 'advances'}
          </Text>
        </Card>
      ) : null}

      <Button
        label="Add an expenditure"
        onPress={() => router.push('/expenditure/new')}
        disabled={!hasAdvance}
      />

      {error ? <Text style={{ color: color.danger, marginTop: space.sm }}>{error}</Text> : null}

      {!hasAdvance ? (
        <Empty
          title="No advance yet"
          body="You can log spending once money has been advanced to you. Ask whoever records transfers to allocate it against a budget line."
        />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing logged yet"
          body="Tap Add an expenditure to record what you spent, with a photo or PDF of the receipt."
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
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    {e.attachments && e.attachments.length > 0 && (
                      <Pressable
                        onPress={() => onReplace(e.id, e.attachments![0].id)}
                        disabled={preparing || replacingId === e.id}
                      >
                        <Pill
                          label={replacingId === e.id ? 'uploading...' : 'replace'}
                          tone="neutral"
                        />
                      </Pressable>
                    )}
                    <Pressable
                      disabled={!e.attachments?.length}
                      onPress={async () => {
                        const attachment = e.attachments?.[0];
                        if (!attachment) return;
                        try {
                          const url = await signedReceiptUrl(attachment.storage_path);
                          Linking.openURL(url);
                        } catch (err) {
                          Alert.alert('Error', 'Could not open receipt');
                        }
                      }}
                    >
                    <Pill
                      label={
                        e.receipt_count === 0
                          ? 'no receipt'
                          : `${e.receipt_count} receipt${e.receipt_count === 1 ? '' : 's'}`
                      }
                      tone={e.receipt_count === 0 ? 'danger' : 'positive'}
                    />
                  </Pressable>
                </View>
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
