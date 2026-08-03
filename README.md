# Zirconix

Expenditure and accountability record-keeping for the Durr Mines & Minerals /
Zircon Mines consortium.

**This is not a payments app.** It never sends, receives, or moves money. It
records money that has already moved outside the app, and tracks how that money
gets spent, with receipts.

---

## The accounting model

Imprest / cash advance. Directors do not spend out of a shared company account:

1. The company **disburses** an amount to a director — bank transfer to his
   personal account, or physical cash. This creates an **obligation**.
2. The director spends it over time and logs each **expenditure** with a receipt
   photo or payment confirmation. Receipted expenditures **discharge** the
   obligation.
3. At any point: `total disbursed − total receipted expenditure = outstanding`.
   A non-zero outstanding is a **visible flag, not an error** — the dashboard
   shows it per director rather than hiding it.

Bank statement matching is a *secondary* check on bank-transfer disbursements.
The primary control is always: every expenditure has a receipt.

---

## What the database enforces

These are in Postgres, not in the app. They hold regardless of what the client
sends, and regardless of who holds the anon key.

| Control | How |
|---|---|
| PKR 10 lac threshold | `BEFORE INSERT` trigger sets status. A client submitting a 20 lac entry pre-marked `confirmed` still lands in `pending_approval`. |
| Authorship | `entered_by` / `recorded_by` stamped from the session. You cannot log an entry as someone else. |
| No self-approval | `CHECK (approver_id <> submitted_by)`, with `submitted_by` filled from the target row by trigger so the client cannot forge it. |
| Receipt required | Deferred constraint trigger, checked at COMMIT. `log_expenditure()` writes the expenditure and its receipt in one transaction; a bare insert with no receipt fails. |
| Receipt cannot be stripped | Deleting the last attachment on a non-rejected expenditure raises. |
| Immutable records | Amount, entity, authorship and creation time cannot be updated. Corrections are new entries. |
| Status transitions | Only through `decide_approval()`. Direct `UPDATE ... SET status` is refused. |
| Append-only audit | `audit_events` is hash-chained (`prev_hash` → `hash`). `UPDATE`, `DELETE` and `TRUNCATE` all raise, and the grants are revoked as well. |
| Tamper detection | `verify_audit_chain()` recomputes every hash and reports the first break. Surfaced as a banner on the Audit tab. |
| Entity isolation | RLS on all 11 tables. A director sees only boards they sit on. |
| Approval needs MFA | The `approvals` insert policy requires an AAL2 (TOTP-verified) session. |

15 control tests were run against the live database and all pass — including
attempts to self-approve, to bypass the approval RPC with a direct insert, to
edit a recorded amount, and to delete the audit log. See the commit message on
`9aebf14`.

To re-verify the chain at any time:

```bash
psql "$SUPABASE_DB_URL" -c "select * from verify_audit_chain(0);"
```

---

## Stack

Expo SDK 57 (React Native 0.86, expo-router, TypeScript) · Supabase Postgres 17,
Auth with TOTP MFA, Storage · TanStack Query.

There is deliberately **no separate Node backend**. Everything that must not be
client-trusted lives in Postgres as `SECURITY INVOKER` RPCs plus triggers and
RLS, which is stronger than an Edge Function: an Edge Function can be bypassed
by calling PostgREST directly, whereas a trigger cannot be bypassed at all.

---

## Setup

```bash
npm install
cp .env.example .env    # fill in the anon key
npm start
```

Node 20.19.4+ is required by React Native 0.86 (currently running 20.16.0, which
warns on install). Upgrade before building for a device.

### Supabase project

`vcoagdrbqsxshczvnwrp` (ap-southeast-1). All five migrations in
`supabase/migrations/` are applied. To regenerate types after a schema change:

```bash
npx supabase gen types typescript --project-id vcoagdrbqsxshczvnwrp > lib/database.types.ts
```

### Repository secrets needed for CI

