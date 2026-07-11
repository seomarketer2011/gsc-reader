# Product Specification — SEO Opportunity Engine

## What this product is

A production-quality SEO opportunity analysis application. It synchronises Google
Search Console (GSC) performance data for large networks of related websites into
its own storage, detects content and optimisation opportunities with deterministic
rules, scores them, and presents them as explainable, actionable recommendations.

Search Console is treated as a **source we synchronise from**, never as a live
backend queried on every dashboard view.

## Who it is for

Owners and operators of networks of related local-service websites — the canonical
example used throughout these docs is a network of **99 fire-protection sites**
sharing an industry, similar services, similar site structure, and a shared page
taxonomy.

## Core hierarchy

```text
Organisation
└── Google connections
    └── Search Console properties

Organisation
└── Networks                 (persistent groups of related sites, e.g. the 99 sites)
    └── Campaigns            (user-defined subsets analysed for a purpose)
        └── Sites
            └── Pages
                └── Queries and query clusters
```

- One site may belong to multiple campaigns.
- Networks are persistent; campaigns are analytical selections over them.
- Duplicate/overlapping GSC properties (`sc-domain:example.com` vs
  `https://www.example.com/`) must be detected so search data is never
  double-counted.

## The defining feature

Pooled network analysis. The tool must answer questions like:

> "This page opportunity exists across the network, but it should be created on
> these 34 sites, improved on these 9, reviewed on these 12 and ignored on the
> remainder."

It must never simply add 99 sites' impressions together. Evidence is always shown
three ways: **network total**, **median site**, and **site coverage count**.

## Primary screens

1. **Opportunity Inbox** (default home) — one card per opportunity with headline,
   affected sites, network impressions, estimated upside, intent, confidence,
   effort, a plain-language "Why", and actions (view evidence, view affected
   sites, create rollout, dismiss).
2. **Coverage Heatmap** — rows are the network's sites, columns are services /
   topics. Each cell has an explicit state (dedicated page, weak page, wrong page
   ranks, missing with demand, network evidence only, not relevant, recommended,
   being built, experiment in progress).
3. **Site Performance** — pages, queries, clusters, CTR opportunities,
   striking-distance terms, declines for one site.
4. **Query Cluster** — all query variations, total demand, trend, sites receiving
   impressions, best-performing network pages, sites eligible for rollout.
5. **Rollout Builder** — a page blueprint applied to a recommended subset of
   sites, in batches, with exclusions and manual-review lists.
6. **Data Explorer** (later phase) — pivot-style dimension/metric explorer.

A global selector bar is always visible:

```text
View: [All Networks ▼] [Campaign ▼] [Site ▼]
Date: [Last 28 days ▼]   Compare: [Previous period ▼]
```

Every screen must have clear **loading, empty and error states**, and saved
filters.

## Explainability requirement

Every recommendation must expose:

```text
What we found · Why it matters · Which data supports it · What should change ·
How much upside exists · How confident we are · Which sites/pages are affected ·
What could go wrong
```

with a "Show raw evidence" drawer containing the exact queries, pages and figures.
The LLM never decides that a page is needed; the deterministic engine detects,
rules validate, scoring prioritises, and the LLM only explains and drafts briefs.

## Security & authorisation ground rules

- Google access uses OAuth 2.0 with the read-only scope
  `https://www.googleapis.com/auth/webmasters.readonly`. Users sign in with
  Google directly; the product never handles Google passwords.
- No credentials or `.env` values are ever committed. Secrets live in the hosting
  platforms' environment-variable stores.
- Supabase service-role keys are server-only. Stored Google refresh tokens are
  encrypted. Development and production credentials are separate.
- Production database migrations require explicit human confirmation.

## Build-order constraint

The application shell is built and tested against **realistic fixture data**
(99 sites, ~20 services, ~100k queries' worth of aggregates) before any live
Search Console connection is added. See `docs/IMPLEMENTATION_PLAN.md`.
