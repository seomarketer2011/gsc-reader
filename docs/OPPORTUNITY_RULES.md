# Opportunity Rules

All detection is deterministic and objectively testable. No LLM participates in
deciding that an opportunity exists — the LLM only explains validated
opportunities and drafts implementation briefs.

## First-wave detectors (Phase 4)

| # | Detector | Signal |
| --- | --- | --- |
| 1 | `ctr_underperformance` | High impressions with CTR materially below the position-expected CTR curve |
| 2 | `striking_distance` | Queries ranking positions 4–15 with meaningful impressions |
| 3 | `title_mismatch` | Important query (by impressions) absent from the ranking page's title/H1 |
| 4 | `wrong_page_ranks` | A query's impressions land on a page not intended for that topic |
| 5 | `url_switching` | Ranking URL for a query cluster flips between pages over time |
| 6 | `declining_clicks` | Statistically meaningful click decline vs comparison period |
| 7 | `missing_dedicated_page` | Distinct query cluster with demand but no dedicated page |

## Network-level detectors (Phase 5)

- **Coverage gap:** eligible sites without a dedicated page for a topic where
  dedicated-page sites demonstrably outperform (median position / CTR).
- **Rollout opportunity:** topic with strong pooled evidence → recommend
  create / improve / review / ignore per site (see eligibility rules in
  `docs/DATA_MODEL.md`).

## Scoring inputs

```text
Demand strength      total cluster impressions · query growth · sites receiving impressions
Coverage gap         % of eligible sites lacking the page
Performance evidence dedicated-page vs non-dedicated-page median position/CTR delta
Commercial value     service lead value · conversion rate · business priority
Confidence           number of evidence sites · months of data · cluster stability
Risk (divisors)      similarity to existing pages · thin-content risk · cannibalisation risk
Effort (divisor)     content production effort
```

## Output contract

Every emitted opportunity carries structured evidence sufficient to render:

```text
what_we_found · why_it_matters · supporting_data (raw queries/pages/figures) ·
proposed_change · estimated_upside (range) · confidence · affected_sites_pages ·
risks
```

An opportunity without complete evidence must not surface in the Inbox.

## Recommendation shape (network example)

```text
Recommended network page: Fire Door Inspections for Landlords
Evidence: 61 sites have related impressions · 12 have dedicated pages ·
          dedicated-page median position 5.8 vs 14.2 without
Action:   create on 34 sites · improve on 9 · manual review 12 ·
          do not create on 6 (service not offered)
```

## Learning loop (later phase)

Track recommendation → implementation date → original page state → targeted
queries → expected vs actual gain, so the system learns which change types work
for which industries, page types, positions and intents.
