-- Each watch-list domain can carry its home town (e.g. "Bromley"), imported
-- alongside the domain. This powers keyword generation per town and the
-- home-site vs overlap view on the rank tracker.

alter table public.tracked_domains add column if not exists location text;
