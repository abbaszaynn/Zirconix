import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { EntitySwitcher } from '../../components/EntitySwitcher';
import {
  useApprovalHistory,
  useDecideApproval,
  useDirectors,
  usePendingApprovals,
  type PendingItem,
} from '../../lib/queries';
import { useSession } from '../../lib/session';
import { humanError, money, shortDate, dateTime } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import {
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Loading,
  Money,
  Pill,
  SectionTitle,
} from '../../components/ui';

export default function Approvals() {
  const router = useRouter();
  const { activeEntity, director, hasMfaSession, hasEnrolledMfa } = useSession();

  const pending = usePendingApprovals(activeEntity?.id);
  const history = useApprovalHistory(activeEntity?.id);
  const { data: directors } = useDirectors();
  const decide = useDecideApproval();

  const [rejecting, setRejecting] = useState<PendingItem | null>(null);
  const [reason, setReason] = useState('');

  const nameOf = (id: string | null | undefined) =>
    directors?.find((d) => d.id === id)?.full_name ?? '—';

  function approve(item: PendingItem) {
    Alert.alert(
      'Approve this entry?',
      `${money(item.amount)} — ${item.label}\nSubmitted by ${nameOf(item.submittedBy)}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          style: 'default',
          onPress: () => {
            decide.mutate(
              { targetType: item.kind, targetId: item.id, decision: 'approved' },
              { onError: (e) => Alert.alert('Not approved', humanError(e)) },
            );
          },
        },
      ],
    );
  }

  function submitRejection() {
    if (!rejecting) return;
    decide.mutate(
      {
        targetType: rejecting.kind,
        targetId: rejecting.id,
        decision: 'rejected',
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          setRejecting(null);
          setReason('');
        },
        onError: (e) => Alert.alert('Not rejected', humanError(e)),
      },
    );
  }

  if (pending.isLoading) return <Loading />;

  const items = pending.data ?? [];

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={pending.isFetching}
          onRefresh={() => {
            void pending.refetch();
            void history.refetch();
          }}
        />
      }
    >
      <EntitySwitcher />

      {!hasEnrolledMfa ? (
        <Banner
          tone="warning"
          title="Two-step verification required to approve"
          body="Any entry of PKR 10 lac or more needs a second director's approval, and approving requires a verified session. Set up your authenticator to take part."
          action={
            <Button
              label="Set up now"
              variant="secondary"
              onPress={() => router.push('/(auth)/mfa-enroll')}
            />
          }
        />
      ) : !hasMfaSession ? (
        <Banner
          tone="warning"
          title="Verify this session to approve"
          body="You are signed in, but this session has not been verified with your authenticator app."
          action={
            <Button
              label="Enter code"
              variant="secondary"
              onPress={() => router.push('/(auth)/mfa-challenge')}
            />
          }
        />
      ) : null}

      {rejecting ? (
        <Card style={s.rejectCard}>
          <Text style={s.rejectTitle}>Reject {money(rejecting.amount)} — {rejecting.label}</Text>
          <Field
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder="Why is this being rejected?"
            multiline
            style={s.reasonInput}
            hint="Recorded permanently against the entry. A rejection must say why."
          />
          <View style={s.rejectActions}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setRejecting(null);
                setReason('');
              }}
              style={s.flex}
            />
            <Button
              label="Confirm rejection"
              variant="danger"
              onPress={submitRejection}
              loading={decide.isPending}
              disabled={!reason.trim()}
              style={s.flex}
            />
          </View>
        </Card>
      ) : null}

      <SectionTitle note={`At or above ${money(1000000)}, a second director must decide`}>
        Awaiting a decision
      </SectionTitle>

      {items.length === 0 ? (
        <Empty title="Nothing pending" body="No entry is waiting on a second director right now." />
      ) : (
        items.map((item) => {
          const isMine = item.submittedBy === director?.id;

          return (
            <Card key={`${item.kind}:${item.id}`} style={s.pendingCard}>
              <View style={s.pendingHead}>
                <View style={s.flex}>
                  <Text style={s.pendingLabel} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <Text style={s.pendingMeta}>
                    {item.category} · {shortDate(item.on)}
                  </Text>
                </View>
                <Money amount={item.amount} size="large" tone="warning" />
              </View>

              <View style={s.pendingBy}>
                <Pill label={item.kind} tone="neutral" />
                <Text style={s.pendingByText}>Submitted by {nameOf(item.submittedBy)}</Text>
              </View>

              {isMine ? (
                <View style={s.blocked}>
                  <Text style={s.blockedText}>
                    You submitted this. Another director has to decide it — the database refuses a
                    self-approval regardless of what this screen offers.
                  </Text>
                </View>
              ) : (
                <View style={s.pendingActions}>
                  <Button
                    label="Reject"
                    variant="ghost"
                    onPress={() => {
                      setRejecting(item);
                      setReason('');
                    }}
                    style={s.flex}
                  />
                  <Button
                    label="Approve"
                    onPress={() => approve(item)}
                    loading={decide.isPending}
                    disabled={!hasMfaSession}
                    style={s.flex}
                  />
                </View>
              )}
            </Card>
          );
        })
      )}

      <SectionTitle>Recent decisions</SectionTitle>

      {(history.data ?? []).length === 0 ? (
        <Empty title="No decisions yet" body="Approvals and rejections will be listed here." />
      ) : (
        <Card style={s.historyCard}>
          {(history.data ?? []).map((a, i) => (
            <View key={a.id} style={[s.historyRow, i > 0 && s.divided]}>
              <View style={s.flex}>
                <Text style={s.historyText}>
                  {nameOf(a.approver_id)}{' '}
                  <Text
                    style={{
                      color: a.decision === 'approved' ? color.positive : color.danger,
                      fontWeight: '700',
                    }}
                  >
                    {a.decision}
                  </Text>{' '}
                  an entry by {nameOf(a.submitted_by)}
                </Text>
                {a.reason ? <Text style={s.historyReason}>“{a.reason}”</Text> : null}
                <Text style={s.historyMeta}>{dateTime(a.decided_at)}</Text>
              </View>
            </View>
          ))}
        </Card>
      )}

      <View style={{ height: space.xxl }} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg },
  flex: { flex: 1 },

  pendingCard: { marginBottom: space.md },
  pendingHead: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  pendingLabel: { ...type.heading, color: color.ink },
  pendingMeta: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  pendingBy: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  pendingByText: { ...type.caption, color: color.inkMuted },
  pendingActions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },

  blocked: {
    marginTop: space.lg,
    padding: space.md,
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.sm,
  },
  blockedText: { ...type.caption, color: color.inkMuted, lineHeight: 17 },

  rejectCard: { marginTop: space.lg, borderColor: color.danger },
  rejectTitle: { ...type.heading, color: color.ink, marginBottom: space.lg },
  reasonInput: { height: 90, paddingTop: space.md, textAlignVertical: 'top' },
  rejectActions: { flexDirection: 'row', gap: space.md },

  historyCard: { paddingVertical: space.sm },
  historyRow: { paddingVertical: space.md },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  historyText: { ...type.body, color: color.ink },
  historyReason: { ...type.caption, color: color.inkMuted, marginTop: space.xs, fontStyle: 'italic' },
  historyMeta: { ...type.caption, color: color.inkFaint, marginTop: space.xs },
});
