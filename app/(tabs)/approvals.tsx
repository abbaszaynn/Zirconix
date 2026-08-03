import { useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  useApprovalHistory,
  useCastVote,
  useDirectors,
  useMyVotes,
  useTransferVotes,
} from '../../lib/queries';
import { useSession } from '../../lib/session';
import { humanError, shortDate } from '../../lib/format';
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
import type { TransferVoteRow } from '../../lib/database.types';

export default function Approvals() {
  const router = useRouter();
  const { activeEntity, director, hasMfaSession, hasEnrolledMfa } = useSession();

  const votes = useTransferVotes(activeEntity?.id, true);
  const mine = useMyVotes(activeEntity?.id, director?.id);
  const history = useApprovalHistory(activeEntity?.id);
  const { data: directors } = useDirectors();
  const cast = useCastVote();

  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const nameOf = useMemo(() => {
    const m = new Map((directors ?? []).map((d) => [d.id, d.full_name]));
    return (id: string | null | undefined) => (id ? (m.get(id) ?? 'Unknown') : 'Unknown');
  }, [directors]);

  const canVote = hasMfaSession && director?.role !== 'auditor';

  async function submit(row: TransferVoteRow, decision: 'approved' | 'rejected') {
    try {
      const result = await cast.mutateAsync({
        disbursementId: row.disbursement_id,
        decision,
        reason: decision === 'rejected' ? reason.trim() : undefined,
      });
      setRejecting(null);
      setReason('');

      Alert.alert(
        result.status === 'confirmed'
          ? 'Transfer confirmed'
          : result.status === 'rejected'
            ? 'Transfer rejected'
            : 'Vote recorded',
        result.status === 'pending_approval'
          ? `${result.approval_count} of ${result.required_votes} votes in. Every director has been notified.`
          : 'Every director has been notified.',
      );
    } catch (e) {
      Alert.alert('Could not record your vote', humanError(e));
    }
  }

  if (votes.isLoading) return <Loading />;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.scroll}
      refreshControl={
        <RefreshControl refreshing={votes.isFetching} onRefresh={() => void votes.refetch()} />
      }
    >
      <Text style={s.title}>Approvals</Text>

      {!hasEnrolledMfa ? (
        <Banner
          tone="warning"
          title="Two-step verification not set up"
          body="Every transfer now needs your vote, and voting requires two-step verification. Until it is set up you can see transfers but not vote on them."
          action={
            <Button
              label="Set it up"
              variant="ghost"
              onPress={() => router.push('/(auth)/mfa-enroll')}
            />
          }
        />
      ) : !hasMfaSession ? (
        <Banner
          tone="warning"
          title="Enter your code to vote"
          body="This session has not been verified with your authenticator yet."
          action={
            <Button
              label="Enter code"
              variant="ghost"
              onPress={() => router.push('/(auth)/mfa-challenge')}
            />
          }
        />
      ) : null}

      {director?.role === 'auditor' ? (
        <Banner
          tone="neutral"
          title="Read-only access"
          body="Auditors see every transfer and every vote, but do not vote themselves."
        />
      ) : null}

      <SectionTitle note="Sender and recipient below 10 lac; two more directors above it">
        Awaiting a vote
      </SectionTitle>

      {(votes.data ?? []).length === 0 ? (
        <Empty
          title="Nothing to vote on"
          body="Every transfer has been decided. New ones appear here the moment they are recorded."
        />
      ) : (
        (votes.data ?? []).map((row) => {
          const myDecision = mine.data?.[row.disbursement_id];
          const iAmSender = row.recorded_by === director?.id;
          const iAmRecipient = row.to_director_id === director?.id;

          return (
            <Card key={row.disbursement_id} style={s.voteCard}>
              <View style={s.head}>
                <View style={s.headMain}>
                  <Money amount={row.amount} size="large" />
                  <Text style={s.meta}>
                    to {row.recipient_name} · from {row.account_name}
                  </Text>
                  <Text style={s.meta}>
                    {row.category} · {shortDate(row.disbursed_on)} ·{' '}
                    {row.method === 'cash' ? 'Cash' : 'Bank transfer'}
                  </Text>
                  <Text style={s.meta}>recorded by {row.sender_name}</Text>
                </View>
                <Pill
                  label={`${row.approval_count} of ${row.required_votes}`}
                  tone={row.approval_count > 0 ? 'warning' : 'neutral'}
                />
              </View>

              {row.note ? <Text style={s.note}>{row.note}</Text> : null}

              <View style={s.tally}>
                <Tick
                  done={row.sender_voted}
                  label={`Sender — ${row.sender_name}`}
                  you={iAmSender}
                />
                {row.principals > 1 ? (
                  <Tick
                    done={row.recipient_voted}
                    label={`Recipient — ${row.recipient_name}`}
                    you={iAmRecipient}
                  />
                ) : (
                  <Text style={s.selfNote}>
                    Recorded to himself, so an extra independent director is required in
                    place of the second principal.
                  </Text>
                )}
                {row.independents_required > 0 ? (
                  <Tick
                    done={row.independent_votes >= row.independents_required}
                    label={`Independent directors — ${row.independent_votes} of ${row.independents_required}`}
                  />
                ) : null}
              </View>

              {myDecision ? (
                <Text style={s.voted}>
                  You {myDecision === 'approved' ? 'approved' : 'rejected'} this. Waiting on
                  the others.
                </Text>
              ) : !canVote ? null : rejecting === row.disbursement_id ? (
                <View style={s.rejectBox}>
                  <Field
                    label="Why are you rejecting this?"
                    value={reason}
                    onChangeText={setReason}
                    placeholder="Recorded against the wrong budget line"
                    multiline
                  />
                  <View style={s.actions}>
                    <Button
                      label="Cancel"
                      variant="ghost"
                      onPress={() => {
                        setRejecting(null);
                        setReason('');
                      }}
                    />
                    <Button
                      label="Confirm rejection"
                      variant="danger"
                      disabled={reason.trim().length === 0}
                      loading={cast.isPending}
                      onPress={() => void submit(row, 'rejected')}
                    />
                  </View>
                </View>
              ) : (
                <View style={s.actions}>
                  <Button
                    label="Reject"
                    variant="ghost"
                    onPress={() => setRejecting(row.disbursement_id)}
                  />
                  <Button
                    label="Approve"
                    loading={cast.isPending}
                    onPress={() => void submit(row, 'approved')}
                  />
                </View>
              )}
            </Card>
          );
        })
      )}

      <SectionTitle note="Most recent first">Votes cast</SectionTitle>
      {(history.data ?? []).length === 0 ? (
        <Empty title="No votes yet" body="Decisions appear here as directors vote." />
      ) : (
        <Card>
          {(history.data ?? []).slice(0, 25).map((a) => (
            <View key={a.id} style={s.histRow}>
              <View style={s.rowMain}>
                <Text style={s.histName}>{nameOf(a.approver_id)}</Text>
                <Text style={s.meta}>
                  {a.voter_role ?? 'director'} · {shortDate(a.decided_at)}
                  {a.reason ? ` · ${a.reason}` : ''}
                </Text>
              </View>
              <Pill
                label={a.decision === 'approved' ? 'approved' : 'rejected'}
                tone={a.decision === 'approved' ? 'positive' : 'danger'}
              />
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

function Tick({ done, label, you }: { done: boolean; label: string; you?: boolean }) {
  return (
    <View style={s.tickRow}>
      <Text style={[s.tick, { color: done ? color.positive : color.inkFaint }]}>
        {done ? '✓' : '○'}
      </Text>
      <Text style={[s.tickLabel, done && s.tickDone]}>
        {label}
        {you ? ' (you)' : ''}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  scroll: { padding: space.lg, paddingBottom: space.xxl * 2, gap: space.md },
  title: { ...type.display, color: color.ink, marginBottom: space.xs },
  voteCard: { gap: space.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headMain: { flex: 1, gap: 2 },
  meta: { ...type.caption, color: color.inkMuted },
  note: {
    ...type.caption,
    color: color.inkMuted,
    fontStyle: 'italic',
    backgroundColor: color.surfaceSunken,
    padding: space.sm,
    borderRadius: radius.sm,
  },
  tally: {
    gap: space.xs,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.border,
    paddingVertical: space.md,
  },
  tickRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tick: { ...type.body, width: 16 },
  tickLabel: { ...type.caption, color: color.inkMuted, flex: 1 },
  tickDone: { color: color.ink },
  selfNote: { ...type.caption, color: color.warning, marginLeft: 24 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
  rejectBox: { gap: space.sm },
  voted: { ...type.caption, color: color.positive },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  rowMain: { flex: 1, gap: 2 },
  histName: { ...type.body, color: color.ink },
});
