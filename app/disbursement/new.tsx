import { useEffect, useMemo, useState } from 'react';
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

import {
  useAccounts,
  useDirectors,
  useRecordDisbursement,
} from '../../lib/queries';
import { useSession } from '../../lib/session';
import { humanError, money } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Choice, Empty, Field, Loading, Money } from '../../components/ui';

const THRESHOLD = 1000000;

export default function NewDisbursement() {
  const router = useRouter();
  const { activeEntity, director } = useSession();

  if (director && director.role !== 'finance_officer') {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        <Empty 
          title="Access restricted" 
          body="Only the finance director can initiate and record new disbursements." 
        />
        <Button label="Go back" onPress={() => router.back()} style={{ marginTop: 24 }} />
      </View>
    );
  }


  const { data: directors } = useDirectors();
  const accounts = useAccounts(activeEntity?.id);
  const record = useRecordDisbursement();

  const [category, setCategory] = useState<string | null>(null);
  const [fromAccountId, setFromAccountId] = useState<string | null>(null);
  const [toDirectorId, setToDirectorId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');
  const [accountRef, setAccountRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // One account is the common case; preselecting it saves a tap and makes the
  // field read as a confirmation rather than a question.
  useEffect(() => {
    if (!fromAccountId && (accounts.data ?? []).length > 0) {
      setFromAccountId(accounts.data![0].id);
    }
  }, [accounts.data, fromAccountId]);

  const numericAmount = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  const needsApproval = amountValid && numericAmount >= THRESHOLD;

  const canSubmit =
    !!category &&
    !!fromAccountId &&
    !!toDirectorId &&
    amountValid &&
    (method === 'cash' || !!accountRef.trim());

  async function submit() {
    if (!canSubmit || !activeEntity) return;
    setError(null);

    try {
      const created = await record.mutateAsync({
        entityId: activeEntity.id,
        category,
        fromAccountId,
        toDirectorId,
        amount: numericAmount,
        method,
        disbursedToRef: method === 'cash' ? 'cash' : accountRef.trim(),
        disbursedOn: new Date().toISOString().slice(0, 10),
        note: note.trim() || undefined,
      });

      setSuccess(
        `${money(numericAmount)} recorded. Every director has been notified, and it needs ` +
          `${created.required_votes} votes before it is confirmed — ` +
          (created.required_votes === 2
            ? 'yours and the recipient’s.'
            : 'yours, the recipient’s, and two other directors’.')
      );
      
      setAmount('');
      setNote('');
      setCategory(null);
      setToDirectorId(null);
      setError(null);

      setTimeout(() => setSuccess(null), 8000);
    } catch (e) {
      setError(humanError(e));
      setSuccess(null);
    }
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
        {success ? <Banner tone="positive" title="Sent to the board" body={success} /> : null}

        <View style={{ height: space.xl }} />

        <Choice
          label="Category"
          value={category}
          options={[
            { value: 'Project Management', label: 'Project Management' },
            { value: 'Community', label: 'Community' },
            { value: 'Labor', label: 'Labor' },
            { value: 'Lease Fee', label: 'Lease Fee' },
            { value: 'Online Developments', label: 'Online Developments' },
            { value: 'Investor Relations', label: 'Investor Relations' },
            { value: 'Equipment', label: 'Equipment' },
          ]}
          onChange={setCategory}
        />

        <View style={{ height: space.xl }} />

        <Choice
          label="Paid from"
          value={fromAccountId}
          options={(accounts.data ?? []).map((a) => ({
            value: a.id,
            label: a.bank_label ? `${a.name} · ${a.bank_label}` : a.name,
          }))}
          onChange={setFromAccountId}
        />

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
            needsApproval
              ? `At or above ${money(THRESHOLD)} — a second director will have to approve this.`
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

  amountInput: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'], height: 60 },
  noteInput: { height: 80, paddingTop: space.md, textAlignVertical: 'top' },
});
