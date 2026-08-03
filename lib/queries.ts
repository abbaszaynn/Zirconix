import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from './supabase';
import type {
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
} from './database.types';

export const qk = {
  budget: (entityId: string, period: string) => ['budget', entityId, period] as const,
  accountability: (entityId: string) => ['accountability', entityId] as const,
  directors: () => ['directors'] as const,
  expenditures: (entityId: string) => ['expenditures', entityId] as const,
  disbursements: (entityId: string) => ['disbursements', entityId] as const,
  myAdvances: (entityId: string, directorId: string) =>
    ['advances', entityId, directorId] as const,
  pending: (entityId: string) => ['pending', entityId] as const,
  audit: (entityId: string) => ['audit', entityId] as const,
  chain: () => ['chain'] as const,
  periods: (entityId: string) => ['periods', entityId] as const,
};

/** Everything an entity-scoped view depends on. Used after any write. */
function invalidateEntity(qc: ReturnType<typeof useQueryClient>, entityId: string) {
  ['budget', 'accountability', 'expenditures', 'disbursements', 'advances', 'pending', 'audit']
    .forEach((root) => qc.invalidateQueries({ queryKey: [root] }));
  void entityId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export function useDirectors() {
  return useQuery({
    queryKey: qk.directors(),
    queryFn: async (): Promise<Director[]> => {
      const { data, error } = await supabase.from('directors').select('*').order('full_name');
      if (error) throw error;
      return data as Director[];
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
        .neq('status', 'rejected')
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

export type PendingItem = {
  kind: 'expenditure' | 'disbursement';
  id: string;
  amount: number;
  label: string;
  submittedBy: string;
  on: string;
  category: string;
};

export function usePendingApprovals(entityId: string | undefined) {
  return useQuery({
    queryKey: qk.pending(entityId ?? ''),
    enabled: !!entityId,
    queryFn: async (): Promise<PendingItem[]> => {
      const [exp, dis] = await Promise.all([
        supabase
          .from('expenditures')
          .select('id, amount, payee, category, spent_on, entered_by')
          .eq('entity_id', entityId!)
          .eq('status', 'pending_approval'),
        supabase
          .from('disbursements')
          .select('id, amount, disbursed_to_ref, method, disbursed_on, recorded_by')
          .eq('entity_id', entityId!)
          .eq('status', 'pending_approval'),
      ]);
      if (exp.error) throw exp.error;
      if (dis.error) throw dis.error;

      const items: PendingItem[] = [
        ...(exp.data ?? []).map((e) => ({
          kind: 'expenditure' as const,
          id: e.id as string,
          amount: Number(e.amount),
          label: e.payee as string,
          submittedBy: e.entered_by as string,
          on: e.spent_on as string,
          category: e.category as string,
        })),
        ...(dis.data ?? []).map((d) => ({
          kind: 'disbursement' as const,
          id: d.id as string,
          amount: Number(d.amount),
          label: d.disbursed_to_ref as string,
          submittedBy: d.recorded_by as string,
          on: d.disbursed_on as string,
          category: d.method === 'cash' ? 'Cash advance' : 'Bank transfer',
        })),
      ];

      return items.sort((a, b) => b.amount - a.amount);
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
        .limit(200);

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
      const row = (Array.isArray(data) ? data[0] : data) as {
        ok: boolean;
        checked: number;
        first_bad_id: number | null;
      };
      return row;
    },
    staleTime: 60 * 1000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

export type NewDisbursement = {
  entityId: string;
  budgetLineId: string;
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
      // recorded_by and status are set by database triggers; anything sent for
      // them is overwritten. They are included only to satisfy NOT NULL.
      const { data, error } = await supabase
        .from('disbursements')
        .insert({
          entity_id: input.entityId,
          budget_line_id: input.budgetLineId,
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
    onSuccess: (d) => invalidateEntity(qc, d.entity_id),
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
    onSuccess: (e) => invalidateEntity(qc, e.entity_id),
  });
}

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      targetType: 'expenditure' | 'disbursement';
      targetId: string;
      decision: ApprovalDecision;
      reason?: string;
    }) => {
      const { data, error } = await supabase.rpc('decide_approval', {
        p_target_type: input.targetType,
        p_target_id: input.targetId,
        p_decision: input.decision,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      ['pending', 'expenditures', 'disbursements', 'budget', 'accountability', 'audit'].forEach(
        (root) => qc.invalidateQueries({ queryKey: [root] }),
      );
    },
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
