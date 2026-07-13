# Operations & Handover

**Read this first if you are new to the project.** It is the single source of
truth for what this app is, where everything lives, how to run and deploy it,
and how to operate it day to day. It assumes no prior context.

Last updated: 2026-07-12.

---

## 1. What this is

An SEO opportunity-analysis app for a network of related local-service
websites. It pulls each site's Google Search Console (GSC) performance data
into its own database, enriches it with DataForSEO search volumes, runs
deterministic detectors to surface opportunities, and (across multiple sites in
the same trade) recommends page rollouts. Full product intent is in
`docs/PRODUCT_SPEC.md`; architecture in `docs/ARCHITECTURE.md`; the phase plan
in `docs/IMPLEMENTATION_PLAN.md`.

**Live app:** https://gsc-reader.seomarketer2011.workers.dev

**Current status:** Live and in real use. Phases 1–6 of the plan are built:
app shell, Supabase auth, Google OAuth + import, per-site detectors, DataForSEO
volumes, query clustering, standalone keyword research (with idea discovery),
the cross-site network engine, and a nightly auto-refresh cron. Raw performance
data currently lives in Postgres, not BigQuery (see §9 Known limitations).

---

## 2. Where everything lives (accounts & services)

| Thing | Value / location | Notes |
| --- | --- | --- |
| **Git repo** | `github.com/seomarketer2011/gsc-reader` | Active branch: `claude/app-architecture-setup-vhuqql`. No PR opened yet — see §11. |
| **Hosting** | Cloudflare Workers, account `Seomarketer2011@yahoo.co.uk` (id `44799b719f2192a9f066f425aaff3106`) | Worker name `gsc-reader`. Paid Workers plan ($5/mo). Account id is pinned in `apps/web/wrangler.jsonc`. |
| **Database + auth** | Supabase project `hlqmeuxaigjjenrupmuv` ("GSC Easy Wins") | URL `https://hlqmeuxaigjjenrupmuv.supabase.co`. Currently free tier — see §9/§10. |
| **Search volumes** | DataForSEO account `pauldanielstone@gmail.com` | Pay-as-you-go balance. Google Ads endpoints. |
| **Google OAuth** | Google Cloud project owned by `pauldanielstone@gmail.com` | Search Console API enabled; read-only scope `webmasters.readonly`. |
| **App framework** | Next.js 16 (App Router) + Tailwind v4, in `apps/web` | Deployed to Workers via the OpenNext adapter (`@opennextjs/cloudflare`). |

The connected Google account for GSC data is `pauldanielstone@gmail.com`.

---

## 3. Secrets & environment variables

**Never commit secret values.** They live in two places only:

1. **On the Cloudflare Worker** (runtime) — set via `wrangler secret put NAME`
   or the Cloudflare dashboard → Worker → Settings → Variables & Secrets.
2. **Locally** in `apps/web/.env.local` (git-ignored) for `npm run dev`, and
   exported on the command line when building/deploying (the two
   `NEXT_PUBLIC_*` values are baked in **at build time**, so they must be
   present in the shell that runs the Cloudflare build — see §6).

`apps/web/.env.example` documents the names. Full list:

