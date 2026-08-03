import type { EntryStatus } from './database.types';

/**
 * PKR formatting.
 *
 * Pakistani financial writing groups digits in the lakh/crore system
 * (1,00,00,000) rather than in thousands (10,000,000). Intl's 'en-PK' locale
 * does this correctly, and directors reading these figures will expect it.
 */
const pkr = new Intl.NumberFormat('en-PK', {
  style: 'currency',
  currency: 'PKR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const pkrExact = new Intl.NumberFormat('en-PK', {
  style: 'currency',
  currency: 'PKR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Rounded, for dashboards. */
export function money(amount: number | null | undefined): string {
  return pkr.format(Number(amount ?? 0));
}

/** To the paisa, for anything that is a record of a specific transaction. */
export function moneyExact(amount: number | null | undefined): string {
  return pkrExact.format(Number(amount ?? 0));
}

/** '25 lac', '1.2 crore' — how these amounts get said out loud. */
export function lakhCrore(amount: number | null | undefined): string {
  const n = Math.abs(Number(amount ?? 0));
  if (n >= 10000000) return `${trim(n / 10000000)} crore`;
  if (n >= 100000) return `${trim(n / 100000)} lac`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

function trim(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-PK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const statusLabel: Record<EntryStatus, string> = {
  auto_confirmed: 'Confirmed',
  pending_approval: 'Awaiting approval',
  confirmed: 'Approved',
  rejected: 'Rejected',
};

export type StatusTone = 'positive' | 'warning' | 'danger' | 'neutral';

export const statusTone: Record<EntryStatus, StatusTone> = {
  auto_confirmed: 'neutral',
  pending_approval: 'warning',
  confirmed: 'positive',
  rejected: 'danger',
};

/**
 * Postgres errors arrive with the raise message intact. Those messages were
 * written to be read by a director, so prefer them over anything invented here.
 */
export function humanError(error: unknown): string {
  if (!error) return 'Something went wrong.';

  const e = error as { message?: string; code?: string; details?: string };
  const raw = e.message ?? String(error);

  if (/Invalid login credentials/i.test(raw)) {
    return 'That email and password do not match.';
  }
  if (/Failed to fetch|Network request failed/i.test(raw)) {
    return 'No connection. Your entry has not been saved — try again when you have signal.';
  }
  if (e.code === '23505') {
    return 'That entry already exists.';
  }
  return raw.replace(/^ERROR:\s*/i, '');
}
