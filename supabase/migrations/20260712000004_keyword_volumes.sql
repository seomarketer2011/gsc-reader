-- Phase 4: cached search volumes from DataForSEO (refreshed monthly, so the
-- same keyword is never paid for twice in a month) and the link between
-- real query clusters and their member queries' aggregate stats.

create table public.keyword_volumes (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  keyword text not null,
  location_name text not null default 'United Kingdom',
  search_volume integer,
  cpc numeric(8, 2),
  competition text,
  fetched_at timestamptz not null default now(),
  primary key (organisation_id, keyword, location_name)
);

alter table public.keyword_volumes enable row level security;
create policy org_members_all on public.keyword_volumes
  for all using (public.is_org_member(organisation_id))
  with check (public.is_org_member(organisation_id));

-- New detector output type for volume-vs-visibility gaps.
alter type public.opportunity_type add value if not exists 'low_visibility';
