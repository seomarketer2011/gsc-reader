# Implementation Plan

Small, independently testable phases. Each phase is committed separately and the
app must build and pass tests at every phase boundary. Live Google Search Console
is not connected until the fixture-data application is working and tested.

## Phase 1 — Application shell on fixture data  ✅ complete

Next.js + TypeScript in `apps/web`, no external services, no credentials.

- Deterministic fixture generator: 1 network of 99 fire-protection sites,
  ~20 services, query clusters, daily performance series, coverage states and
  scored opportunities. Seeded PRNG → identical data every run (testable).
- Data-access layer (`src/lib/data/`) so fixtures can later be swapped for real
  APIs without touching the UI.
- Screens: global Organisation/Network/Campaign/Site + date/compare selectors ·
  Opportunity Inbox · network site-topic coverage matrix · site performance ·
  query cluster · new-page rollout builder · saved filters.
- Clear loading, empty and error states on every screen.
- Unit tests for the scoring function and fixture determinism.

**Done when:** `npm run build` and `npm test` pass; every screen renders with
realistic data; recommendations show full evidence.

## Phase 2 — Supabase application database  ✅ built (auth, orgs, synced user state)

Schema migrations for the tables in `docs/DATA_MODEL.md`; auth (login,
organisations, membership); saved filters and recommendation status move from
fixtures to Postgres. Every schema change is a migration.

## Phase 3 — One Search Console property  ✅ built (single & multi-property)

Google OAuth (read-only scope) → list accessible properties → select one →
import 16 months of history via daily requests → display real pages and queries.
Tested end-to-end with a single website before any bulk onboarding.

## Phase 4 — First opportunity detectors  ✅ built (+ DataForSEO low-visibility detector)

The seven rule-based detectors in `docs/OPPORTUNITY_RULES.md`, running on the
imported property. Deterministic, unit-tested; no LLM in the decision path.

## Phase 5 — Networks and pooled analysis  ✅ built (clustering, coverage matrix, network rollouts)

Shared service taxonomy · location normalisation · cross-site query clustering ·
site-topic coverage matrix on real data · dedicated-page vs missing-page
comparisons · network rollout recommendations.

## Phase 6 — Daily jobs  ✅ (nightly Cloudflare cron) · ⏳ BigQuery move still pending

Daily refresh is **done** as a Cloudflare Worker cron (03:30 UTC) that tops up
the last few days per property and re-runs all detectors (see `OPERATIONS.md`
§7). Still **pending**: moving raw performance rows from Postgres to BigQuery
(partitioned/clustered per `docs/ARCHITECTURE.md`) before the Postgres size cap
bites; application state stays in Postgres.

## Phase 7 — Crawler and AI explanations  ⏳ not started

Page crawler (titles, H1s, headings, content, internal links, canonicals,
indexability, similarity) feeding cannibalisation/content-gap analysis; LLM
explanations and briefs generated strictly downstream of the deterministic
engine.

## Later

Standalone **Keyword research** (paste list → volumes/CPC/competition/12-month
trend + idea discovery, cross-referenced against own rankings) is **built**.
Still later: Data Explorer (pivot builder) · GA4/CRM commercial prioritisation ·
experiment tracking and the learning loop.

## Standing rules for every phase

1. No production resources modified without explicit confirmation.
2. No credentials or `.env` values committed, ever.
3. Database migrations for every schema change.
4. Automated tests for opportunity calculations and data imports.
5. Each completed phase is a separate commit.
6. Security-sensitive operations are explained and confirmed before execution.
