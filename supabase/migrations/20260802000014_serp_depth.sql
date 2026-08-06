-- How deep a campaign's rank checks look, and what depth each stored result
-- was actually taken at.
--
-- DataForSEO bills a Google organic SERP by the page of ten results it had to
-- fetch, so depth is the one setting that changes what a run costs: depth 100
-- is ten pages (~$0.006 a keyword), depth 50 is five (~$0.003), depth 20 is
-- two (~$0.0012). It is a per-campaign choice because a 292-site network and
-- a single client site want different trade-offs — cheap and shallow to watch
-- the top of the page, deep and dear to see everything.
--
-- The recorded depth is not decoration. Positions are stored as "rows that
-- exist", so a domain with no row means "not in the top N" — and N used to be
-- implicit. Drop a campaign from depth 100 to depth 20 without recording it
-- and every site that sat at #21–100 would read as having crashed out of the
-- results overnight. With the depth on the row, the tracker can tell "it
-- fell out" from "we stopped looking that far".

-- 1 · The campaign's setting. Restricted to the depths DataForSEO bills as
-- whole pages, so the cost shown in the app is always the cost charged.
alter table public.campaigns
  add column if not exists serp_depth integer not null default 100;

alter table public.campaigns
  drop constraint if exists campaigns_serp_depth_check,
  add constraint campaigns_serp_depth_check check (serp_depth in (10, 20, 30, 50, 100));

-- 2 · The depth a stored result was taken at. Null on every row written
-- before this column existed, which is unambiguous: depth 100 was hard-coded
-- until now, so null reads as 100 everywhere in the app.
alter table public.serp_checks add column if not exists depth integer;

-- 3 · The depth a queued task was posted with, so collection can stamp the
-- resulting check row correctly even if the campaign's setting is changed
-- while its tasks are still in flight.
alter table public.serp_task_queue add column if not exists depth integer;
