-- Which DataForSEO queue a campaign's checks go through.
--
-- Priority 1 (standard) and priority 2 (high) are separate crawler pools,
-- and high priority costs exactly double. Normally standard comes back
-- within minutes and is the right default — but the pools fail
-- independently: on 2026-08-06 the standard pool sat on tasks for hours
-- while a high-priority probe completed in 40 seconds. This setting exists
-- so a run can be moved to the working pool when that happens, per
-- campaign, with the doubled cost shown before anything is spent.

alter table public.campaigns
  add column if not exists serp_priority integer not null default 1;

alter table public.campaigns
  drop constraint if exists campaigns_serp_priority_check,
  add constraint campaigns_serp_priority_check check (serp_priority in (1, 2));
