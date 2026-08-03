import { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { useBudgetSummary, useDirectors, usePeriods, useRecordDisbursement } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { humanError, money } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Choice, Empty, Field, Loading, Money } from '../../components/ui';

const THRESHOLD = 1000000;

export default function NewDisbursement() {
  const router = useRouter();
  const { activeEntity } = useSession();

  const { data: periods } = usePeriods(activeEntity?.id);
  const period = periods?.[0];
  const budget = useBudgetSummary(activeEntity?.id, period);
  const { data: directors } = useDirectors();
  const record = useRecordDisbursement();

  const [budgetLineId, setBudgetLineId] = useState<string | null>(null);
  const [toDirectorId, setToDirectorId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [accountRef, setAccountRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const line = useMemo(
    () => (budget.data ?? []).find((b) => b.budget_line_id === budgetLineId) ?? null,
    [budget.data, budgetLineId],
  );

  const numericAmount = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  const needsApproval = amountValid && numericAmount >= THRESHOLD;
  const overBudget = line && amountValid && numericAmount > Number(line.undisbursed_amount);

  const canSubmit =
    !!budgetLineId &&
    !!toDirectorId &&
    amountValid &&
    (method === 'cash' || !!accountRef.trim());

  async function submit() {
    if (!canSubmit || !activeEntity || !budgetLineId || !toDirectorId) return;
    setError(null);

    try {
      const created = await record.mutateAsync({
        entityId: activeEntity.id,
        budgetLineId,
        toDirectorId,
        amount: numericAmount,
        method,
        disbursedToRef: method === 'cash' ? 'cash' : accountRef.trim(),
        disbursedOn: new Date().toISOString().slice(0, 10),
        note: note.trim() || undefined,
      });

      Alert.alert(
        created.status === 'pending_approval' ? 'Sent for approval' : 'Recorded',
        created.status === 'pending_approval'
          ? `${money(numericAmount)} is at or above ${money(THRESHOLD)}, so a second director must approve it.`
          : `${money(numericAmount)} recorded. The receiving director is now accountable for it until receipted expenditures explain it.`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
    } catch (e) {
      setError(humanError(e));
    }
  }

  if (budget.isLoading) return <Loading />;

  if ((budget.data ?? []).length === 0) {
    return (
      <View style={s.screen}>
        <Empty
          title="No budget lines"
          body="A disbursement has to be charged to an allocated budget line, and none exist for this period yet."
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Banner
          tone="neutral"
          title="This records money that has already moved"
          body="Zirconix never transfers funds. Make the transfer or hand over the cash first, then record it here so it can be accounted for."
        />

        {error ? <Banner tone="danger" title="Not saved" body={error} /> : null}

        <Text style={s.groupLabel}>BUDGET LINE · {period ?? '—'}</Text>
        {(budget.data ?? []).map((b) => {
          const active = b.budget_line_id === budgetLineId;
          return (
            <Pressable
              key={b.budget_line_id}
              onPress={() => setBudgetLineId(b.budget_line_id)}
              style={[s.line, active && s.lineActive]}
            >
              <View style={s.flex}>
                <Text style={s.lineTitle}>{b.category}</Text>
                <Text style={s.lineMeta}>
                  {money(b.disbursed_amount)} disbursed of {money(b.allocated_amount)}
                </Text>
              </View>
              <View style={s.lineRight}>
                <Money
                  amount={b.undisbursed_amount}
                  tone={Number(b.undisbursed_amount) > 0 ? 'neutral' : 'warning'}
                />
                <Text style={s.lineRemaining}>undisbursed</Text>
              </View>
            </Pressable>
          );
        })}

        <View style={{ height: space.xl }} />

        <Choice
          label="Disbursed to"
          value={toDirectorId}
          options={(directors ?? [])
            .filter((d) => d.is_active && d.role !== 'auditor')
            .map((d) => ({ value: d.id, label: d.full_name }))}
          onChange={setToDirectorId}
        />

        <Field
          label="Amount (PKR)"
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0"
          style={s.amountInput}
          hint={
            !overBudget && needsApproval
              ? `At or above ${money(THRESHOLD)} — a second director will have to approve this.`
              : undefined
          }
          error={
            overBudget
              ? `Only ${money(line!.undisbursed_amount)} is left undisbursed on that line.`
              : undefined
          }
        />

        <Choice
          label="Method"
          value={method}
          options={[
            { value: 'bank_transfer' as const, label: 'Bank transfer' },
            { value: 'cash' as const, label: 'Cash' },
          ]}
          onChange={setMethod}
        />

        {method === 'bank_transfer' ? (
          <Field
            label="Receiving account"
            value={accountRef}
            onChangeText={setAccountRef}
            placeholder="HBL ****4471"
            hint="Record only the bank and the last four digits. Do not enter a full account number — this field is visible to every director on this board."
          />
        ) : null}

        <Field
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="Purpose of the advance"
          multiline
          style={s.noteInput}
        />

        <Button
          label={needsApproval ? 'Submit for approval' : 'Record disbursement'}
          onPress={submit}
          loading={record.isPending}
          disabled={!canSubmit}
        />

        <View style={{ height: space.xxl }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg },
  flex: { flex: 1 },
  groupLabel: { ...type.micro, color: color.inkMuted, marginBottom: space.sm },

  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.sm,
  },
  lineActive: { borderColor: color.accent, backgroundColor: color.accentSoft },
  lineTitle: { ...type.body, color: color.ink, fontWeight: '600' },
  lineMeta: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  lineRight: { alignItems: 'flex-end' },
  lineRemaining: { ...type.micro, color: color.inkFaint },

  amountInput: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'], height: 60 },
  noteInput: { height: 80, paddingTop: space.md, textAlignVertical: 'top' },
});
