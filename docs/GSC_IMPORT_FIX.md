# GSC import refresh and resume

The manual import previously resumed before the oldest performance row. It
never caught up newer dates on existing properties, and a zero-row window
could repeat until the client exhausted its 100-request limit.

The import now checks missing days from newest to oldest. `gsc_import_days`
records each completed API day, including empty results, only after every
Google result page and database batch succeeds. The first request of a manual
run refreshes the most recent five finalised days; continuation requests skip
that refresh. Google rows are paginated in 25,000-row responses and written in
1,000-row batches. Google still limits the underlying query/page data it exposes.

Existing authorisation stays in place: the route authenticates the user and
looks up the property under RLS before using the server's service client.
The new bookkeeping table has RLS enabled and no client grants or policies.
No Google permissions, secrets, scheduled triggers, or paid API calls change.

## Release order

1. Apply `supabase/migrations/20261028082755_gsc_import_day_checkpoints.sql`.
2. Run `npm ci`, `npm test`, and the build from `apps/web`.
3. Deploy the Worker using the existing credentials and public Supabase build
   variables described in `OPERATIONS.md`, section 6.
4. In Connections, run **Resume / update import** on Boltfix first. Verify
   October performance rows and recent completed dates in `gsc_import_days`.
   Then run imports for the remaining tracked properties.

The first run rechecks all 486 dates because historical performance rows cannot
prove that a whole day was fetched. On 28 October 2026 the first chunk requests
12–25 October, then older unchecked dates. Recent data is available after the
first chunk; an empty day still counts as checked, never as a fabricated zero
performance row. Future manual runs mainly refresh the latest five finalised
days plus any newly eligible or unfinished dates.

## Validation and rollback

Regression tests cover empty-history completion, interrupted resume, missing
dates, recent refresh, pagination, failed Google reads, failed database writes,
and failed checkpoint reads/writes. The migration test applies the full schema
in PGlite and checks service access, client denial, constraints and cascade.

Rolling back the Worker code leaves the additional table harmless but restores
the old import bug. Keep the checkpoint table so progress survives a redeploy.
No existing performance data is deleted by this migration.
