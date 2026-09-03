import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { money } from './format';
import type { Account, AuditEvent, BudgetSummaryRow, Director } from './database.types';

/**
 * A printable audit report.
 *
 * This is the artefact that leaves the app and goes to an accountant, a bank,
 * or a court, so it is built to stand on its own: it states what it covers,
 * who produced it, whether the hash chain verified at the moment of printing
 * (a tamper-evident log is worthless in print unless the print says whether
 * the evidence held), and — per event — every field of the record, not a
 * one-line summary. Foreign keys (which director, which account, which
 * budget line) are resolved to names rather than left as UUIDs, wherever a
 * name is available.
 */

type ChainStatus = { ok: boolean; checked: number; first_bad_id: number | null };

export type AuditReportInput = {
  entityName: string;
  entityLegalName: string;
  events: AuditEvent[];
  directors: Director[];
  accounts: Account[];
  budgetLines: BudgetSummaryRow[];
  chain: ChainStatus | undefined;
  generatedBy: string;
  filterNote?: string;
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-PK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('en-PK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

const TABLE_LABEL: Record<string, string> = {
  disbursements: 'Transfer',
  expenditures: 'Expenditure',
  approvals: 'Vote',
  attachments: 'Receipt',
  budget_lines: 'Budget line',
  directors: 'Director',
  director_entities: 'Board membership',
  entities: 'Entity',
  accounts: 'Account',
  account_deposits: 'Incoming funds',
  statement_imports: 'Statement import',
};

// ─────────────────────────────────────────────────────────────────────────────
// Field resolution — turns a raw row (from to_jsonb(OLD)/to_jsonb(NEW)) into a
// labelled, human-readable list. Every table has its own set of columns that
// actually matter to a reader; id/entity_id/created_at/updated_at are skipped
// everywhere since they are already in the event's own header line.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Ctx = { directorName: (id: unknown) => string; accountName: (id: unknown) => string; budgetLineName: (id: unknown) => string };

function fmtBool(v: unknown): string {
  return v ? 'Yes' : 'No';
}
function fmtLabel(v: unknown): string {
  return String(v ?? '').replace(/_/g, ' ');
}
function fmtMoney(v: unknown): string {
  return money(Number(v));
}
function fmtDate(v: unknown): string {
  return v ? dateOnly(String(v)) : '—';
}
function fmtDateTime(v: unknown): string {
  return v ? stamp(String(v)) : '—';
}
function fmtKB(v: unknown): string {
  return v == null ? '—' : `${Math.round(Number(v) / 1024)} KB`;
}
function fmtRaw(v: unknown): string {
  return v == null || v === '' ? '—' : String(v);
}

type FieldSpec = { key: string; label: string; format: (v: unknown, ctx: Ctx) => string };

const F = {
  amount: { key: 'amount', label: 'Amount', format: fmtMoney },
  method: { key: 'method', label: 'Method', format: fmtLabel },
  fromAccount: { key: 'from_account_id', label: 'From account', format: (v: unknown, c: Ctx) => c.accountName(v) },
  toAccount: { key: 'to_account_id', label: 'To account', format: (v: unknown, c: Ctx) => c.accountName(v) },
  toDirector: { key: 'to_director_id', label: 'To director', format: (v: unknown, c: Ctx) => c.directorName(v) },
  budgetLine: { key: 'budget_line_id', label: 'Budget line', format: (v: unknown, c: Ctx) => c.budgetLineName(v) },
  disbursedRef: { key: 'disbursed_to_ref', label: 'Reference', format: fmtRaw },
  disbursedOn: { key: 'disbursed_on', label: 'Date', format: fmtDate },
  note: { key: 'note', label: 'Note', format: fmtRaw },
  status: { key: 'status', label: 'Status', format: fmtLabel },
  requiredVotes: { key: 'required_votes', label: 'Votes required', format: fmtRaw },
  approvalCount: { key: 'approval_count', label: 'Approvals', format: fmtRaw },
  rejectionCount: { key: 'rejection_count', label: 'Rejections', format: fmtRaw },
  underReview: { key: 'under_review', label: 'Under review', format: fmtBool },
  voidedAt: { key: 'voided_at', label: 'Voided at', format: fmtDateTime },
  voidedBy: { key: 'voided_by', label: 'Voided by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  voidReason: { key: 'void_reason', label: 'Void reason', format: fmtRaw },
  recordedBy: { key: 'recorded_by', label: 'Recorded by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  category: { key: 'category', label: 'Category', format: fmtRaw },
  payee: { key: 'payee', label: 'Paid to', format: fmtRaw },
  spentOn: { key: 'spent_on', label: 'Date', format: fmtDate },
  receiptCount: { key: 'receipt_count', label: 'Receipts attached', format: fmtRaw },
  enteredBy: { key: 'entered_by', label: 'Logged by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  disbursementId: { key: 'disbursement_id', label: 'Against transfer', format: (v: unknown) => shortId(v) },
  decision: { key: 'decision', label: 'Decision', format: fmtLabel },
  reason: { key: 'reason', label: 'Reason', format: fmtRaw },
  approverId: { key: 'approver_id', label: 'Voted by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  submittedBy: { key: 'submitted_by', label: 'Original submitter', format: (v: unknown, c: Ctx) => c.directorName(v) },
  voterRole: { key: 'voter_role', label: 'Voting as', format: fmtLabel },
  decidedAt: { key: 'decided_at', label: 'Decided at', format: fmtDateTime },
  kind: { key: 'kind', label: 'Kind', format: fmtLabel },
  mimeType: { key: 'mime_type', label: 'File type', format: fmtRaw },
  byteSize: { key: 'byte_size', label: 'File size', format: fmtKB },
  uploadedBy: { key: 'uploaded_by', label: 'Uploaded by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  storagePath: { key: 'storage_path', label: 'File', format: fmtRaw },
  period: { key: 'period', label: 'Period', format: fmtRaw },
  project: { key: 'project', label: 'Project', format: fmtRaw },
  allocated: { key: 'allocated_amount', label: 'Allocated', format: fmtMoney },
  ownerDirector: { key: 'owner_director_id', label: 'Owner', format: (v: unknown, c: Ctx) => c.directorName(v) },
  createdBy: { key: 'created_by', label: 'Created by', format: (v: unknown, c: Ctx) => c.directorName(v) },
  fullName: { key: 'full_name', label: 'Name', format: fmtRaw },
  email: { key: 'email', label: 'Email', format: fmtRaw },
  role: { key: 'role', label: 'Role', format: fmtLabel },
  isActive: { key: 'is_active', label: 'Active', format: fmtBool },
  name: { key: 'name', label: 'Name', format: fmtRaw },
  legalName: { key: 'legal_name', label: 'Legal name', format: fmtRaw },
  accountKind: { key: 'kind', label: 'Type', format: fmtLabel },
  bankLabel: { key: 'bank_label', label: 'Bank reference', format: fmtRaw },
  sourceType: { key: 'source_type', label: 'Source', format: fmtLabel },
  sourceDirector: { key: 'source_director_id', label: 'From director', format: (v: unknown, c: Ctx) => c.directorName(v) },
  sourceInvestor: { key: 'source_investor_name', label: 'From investor', format: fmtRaw },
  depositDate: { key: 'deposit_date', label: 'Date', format: fmtDate },
} satisfies Record<string, FieldSpec>;

const TABLE_FIELDS: Record<string, FieldSpec[]> = {
  disbursements: [
    F.amount, F.method, F.fromAccount, F.toDirector, F.budgetLine, F.disbursedRef,
    F.disbursedOn, F.note, F.status, F.requiredVotes, F.approvalCount, F.rejectionCount,
    F.underReview, F.voidedAt, F.voidedBy, F.voidReason, F.recordedBy,
  ],
  expenditures: [
    F.amount, F.category, F.payee, F.spentOn, F.note, F.status, F.receiptCount, F.enteredBy, F.disbursementId,
  ],
  approvals: [F.decision, F.reason, F.approverId, F.submittedBy, F.voterRole, F.decidedAt],
  attachments: [F.kind, F.mimeType, F.byteSize, F.storagePath, F.uploadedBy],
  budget_lines: [F.category, F.period, F.project, F.allocated, F.ownerDirector, F.createdBy],
  directors: [F.fullName, F.email, F.role, F.isActive],
  director_entities: [{ key: 'director_id', label: 'Director', format: (v: unknown, c: Ctx) => c.directorName(v) }],
  entities: [F.name, F.legalName],
  accounts: [F.name, F.accountKind, F.bankLabel, F.isActive],
  account_deposits: [F.amount, F.toAccount, F.sourceType, F.sourceDirector, F.sourceInvestor, F.depositDate, F.recordedBy],
};

function shortId(v: unknown): string {
  const s = String(v ?? '');
  return s ? `${s.slice(0, 8)}…` : '—';
}

/**
 * Renders a row's fields as HTML. For an UPDATE, only fields that actually
 * changed are shown, each as "before → after" — the point of a diff is what
 * moved, and repeating every unchanged column would bury it. For an INSERT or
 * DELETE, every field with a value is shown.
 */
function renderFields(specs: FieldSpec[], before: Row | null, after: Row | null, ctx: Ctx): string {
  const isUpdate = before && after;
  const rows: string[] = [];

  for (const spec of specs) {
    const b = before?.[spec.key];
    const a = after?.[spec.key];
    const source = after ?? before;
    if (source?.[spec.key] === undefined) continue;

    if (isUpdate) {
      const changed = JSON.stringify(b) !== JSON.stringify(a);
      if (!changed) continue;
      rows.push(
        `<tr><td class="fk">${esc(spec.label)}</td><td class="fv">${esc(spec.format(b, ctx))} <span class="arrow">→</span> <strong>${esc(spec.format(a, ctx))}</strong></td></tr>`,
      );
    } else {
      const v = after ? a : b;
      if (v === null || v === undefined) continue;
      rows.push(`<tr><td class="fk">${esc(spec.label)}</td><td class="fv">${esc(spec.format(v, ctx))}</td></tr>`);
    }
  }

  if (rows.length === 0) {
    return isUpdate ? '<p class="noChange">No tracked field changed (bookkeeping-only update).</p>' : '';
  }
  return `<table class="fields">${rows.join('')}</table>`;
}

/** One plain sentence up top, for the events that matter most financially. */
function summarySentence(e: AuditEvent, ctx: Ctx): string | null {
  const row = (e.after ?? e.before) as Row | null;
  if (!row) return null;
  const actor = e.actor_id ? ctx.directorName(e.actor_id) : 'The system';

  switch (e.table_name) {
    case 'disbursements':
      if (e.action === 'insert') {
        return `${actor} recorded a transfer of ${money(Number(row.amount))} (${fmtLabel(row.method)}) to ${ctx.directorName(row.to_director_id)}.`;
      }
      if (e.action === 'update' && row.voided_at && !(e.before as Row | null)?.voided_at) {
        return `${actor} voided this transfer: "${fmtRaw(row.void_reason)}"`;
      }
      if (e.action === 'update') {
        return `${actor} updated this transfer's status to ${fmtLabel(row.status)}.`;
      }
      return null;
    case 'expenditures':
      if (e.action === 'insert') {
        return `${actor} logged an expenditure of ${money(Number(row.amount))} to ${fmtRaw(row.payee)} (${fmtRaw(row.category)}).`;
      }
      if (e.action === 'delete') {
        return `${actor} deleted an expenditure of ${money(Number(row.amount))} to ${fmtRaw(row.payee)}, dated ${fmtDate(row.spent_on)}.`;
      }
      return null;
    case 'approvals':
      return `${ctx.directorName(row.approver_id)} ${row.decision === 'rejected' ? 'rejected' : 'approved'} a transfer${row.reason ? `: "${fmtRaw(row.reason)}"` : '.'}`;
    case 'account_deposits':
      if (e.action === 'insert') {
        const source = row.source_type === 'director' ? ctx.directorName(row.source_director_id) : fmtRaw(row.source_investor_name);
        return `${actor} recorded ${money(Number(row.amount))} received from ${source} into ${ctx.accountName(row.to_account_id)}.`;
      }
      return null;
    default:
      return null;
  }
}

export function buildAuditReportHtml(input: AuditReportInput): string {
  const { entityName, entityLegalName, events, directors, accounts, budgetLines, chain, generatedBy } = input;

  const directorMap = new Map(directors.map((d) => [d.id, d.full_name]));
  const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
  const budgetLineMap = new Map(budgetLines.map((b) => [b.budget_line_id, `${b.category} · ${b.period}`]));

  const ctx: Ctx = {
    directorName: (id) => (id ? directorMap.get(String(id)) ?? shortId(id) : '—'),
    accountName: (id) => (id ? accountMap.get(String(id)) ?? shortId(id) : '—'),
    budgetLineName: (id) => (id ? budgetLineMap.get(String(id)) ?? shortId(id) : '—'),
  };

  const printedAt = stamp(new Date().toISOString());
  const range = events.length > 0 ? `#${events[events.length - 1].id} – #${events[0].id}` : 'no events';

  const chainBanner = !chain
    ? `<div class="chain unknown"><strong>Chain not verified.</strong> Integrity could not be checked when this report was produced.</div>`
    : chain.ok
      ? `<div class="chain ok"><strong>Chain verified.</strong> All ${chain.checked} events recomputed from genesis and every hash matched. No record in this log has been altered or removed.</div>`
      : `<div class="chain bad"><strong>CHAIN BROKEN at event #${chain.first_bad_id}.</strong> ${chain.checked} events verified before the break. Every entry from that point on must be treated as unreliable until investigated.</div>`;

  const cards = events
    .map((e) => {
      const specs = TABLE_FIELDS[e.table_name];
      const before = e.before as Row | null;
      const after = e.after as Row | null;
      const sentence = summarySentence(e, ctx);
      const tone = e.action === 'insert' ? 'ins' : e.action === 'delete' ? 'del' : 'upd';

      return `
      <section class="event">
        <div class="eventHead">
          <span class="tag ${tone}">${esc(e.action)}</span>
          <span class="etable">${esc(TABLE_LABEL[e.table_name] ?? e.table_name)}</span>
          <span class="eid">#${e.id}</span>
          <span class="ewhen">${esc(stamp(e.created_at))}</span>
          <span class="eactor">${esc(e.actor_id ? directorMap.get(e.actor_id) ?? 'Unknown director' : 'System')}</span>
        </div>
        ${sentence ? `<p class="sentence">${esc(sentence)}</p>` : ''}
        ${specs ? renderFields(specs, before, after, ctx) : ''}
        <div class="hashes">
          <span>Hash <code>${esc(e.hash)}</code></span>
          <span>Previous <code>${esc(e.prev_hash)}</code></span>
        </div>
      </section>`;
    })
    .join('');

  return `
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0F1B2A; font-size: 9.5pt; margin: 0; }
  header { border-bottom: 2px solid #0F1B2A; padding-bottom: 8pt; margin-bottom: 12pt; }
  .wordmark { font-size: 16pt; font-weight: 700; letter-spacing: 3pt; }
  .legal { color: #5B6B7C; font-size: 8pt; margin-top: 2pt; }
  h1 { font-size: 13pt; margin: 10pt 0 2pt; }
  .facts { display: flex; flex-wrap: wrap; gap: 16pt; margin-top: 6pt; color: #5B6B7C; font-size: 8pt; }
  .facts b { color: #0F1B2A; font-weight: 600; }
  .chain { margin: 10pt 0 14pt; padding: 8pt 10pt; border-radius: 3pt; border-left: 3pt solid; font-size: 8.5pt; }
  .chain.ok      { background: #EAF5EF; border-color: #0F7B4F; }
  .chain.bad     { background: #FBEBEA; border-color: #A3231C; }
  .chain.unknown { background: #FBF3E6; border-color: #9A5B00; }

  .event { border: 1px solid #E4E9EE; border-radius: 4pt; padding: 8pt 10pt; margin-bottom: 8pt; page-break-inside: avoid; }
  .eventHead { display: flex; align-items: center; gap: 8pt; flex-wrap: wrap; font-size: 8pt; }
  .tag { text-transform: uppercase; font-weight: 700; font-size: 7pt; letter-spacing: 0.5pt;
         padding: 2pt 6pt; border-radius: 8pt; }
  .tag.ins { background: #EAF5EF; color: #0F7B4F; }
  .tag.del { background: #FBEBEA; color: #A3231C; }
  .tag.upd { background: #FBF3E6; color: #9A5B00; }
  .etable { font-weight: 600; }
  .eid { color: #9AA6B2; font-variant-numeric: tabular-nums; }
  .ewhen { color: #5B6B7C; font-variant-numeric: tabular-nums; margin-left: auto; }
  .eactor { color: #5B6B7C; }
  .sentence { margin: 6pt 0 4pt; font-size: 9pt; }

  table.fields { width: 100%; border-collapse: collapse; margin-top: 4pt; }
  table.fields td { padding: 2pt 4pt; border-top: 1px solid #F0F3F6; vertical-align: top; font-size: 8.5pt; }
  td.fk { color: #5B6B7C; width: 130pt; white-space: nowrap; }
  td.fv { color: #0F1B2A; }
  .arrow { color: #9AA6B2; }
  .noChange { color: #9AA6B2; font-size: 8pt; font-style: italic; margin: 4pt 0; }

  .hashes { display: flex; gap: 16pt; margin-top: 6pt; font-size: 6.5pt; color: #9AA6B2; flex-wrap: wrap; }
  .hashes code { font-family: "SF Mono", Menlo, Consolas, monospace; word-break: break-all; }

  footer { margin-top: 14pt; padding-top: 6pt; border-top: 1px solid #E4E9EE; color: #5B6B7C; font-size: 7.5pt; }
</style>

<header>
  <div class="wordmark">ZIRCONIX</div>
  <div class="legal">${esc(entityLegalName)}</div>
  <h1>Audit log — ${esc(entityName)}</h1>
  <div class="facts">
    <span><b>Produced</b> ${esc(printedAt)}</span>
    <span><b>By</b> ${esc(generatedBy)}</span>
    <span><b>Events</b> ${events.length} (${esc(range)})</span>
    ${input.filterNote ? `<span><b>Filter</b> ${esc(input.filterNote)}</span>` : ''}
  </div>
</header>

${chainBanner}

${cards || '<p>No events match this filter.</p>'}

<footer>
  Every row is chained to the one before it by SHA-256 over its contents and its predecessor's
  hash, so altering or deleting any entry invalidates every hash after it. For an update, only the
  fields that changed are shown; for a new or deleted record, every recorded field is shown. This
  report reflects the log at the moment of printing.
</footer>`;
}

export async function exportAuditPdf(input: AuditReportInput): Promise<void> {
  const { uri } = await Print.printToFileAsync({
    html: buildAuditReportHtml(input),
    base64: false,
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      dialogTitle: 'Zirconix audit log',
      UTI: 'com.adobe.pdf',
    });
  } else {
    // Desktop web has no share sheet; the print dialog is the export.
    await Print.printAsync({ html: buildAuditReportHtml(input) });
  }
}
