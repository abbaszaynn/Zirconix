import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Link, useRouter } from 'expo-router';

import {
  useAccountability,
  useBudgetSummary,
  useDirectors,
  usePeriods,
  useDeposits,
} from '../../lib/queries';
import { useSession } from '../../lib/session';
import { money, lakhCrore } from '../../lib/format';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Card, Empty, Loading, Money, Pill, SectionTitle } from '../../components/ui';

export default function Dashboard() {
  const router = useRouter();
  const { activeEntity, director, hasEnrolledMfa } = useSession();
  const [period, setPeriod] = useState<string | null>(null);

  const { data: periods } = usePeriods(activeEntity?.id);
  const effectivePeriod = period ?? periods?.[0];

  const budget = useBudgetSummary(activeEntity?.id, effectivePeriod);
  const accountability = useAccountability(activeEntity?.id);
  const deposits = useDeposits(activeEntity?.id);
  const { data: directors } = useDirectors();

  const totals = useMemo(() => {
    const rows = budget.data ?? [];
    return rows.reduce(
      (acc, r) => ({
        allocated: acc.allocated + Number(r.allocated_amount),
        disbursed: acc.disbursed + Number(r.disbursed_amount),
        spent: acc.spent + Number(r.spent_amount),
        unaccounted: acc.unaccounted + Number(r.unaccounted_amount),
      }),
      { allocated: 0, disbursed: 0, spent: 0, unaccounted: 0 },
    );
  }, [budget.data]);

  const totalFund = useMemo(() => {
    return (deposits.data ?? []).reduce((acc, d) => acc + Number(d.amount), 0);
  }, [deposits.data]);

  const nameOf = (id: string) =>
    directors?.find((d) => d.id === id)?.full_name ?? 'Unknown director';

  const refreshing = budget.isFetching || accountability.isFetching || deposits.isFetching;

  if (!activeEntity) {
    return (
      <Empty
        title="No company assigned"
        body="Your account is not on the director list for either company yet. Ask an existing director to add you."
      />
    );
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void budget.refetch();
            void accountability.refetch();
            void deposits.refetch();
          }}
        />
      }
    >

      {!hasEnrolledMfa ? (
        <Banner
          tone="neutral"
          title="Two-step verification not set up"
          body="You can log expenditures without it, but you will not be able to approve another director's entry."
          action={
            <Button
              label="Set it up"
              variant="secondary"
              onPress={() => router.push('/(auth)/mfa-enroll')}
            />
          }
        />
      ) : null}

      {periods && periods.length > 1 ? (
        <View style={s.periodRow}>
          {periods.map((p) => {
            const active = p === effectivePeriod;
            return (
              <Text
                key={p}
                onPress={() => setPeriod(p)}
                style={[s.period, active && s.periodActive]}
              >
                {p}
              </Text>
            );
          })}
        </View>
      ) : null}

      {/* Headline: showing available balance. */}
      <Card style={s.hero}>
        <Text style={s.heroLabel}>AVAILABLE BALANCE</Text>
        <Money amount={totalFund - totals.disbursed} size="display" align="left" />

        <View style={s.heroGrid}>
          <Stat label="Total Fund" amount={totalFund} />
          <Stat label="Disbursed" amount={totals.disbursed} />
          <Stat label="Spent" amount={totals.spent} />
        </View>

        <Text style={s.heroNote}>
          {totals.unaccounted > 0
            ? `${money(totals.unaccounted)} has left the company and is not yet explained by a receipted expenditure.`
            : 'Every rupee disbursed is accounted for by a receipted expenditure.'}
        </Text>
      </Card>

      <View style={s.actions}>
        {director?.role === 'finance_officer' && (
          <>
            <Button
              label="Record incoming funds"
              variant="secondary"
              onPress={() => router.push('/deposit/new')}
              style={s.actionBtn}
            />
            <Button
              label="Record disbursement"
              variant="secondary"
              onPress={() => router.push('/disbursement/new')}
              style={s.actionBtn}
            />
          </>
        )}
        <Button
          label="Log expenditure"
          onPress={() => router.push('/expenditure/new')}
          style={s.actionBtn}
        />
      </View>


      <SectionTitle note="Recent capital injections into the company accounts">
        Incoming Funds
      </SectionTitle>

      {deposits.isLoading ? (
        <Loading />
      ) : (deposits.data ?? []).length === 0 ? (
        <Empty
          title="No incoming funds"
          body="No capital injections have been recorded yet."
        />
      ) : (
        <Card style={s.tableCard}>
          {(deposits.data ?? []).map((d, i) => {
            const sourceName =
              d.source_type === 'director'
                ? d.directors?.full_name ?? 'Unknown director'
                : d.source_investor_name ?? 'Unknown investor';

            return (
              <View key={d.id} style={[s.accRow, i > 0 && s.catRowDivided]}>
                <View style={s.accMain}>
                  <Text style={s.accName}>{sourceName}</Text>
                  <Text style={s.accMeta}>
                    to {d.accounts?.name ?? 'Account'} · {d.deposit_date}
                  </Text>
                </View>
                <View style={s.accRight}>
                  <Money amount={d.amount} tone="positive" size="large" />
                  <Pill label={d.source_type} tone="neutral" />
                </View>
              </View>
            );
          })}
        </Card>
      )}

      <SectionTitle note="Allocated against spent, per category">By category</SectionTitle>

      {budget.isLoading ? (
        <Loading />
      ) : (budget.data ?? []).length === 0 ? (
        <Empty
          title="No budget lines yet"
          body={`Nothing has been allocated for ${effectivePeriod ?? 'this period'}.`}
        />
      ) : (
        <Card style={s.tableCard}>
          {(budget.data ?? []).map((r, i) => {
            const pct =
              Number(r.allocated_amount) > 0
                ? Math.min(1, Number(r.spent_amount) / Number(r.allocated_amount))
                : 0;
            const over = Number(r.spent_amount) > Number(r.allocated_amount);

            return (
              <View key={r.budget_line_id} style={[s.catRow, i > 0 && s.catRowDivided]}>
                <View style={s.catHead}>
                  <Text style={s.catName} numberOfLines={1}>
                    {r.category}
                  </Text>
                  <Money
                    amount={r.spent_amount}
                    tone={over ? 'danger' : 'neutral'}
                    size="body"
                  />
                </View>

                <View style={s.bar}>
                  <View
                    style={[
                      s.barFill,
                      { width: `${pct * 100}%` },
                      over && { backgroundColor: color.danger },
                    ]}
                  />
                </View>

                <View style={s.catFoot}>
                  <Text style={s.catMeta}>
                    of {lakhCrore(r.allocated_amount)} allocated
                  </Text>
                  {Number(r.unaccounted_amount) > 0 ? (
                    <Text style={s.catFlag}>
                      {lakhCrore(r.unaccounted_amount)} unaccounted
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>
      )}

      <SectionTitle note="Advanced against receipted. A gap is a flag, not an error.">
        Director accountability
      </SectionTitle>

      {(accountability.data ?? []).length === 0 ? (
        <Empty
          title="No advances yet"
          body="Once money is disbursed to a director, their outstanding balance appears here."
        />
      ) : (
        <Card style={s.tableCard}>
          {(accountability.data ?? []).map((a, i) => {
            const outstanding = Number(a.outstanding);
            const isMe = a.director_id === director?.id;

            return (
              <Link
                key={a.director_id}
                href={{ pathname: '/director/[id]', params: { id: a.director_id } }}
                asChild
              >
                <Pressable>
                  <View style={[s.accRow, i > 0 && s.catRowDivided]}>
                    <View style={s.accMain}>
                      <Text style={s.accName}>
                        {nameOf(a.director_id)}
                        {isMe ? <Text style={s.you}>  YOU</Text> : null}
                      </Text>
                      <Text style={s.accMeta}>
                        {money(a.total_accounted)} accounted of {money(a.total_disbursed)} ·{' '}
                        {a.advance_count} advance{Number(a.advance_count) === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <View style={s.accRight}>
                      <Money
                        amount={outstanding}
                        tone={outstanding > 0 ? 'warning' : 'positive'}
                        size="large"
                      />
                      <Pill
                        label={outstanding > 0 ? 'outstanding' : 'clear'}
                        tone={outstanding > 0 ? 'warning' : 'positive'}
                      />
                    </View>
                  </View>
                </Pressable>
              </Link>
            );
          })}
        </Card>
      )}

      <View style={{ height: space.xxl }} />
    </ScrollView>
  );
}

function Stat({
  label,
  amount,
  tone,
}: {
  label: string;
  amount: number;
  tone?: 'warning' | 'positive';
}) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label.toUpperCase()}</Text>
      <Money amount={amount} tone={tone ?? 'neutral'} size="body" align="left" />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  content: { padding: space.lg, paddingTop: space.lg },

  periodRow: { flexDirection: 'row', gap: space.sm, marginTop: space.lg, flexWrap: 'wrap' },
  period: {
    ...type.caption,
    color: color.inkMuted,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunken,
    overflow: 'hidden',
  },
  periodActive: { backgroundColor: color.ink, color: '#fff', fontWeight: '600' },

  hero: { marginTop: space.lg },
  heroLabel: { ...type.micro, color: color.inkMuted, marginBottom: space.xs },
  heroGrid: {
    flexDirection: 'row',
    marginTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space.lg,
    gap: space.md,
  },
  stat: { flex: 1 },
  statLabel: { ...type.micro, color: color.inkFaint, marginBottom: space.xs },
  heroNote: { ...type.caption, color: color.inkMuted, marginTop: space.lg, lineHeight: 17 },

  actions: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  actionBtn: { flex: 1 },

  tableCard: { paddingVertical: space.sm },

  catRow: { paddingVertical: space.md },
  catRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  catHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  catName: { ...type.body, color: color.ink, fontWeight: '500', flex: 1 },
  bar: {
    height: 5,
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.pill,
    marginTop: space.sm,
    overflow: 'hidden',
  },
  barFill: { height: 5, backgroundColor: color.accent, borderRadius: radius.pill },
  catFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs + 2 },
  catMeta: { ...type.caption, color: color.inkMuted },
  catFlag: { ...type.caption, color: color.warning, fontWeight: '600' },

  accRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.md, gap: space.md },
  accMain: { flex: 1 },
  accName: { ...type.body, color: color.ink, fontWeight: '500' },
  you: { ...type.micro, color: color.accent },
  accMeta: { ...type.caption, color: color.inkMuted, marginTop: 2 },
  accRight: { alignItems: 'flex-end', gap: space.xs },
});
