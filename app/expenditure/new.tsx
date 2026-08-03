import { useMemo, useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { useLogExpenditure, useMyAdvances } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { compressImage, uploadReceipt, type PreparedReceipt } from '../../lib/receipts';
import { humanError, money, shortDate } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Card, Choice, Empty, Field, Loading, Money } from '../../components/ui';

const CATEGORIES = [
  'Equipment',
  'Site operations & labor',
  'Transport & logistics',
  'Lease & regulatory fees',
  'Contingency',
];

const THRESHOLD = 1000000;

export default function NewExpenditure() {
  const router = useRouter();
  const { activeEntity, director } = useSession();

  const advances = useMyAdvances(activeEntity?.id, director?.id);
  const logExpenditure = useLogExpenditure();

  const [disbursementId, setDisbursementId] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<PreparedReceipt | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => (advances.data ?? []).find((a) => a.disbursement_id === disbursementId) ?? null,
    [advances.data, disbursementId],
  );

  const numericAmount = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  const needsApproval = amountValid && numericAmount >= THRESHOLD;
  const overAdvance = selected && amountValid && numericAmount > Number(selected.remaining);

  const canSubmit =
    !!disbursementId && amountValid && !!category && !!payee.trim() && !!receipt && !preparing;

  async function pickReceipt(source: 'camera' | 'library') {
    setError(null);
    try {
      const permission =
        source === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        setError(
          source === 'camera'
            ? 'Camera access is needed to photograph a receipt.'
            : 'Photo access is needed to attach an existing receipt.',
        );
        return;
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 1, mediaTypes: ['images'] })
          : await ImagePicker.launchImageLibraryAsync({ quality: 1, mediaTypes: ['images'] });

      if (result.canceled || !result.assets[0]) return;

      setPreparing(true);
      const prepared = await compressImage(
        result.assets[0].uri,
        source === 'camera' ? 'receipt_photo' : 'payment_confirmation',
      );
      setReceipt(prepared);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setPreparing(false);
    }
  }

  async function submit() {
    if (!canSubmit || !activeEntity || !receipt || !disbursementId || !category) return;
    setError(null);

    try {
      // Upload first, then one atomic RPC creates the expenditure and its
      // attachment together. If the RPC fails, the orphaned object is harmless —
      // it is unreferenced and invisible to every query.
      const uploaded = await uploadReceipt(activeEntity.id, receipt);

      const created = await logExpenditure.mutateAsync({
        disbursementId,
        amount: numericAmount,
        category,
        payee: payee.trim(),
        spentOn: new Date().toISOString().slice(0, 10),
        note: note.trim() || undefined,
        attachments: [uploaded],
      });

      Alert.alert(
        created.status === 'pending_approval' ? 'Sent for approval' : 'Recorded',
        created.status === 'pending_approval'
          ? `${money(numericAmount)} is at or above ${money(THRESHOLD)}, so a second director must approve it before it is confirmed.`
          : `${money(numericAmount)} to ${payee.trim()} has been recorded with its receipt.`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
    } catch (e) {
      setError(humanError(e));
    }
  }

  if (advances.isLoading) return <Loading />;

  if ((advances.data ?? []).length === 0) {
    return (
      <View style={s.screen}>
        <Empty
          title="No advance to spend against"
          body="An expenditure has to be charged to money that was disbursed to you. Record a disbursement first, or ask whoever handles disbursements to record one."
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
        {error ? <Banner tone="danger" title="Not saved" body={error} /> : null}

        <Text style={s.groupLabel}>CHARGE TO WHICH ADVANCE</Text>
        {(advances.data ?? []).map((a) => {
          const active = a.disbursement_id === disbursementId;
          return (
            <Pressable
              key={a.disbursement_id}
              onPress={() => setDisbursementId(a.disbursement_id)}
              style={[s.advance, active && s.advanceActive]}
            >
              <View style={s.flex}>
                <Text style={s.advanceTitle}>
                  {a.method === 'cash' ? 'Cash advance' : 'Bank transfer'} ·{' '}
                  {shortDate(a.disbursed_on)}
                </Text>
                <Text style={s.advanceMeta}>
                  {money(a.spent)} spent of {money(a.advanced)}
                </Text>
              </View>
              <View style={s.advanceRight}>
                <Money amount={a.remaining} tone={Number(a.remaining) > 0 ? 'neutral' : 'warning'} />
                <Text style={s.advanceRemaining}>remaining</Text>
              </View>
            </Pressable>
          );
        })}

        <View style={{ height: space.xl }} />

        <Field
          label="Amount (PKR)"
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0"
          style={s.amountInput}
          hint={
            overAdvance
              ? undefined
              : needsApproval
                ? `At or above ${money(THRESHOLD)} — a second director will have to approve this.`
                : undefined
          }
          error={
            overAdvance
              ? `This is more than the ${money(selected!.remaining)} left on that advance. It will be recorded, but it will show as an unexplained gap until a further disbursement covers it.`
              : undefined
          }
        />

        <Choice
          label="Category"
          value={category}
          options={CATEGORIES.map((c) => ({ value: c, label: c }))}
          onChange={setCategory}
        />

        <Field
          label="Paid to"
          value={payee}
          onChangeText={setPayee}
          placeholder="Supplier, contractor or payee"
        />

        <Field
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
          placeholder="What was this for?"
          multiline
          style={s.noteInput}
        />

        <Text style={s.groupLabel}>RECEIPT — REQUIRED</Text>
        <Card style={s.receiptCard}>
          {receipt ? (
            <View style={s.receiptPreview}>
              <Image source={{ uri: receipt.uri }} style={s.thumb} resizeMode="cover" />
              <View style={s.flex}>
                <Text style={s.receiptOk}>Receipt attached</Text>
                <Text style={s.receiptMeta}>
                  Compressed to {(receipt.byteSize / 1024).toFixed(0)} KB before upload
                </Text>
                <Pressable onPress={() => setReceipt(null)}>
                  <Text style={s.replace}>Replace</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              <Text style={s.receiptPrompt}>
                Every expenditure needs a receipt or a payment confirmation. This is enforced by the
                database — an entry without one cannot be saved.
              </Text>
              <View style={s.receiptButtons}>
                <Button
                  label="Photograph"
                  variant="secondary"
                  onPress={() => void pickReceipt('camera')}
                  loading={preparing}
                  style={s.flex}
                />
                <Button
                  label="Choose file"
                  variant="secondary"
                  onPress={() => void pickReceipt('library')}
                  loading={preparing}
                  style={s.flex}
                />
              </View>
            </>
          )}
        </Card>

        <Button
          label={needsApproval ? 'Submit for approval' : 'Record expenditure'}
          onPress={submit}
          loading={logExpenditure.isPending}
          disabled={!canSubmit}
          style={{ marginTop: space.lg }}
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

  advance: {
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
  advanceActive: { borderColor: color.accent, backgroundColor: color.accentSoft },
  advanceTitle: { ...type.body, color: color.ink, fontWeight: '600' },
  advanceMeta: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  advanceRight: { alignItems: 'flex-end' },
  advanceRemaining: { ...type.micro, color: color.inkFaint },

  amountInput: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'], height: 60 },
  noteInput: { height: 80, paddingTop: space.md, textAlignVertical: 'top' },

  receiptCard: { marginBottom: space.md },
  receiptPrompt: { ...type.caption, color: color.inkMuted, lineHeight: 18, marginBottom: space.lg },
  receiptButtons: { flexDirection: 'row', gap: space.md },
  receiptPreview: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  thumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: color.surfaceSunken },
  receiptOk: { ...type.body, color: color.positive, fontWeight: '600' },
  receiptMeta: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  replace: { ...type.caption, color: color.accent, fontWeight: '600', marginTop: space.sm },
});
