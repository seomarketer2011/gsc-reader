-- Standard-queue rank checking: SERP tasks are posted to DataForSEO's task
-- queue (~3x cheaper than live mode, massively parallel on their side) and
-- collected a few minutes later. One row per in-flight task; the row is
-- deleted once the result (or a permanent error) lands in serp_checks.

create table public.serp_task_queue (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  keyword_id uuid not null references public.tracked_keywords (id) on delete cascade,
  task_id text not null,
  check_date date not null default current_date,
  posted_at timestamptz not null default now(),
  unique (keyword_id, check_date)
);

create index idx_serp_task_queue_org on public.serp_task_queue (organisation_id, posted_at);

alter table public.serp_task_queue enable row level security;
create policy org_members_all on public.serp_task_queue
  for all using (public.is_org_member(organisation_id))
  with check (public.is_org_member(organisation_id));
