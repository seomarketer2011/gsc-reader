# Data Model

## PostgreSQL (application source of truth)

Core tables:

```text
organisations            users                    organisation_users
google_connections       gsc_properties           sites
networks                 network_sites            campaigns
campaign_sites           services                 site_services
locations                site_locations           crawl_runs
pages                    page_snapshots           query_clusters
query_cluster_members    opportunities            opportunity_evidence
recommendations          recommendation_actions   experiments
experiment_results       sync_runs                data_anomalies
saved_filters
```

Answers questions such as: which sites belong to this campaign; which services a
site offers; whether a recommendation was approved; whether a page already
exists; who is implementing it; what changed and whether it worked.

Key constraints:

- `gsc_properties` records the property type so `sc-domain:` and URL-prefix
  duplicates of the same site can be detected and never double-counted.
- `network_sites` / `campaign_sites` are many-to-many; a site can be in several
  campaigns.
- Every schema change ships as a migration in `supabase/migrations/`.

## BigQuery (analytical warehouse)

Raw table `gsc_query_page_daily`:

```text
date · organisation_id · property_id · site_id · query · page · country ·
device · search_type · search_appearance · clicks · impressions · ctr ·
position · data_state
```

Partitioned by `date`; clustered by `site_id`, `query_cluster_id`, `page`.
Idempotent upserts keyed on
`(site_id, date, query, page, country, device, search_type, search_appearance)`.

Derived tables: `gsc_site_daily`, `gsc_page_daily`, `gsc_query_daily`,
`gsc_page_query_28d`, `gsc_cluster_daily`, `gsc_campaign_daily`,
`gsc_network_daily`, `network_topic_coverage`, `opportunity_metrics`.

## Domain concepts

### Query normalisation

Raw queries are retained and additionally decomposed into structured components:

```text
"fire door inspection croydon"
→ service: fire door inspection · intent: commercial/service ·
  location: Croydon · normalised: "fire door inspection [location]"
```

so the same opportunity is recognisable across different local sites.

### Service taxonomy

Each industry network defines canonical service entities (e.g. fire door
installation / inspection / repair / maintenance, fire risk assessment, landlord
compliance, …). Query variants map onto entities; meaningfully different
sub-intents stay distinct clusters.

### Coverage cell states

Every (site × topic) cell in the coverage matrix is in exactly one state:

```text
strong_dedicated_page · weak_dedicated_page · poorly_targeted_page ·
wrong_page_ranks · missing_with_demand · network_evidence_only ·
not_relevant · recommended · being_built · experiment_in_progress
```

### Network evidence (per topic / proposed page)

```text
total network impressions & clicks · sites receiving impressions ·
sites with dedicated pages · sites relying on broad pages ·
eligible sites with no page · median position (with vs without page) ·
median CTR · top-performing sites · estimated network opportunity
```

Always presented as network total + median site + site coverage count; never a
bare sum (one large site must not distort the network).

### Site eligibility for a rollout

A site is eligible for a recommended page when it genuinely offers the service,
the page suits its market, no equivalent page exists, GSC shows direct or
analogous demand, its broad pages already receive related impressions, enough
unique local/business content exists, the site is indexable and healthy, and the
page would not create significant internal overlap.

### Opportunity scoring

```text
network_opportunity_score =
  demand_strength × site_coverage_gap × dedicated_page_evidence ×
  commercial_value × applicability × confidence
  ÷ content_effort ÷ duplication_risk ÷ cannibalisation_risk
```

Inputs per factor are enumerated in `docs/OPPORTUNITY_RULES.md`. The scoring
function is pure, deterministic and unit-tested.
