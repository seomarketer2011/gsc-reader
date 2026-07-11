# migrations

Application-database migrations. Every schema change ships as a new file here —
never edit an applied migration.

## Applying to your Supabase project

**Option A — SQL Editor (no tooling needed):**
open your project → SQL Editor → New query → paste the full contents of the
migration file → Run. Apply files in filename order.

**Option B — Supabase CLI:**

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Migrations are validated locally against PGlite (a real Postgres engine)
before being committed.

## Files

| File | Contents |
| --- | --- |
| `20260711000001_initial_schema.sql` | Full Phase 2 schema: identity/membership, Google connections + GSC properties, sites/networks/campaigns, service taxonomy, pages/crawls, query clusters, opportunities/recommendations/rollouts, experiments, sync runs, saved filters. Row-level security on every table (org-membership rule); the service-role key bypasses RLS for server jobs. |
