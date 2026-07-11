# Architecture

## System overview

```text
Google Search Console
        ↓
Data ingestion jobs (Cloud Run Jobs, scheduled)
        ↓
BigQuery — raw and aggregated SEO performance data
        ↓
SEO opportunity engine (deterministic detectors + scoring)
        ↓
PostgreSQL (Supabase) — campaigns, sites, recommendations, users, decisions
        ↓
Next.js dashboard (Vercel)
```

Two storage layers with a clean separation of responsibility:

| Layer | Technology | Holds |
| --- | --- | --- |
| Application database | PostgreSQL (Supabase) | Users, organisations, Google connections, sites, networks, campaigns, services, opportunities, recommendations, experiments, sync runs — the application source of truth |
| Analytical warehouse | BigQuery | Raw daily GSC rows (date × site × query × page × device × country × search type/appearance) and derived summary tables |

The dashboard never queries Search Console directly. High-volume analytical scans
never run against Postgres.

## Components

### `apps/web` — Next.js dashboard (Cloudflare Workers via OpenNext; Vercel also supported)

TypeScript, App Router. Global Network → Campaign → Site selectors, Opportunity
Inbox, coverage matrix, site/cluster views, rollout builder. Phase 1 runs entirely
on fixture data behind a data-access layer, so swapping in real APIs later does
not change the UI.

### `services/gsc-ingestor` — Search Console imports

Cloud Run Job. Per property, per day: pull Page + Query + Device + Country rows,
upsert into BigQuery with the idempotency key
`(site_id, date, query, page, country, device, search_type, search_appearance)`.
Historical backfill runs as one request per day rather than one huge range.
Nightly incremental runs re-pull the last few days (data can change), validate
totals, refresh summary tables, then trigger the opportunity engine.

Two connectors, both normalised into the same warehouse schema:

- **Default:** Search Analytics API (easy multi-property onboarding; subject to
  API row limits).
- **High-volume option:** native GSC bulk export → BigQuery (per-property
  configuration, no historical backfill, anonymised queries excluded).

Finalised data drives opportunity calculations; fresh data may drive trend alerts
only.

### `services/opportunity-engine` — detection and scoring

Deterministic detectors (see `docs/OPPORTUNITY_RULES.md`) over BigQuery summary
tables, producing opportunities and recommendations in Postgres. The LLM sits
strictly downstream: it explains validated opportunities and drafts briefs; it
never originates them.

### `services/crawler` — page snapshots (later phase)

Collects titles, H1s, headings, main content, internal links, canonicals,
indexability, page similarity. Snapshots stored in Cloud Storage; extracted
structure in Postgres.

### Scheduled processing

Cloud Run Jobs + Cloud Scheduler. Jobs pull data, write, refresh summaries,
update scores, and exit — no long-running import inside a web request.

## BigQuery layout

Raw table `gsc_query_page_daily`, partitioned by `date`, clustered by
`site_id`, `query_cluster_id`, `page`. Derived tables:

```text
gsc_site_daily · gsc_page_daily · gsc_query_daily · gsc_page_query_28d ·
gsc_cluster_daily · gsc_campaign_daily · gsc_network_daily ·
network_topic_coverage · opportunity_metrics
```

Dashboard reads come from precomputed summaries/materialised views, never from
raw-table scans per page load.

## Secrets and configuration

Typical secret names (values live only in Vercel/Supabase/GCP secret stores):

```text
GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · GOOGLE_REDIRECT_URI
SUPABASE_URL · SUPABASE_ANON_KEY · SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLOUD_PROJECT_ID · BIGQUERY_DATASET
TOKEN_ENCRYPTION_KEY · NEXTAUTH_SECRET
```

Rules: no `.env` in git; no secrets in source; service-role key never shipped to
the browser; read-only GSC scope; least-privilege service accounts; encrypted
refresh tokens; human confirmation before production migrations.

## Repository structure

```text
gsc-reader/
├── apps/
│   └── web/                  # Next.js dashboard
├── services/
│   ├── gsc-ingestor/         # Search Console imports
│   ├── opportunity-engine/   # SEO detection + scoring
│   └── crawler/              # Site crawling (later phase)
├── packages/
│   └── shared-types/         # Cross-service domain types
├── supabase/
│   └── migrations/           # Every schema change is a migration
├── bigquery/
│   └── schemas/              # Warehouse table definitions
├── infrastructure/
│   └── cloud-run/            # Job definitions and schedules
└── docs/
```
