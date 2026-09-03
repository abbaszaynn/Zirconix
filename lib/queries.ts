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

/**
 * Budget lines, optionally scoped to one period.
 *
 * Called without a period by the dashboard, which shows a running position
 * across every month rather than resetting at each month boundary — the bug
 * that made September's available balance read as all-time deposits minus only
 * September's disbursements.
 */
export function useBudgetSummary(entityId: string | undefined, period?: string | null) {
  return useQuery({
    queryKey: qk.budget(entityId ?? '', period ?? '__all__'),
    enabled: !!entityId,
    queryFn: async (): Promise<BudgetSummaryRow[]> => {
      let q = supabase
        .from('v_budget_summary')
        .select('*')
        .eq('entity_id', entityId!)
        .order('category');

      if (period) q = q.eq('period', period);

      const { data, error } = await q;
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
  attachments: { id: string; storage_path: string; kind: string }[] | null;
};

export type MyExpenditureRow = Expenditure & {
  attachments: { id: string; storage_path: string; kind: string }[] | null;
};

export function useExpenditures(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.expenditures(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<ExpenditureRow[]> => {
      const { data, error } = await supabase
        .from('expenditures')
        .select('*, disbursements(to_director_id), attachments(id, storage_path, kind)')
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
    queryFn: async (): Promise<MyExpenditureRow[]> => {
      const { data, error } = await supabase
        .from('expenditures')
        .select('*, attachments(id, storage_path, kind)')
        .eq('entity_id', entityId!)
        .eq('entered_by', directorId!)
        .order('spent_on', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as MyExpenditureRow[];
    },
  });
}

export function useExpenditure(id: string | null) {
  return useQuery({
    queryKey: ['expenditure', id],
    enabled: !!id,
    queryFn: async (): Promise<MyExpenditureRow> => {
      const { data, error } = await supabase
        .from('expenditures')
        .select('*, attachments(id, storage_path, kind)')
        .eq('id', id!)
        .single();
      if (error) throw error;
      return data as MyExpenditureRow;
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

/**
 * Transfers that still need the board's attention.
 *
 * That is not the same as "pending" any more: a transfer can be confirmed by
 * majority and still carry an objection nobody has resolved. Both belong on
 * the approvals screen, so this asks for either.
 */
export function useTransferVotes(entityId: string | undefined, onlyOpen = true) {
  return useQuery({
    queryKey: [...qk.votes(entityId ?? ''), onlyOpen],
    enabled: !!entityId,
    queryFn: async (): Promise<TransferVoteRow[]> => {
      let q = supabase
        .from('v_transfer_votes')
        .select('*')
        .eq('entity_id', entityId!)
        .order('amount', { ascending: false });

      if (onlyOpen) q = q.or('status.eq.pending_approval,under_review.is.true');

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
  /** 'YYYY-MM'. Bounds the log to one calendar month, for a monthly audit. */
  month?: string;
}) {
  return useQuery({
    queryKey: [...qk.audit(entityId ?? ''), filters?.actorId, filters?.table, filters?.month],
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

      if (filters?.month) {
        const [y, m] = filters.month.split('-').map(Number);
        // Half-open [start of month, start of next month) so the boundary
        // instant belongs to exactly one month.
        const start = new Date(Date.UTC(y, m - 1, 1));
        const end = new Date(Date.UTC(y, m, 1));
        q = q.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
      }

      const { data, error } = await q;
      if (error) throw error;
      return data as AuditEvent[];
    },
  });
}

/** The months that actually have audit entries, newest first, as 'YYYY-MM'. */
export function useAuditMonths(entityId: string | undefined) {
  return useQuery({
    queryKey: ['auditMonths', entityId],
    enabled: !!entityId,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('audit_events')
        .select('created_at')
        .eq('entity_id', entityId!)
        .order('id', { ascending: false })
        .limit(2000);
      if (error) throw error;

      const months = new Set<string>();
      for (const row of data ?? []) {
        months.add(String(row.created_at).slice(0, 7));
      }
      return [...months].sort().reverse();
    },
    staleTime: 5 * 60 * 1000,
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

export type ProofAttachment = {
  storage_path: string;
  kind: string;
  mime_type: string;
  byte_size?: number;
};

export type NewDisbursement = {
  entityId: string;
  category: string;
  fromAccountId: string;
  toDirectorId: string;
  amount: number;
  method: DisbursementMethod;
  disbursedToRef: string;
  disbursedOn: string;
  note?: string;
  /** Required — the database refuses a transfer with no proof of payment. */
  attachments: ProofAttachment[];
};

export function useRecordDisbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewDisbursement): Promise<Disbursement> => {
      const { data, error } = await supabase
        .rpc('record_disbursement_auto_budget', {
          p_entity_id: input.entityId,
          p_category: input.category,
          p_from_account_id: input.fromAccountId,
          p_to_director_id: input.toDirectorId,
          p_amount: input.amount,
          p_method: input.method,
          p_disbursed_to_ref: input.disbursedToRef,
          p_disbursed_on: input.disbursedOn,
          p_note: input.note ?? null,
          // Ignored by the RPC, which stamps recorded_by from
          // current_director_id() itself — the client cannot record a transfer
          // as somebody else. Still passed because the signature requires it.
          p_recorded_by: input.toDirectorId,
          p_attachments: input.attachments,
        })
        .single();
      if (error) throw error;
      return data as unknown as Disbursement;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export type NewExpenditure = {
  /** Whose pool of advances this draws down — normally the caller's own. */
  directorId: string;
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

/**
 * Charges an expenditure against a director's total pool of advances, not one
 * named transfer. Several disbursements to the same director are still
 * separate voted, audited rows underneath — log_expenditure() picks one as
 * the bookkeeping anchor — but the amount a director can spend, and the cap
 * that stops him overspending, is the sum of everything confirmed and live.
 */
export function useLogExpenditure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewExpenditure): Promise<Expenditure> => {
      const { data, error } = await supabase.rpc('log_expenditure', {
        p_director_id: input.directorId,
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

/**
 * Deletion goes through delete_own_expenditure(), not a raw table `.delete()`.
 *
 * `authenticated` has no DELETE grant on `expenditures` at all — table-level
 * grants are checked before RLS even runs, so a direct `.from('expenditures')
 * .delete()` was always going to fail, silently or otherwise, no matter who
 * asked. The RPC is SECURITY DEFINER: it runs as its own owner, so it isn't
 * subject to that grant, and it does its own ownership check first — a
 * director can delete an entry he logged himself, and nothing else. The
 * database is the one place this rule lives; if it's ever loosened (e.g. to
 * let a finance officer delete on someone's behalf), it changes there, not
 * by adding a table grant that would reopen this for everyone.
 */
export function useDeleteExpenditure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.rpc('delete_own_expenditure', {
        p_expenditure_id: id,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export type UpdateExpenditureInput = {
  id: string;
  amount: number;
  category: string;
  payee: string;
  note?: string;
  disbursementId: string;
};

export function useUpdateExpenditure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateExpenditureInput): Promise<void> => {
      const { error } = await supabase
        .from('expenditures')
        .update({
          amount: input.amount,
          category: input.category,
          payee: input.payee,
          note: input.note ?? null,
          disbursement_id: input.disbursementId,
        })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

export type ReplaceReceiptInput = {
  entityId: string;
  expenditureId: string;
  oldAttachmentId: string;
  newReceipt: {
    storage_path: string;
    kind: string;
    mime_type: string;
    byte_size?: number;
  };
  directorId: string;
};

export function useReplaceReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReplaceReceiptInput): Promise<void> => {
      // Insert new attachment
      const { error: insertError } = await supabase.from('attachments').insert({
        entity_id: input.entityId,
        expenditure_id: input.expenditureId,
        kind: input.newReceipt.kind,
        storage_path: input.newReceipt.storage_path,
        mime_type: input.newReceipt.mime_type,
        byte_size: input.newReceipt.byte_size ?? null,
        uploaded_by: input.directorId,
      });
      if (insertError) throw insertError;

      // Delete old attachment
      const { error: deleteError } = await supabase
        .from('attachments')
        .delete()
        .eq('id', input.oldAttachmentId);
      if (deleteError) throw deleteError;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

/**
 * Voids a transfer that should never have been recorded — a duplicate, a typo,
 * an entry against the wrong director.
 *
 * Deliberately not the same as rejecting it. A rejection is a decision the
 * board made about real money; a void says the row is not a movement of money
 * at all. The database refuses to void an advance that already has spending
 * logged against it, and refuses to un-void anything.
 */
export function useVoidDisbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { disbursementId: string; reason: string }) => {
      const { data, error } = await supabase.rpc('void_disbursement', {
        p_disbursement_id: input.disbursementId,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as Disbursement;
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
    // Without this the bell's unread badge and the list's "unread" styling
    // stayed stale until something else happened to refetch — marking as read
    // looked like it silently didn't work.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
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
  /** Required — the database refuses incoming funds with no slip or confirmation. */
  attachments: ProofAttachment[];
};

/**
 * Goes through record_deposit() rather than inserting into the table.
 *
 * The deposit and its proof have to land in one transaction: a deferred
 * constraint trigger checks at COMMIT that a proof exists, so a bare table
 * insert can no longer succeed on its own.
 */
export function useCreateDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: NewDeposit): Promise<AccountDeposit> => {
      const { data, error } = await supabase.rpc('record_deposit', {
        p_entity_id: input.entityId,
        p_to_account_id: input.toAccountId,
        p_amount: input.amount,
        p_source_type: input.sourceType,
        p_source_director_id: input.sourceDirectorId ?? null,
        p_source_investor_name: input.sourceInvestorName ?? null,
        p_deposit_date: input.depositDate,
        p_attachments: input.attachments,
      });
      if (error) throw error;
      return data as AccountDeposit;
    },
    onSuccess: () => invalidateAll(qc),
  });
}
