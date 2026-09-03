/**
 * Generated from the live schema. Regenerate after any migration with:
 *   npx supabase gen types typescript --project-id vcoagdrbqsxshczvnwrp > lib/database.types.ts
 *
 * Note on `number`: Postgres numeric(18,2) arrives over PostgREST as a JSON
 * number. For PKR amounts in the low millions that is exactly representable in a
 * double, so arithmetic in the app is safe. Do not extend this to a currency
 * where totals could exceed 2^53 minor units without switching to strings.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type DirectorRole = 'director' | 'finance_officer' | 'auditor';
export type DisbursementMethod = 'bank_transfer' | 'cash';
export type EntryStatus =
  | 'auto_confirmed'
  | 'pending_approval'
  | 'confirmed'
  | 'rejected';
export type ApprovalDecision = 'approved' | 'rejected';
export type VoterRole = 'sender' | 'recipient' | 'independent';
export type NotificationKind =
  | 'vote_required'
  | 'vote_cast'
  | 'transfer_confirmed'
  | 'transfer_rejected'
  | 'expenditure_logged';
export type AttachmentKind =
  | 'receipt_photo'
  | 'receipt_pdf'
  | 'payment_confirmation'
  | 'transfer_proof';
export type DepositSource = 'director' | 'investor';

export interface Entity {
  id: string;
  tenant_id: string | null;
  name: string;
  legal_name: string;
  created_at: string;
}

export interface Director {
  id: string;
  auth_user_id: string | null;
  full_name: string;
  email: string;
  role: DirectorRole;
  is_active: boolean;
  expo_push_token: string | null;
  created_at: string;
}

/**
 * A company source account. Durr Mines and Zircon Mines are rows here — they are
 * no longer separate entities, so a transfer records which one paid.
 */
export interface Account {
  id: string;
  entity_id: string;
  name: string;
  kind: 'bank' | 'cash_box';
  /** Masked tail only, e.g. 'HBL ****4471'. */
  bank_label: string | null;
  is_active: boolean;
  created_at: string;
}

export interface AccountDeposit {
  id: string;
  entity_id: string;
  to_account_id: string;
  amount: number;
  source_type: DepositSource;
  source_director_id: string | null;
  source_investor_name: string | null;
  recorded_by: string;
  deposit_date: string;
  created_at: string;
}

export interface Notification {
  id: string;
  entity_id: string;
  director_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  disbursement_id: string | null;
  expenditure_id: string | null;
  read_at: string | null;
  pushed_at: string | null;
  created_at: string;
}

export interface BudgetLine {
  id: string;
  entity_id: string;
  owner_director_id: string;
  period: string;
  project: string | null;
  category: string;
  allocated_amount: number;
  created_by: string;
  created_at: string;
}

export interface Disbursement {
  id: string;
  entity_id: string;
  budget_line_id: string;
  /** Which company account the money left from. */
  from_account_id: string;
  to_director_id: string;
  amount: number;
  method: DisbursementMethod;
  disbursed_to_ref: string;
  disbursed_on: string;
  note: string | null;
  status: EntryStatus;
  /** Majority needed to settle: this many approvals confirms, this many rejections rejects. */
  required_votes: number;
  approval_count: number;
  rejection_count: number;
  /** At least one objection outstanding. Independent of status. */
  under_review: boolean;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export interface Expenditure {
  id: string;
  entity_id: string;
  disbursement_id: string;
  amount: number;
  category: string;
  payee: string;
  note: string | null;
  spent_on: string;
  status: EntryStatus;
  receipt_count: number;
  entered_by: string;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  entity_id: string;
  expenditure_id: string | null;
  disbursement_id: string | null;
  kind: AttachmentKind;
  storage_path: string;
  mime_type: string;
  byte_size: number | null;
  sha256: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface Approval {
  id: string;
  entity_id: string;
  expenditure_id: string | null;
  disbursement_id: string | null;
  submitted_by: string;
  approver_id: string;
  decision: ApprovalDecision;
  reason: string | null;
  /** Why this director was entitled to vote. Display only — the tally uses ids. */
  voter_role: VoterRole | null;
  decided_at: string;
  created_at: string;
}

export interface AuditEvent {
  id: number;
  entity_id: string | null;
  actor_id: string | null;
  action: 'insert' | 'update' | 'delete';
  table_name: string;
  record_id: string | null;
  before: Json | null;
  after: Json | null;
  created_at: string;
  prev_hash: string;
  hash: string;
}

export interface BudgetSummaryRow {
  budget_line_id: string;
  entity_id: string;
  period: string;
  project: string | null;
  category: string;
  owner_director_id: string;
  allocated_amount: number;
  disbursed_amount: number;
  spent_amount: number;
  undisbursed_amount: number;
  /** Money that left the company but is not yet explained by a receipted expenditure. */
  unaccounted_amount: number;
  available_amount: number;
}

export interface DirectorAccountabilityRow {
  entity_id: string;
  director_id: string;
  advance_count: number;
  total_disbursed: number;
  total_accounted: number;
  claimed_without_receipt: number;
  /** total_disbursed − total_accounted. Non-zero is a flag, not an error. */
  outstanding: number;
}

export interface TransferObjection {
  name: string;
  reason: string | null;
  at: string;
}

/**
 * Vote progress for a transfer, joined to the names a director needs to see.
 *
 * Majority rules: `approval_count` reaching `required_votes` confirms it,
 * `rejection_count` reaching it rejects it. `under_review` is independent of
 * status — a confirmed transfer someone has since objected to stays confirmed
 * and spendable, but carries the flag until the board resolves it.
 */
export interface TransferVoteRow {
  disbursement_id: string;
  entity_id: string;
  amount: number;
  status: EntryStatus;
  under_review: boolean;
  required_votes: number;
  approval_count: number;
  rejection_count: number;
  method: DisbursementMethod;
  disbursed_on: string;
  note: string | null;
  from_account_id: string;
  account_name: string;
  to_director_id: string;
  recipient_name: string;
  recorded_by: string;
  sender_name: string;
  category: string;
  period: string;
  objections: TransferObjection[] | null;
}

export interface DisbursementBalanceRow {
  disbursement_id: string;
  entity_id: string;
  budget_line_id: string;
  to_director_id: string;
  advanced: number;
  method: DisbursementMethod;
  disbursed_on: string;
  status: EntryStatus;
  spent: number;
  remaining: number;
}
