import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import {
  useAccounts,
  useCreateDeposit,
  useDirectors,
} from '../../lib/queries';
import { useSession } from '../../lib/session';
import { useReceiptPicker } from '../../lib/useReceiptPicker';
import { uploadReceipt } from '../../lib/receipts';
import { humanError, money } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Choice, Empty, Field, Loading } from '../../components/ui';

export default function NewDeposit() {
  const router = useRouter();
  const { activeEntity, director } = useSession();

  if (director && director.role !== 'finance_officer') {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
        <Empty 
          title="Access restricted" 
          body="Only the finance director can record incoming funds." 
        />
        <Button label="Go back" onPress={() => router.back()} style={{ marginTop: 24 }} />
      </View>
    );
  }

  const { data: directors } = useDirectors();
  const accounts = useAccounts(activeEntity?.id);
  const record = useCreateDeposit();

  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [sourceType, setSourceType] = useState<'director' | 'investor'>('director');
  const [sourceDirectorId, setSourceDirectorId] = useState<string | null>(null);
  const [sourceInvestorName, setSourceInvestorName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Incoming funds need proof, same as a director's expenditure does. The
  // database enforces this too — record_deposit() refuses without one.
  const { receipt, setReceipt, preparing, promptUpload, error: pickError } = useReceiptPicker();

  const numericAmount = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;

  const canSubmit =
    !!toAccountId &&
    amountValid &&
    !!receipt &&
    !preparing &&
    (sourceType === 'director' ? !!sourceDirectorId : !!sourceInvestorName.trim());

  async function submit() {
    if (!canSubmit || !activeEntity || !toAccountId || !director) return;
    setError(null);

    try {
      // Upload first, then one RPC writes the deposit and its proof together.
      // If the RPC fails the uploaded object is unreferenced and invisible.
      const uploaded = await uploadReceipt(activeEntity.id, receipt!);

      await record.mutateAsync({
        entityId: activeEntity.id,
        toAccountId,
        amount: numericAmount,
        sourceType,
        sourceDirectorId: sourceType === 'director' ? sourceDirectorId : null,
        sourceInvestorName: sourceType === 'investor' ? sourceInvestorName.trim() : null,
        depositDate: new Date().toISOString().slice(0, 10),
        attachments: [uploaded],
      });

      setSuccess(`${money(numericAmount)} has been added to the account balance.`);
      setAmount('');
      setSourceInvestorName('');
      setSourceDirectorId(null);
      setReceipt(null);
      setError(null);
      
      // Auto-hide success after 5 seconds
      setTimeout(() => setSuccess(null), 5000);
    } catch (e) {
      setError(humanError(e));
      setSuccess(null);
    }
  }

  if (accounts.isLoading) return <Loading />;

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Banner
          tone="neutral"
          title="Record incoming funds"
          body="Use this form to log capital injections from directors or outside investors into company accounts."
        />

        {error ? <Banner tone="danger" title="Not saved" body={error} /> : null}
        {success ? <Banner tone="positive" title="Success" body={success} /> : null}

        <View style={{ height: space.xl }} />

        <Choice
          label="Destination Account"
          value={toAccountId}
          options={(accounts.data ?? []).map((a) => ({
            value: a.id,
            label: a.bank_label ? `${a.name} · ${a.bank_label}` : a.name,
          }))}
          onChange={setToAccountId}
        />

        <Field
          label="Amount (PKR)"
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0"
          style={s.amountInput}
        />

        <Choice
          label="Source of Funds"
          value={sourceType}
          options={[
            { value: 'director', label: 'Director' },
            { value: 'investor', label: 'External Investor' },
          ]}
          onChange={setSourceType}
        />

        {sourceType === 'director' ? (
          <Choice
            label="Which director?"
            value={sourceDirectorId}
            options={(directors ?? [])
              .filter((d) => d.is_active)
              .map((d) => ({ value: d.id, label: d.full_name }))}
            onChange={setSourceDirectorId}
          />
        ) : (
          <Field
            label="Investor Name"
            value={sourceInvestorName}
            onChangeText={setSourceInvestorName}
            placeholder="Name of the investor or organization"
          />
        )}

        <View style={{ height: space.xl }} />

        <Text style={s.proofLabel}>PROOF OF DEPOSIT</Text>
        <Text style={s.proofHint}>
          The deposit slip, bank confirmation or a photo of the transfer. Required — money
          coming in is recorded with evidence, the same as money going out.
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
          label="Record incoming funds"
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
  amountInput: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'], height: 60 },
  proofLabel: { ...type.micro, color: color.inkMuted, marginBottom: space.xs, letterSpacing: 1 },
  proofHint: { ...type.caption, color: color.inkMuted, marginBottom: space.sm, lineHeight: 17 },
});
