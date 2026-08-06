# Operations & Handover

**Read this first if you are new to the project.** It is the single source of
truth for what this app is, where everything lives, how to run and deploy it,
and how to operate it day to day. It assumes no prior context.

Last updated: 2026-08-04.

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
the cross-site network engine, and a campaign-scoped rank tracker. Nothing
refreshes automatically — every import, analysis and rank check is started by
hand from the app (see §7). Raw performance data currently lives in Postgres,
not BigQuery (see §9 Known limitations).

---

## 2. Where everything lives (accounts & services)

| Thing | Value / location | Notes |
| --- | --- | --- |
| **Git repo** | `github.com/seomarketer2011/gsc-reader` | Active branch: `main` (all earlier `claude/*` work branches are merged into it). |
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
| `CRON_SECRET` | Generated once: `openssl rand -hex 24` | Guards both `/api/cron/*` endpoints | **NO — secret** |

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
| `20260802000006_unique_group_names.sql` | Unique campaign (site group) name per organisation |
| `20260802000007_rank_tracker.sql` | `tracked_keywords`, `tracked_domains`, `serp_checks`, `serp_rankings` |
| `20260802000008_domain_home_locations.sql` | `tracked_domains.location` (home town) |
| `20260802000009_location_validation.sql` | `tracked_domains.location_valid` |
| `20260802000010_serp_location_override.sql` | `tracked_domains.serp_location` (where the SERP is fetched from) |
| `20260802000011_serp_task_queue.sql` | `serp_task_queue` (DataForSEO standard-queue tasks in flight) |
| `20260802000012_rank_tracker_campaigns.sql` | `campaign_id` required on both tracked tables; existing data backfilled into one campaign per org; uniqueness moved under the campaign |
| `20260802000013_keyword_location_validation.sql` | `tracked_keywords.location_valid` |
| `20260802000014_serp_depth.sql` | `campaigns.serp_depth` (how deep checks look), `serp_checks.depth` + `serp_task_queue.depth` (depth each result/task was taken at) |

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

### Deploying from a Claude Code session

Sessions on this repo are provisioned with Cloudflare credentials already in
the environment, so a deploy can be run directly from a session — there is no
need to ask the operator to do it on their own machine:

- `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` — global API key auth, which
  `wrangler` picks up with no login step. Confirm with `npx wrangler whoami`.
- **`CLOUDFLARE_ACCOUNT_ID` in the environment does NOT necessarily point at
  this project's account.** The global key can see many accounts. This app
  lives on `44799b719f2192a9f066f425aaff3106`
  (Seomarketer2011@yahoo.co.uk), which is also the `account_id` pinned in
  `wrangler.jsonc`. Pin it on the command as well so the two can never
  disagree:

```bash
CLOUDFLARE_ACCOUNT_ID=44799b719f2192a9f066f425aaff3106 npx wrangler deploy
```

The build still needs the two `NEXT_PUBLIC_*` values exported (above). The
Supabase publishable key is not in the repo and not in the session
environment; it is baked into the deployed client bundle, so it can be
recovered from the live site when it isn't to hand — fetch `/login`, find the
`/_next/static/chunks/*.js` chunk containing `hlqmeuxaigjjenrupmuv`, and pull
the `sb_publishable_…` value out of it. It is a publishable key: public by
design, safe to use this way, still not something to commit.

After deploying, check the trigger list wrangler prints back (§7) — it is the
quickest confirmation that the cron configuration deployed as intended.

---

## 7. Scheduled jobs (cron)

**Nothing refreshes on a schedule.** By operator decision, GSC imports,
analysis and rank checks all happen only when their button in the app is
pressed. `wrangler.jsonc` declares exactly one trigger:

- **`*/5 * * * *` → `/api/cron/ranks`.** Collects finished DataForSEO tasks
  and nothing else — it never posts a task, so it cannot spend money on its
  own. It exists so a rank check started in the app can be left to finish
  after the tab is closed. Exits immediately when nothing is in flight.

`worker-entry.mjs` `scheduled()` POSTs to that route with the
`x-cron-secret` header; both cron routes reject any call without the correct
`CRON_SECRET`.

