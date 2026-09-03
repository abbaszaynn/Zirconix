import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

import { useLogExpenditure, useMyAdvances, useExpenditure, useUpdateExpenditure, useReplaceReceipt } from '../../lib/queries';
import { useSession } from '../../lib/session';
import {
  compressImage,
  preparePdf,
  uploadReceipt,
  type PreparedReceipt,
} from '../../lib/receipts';
import { humanError, money } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Card, Choice, Empty, Field, Loading, Money } from '../../components/ui';

const CATEGORIES = [
  'Equipment',
  'Site operations & labor',
  'Transport & logistics',
  'Lease & regulatory fees',
  'Contingency',
];

export default function NewExpenditure() {
  const router = useRouter();
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const isEditing = !!edit;
  const { activeEntity, director } = useSession();

  const advances = useMyAdvances(activeEntity?.id, director?.id);
  const logExpenditure = useLogExpenditure();
  const updateExpenditure = useUpdateExpenditure();
  const replaceReceipt = useReplaceReceipt();
  const { data: editData } = useExpenditure(edit ?? null);

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<PreparedReceipt | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (isEditing && editData) {
      setAmount(editData.amount.toString());
      setCategory(editData.category);
      setPayee(editData.payee);
      setNote(editData.note || '');
    }
  }, [editData, isEditing]);

  /**
   * One pool, not a list to pick from. Several transfers to the same director
   * are still separate voted rows underneath, but a director does not think in
   * those terms while spending — he was given a total and draws against the
   * total. log_expenditure() enforces this same cap server-side; this is only
   * what lets the form say so before he uploads a receipt.
   */
  const pool = useMemo(() => {
    const rows = advances.data ?? [];
    return {
      advanced: rows.reduce((n, r) => n + Number(r.advanced), 0),
      spent: rows.reduce((n, r) => n + Number(r.spent), 0),
      remaining: rows.reduce((n, r) => n + Number(r.remaining), 0),
    };
  }, [advances.data]);

  const numericAmount = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(numericAmount) && numericAmount > 0;
  // Editing an existing entry does not draw further against the pool — its
  // amount is already inside `pool.spent` — so the cap only applies to a new one.
  const overAdvance = !isEditing && amountValid && numericAmount > pool.remaining;

  // Guards the window BEFORE the mutation starts. uploadReceipt() runs first
  // and can take a second or more on a site connection, during which the
  // mutation's isPending is still false and the button stays live — two taps
  // there produced two uploads and two identical entries. This is what put
  // 194,106 of duplicate expenditures into the ledger on 24 August.
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    amountValid && !!category && !!payee.trim() &&
    (isEditing || !!receipt) && !preparing && !submitting &&
    // The database refuses this outright now; blocking here means the director
    // finds out before uploading a receipt rather than after.
    !overAdvance;

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

  async function pickFiles() {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/jpeg', 'image/png', 'application/pdf'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setPreparing(true);
      if (asset.mimeType === 'application/pdf' || asset.name?.toLowerCase().endsWith('.pdf')) {
        setReceipt(await preparePdf(asset.uri, asset.size ?? undefined));
      } else {
        const prepared = await compressImage(asset.uri, 'payment_confirmation');
        setReceipt(prepared);
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setPreparing(false);
    }
  }

  async function submit() {
    if (!canSubmit || !activeEntity || !director || !category) return;
    setError(null);
    setSubmitting(true);

    try {
      if (isEditing && editData) {
        if (receipt) {
          const uploaded = await uploadReceipt(activeEntity.id, receipt);
          await replaceReceipt.mutateAsync({
            entityId: activeEntity.id,
            expenditureId: edit!,
            oldAttachmentId: editData.attachments?.[0]?.id ?? '',
            newReceipt: uploaded,
            directorId: director!.id,
          });
        }
        await updateExpenditure.mutateAsync({
          id: edit!,
          amount: numericAmount,
          category,
          payee: payee.trim(),
          note: note.trim() || undefined,
          // Unchanged — there is no picker to change it from any more, and
          // the database treats this as immutable regardless.
          disbursementId: editData.disbursement_id,
        });
        setSuccess('Expenditure updated successfully.');
      } else {
        if (!receipt) return;
        const uploaded = await uploadReceipt(activeEntity.id, receipt);

        await logExpenditure.mutateAsync({
          directorId: director.id,
          amount: numericAmount,
          category,
          payee: payee.trim(),
          spentOn: new Date().toISOString().slice(0, 10),
          note: note.trim() || undefined,
          attachments: [uploaded],
        });

        setSuccess(
          `${money(numericAmount)} to ${payee.trim()} has been recorded with its receipt. ` +
            'The other directors have been notified.'
        );

        setAmount('');
        setCategory(null);
        setPayee('');
        setNote('');
        setReceipt(null);
      }
      setError(null);
      setTimeout(() => setSuccess(null), 8000);
    } catch (e) {
      setError(humanError(e));
      setSuccess(null);
    }
  }

  if (advances.isLoading || (isEditing && !editData)) return <Loading />;

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
        {success ? <Banner tone="positive" title={isEditing ? 'Updated' : 'Recorded'} body={success} /> : null}

        {!isEditing ? (
          <Card style={s.poolCard}>
            <Text style={s.groupLabel}>AVAILABLE TO SPEND</Text>
            <Money
              amount={pool.remaining}
              size="display"
              align="left"
              tone={pool.remaining > 0 ? 'neutral' : 'warning'}
            />
            <Text style={s.poolMeta}>
              {money(pool.spent)} accounted for of {money(pool.advanced)} advanced to you in
              total{advances.data && advances.data.length > 1 ? ` across ${advances.data.length} transfers` : ''}
            </Text>
          </Card>
        ) : null}

        <View style={{ height: space.xl }} />

        <Field
          label="Amount (PKR)"
          value={amount}
          onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0"
          style={s.amountInput}
          error={
            overAdvance
              ? `Only ${money(pool.remaining)} is left available to you, so this cannot be saved. ` +
                `An expenditure settles what you were advanced — it cannot exceed it. If you spent ` +
                `your own money, ask for it to be transferred to you first, then account for it against that.`
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
                <Text style={s.receiptOk}>New receipt attached</Text>
                <Text style={s.receiptMeta}>
                  Compressed to {(receipt.byteSize / 1024).toFixed(0)} KB before upload
                </Text>
                <Pressable onPress={() => setReceipt(null)}>
                  <Text style={s.replace}>{isEditing ? 'Cancel replacement' : 'Replace'}</Text>
                </Pressable>
              </View>
            </View>
          ) : isEditing ? (
            <View style={s.receiptPreview}>
              <View style={[s.thumb, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: color.inkMuted, fontSize: 10 }}>Stored</Text>
              </View>
              <View style={s.flex}>
                <Text style={s.receiptOk}>Existing receipt</Text>
                <Text style={s.receiptMeta}>
                  A receipt is already stored for this expenditure.
                </Text>
                <View style={s.receiptButtons}>
                  <Pressable onPress={() => pickReceipt('camera')}>
                    <Text style={s.replace}>Take photo</Text>
                  </Pressable>
                  <Pressable onPress={pickFiles}>
                    <Text style={s.replace}>Choose file</Text>
                  </Pressable>
                </View>
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
                  label="Take photo"
                  variant="secondary"
                  onPress={() => pickReceipt('camera')}
                  loading={preparing}
                  style={s.flex}
                />
                <Button
                  label="Choose file"
                  variant="secondary"
                  onPress={pickFiles}
                  loading={preparing}
                  style={s.flex}
                />
              </View>
            </>
          )}
        </Card>

        <Button
          label={isEditing ? 'Update expenditure' : 'Record expenditure'}
          onPress={submit}
          loading={
            submitting ||
            logExpenditure.isPending ||
            updateExpenditure.isPending ||
            replaceReceipt.isPending
          }
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
  poolCard: { gap: space.xs },
  poolMeta: { ...type.caption, color: color.inkMuted, marginTop: space.xs },

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
