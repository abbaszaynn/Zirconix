import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { money } from './format';
import type { AuditEvent, Director } from './database.types';

/**
 * A printable audit report.
 *
 * This is the artefact that leaves the app and goes to an accountant, a bank, or
 * a court, so it is built to stand on its own: it states what it covers, who
 * produced it, and — crucially — whether the hash chain verified at the moment
 * of printing. A tamper-evident log is worthless in print unless the print says
 * whether the evidence held.
 */

type ChainStatus = { ok: boolean; checked: number; first_bad_id: number | null };

export type AuditReportInput = {
  entityName: string;
  entityLegalName: string;
  events: AuditEvent[];
  directors: Director[];
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
  const d = new Date(iso);
  return d.toLocaleString('en-PK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
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
  statement_imports: 'Statement import',
};

/**
 * Pulls the few fields a reader actually needs out of the row snapshot. The full
 * before/after JSON is deliberately not printed — it would run to hundreds of
 * pages and bury the entries that matter.
 */
function summarise(e: AuditEvent): string {
  const row = (e.after ?? e.before) as Record<string, unknown> | null;
  if (!row) return '—';

  const bits: string[] = [];
  if (typeof row.amount === 'number' || typeof row.amount === 'string') {
    bits.push(money(Number(row.amount)));
  }
  if (row.category) bits.push(String(row.category));
  if (row.payee) bits.push(String(row.payee));
  if (row.status) bits.push(String(row.status).replace(/_/g, ' '));
  if (row.decision) bits.push(String(row.decision));
  if (row.name) bits.push(String(row.name));
  if (row.full_name) bits.push(String(row.full_name));
  if (row.method) bits.push(String(row.method).replace(/_/g, ' '));

  return bits.length ? bits.join(' · ') : '—';
}

export function buildAuditReportHtml(input: AuditReportInput): string {
  const { entityName, entityLegalName, events, directors, chain, generatedBy } = input;

  const nameOf = new Map(directors.map((d) => [d.id, d.full_name]));
  const printedAt = stamp(new Date().toISOString());

  const range =
    events.length > 0
      ? `#${events[events.length - 1].id} – #${events[0].id}`
      : 'no events';

  const chainBanner = !chain
    ? `<div class="chain unknown"><strong>Chain not verified.</strong>
         Integrity could not be checked when this report was produced.</div>`
    : chain.ok
      ? `<div class="chain ok"><strong>Chain verified.</strong>
           All ${chain.checked} events recomputed from genesis and every hash matched.
           No record has been altered or removed.</div>`
      : `<div class="chain bad"><strong>CHAIN BROKEN at event #${chain.first_bad_id}.</strong>
           ${chain.checked} events verified before the break. Every entry from that
           point on must be treated as unreliable until investigated.</div>`;

  const rows = events
    .map(
      (e) => `
      <tr>
        <td class="num">${e.id}</td>
        <td class="when">${esc(stamp(e.created_at))}</td>
        <td>${esc(nameOf.get(e.actor_id ?? '') ?? (e.actor_id ? 'Unknown' : 'System'))}</td>
        <td>${esc(e.action)}</td>
        <td>${esc(TABLE_LABEL[e.table_name] ?? e.table_name)}</td>
        <td>${esc(summarise(e))}</td>
        <td class="hash" title="${esc(e.hash)}">${esc(e.hash.slice(0, 16))}…</td>
      </tr>`,
    )
    .join('');

  return `
<meta charset="utf-8" />
<style>
  @page { size: A4 landscape; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0F1B2A; font-size: 9pt; margin: 0;
  }
  header { border-bottom: 2px solid #0F1B2A; padding-bottom: 8pt; margin-bottom: 12pt; }
  .wordmark { font-size: 15pt; font-weight: 700; letter-spacing: 3pt; }
  .legal { color: #5B6B7C; font-size: 8pt; margin-top: 2pt; }
  h1 { font-size: 12pt; margin: 10pt 0 2pt; }
  .facts { display: flex; flex-wrap: wrap; gap: 18pt; margin-top: 6pt;
           color: #5B6B7C; font-size: 8pt; }
  .facts b { color: #0F1B2A; font-weight: 600; }
  .chain { margin: 10pt 0 12pt; padding: 8pt 10pt; border-radius: 3pt;
           border-left: 3pt solid; font-size: 8.5pt; }
  .chain.ok      { background: #EAF5EF; border-color: #0F7B4F; }
  .chain.bad     { background: #FBEBEA; border-color: #A3231C; }
  .chain.unknown { background: #FBF3E6; border-color: #9A5B00; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 7.5pt; letter-spacing: 0.6pt; text-transform: uppercase;
       color: #5B6B7C; border-bottom: 1px solid #0F1B2A; padding: 4pt 5pt; }
  td { padding: 4pt 5pt; border-bottom: 1px solid #E4E9EE; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .num  { font-variant-numeric: tabular-nums; color: #5B6B7C; width: 34pt; }
  .when { font-variant-numeric: tabular-nums; white-space: nowrap; width: 96pt; }
  .hash { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 7.5pt;
          color: #5B6B7C; white-space: nowrap; }
  footer { margin-top: 14pt; padding-top: 6pt; border-top: 1px solid #E4E9EE;
           color: #5B6B7C; font-size: 7.5pt; }
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

<table>
  <thead>
    <tr>
      <th>#</th><th>Timestamp (PKT)</th><th>Actor</th><th>Action</th>
      <th>Record</th><th>Detail</th><th>Hash</th>
    </tr>
  </thead>
  <tbody>${rows || '<tr><td colspan="7">No events for this filter.</td></tr>'}</tbody>
</table>

<footer>
  Every row is chained to the one before it by SHA-256 over its contents and its
  predecessor's hash, so altering or deleting any entry invalidates every hash after it.
  Hashes are shown truncated to 16 characters; the full value is held in the database.
  This report reflects the log at the moment of printing.
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
