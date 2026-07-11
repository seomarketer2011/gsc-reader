-- Initial application schema (Phase 2) — the tables in docs/DATA_MODEL.md.
-- This is the application source of truth: users, organisations, networks,
-- campaigns, sites, opportunities, recommendations and decisions.
-- High-volume Search Console performance rows do NOT live here — they go to
-- BigQuery in Phase 6 (see docs/ARCHITECTURE.md).

-- ── Enums ────────────────────────────────────────────────────────────────

create type public.member_role as enum ('owner', 'admin', 'member');
create type public.property_type as enum ('domain', 'url_prefix');
create type public.connection_status as enum ('active', 'revoked', 'error');
create type public.level as enum ('low', 'medium', 'high');
create type public.opportunity_type as enum (
  'missing_dedicated_page', 'ctr_underperformance', 'striking_distance',
  'title_mismatch', 'wrong_page_ranks', 'url_switching', 'declining_clicks'
);
create type public.opportunity_status as enum ('open', 'dismissed', 'actioned');
create type public.query_intent as enum ('commercial', 'informational', 'local');
create type public.recommendation_status as enum ('proposed', 'approved', 'rejected', 'implemented');
create type public.rollout_status as enum ('draft', 'in_progress', 'complete');
create type public.run_status as enum ('running', 'succeeded', 'failed');
create type public.sync_type as enum ('backfill', 'incremental');

-- ── Identity and membership ──────────────────────────────────────────────

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  created_at timestamptz not null default now()
);

create table public.organisation_users (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create function public.is_org_member(org uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.organisation_users
    where organisation_id = org and user_id = auth.uid()
  );
$$;

-- ── Google connections and Search Console properties ─────────────────────

create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  google_account_email text not null,
  -- Refresh token is encrypted by the application layer (TOKEN_ENCRYPTION_KEY)
  -- before it is stored; the raw token never touches the database.
  refresh_token_encrypted text,
  scopes text[] not null default array['https://www.googleapis.com/auth/webmasters.readonly'],
  status public.connection_status not null default 'active',
  created_at timestamptz not null default now()
);

create table public.gsc_properties (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  google_connection_id uuid not null references public.google_connections (id) on delete cascade,
  property_uri text not null, -- e.g. sc-domain:example.com or https://www.example.com/
  property_type public.property_type not null,
  permission_level text,
  created_at timestamptz not null default now(),
  -- Duplicate/overlapping property detection relies on one row per URI per org.
  unique (organisation_id, property_uri)
);

-- ── Sites, networks, campaigns ────────────────────────────────────────────

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  gsc_property_id uuid references public.gsc_properties (id) on delete set null,
  name text not null,
  domain text not null,
  location text,
  region text,
  launched_year smallint,
  healthy boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organisation_id, domain)
);

create table public.networks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.network_sites (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  network_id uuid not null references public.networks (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  primary key (network_id, site_id)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  network_id uuid references public.networks (id) on delete set null,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.campaign_sites (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  primary key (campaign_id, site_id)
);

-- ── Service taxonomy and locations ────────────────────────────────────────

create table public.services (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  name text not null,
  commercial_value smallint not null default 2 check (commercial_value between 1 and 3),
  unique (organisation_id, name)
);

create table public.site_services (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (site_id, service_id)
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  town text not null,
  region text,
  unique (organisation_id, town)
);

create table public.site_locations (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  primary key (site_id, location_id)
);

-- ── Pages and crawling (populated from Phase 7) ──────────────────────────

create table public.pages (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  url text not null,
  first_seen date,
  created_at timestamptz not null default now(),
  unique (site_id, url)
);

create table public.crawl_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid not null references public.sites (id) on delete cascade,
  status public.run_status not null default 'running',
  pages_crawled integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.page_snapshots (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  page_id uuid not null references public.pages (id) on delete cascade,
  crawl_run_id uuid references public.crawl_runs (id) on delete set null,
  title text,
  h1 text,
  headings jsonb,
  content_hash text,
  internal_link_count integer,
  canonical text,
  indexable boolean,
  captured_at timestamptz not null default now()
);

-- ── Query clusters ────────────────────────────────────────────────────────

create table public.query_clusters (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  name text not null,
  audience text,
  normalised_form text,
  intent public.query_intent not null default 'local',
  created_at timestamptz not null default now()
);

create table public.query_cluster_members (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  cluster_id uuid not null references public.query_clusters (id) on delete cascade,
  query text not null,
  primary key (cluster_id, query)
);

-- ── Opportunities, recommendations, rollouts ─────────────────────────────

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  type public.opportunity_type not null,
  status public.opportunity_status not null default 'open',
  title text not null,
  cluster_id uuid references public.query_clusters (id) on delete set null,
  service_id uuid references public.services (id) on delete set null,
  site_id uuid references public.sites (id) on delete cascade,
  score numeric(5, 1) not null default 0,
  network_impressions bigint not null default 0,
  est_clicks_low integer not null default 0,
  est_clicks_high integer not null default 0,
  commercial_intent public.level not null default 'medium',
  confidence public.level not null default 'medium',
  effort public.level not null default 'medium',
  what_we_found text not null,
  why_it_matters text not null,
  proposed_change text not null,
  risks text[] not null default '{}',
  site_plans jsonb not null default '[]', -- per-site create/improve/review/exclude
  detected_at timestamptz not null default now(),
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz
);

create table public.opportunity_evidence (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  opportunity_id uuid not null references public.opportunities (id) on delete cascade,
  kind text not null, -- e.g. 'query_stats', 'position_comparison'
  payload jsonb not null
);

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  site_id uuid references public.sites (id) on delete cascade,
  summary text not null,
  status public.recommendation_status not null default 'proposed',
  created_at timestamptz not null default now()
);

