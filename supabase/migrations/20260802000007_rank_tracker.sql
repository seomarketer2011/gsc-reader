-- Rank tracker: organic Google positions for a set of keywords, checked
-- against BOTH GSC-connected sites and a plain watch-list of domains that
-- need no Google connection (most of the network isn't connected yet).

create table public.tracked_keywords (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  keyword text not null,
  location_name text not null default 'United Kingdom',
  created_at timestamptz not null default now(),
  unique (organisation_id, keyword, location_name)
);

-- Domains tracked without a GSC connection ("watch list").
create table public.tracked_domains (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  domain text not null,
  created_at timestamptz not null default now(),
  unique (organisation_id, domain)
);

-- One row per keyword per day a SERP was fetched; top_results keeps the
-- top-10 for "who is above us" context. error records failed fetches so a
-- bad keyword/location doesn't retry forever within the same day.
create table public.serp_checks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  keyword_id uuid not null references public.tracked_keywords (id) on delete cascade,
  check_date date not null default current_date,
  checked_at timestamptz not null default now(),
  top_results jsonb not null default '[]',
  error text,
  unique (keyword_id, check_date)
);

-- One row per (keyword, domain) that appeared in the top 100 that day.
-- Absence of a row for a watched domain = did not rank. site_id links the
-- domain back to a GSC-connected site when one exists.
create table public.serp_rankings (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  keyword_id uuid not null references public.tracked_keywords (id) on delete cascade,
  domain text not null,
  site_id uuid references public.sites (id) on delete set null,
  check_date date not null default current_date,
  position integer not null,
  url text,
  unique (keyword_id, domain, check_date)
);

create index idx_tracked_keywords_org on public.tracked_keywords (organisation_id);
create index idx_tracked_domains_org on public.tracked_domains (organisation_id);
create index idx_serp_checks_keyword on public.serp_checks (keyword_id, check_date desc);
create index idx_serp_rankings_org_date on public.serp_rankings (organisation_id, check_date desc);
create index idx_serp_rankings_keyword on public.serp_rankings (keyword_id, check_date desc);

-- Same RLS shape as every other domain table: org members read/write.
do $$
declare
  t text;
begin
  foreach t in array array[
    'tracked_keywords', 'tracked_domains', 'serp_checks', 'serp_rankings'
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
