import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from './supabase';
import type {
  Account,
  Approval,
  ApprovalDecision,
  BudgetSummaryRow,
  Director,
  Disbursement,
  DisbursementBalanceRow,
  DirectorAccountabilityRow,
  Expenditure,
  AuditEvent,
  DisbursementMethod,
  Notification,
  TransferVoteRow,
  AccountDeposit,
  DepositSource,
} from './database.types';

export const qk = {
  budget: (entityId: string, period: string) => ['budget', entityId, period] as const,
  accountability: (entityId: string) => ['accountability', entityId] as const,
  directors: () => ['directors'] as const,
  accounts: (entityId: string) => ['accounts', entityId] as const,
  expenditures: (entityId: string) => ['expenditures', entityId] as const,
  disbursements: (entityId: string) => ['disbursements', entityId] as const,
  myAdvances: (entityId: string, directorId: string) =>
    ['advances', entityId, directorId] as const,
  votes: (entityId: string) => ['votes', entityId] as const,
  notifications: (directorId: string) => ['notifications', directorId] as const,
  audit: (entityId: string) => ['audit', entityId] as const,
  chain: () => ['chain'] as const,
  periods: (entityId: string) => ['periods', entityId] as const,
};

/** Every query root that any write can invalidate. */
const LIVE_ROOTS = [
  'budget',
  'accountability',
  'expenditures',
  'disbursements',
  'advances',
  'votes',
  'myVotes',
  'approvalHistory',
  'notifications',
  'audit',
  'chain',
  'deposits',
] as const;

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  LIVE_ROOTS.forEach((root) => qc.invalidateQueries({ queryKey: [root] }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Realtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keeps every director's dashboard current without a refresh.
 *
 * Postgres publishes the change, Realtime forwards it (subject to the same RLS
 * the director reads under), and we invalidate rather than patch the cache —
 * the interesting numbers are all aggregates from views, so a refetch is both
 * simpler and more likely to be right than trying to apply a row delta to them.
 */
export function useRealtimeSync(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const channel = supabase
      .channel(`zirconix-live-${Math.random()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'disbursements' }, () =>
        invalidateAll(qc),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenditures' }, () =>
        invalidateAll(qc),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals' }, () =>
        invalidateAll(qc),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'budget_lines' }, () =>
        invalidateAll(qc),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'account_deposits' }, () =>
        invalidateAll(qc),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () =>
        qc.invalidateQueries({ queryKey: ['notifications'] }),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, qc]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export function useDirectors() {
  return useQuery({
    queryKey: qk.directors(),
    queryFn: async (): Promise<Director[]> => {
      const { data, error } = await supabase.from('directors').select('*').eq('is_active', true).order('full_name');
      if (error) throw error;
      return data as Director[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** The company accounts a transfer can be paid out of. */
export function useAccounts(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.accounts(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<Account[]> => {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('entity_id', entityId!)
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data as Account[];
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function usePeriods(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.periods(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('budget_lines')
        .select('period')
        .eq('entity_id', entityId!);
      if (error) throw error;
      return [...new Set((data ?? []).map((r) => r.period as string))].sort().reverse();
    },
  });
}

export function useBudgetSummary(entityId: string | undefined, period: string | undefined) {
  return useQuery({
    queryKey: qk.budget(entityId ?? '', period ?? ''),
    enabled: !!entityId && !!period,
    queryFn: async (): Promise<BudgetSummaryRow[]> => {
      const { data, error } = await supabase
        .from('v_budget_summary')
        .select('*')
        .eq('entity_id', entityId!)
        .eq('period', period!)
        .order('category');
      if (error) throw error;
      return data as BudgetSummaryRow[];
    },
  });
}

export function useAccountability(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.accountability(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<DirectorAccountabilityRow[]> => {
      const { data, error } = await supabase
        .from('v_director_accountability')
        .select('*')
        .eq('entity_id', entityId!);
      if (error) throw error;
      return data as DirectorAccountabilityRow[];
    },
  });
}

/** The advances this director still has to account for — the expenditure form's source list. */
export function useMyAdvances(entityId: string | undefined, directorId: string | undefined) {
  return useQuery({
    queryKey: qk.myAdvances(entityId ?? '', directorId ?? ''),
    enabled: !!entityId && !!directorId,
    queryFn: async (): Promise<DisbursementBalanceRow[]> => {
      const { data, error } = await supabase
        .from('v_disbursement_balance')
        .select('*')
        .eq('entity_id', entityId!)
        .eq('to_director_id', directorId!)
        .in('status', ['confirmed', 'auto_confirmed'])
        .order('disbursed_on', { ascending: false });
      if (error) throw error;
      return data as DisbursementBalanceRow[];
    },
  });
}

export type ExpenditureRow = Expenditure & {
  disbursements: { to_director_id: string } | null;
};

export function useExpenditures(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.expenditures(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<ExpenditureRow[]> => {
      const { data, error } = await supabase
        .from('expenditures')
        .select('*, disbursements(to_director_id)')
        .eq('entity_id', entityId!)
        .order('spent_on', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as ExpenditureRow[];
    },
  });
}

/** Only this director's own spending — what the expenditure page lists. */
export function useMyExpenditures(entityId: string | undefined, directorId: string | undefined) {
  return useQuery({
    queryKey: [...qk.expenditures(entityId ?? ''), 'mine', directorId],
    enabled: !!entityId && !!directorId,
    queryFn: async (): Promise<Expenditure[]> => {
      const { data, error } = await supabase
        .from('expenditures')
        .select('*')
        .eq('entity_id', entityId!)
        .eq('entered_by', directorId!)
        .order('spent_on', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as Expenditure[];
    },
  });
}

export function useDisbursements(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.disbursements(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<Disbursement[]> => {
      const { data, error } = await supabase
        .from('disbursements')
        .select('*')
        .eq('entity_id', entityId!)
        .order('disbursed_on', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as Disbursement[];
    },
  });
}

/** Transfers awaiting a vote, with who has already voted and in what capacity. */
export function useTransferVotes(entityId: string | undefined, onlyPending = true) {
  return useQuery({
    queryKey: [...qk.votes(entityId ?? ''), onlyPending],
    enabled: !!entityId,
    queryFn: async (): Promise<TransferVoteRow[]> => {
      let q = supabase
        .from('v_transfer_votes')
        .select('*')
        .eq('entity_id', entityId!)
        .order('amount', { ascending: false });

      if (onlyPending) q = q.eq('status', 'pending_approval');

      const { data, error } = await q;
      if (error) throw error;
      return data as TransferVoteRow[];
    },
  });
}

/**
 * Which transfers this director has already voted on.
 *
 * v_transfer_votes reports who voted in each ROLE, which is what the board needs
 * to see, but not "have I voted" — for an independent it cannot, since the view
 * only counts them. A director must never be shown a live Approve button for a
 * transfer he has already decided.
 */
export function useMyVotes(entityId: string | undefined, directorId: string | undefined) {
  return useQuery({
    queryKey: ['myVotes', entityId, directorId],
    enabled: !!entityId && !!directorId,
    queryFn: async (): Promise<Record<string, ApprovalDecision>> => {
      const { data, error } = await supabase
        .from('approvals')
        .select('disbursement_id, decision')
        .eq('entity_id', entityId!)
        .eq('approver_id', directorId!);
      if (error) throw error;

      const map: Record<string, ApprovalDecision> = {};
      for (const row of data ?? []) {
        if (row.disbursement_id) {
          map[row.disbursement_id as string] = row.decision as ApprovalDecision;
        }
      }
      return map;
    },
  });
}

export function useNotifications(directorId: string | undefined) {
  return useQuery({
    queryKey: qk.notifications(directorId ?? ''),
    enabled: !!directorId,
    queryFn: async (): Promise<Notification[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as Notification[];
    },
  });
}

export function useAuditEvents(entityId: string | undefined, filters?: {
  actorId?: string;
  table?: string;
}) {
  return useQuery({
    queryKey: [...qk.audit(entityId ?? ''), filters?.actorId, filters?.table],
    enabled: !!entityId,
    queryFn: async (): Promise<AuditEvent[]> => {
      let q = supabase
        .from('audit_events')
        .select('*')
        .eq('entity_id', entityId!)
        .order('id', { ascending: false })
        .limit(500);

      if (filters?.actorId) q = q.eq('actor_id', filters.actorId);
      if (filters?.table) q = q.eq('table_name', filters.table);

      const { data, error } = await q;
      if (error) throw error;
      return data as AuditEvent[];
    },
  });
}

export function useChainIntegrity() {
  return useQuery({
    queryKey: qk.chain(),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('verify_audit_chain', { p_from: 0 });
      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as {
        ok: boolean;
        checked: number;
        first_bad_id: number | null;
      };
    },
    staleTime: 60 * 1000,
  });
}

export function useApprovalHistory(entityId: string | undefined) {
  return useQuery({
    queryKey: ['approvalHistory', entityId],
    enabled: !!entityId,
    queryFn: async (): Promise<Approval[]> => {
      const { data, error } = await supabase
        .from('approvals')
        .select('*')
        .eq('entity_id', entityId!)
        .order('decided_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as Approval[];
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export type NewDisbursement = {
  entityId: string;
  budgetLineId: string;
  fromAccountId: string;
  toDirectorId: string;
  amount: number;
  method: DisbursementMethod;
  disbursedToRef: string;
  disbursedOn: string;
  note?: string;
};

export function useRecordDisbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewDisbursement): Promise<Disbursement> => {
      // recorded_by, status and required_votes are all set by database triggers;
      // anything sent for them is overwritten. recorded_by is included only to
      // satisfy NOT NULL before the trigger replaces it.
      const { data, error } = await supabase
        .from('disbursements')
        .insert({
          entity_id: input.entityId,
          budget_line_id: input.budgetLineId,
          from_account_id: input.fromAccountId,
          to_director_id: input.toDirectorId,
          amount: input.amount,
          method: input.method,
          disbursed_to_ref: input.disbursedToRef,
          disbursed_on: input.disbursedOn,
          note: input.note ?? null,
          recorded_by: input.toDirectorId,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Disbursement;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export type NewExpenditure = {
  disbursementId: string;
  amount: number;
  category: string;
  payee: string;
  spentOn: string;
  note?: string;
  attachments: {
    storage_path: string;
    kind: string;
    mime_type: string;
    byte_size?: number;
  }[];
};

export function useLogExpenditure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewExpenditure): Promise<Expenditure> => {
      const { data, error } = await supabase.rpc('log_expenditure', {
        p_disbursement_id: input.disbursementId,
        p_amount: input.amount,
        p_category: input.category,
        p_payee: input.payee,
        p_spent_on: input.spentOn,
        p_attachments: input.attachments,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return data as Expenditure;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/** One director's vote on one transfer. The database tallies and decides. */
export function useCastVote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      disbursementId: string;
      decision: ApprovalDecision;
      reason?: string;
    }): Promise<Disbursement> => {
      const { data, error } = await supabase.rpc('cast_disbursement_vote', {
        p_disbursement_id: input.disbursementId,
        p_decision: input.decision,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data as Disbursement;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', ids);
      if (error) throw error;
    },
  });
}

export type AccountDepositRow = AccountDeposit & {
  accounts: { name: string } | null;
  directors: { full_name: string } | null;
  recorded_by_director: { full_name: string } | null;
};

export function useDeposits(entityId: string | undefined) {
  return useQuery({
    queryKey: ['deposits', entityId ?? ''],
    enabled: !!entityId,
    queryFn: async (): Promise<AccountDepositRow[]> => {
      const { data, error } = await supabase
        .from('account_deposits')
        .select(`
          *,
          accounts ( name ),
          directors!account_deposits_source_director_id_fkey ( full_name ),
          recorded_by_director:directors!account_deposits_recorded_by_fkey ( full_name )
        `)
        .eq('entity_id', entityId!)
        .order('deposit_date', { ascending: false });
      if (error) throw error;
      return data as unknown as AccountDepositRow[];
    },
  });
}

export type NewDeposit = {
  entityId: string;
  toAccountId: string;
  amount: number;
  sourceType: DepositSource;
  sourceDirectorId?: string | null;
  sourceInvestorName?: string | null;
  depositDate: string;
  recordedBy: string;
};

export function useCreateDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewDeposit): Promise<AccountDeposit> => {
      const { data, error } = await supabase
        .from('account_deposits')
        .insert({
          entity_id: input.entityId,
          to_account_id: input.toAccountId,
          amount: input.amount,
          source_type: input.sourceType,
          source_director_id: input.sourceDirectorId ?? null,
          source_investor_name: input.sourceInvestorName ?? null,
          deposit_date: input.depositDate,
          recorded_by: input.recordedBy,
        })
        .select()
        .single();
      if (error) throw error;
      return data as AccountDeposit;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }),
  });
}
