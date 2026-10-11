-- Two upgrades to the attempt log, from review. First, counts alone cannot
-- reconstruct a flip like "absent at 10:04, #1 an hour later": each attempt
-- now stores the watched domains it actually saw, with positions, as
-- compact jsonb ([{"d":"sw12locksmithbalham.co.uk","p":1},...]). Second,
-- collection retries (queue rows kept after a failed write) could insert
-- the same provider task twice, so attempts are unique per task_id and the
-- collector upserts with duplicates ignored.
alter table public.serp_check_attempts
  add column if not exists rankings jsonb;

delete from public.serp_check_attempts a
  using public.serp_check_attempts b
  where a.task_id = b.task_id and a.id > b.id;

create unique index if not exists serp_check_attempts_task_idx
  on public.serp_check_attempts (task_id);
