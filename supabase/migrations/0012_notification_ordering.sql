-- Zirconix — notifications need an orderable timestamp
--
-- created_at defaulted to now(), which is the TRANSACTION start time and is
-- identical for every row written in the same transaction. A single vote writes
-- several notifications at once — "Vote recorded" for everyone, then "Transfer
-- confirmed" once the tally lands — and with equal timestamps the inbox could
-- show the outcome above the vote that caused it.
--
-- clock_timestamp() advances within the transaction, so the inbox reads in the
-- order things actually happened. audit_row_change() already stamps the chain
-- this way; this makes the two consistent.

alter table public.notifications
  alter column created_at set default clock_timestamp();