`/api/cron/daily` still exists and still works — it re-imports the last 5
days of GSC data for every tracked property (idempotent upserts; GSC
finalises data ~2–3 days late), re-runs the per-site detectors, then the
network detector per organisation, logging each run to `sync_runs`. It is
simply no longer scheduled. To run it:

```bash
curl -X POST https://gsc-reader.seomarketer2011.workers.dev/api/cron/daily \
  -H "x-cron-secret: <CRON_SECRET>"
```

To put nightly refresh back, add `"30 3 * * *"` to the `crons` array in
`wrangler.jsonc`, restore the cron-to-path branch in `worker-entry.mjs`, and
redeploy. Cost is not a reason to leave it off (see §10) — this is a
"nothing moves unless I move it" preference.

Note for §9: the nightly job's database writes used to be what kept the free
Supabase project from pausing. With no scheduled writes, an idle week can
pause the project.

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

### Rank tracker: what a check costs and how long it takes

- **Cost.** DataForSEO bills **$0.0006 per page of ten results** it has to
  fetch, so the campaign's depth setting (on the rank-tracker page, "How deep
  to look") is the one cost lever and scales exactly: top 100 = $0.006 per
  keyword, top 50 = $0.003, top 30 = $0.0018, top 20 = $0.0012, top 10 =
  $0.0006. A 477-keyword campaign is ~$2.86 a run at top 100, ~$1.43 at top
  50, ~$0.57 at top 20. The button shows the estimate before you press it.
  Check the balance at `https://api.dataforseo.com/v3/appendix/user_data`.
- **Depth trade-off.** A site below the chosen depth is indistinguishable
  from one that doesn't rank, and striking-distance work lives at #11–30 —
  so shallow depths suit watching a network's winners, not moving a site.
  Every stored result records the depth it was taken at; reducing the depth
  marks sites below the new limit "out of range" instead of reporting them
  as dropped.
- **Timing.** Tasks are posted in seconds and normally come back within a
  couple of minutes, worst case ~20. The page shows how many are still in
  flight and how long the oldest has been out there; past **60 minutes** it
  says "stalled" and offers a button to forget the in-flight tasks so a fresh
  check can be started.
- **You can close the tab.** The 5-minute cron (§7) collects whatever is
  finished. The button watches for 45 minutes and then says so — that message
  is not a failure.
- **Nothing is charged twice.** A keyword already checked today, or already
  queued today, is skipped by the next check. Both exclusions are scoped to
  today, so yesterday's leftovers can never block today's run.

### Rank tracker: position history

Every check writes one `serp_checks` row (whether it ran) and one
`serp_rankings` row per watched domain in the top 100. History and movement
are derived from those rows — there is no separate history table, and no
migration was needed to add the feature. The rules live in
`apps/web/src/lib/engine/rank-history.ts` and are unit-tested:

- **Failed checks are not history.** A DataForSEO error says nothing about
  where a site ranked, so comparisons skip it and use the last check that
  actually produced positions.
- **A missing `serp_rankings` row means "not in the top 100"**, which is why
  "dropped out" has to be computed by comparing two checks rather than read
  off a column.
- The dashboard compares the two most recent successful checks; expanding a
  keyword pulls its last 20 checks (180-day window) as a full position grid.

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
  inactivity** — and since the nightly cron was switched off (§7) nothing
  writes to the database on a schedule any more, so a quiet week now really
  can pause it. The app goes down until it's resumed from the dashboard. Upgrading
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
| DataForSEO | Pay-as-you-go | Volumes cached 30 days per keyword, so re-analysis is almost all cache hits; new keywords cost fractions of a penny. **Rank checks are the real spend: ~$0.006 per keyword per run** (see §8), so a 477-keyword campaign is ~$2.90 each time you press the button. Top up balance when low. |

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

**Housekeeping:** all work now lives on `main`; the earlier `claude/*` work
branches are merged into it and can be deleted (make `main` the default branch
in GitHub → Settings → Branches first). Cloudflare deploys currently build from
whatever branch is deployed by hand — if you connect Cloudflare↔GitHub for
auto-deploy, point it at `main`.

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
  src/app/api/cron/daily/   GSC top-up + detectors (secret-guarded; no longer scheduled)
  src/app/api/cron/ranks/   rank-tracker collection tick (secret-guarded; */5)
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