| Secret | Used by | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | backup | Session pooler string from Project Settings → Database |
| `BACKUP_PASSPHRASE` | backup | Long random string. **Store a copy outside GitHub** — without it the backups are unreadable |
| `BACKUP_REPO` | backup | `owner/name` of a private repo to hold dumps |
| `BACKUP_REPO_TOKEN` | backup | PAT with `contents:write` on that repo |
| `SUPABASE_URL` | keepalive | `https://vcoagdrbqsxshczvnwrp.supabase.co` |
| `SUPABASE_ANON_KEY` | keepalive | Publishable key |

Backups run nightly at 02:30 UTC; keepalive every third day. Neither works until
the secrets above exist — set them before relying on either.

---

## Access is invite-only

A director record must exist with the person's email **before** they sign up. On
signup, a trigger links the auth user to that record by email. Someone who
registers with an unlisted address gets a valid account with no director row,
and RLS shows them nothing.

⚠️ **The seed data contains placeholders.** Seat 1 is `abbaszayn827@gmail.com`;
seats 2–8 are `*@example.invalid`. Replace them with the real directors' names,
emails, roles and board memberships before the pilot — **an email here is what
grants access to two companies' financial records**, so a wrong address is an
access-control mistake, not a cosmetic one.

Roles: `director` and `finance_officer` can write; `auditor` is read-only
everywhere.

### Creating a login

Create the auth user from **Dashboard → Authentication → Add user**, or the
Admin API. The `directors` row must already carry that email; the trigger links
the two on insert.

⚠️ **Do not create auth users with a raw `INSERT INTO auth.users`.** GoTrue reads
`confirmation_token`, `recovery_token`, `email_change`, `phone_change`,
`reauthentication_token` and their siblings into a non-nullable Go `string`. A
hand-written insert leaves them `NULL`, and GoTrue then fails while *loading* the
user — before it checks the password:

```
error finding user: sql: Scan error on column index 3,
name "confirmation_token": converting NULL to string is unsupported
```

Sign-in returns **HTTP 500**, not "invalid credentials", so it looks like a wrong
password and resetting the password does not help. The dashboard and Admin API
write `''` for those columns and also create the matching `auth.identities` row.
If you have already made this mistake, `coalesce` the token columns to `''` and
insert the missing email identity — see `git show` on the commit that added this
section.

---

## Free-tier constraints, and what was done about them

- **1 GB storage.** Receipts are compressed on-device to 1600px / 70% JPEG
  (~150–400 KB) before upload. A 5 MB hard ceiling is set on the bucket.
- **No automated backups.** `.github/workflows/backup.yml`, encrypted, off-platform.
- **Auto-pause after 7 days idle.** `.github/workflows/keepalive.yml`.
- **500 MB database.** Not a concern at this volume; the audit log is the only
  table that grows without bound and it stores JSON diffs, not blobs.

---

## Built

- [x] Schema, RLS, audit chain, all controls above
- [x] Email/password auth, TOTP enrollment and challenge
- [x] Entity switcher for directors on both boards
- [x] Budget dashboard — allocated / disbursed / spent / unaccounted, by
      category and by director
- [x] Record a disbursement (bank transfer or cash)
- [x] Log an expenditure with on-device receipt compression and atomic upload
- [x] Approval queue with approve/reject, reason required on rejection
- [x] Audit log viewer with chain-integrity banner and filters
- [x] Backup + keepalive workflows

## Not yet built

- [ ] **Push notifications** (pending approval, threshold breach). Needs an Edge
      Function holding the Expo push credentials — `directors.expo_push_token`
      already exists for it.
- [ ] **Export** — PDF/Excel per director per period. The
      `v_director_accountability` and `v_budget_summary` views already produce
      exactly the figures the report needs.
- [ ] **Bank statement import + matching.** Deferred per the brief: least urgent
      for a pilot with 8 people who can be asked directly. Tables
      (`statement_imports`, `statement_lines`), RLS and the private `statements`
      bucket are all in place.

---

## Conventions

- Money is `numeric(18,2)` PKR. Never float.
- Amounts are formatted with the `en-PK` locale, so they group in the lakh/crore
  system (`1,00,00,000`), which is how these figures get read aloud.
- Colour is reserved for meaning — entry status and the accountability gap.
  Nothing is coloured for decoration.
- Keep changes scoped to a file or feature; avoid cross-cutting refactors.
- Never skip receipt validation or the audit trigger "to move faster".