create table public.recommendation_actions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  recommendation_id uuid not null references public.recommendations (id) on delete cascade,
  action text not null, -- e.g. 'approved', 'implemented', 'note'
  actor_id uuid references auth.users (id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create table public.rollouts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  opportunity_id uuid references public.opportunities (id) on delete set null,
  blueprint_title text not null,
  batches jsonb not null default '[]', -- [{name, site_ids}]
  excluded_site_ids jsonb not null default '[]',
  review_site_ids jsonb not null default '[]',
  status public.rollout_status not null default 'draft',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── Experiments and the learning loop ─────────────────────────────────────

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid references public.sites (id) on delete cascade,
  page_id uuid references public.pages (id) on delete set null,
  recommendation_id uuid references public.recommendations (id) on delete set null,
  hypothesis text,
  status public.run_status not null default 'running',
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.experiment_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  experiment_id uuid not null references public.experiments (id) on delete cascade,
  metric text not null, -- 'clicks', 'position', 'ctr'
  value_before numeric,
  value_after numeric,
  uplift_pct numeric,
  computed_at timestamptz not null default now()
);

-- ── Operations: sync runs and anomalies ──────────────────────────────────

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  gsc_property_id uuid references public.gsc_properties (id) on delete cascade,
  sync_type public.sync_type not null,
  status public.run_status not null default 'running',
  rows_imported bigint not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.data_anomalies (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  site_id uuid references public.sites (id) on delete cascade,
  anomaly_date date not null,
  kind text not null, -- e.g. 'total_mismatch', 'missing_day', 'duplicate_property'
  details jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── User state ────────────────────────────────────────────────────────────

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  params text not null, -- serialized URLSearchParams, same shape as the UI uses
  created_at timestamptz not null default now(),
  unique (organisation_id, user_id, name)
);

-- ── Indexes for the hot dashboard paths ───────────────────────────────────

create index idx_sites_org on public.sites (organisation_id);
create index idx_opportunities_inbox on public.opportunities (organisation_id, status, score desc);
create index idx_opportunities_site on public.opportunities (site_id) where site_id is not null;
create index idx_recommendations_org_status on public.recommendations (organisation_id, status);
create index idx_pages_site on public.pages (site_id);
create index idx_sync_runs_property on public.sync_runs (gsc_property_id, started_at desc);
create index idx_saved_filters_user on public.saved_filters (user_id);

-- ── Row-level security ────────────────────────────────────────────────────
-- Uniform rule: members of an organisation can read and write its rows.
-- Every domain table carries organisation_id so one policy shape fits all.
-- The service-role key (server-side jobs) bypasses RLS by design.

do $$
declare
  t text;
begin
  foreach t in array array[
    'google_connections', 'gsc_properties', 'sites', 'networks',
    'network_sites', 'campaigns', 'campaign_sites', 'services',
    'site_services', 'locations', 'site_locations', 'pages', 'crawl_runs',
    'page_snapshots', 'query_clusters', 'query_cluster_members',
    'opportunities', 'opportunity_evidence', 'recommendations',
    'recommendation_actions', 'rollouts', 'experiments',
    'experiment_results', 'sync_runs', 'data_anomalies', 'saved_filters'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy org_members_all on public.%I for all '
      || 'using (public.is_org_member(organisation_id)) '
      || 'with check (public.is_org_member(organisation_id))',
      t
    );
  end loop;
end $$;

alter table public.organisations enable row level security;
create policy org_members_select on public.organisations
  for select using (public.is_org_member(id));

alter table public.profiles enable row level security;
create policy own_profile_all on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

alter table public.organisation_users enable row level security;
create policy org_members_select on public.organisation_users
  for select using (public.is_org_member(organisation_id));
-- Membership rows and new organisations are created by the server (service
-- role) during onboarding, so no insert/update policies are granted here.
