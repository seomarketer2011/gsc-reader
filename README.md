# gsc-reader — SEO Opportunity Engine

An SEO opportunity analysis application for networks of related websites. It
synchronises Google Search Console data into its own storage, detects
opportunities with deterministic rules, and presents them as explainable,
actionable recommendations — including network-wide page rollouts ("create this
page on these 34 of 99 sites, improve it on 9, review 12, ignore the rest").

## 👉 New here? Read [`OPERATIONS.md`](OPERATIONS.md) first

[`OPERATIONS.md`](OPERATIONS.md) is the complete handover: live URLs, every
account and service, all environment variables and where to get them, the
database migrations, how to run/deploy/operate, known limitations, costs, and
next steps. It assumes zero prior context — start there.

## Status

**Live and in real use.** Phases 1–6 built: app shell, Supabase auth, Google
OAuth + Search Console import, per-site opportunity detectors, DataForSEO search
volumes, query clustering, standalone keyword research, the cross-site network
engine, and a nightly auto-refresh cron. Raw performance data currently lives in
Postgres (BigQuery migration is a future step). See
[`OPERATIONS.md`](OPERATIONS.md) for current state and
`docs/IMPLEMENTATION_PLAN.md` for the phase roadmap.

Live app: **https://gsc-reader.seomarketer2011.workers.dev**

## Getting started

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests (scoring + fixture determinism)
npm run build      # production build
```

## Deploying (Cloudflare)

Deploys go to the `gsc-reader` Worker on the pinned Cloudflare account. The two
`NEXT_PUBLIC_*` values are compiled in at build time, so export them in the
build shell first. Full steps, secrets and gotchas are in
[`OPERATIONS.md` §6](OPERATIONS.md).

```bash
cd apps/web
export NEXT_PUBLIC_SUPABASE_URL="…"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="…"
npx opennextjs-cloudflare build
npx wrangler deploy
```

## Documentation

| Doc | Contents |
| --- | --- |
| [OPERATIONS.md](OPERATIONS.md) | **Handover: accounts, secrets, migrations, deploy, operate, costs, roadmap** |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | What the product is, hierarchy, screens, explainability and security rules |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design: Next.js/Cloudflare · Supabase Postgres · BigQuery · scheduled jobs |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Postgres tables, BigQuery warehouse layout, domain concepts |
| [docs/OPPORTUNITY_RULES.md](docs/OPPORTUNITY_RULES.md) | Deterministic detectors and the scoring model |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Phased build order and standing rules |

## Repository layout

```text
apps/web/                 Next.js dashboard (Phase 1: fixture data)
services/gsc-ingestor/    Search Console imports            (Phase 3+)
services/opportunity-engine/  Detection + scoring service   (Phase 4+)
services/crawler/         Page crawling and snapshots       (Phase 7)
packages/shared-types/    Cross-service domain types
supabase/migrations/      Application-database migrations   (Phase 2+)
bigquery/schemas/         Warehouse table definitions       (Phase 6)
infrastructure/cloud-run/ Scheduled job definitions         (Phase 6)
docs/                     Specifications and plans
```

## Security ground rules

Never commit credentials or `.env` files. Google access is OAuth 2.0 with the
read-only Search Console scope only. See `docs/PRODUCT_SPEC.md` for the full
list of rules.
