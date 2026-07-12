-- Phase 3b: raw Search Console performance rows (query × page × day).
-- Lives in Postgres while the network is small; moves to BigQuery in Phase 6
-- (docs/ARCHITECTURE.md). Device/country dimensions arrive with that move.

create table public.gsc_performance_daily (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  gsc_property_id uuid not null references public.gsc_properties (id) on delete cascade,
  date date not null,
  query text not null,
  page text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  position numeric(6, 2) not null default 0,
  primary key (gsc_property_id, date, query, page)
);

create index idx_perf_property_date on public.gsc_performance_daily (gsc_property_id, date desc);
create index idx_perf_property_page on public.gsc_performance_daily (gsc_property_id, page);

alter table public.gsc_performance_daily enable row level security;
create policy org_members_all on public.gsc_performance_daily
  for all using (public.is_org_member(organisation_id))
  with check (public.is_org_member(organisation_id));

-- Daily totals per property (drives site trend charts without raw scans).
create view public.gsc_site_daily
with (security_invoker = true) as
select
  organisation_id,
  gsc_property_id,
  date,
  sum(clicks)::int as clicks,
  sum(impressions)::int as impressions,
  round(avg(position)::numeric, 2) as position
from public.gsc_performance_daily
group by 1, 2, 3;