| Variable | Where to get it | Used for | Public? |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → Data API | Browser + server Supabase client | Yes (baked into JS) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → **Publishable key** | Browser + server client (RLS-scoped) | Yes (safe by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API Keys → **Secret key** | Server-only: onboarding, imports, cron. Bypasses RLS. | **NO — secret** |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud → Credentials → OAuth client | GSC OAuth flow | NO — secret |
| `GOOGLE_OAUTH_CLIENT_SECRET` | same OAuth client | GSC token exchange | NO — secret |
| `TOKEN_ENCRYPTION_KEY` | Generated once: `openssl rand -base64 32` (32 bytes) | AES-256-GCM encryption of stored Google refresh tokens | **NO — secret** |
| `DATAFORSEO_LOGIN` | DataForSEO account email | Search-volume API auth | NO — secret |
| `DATAFORSEO_PASSWORD` | DataForSEO dashboard → **API Access** (a generated API password, NOT the website password) | Search-volume API auth | NO — secret |
| `CRON_SECRET` | Generated once: `openssl rand -hex 24` | Guards the `/api/cron/daily` endpoint | **NO — secret** |

If `TOKEN_ENCRYPTION_KEY` is ever lost or changed, existing stored Google
refresh tokens become undecryptable — every Google connection must be
re-authorised. Do not rotate it casually.

### OAuth redirect URIs (must exist in the Google OAuth client)
- `http://localhost:3000/api/google/callback` (local dev)
- `https://gsc-reader.seomarketer2011.workers.dev/api/google/callback` (prod)

### Supabase auth setting
Authentication → URL Configuration → **Site URL** =
`https://gsc-reader.seomarketer2011.workers.dev` (so confirmation emails link to
the live app, not localhost).

---

## 4. Database

PostgreSQL on Supabase is the application source of truth (users, orgs, sites,
connections, opportunities, performance rows, keyword cache). Schema details in
`docs/DATA_MODEL.md`.

**Migrations live in `supabase/migrations/` and must be applied in filename
order.** They are applied by pasting each file into Supabase → SQL Editor → Run.
(There is no automated migration runner wired up — this is manual today.)

Applied migrations, in order:

| File | Adds |
| --- | --- |
| `20260711000001_initial_schema.sql` | All core tables + RLS (org-membership policy on every table) |
| `20260711000002_user_state.sql` | `user_dismissals`, `rollouts.opportunity_key` |
| `20260712000003_performance_data.sql` | `gsc_performance_daily` (raw GSC rows) + `gsc_site_daily` view |
| `20260712000004_keyword_volumes.sql` | `keyword_volumes` cache + `low_visibility` opportunity type |
| `20260712000005_keyword_research.sql` | `keyword_volumes.monthly` + `competition_index` columns |

**When adding a migration:** write a new timestamped `.sql` file, validate it
(there is a PGlite validator harness used during development — apply all
migrations to an in-memory Postgres and smoke-test), then apply it in the
Supabase SQL Editor. Never edit an already-applied migration.

Every table has Row-Level Security: a user only sees rows for organisations they
belong to. The service-role key bypasses RLS and is used only by server code
(onboarding, imports, cron, detectors).

---

## 5. Running locally

```bash
cd apps/web
cp .env.example .env.local     # then fill in the values (see §3)
npm install
npm run dev                    # http://localhost:3000
npm test                       # vitest unit tests (scoring, fixtures, clustering)
npm run lint
npm run build                  # plain Next.js production build (type-check + compile)
```

Without Supabase env vars the app runs in **fixture mode** (demo 99-site
network, no login) — useful for UI work with no credentials.

---

## 6. Deploying

Deploys go to the Cloudflare Worker on the pinned account. The two
`NEXT_PUBLIC_*` values are compiled into the client bundle, so they must be
exported in the build shell:

```bash
cd apps/web
export NEXT_PUBLIC_SUPABASE_URL="https://hlqmeuxaigjjenrupmuv.supabase.co"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="<publishable key>"
npx opennextjs-cloudflare build      # builds .open-next/ (wrapped by worker-entry.mjs)
npx wrangler deploy                  # uploads to the gsc-reader Worker
```

Server-side secrets (§3) are already set on the Worker and do NOT need
re-supplying on deploy — only the two public build-time vars do. To add or
rotate a server secret: `printf '%s' "<value>" | npx wrangler secret put NAME`.

`worker-entry.mjs` wraps the OpenNext worker to add the `scheduled` (cron)
handler; `wrangler.jsonc` sets `main` to it and declares the cron trigger.

There is no CI/CD yet — deploys are run by hand from a machine (or session) that
has `wrangler` authenticated to the Cloudflare account. Cloudflare can also be
connected to the GitHub repo for auto-deploy on push if desired (not set up).

---

## 7. The nightly job (cron)

- **Schedule:** `30 3 * * *` (03:30 UTC daily), declared in `wrangler.jsonc`.
- **What it does:** `worker-entry.mjs` `scheduled()` → POSTs to
  `/api/cron/daily` with the `x-cron-secret` header. That route
  (`apps/web/src/app/api/cron/daily/route.ts`), for every tracked property:
  re-imports the last 5 days of GSC data (idempotent upserts; GSC finalises data
  ~2–3 days late), re-runs the per-site detectors, then runs the network
  detector per organisation. Every run is logged to the `sync_runs` table.
- **Protection:** rejects any call without the correct `CRON_SECRET`.
- **Manual trigger (for testing):**
  `curl -X POST https://gsc-reader.seomarketer2011.workers.dev/api/cron/daily -H "x-cron-secret: <CRON_SECRET>"`
- Frequency can be reduced to weekly by editing the cron and widening the
  re-import window from 5 to ~10 days. Cost is not a reason to (see §10).

---

## 8. How to operate it (day-to-day user flow)

1. **Sign in** at the live URL. First sign-in auto-creates your organisation.
2. **Google connections** → Connect Google Search Console → authorise the
   account that owns the GSC properties (read-only). Properties then list here.
3. **Track a property** (search box helps with large accounts) — this registers
   it and creates a site record.
4. **Import 16 months** — button next to each tracked property; runs in chunks
   with a progress counter, resumable, safe to re-run. Do this once per site;
   the nightly cron keeps it fresh afterwards.
5. **Run analysis** (button on the Opportunity Inbox) — runs all detectors +
   the network pass across every tracked property. The nightly cron also does
   this automatically.
6. Work the **Opportunity Inbox** (filter/sort/dismiss/save filters), the
   **Coverage matrix** (cross-site topic coverage), **Sites**, **Query
   clusters**, **Keyword research**, and **Rollouts**.

**Network rollout cards only appear with 2+ sites in the same trade** — a topic
that wins on one site and is weak/missing on another. Two sites in different
trades (e.g. an electrician + a locksmith) correctly produce zero rollouts.

### The detectors (all deterministic, no LLM in the decision path)
Per-site: striking distance (pos 4–15), CTR underperformance vs an expected
curve, internal competition (one topic split across pages), declining clicks
(needs ~24 days history), and low-visibility-vs-demand (uses DataForSEO volume).
Network: topic proven on ≥1 site + weak/absent on others that show related
demand → create/improve/review/exclude plan per site. Rules & scoring in
`docs/OPPORTUNITY_RULES.md`.

### Query clustering
Wording variants ("locksmith croydon", "croydon locksmiths", "locksmith near
me") normalise to one topic (`locksmith [location]`) so you get one opportunity,
not six. Logic in `apps/web/src/lib/engine/cluster.ts`, unit-tested.

---

## 9. Known limitations & gotchas

- **Raw data is in Postgres, not BigQuery.** The architecture calls for BigQuery
  at scale (Phase 6 in the plan). Fine for a handful of sites; the Supabase free
  tier's 500 MB cap is the real ceiling (~10–20 data-rich sites). See §10.
- **Supabase is on the free tier.** Free projects **pause after ~1 week of
  inactivity** — the nightly cron's DB writes keep it awake, but if the app goes
  quiet and the project pauses, the app goes down until it's resumed. Upgrading
  to Pro ($25/mo) removes this and raises the size cap. **This is the first
  upgrade to make as usage grows.**
- **Date-range selector** affects Sites and site detail, but Query clusters and
  the Inbox are intentionally fixed to a 28-day analysis window (consistent
  detection thresholds). The on-screen subtitles say so.
- **Coverage matrix ignores the site selector by design** (a cross-site matrix
  filtered to one site is meaningless) — it says so on-screen.
- **New GSC properties have little history.** A property only recently added in
  Search Console holds only a few days of data; that's a Google limitation, not
  a bug. History grows daily.
- **Connections page can feel slow** on large Google accounts because it lists
  properties live from Google and checks import status per tracked property on
  every render. Caching the property list is a known future improvement.
- **Manual migrations & manual deploys.** No automated runner/CI yet.

---

## 10. Costs

| Service | Now | Scaling notes |
| --- | --- | --- |
| Google Search Console API | £0 | Free; nightly usage is far under quota even at 99 sites. |
| Cloudflare Workers | $5/mo (paid plan active) | One cron/night is negligible. Paid plan raised CPU 10ms→30s and subrequests 50→1000, so in-app analysis/imports are safe. |
| Supabase | Free now | **Upgrade to Pro ($25/mo) first** as sites grow (size cap + no pausing). |
| DataForSEO | Pay-as-you-go | Volumes cached 30 days per keyword, so re-analysis is almost all cache hits; new keywords cost fractions of a penny. Top up balance when low. |

The design (free GSC API, 30-day volume cache, idempotent imports) makes run
frequency cheap on purpose.

---

## 11. Next steps / roadmap

Immediate operational: **import more same-trade sites** — that's the fuel for
the network engine and the coverage matrix; both light up with 2+ related sites.

Not yet built (from `docs/IMPLEMENTATION_PLAN.md` and product spec):
- Move raw performance rows to **BigQuery** (Phase 6 proper) before the Postgres
  size cap bites.
- **Page crawler + AI explanations** (Phase 7): titles/H1s/content/canonicals,
  cannibalisation and content-gap analysis, LLM-written briefs downstream of the
  deterministic engine.
- **Commercial prioritisation** (GA4/CRM/lead value) and the **learning loop**
  (track recommendation → implementation → actual gain).
- Automated migrations/CI, and property-list caching on the Connections page.

**Housekeeping:** the work is all on branch
`claude/app-architecture-setup-vhuqql`; no PR has been opened. Consider opening
one to merge into the default branch. Cloudflare deploys currently build from
whatever branch is deployed by hand — if you connect Cloudflare↔GitHub for
auto-deploy, point it at the branch you settle on.

**Security note:** the Supabase secret key and DataForSEO password were shared in
a chat during setup. Best practice is to rotate both once handover is complete
(regenerate in each dashboard, update the Worker secret and local env), then the
old values are dead.

---

## 12. Quick reference (map of the code)

```
apps/web/
  src/app/(app)/            authenticated screens (inbox, coverage, sites,
                            clusters, keywords, rollouts, connections)
  src/app/login/            sign-in (outside the app chrome)
  src/app/api/google/       OAuth start/callback + chunked import
  src/app/api/analysis/run/ on-demand "Run analysis"
  src/app/api/keywords/     lookup + suggest (DataForSEO)
  src/app/api/cron/daily/   nightly job endpoint (secret-guarded)
  src/lib/supabase/         browser/server/service clients (+ fixture fallback)
  src/lib/google/           OAuth, token crypto, GSC import
  src/lib/engine/           detect (per-site) · network (cross-site) ·
                            cluster (query normalisation) · volumes ·
                            research (DataForSEO helpers)
  src/lib/data/             real.ts (DB reads) + fixtures (demo mode)
  worker-entry.mjs          wraps OpenNext worker, adds cron scheduled()
  wrangler.jsonc            Worker config: account, cron, main entry
supabase/migrations/        ordered SQL migrations (apply by hand)
docs/                       product spec, architecture, data model, rules, plan
```
