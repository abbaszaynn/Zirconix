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
import { useReceiptPicker } from '../../lib/useReceiptPicker';
import { uploadReceipt } from '../../lib/receipts';
import { humanError, money } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Choice, Empty, Field, Loading, Money } from '../../components/ui';

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

  // Proof of the transfer is required, the same as a receipt is for spending.
  // record_disbursement_auto_budget() refuses without one, so this is a
  // convenience check rather than the actual control.
  const { receipt, setReceipt, preparing, promptUpload, error: pickError } = useReceiptPicker();

  // Same double-submit window as the expenditure form: uploadReceipt() runs
  // before the mutation, so isPending alone leaves the button live during the
  // upload. Two taps there create two records of one payment.
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    !!category &&
    !!fromAccountId &&
    !!toDirectorId &&
    amountValid &&
    !!receipt &&
    !preparing &&
    !submitting &&
    (method === 'cash' || !!accountRef.trim());

  async function submit() {
    if (!canSubmit || !activeEntity) return;
    setError(null);
    setSubmitting(true);

    try {
      const uploaded = await uploadReceipt(activeEntity.id, receipt!);

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
        attachments: [uploaded],
      });

      setSuccess(
        `${money(numericAmount)} recorded with its proof. Every director has been notified. ` +
          `It is confirmed once ${created.required_votes} directors approve it, and rejected ` +
          `if ${created.required_votes} reject it.`
      );

      setAmount('');
      setNote('');
      setCategory(null);
      setToDirectorId(null);
      setReceipt(null);
      setError(null);

      setTimeout(() => setSuccess(null), 8000);
    } catch (e) {
      setError(humanError(e));
      setSuccess(null);
    } finally {
      setSubmitting(false);
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
          hint="Every transfer goes to the board, whatever the amount."
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

        <Text style={s.proofLabel}>PROOF OF TRANSFER</Text>
        <Text style={s.proofHint}>
          The bank confirmation, or a photo of the cash being handed over. Required — the
          same standard directors are held to when they log what they spent.
        </Text>
        {pickError ? <Banner tone="danger" title="Could not attach" body={pickError} /> : null}
        <Button
          label={
            preparing
              ? 'Preparing…'
              : receipt
                ? `Attached · ${Math.round(receipt.byteSize / 1024)} KB — replace`
                : 'Attach proof'
          }
          variant="secondary"
          loading={preparing}
          onPress={() => promptUpload()}
        />

        <View style={{ height: space.xl }} />

        <Button
          label="Record disbursement"
          onPress={submit}
          loading={submitting || record.isPending}
          disabled={!canSubmit}
        />

        <View style={{ height: space.xxl }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  proofLabel: { ...type.micro, color: color.inkMuted, marginBottom: space.xs, letterSpacing: 1 },
  proofHint: { ...type.caption, color: color.inkMuted, marginBottom: space.sm, lineHeight: 17 },
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg },
  flex: { flex: 1 },
  groupLabel: { ...type.micro, color: color.inkMuted, marginBottom: space.sm },

  amountInput: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'], height: 60 },
  noteInput: { height: 80, paddingTop: space.md, textAlignVertical: 'top' },
});
