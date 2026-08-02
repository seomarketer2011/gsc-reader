-- Import-time location validation: whether a domain's home town matched a
-- real DataForSEO location when it was imported (null = not checked).

alter table public.tracked_domains add column if not exists location_valid boolean;
