# gsc-reader — SEO Opportunity Engine

An SEO opportunity analysis application for networks of related websites. It
synchronises Google Search Console data into its own storage, detects
opportunities with deterministic rules, and presents them as explainable,
actionable recommendations — including network-wide page rollouts ("create this
page on these 34 of 99 sites, improve it on 9, review 12, ignore the rest").

## Status

**Phase 1** — application shell running on deterministic fixture data
(99-site network, 20 services). No live Google connection yet; see
`docs/IMPLEMENTATION_PLAN.md` for the phase roadmap.

## Getting started

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests (scoring + fixture determinism)
npm run build      # production build
```

## Deploying (Cloudflare)

The app ships with Cloudflare's OpenNext adapter (`apps/web/wrangler.jsonc`).
In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**,
pick this repo, set the root directory to `apps/web`, build command
`npx opennextjs-cloudflare build`, deploy command `npx wrangler deploy`. Add the
environment variables from `apps/web/.env.example` as Worker
**Variables & Secrets** — never in the repo. Local check: `npm run cf:preview`.
(Vercel also works with zero config if preferred.)

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | What the product is, hierarchy, screens, explainability and security rules |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design: Next.js/Vercel · Supabase Postgres · BigQuery · Cloud Run Jobs |
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
