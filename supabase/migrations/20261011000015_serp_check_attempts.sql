-- Append-only log of every collected SERP check. serp_checks is unique per
-- keyword/day and a same-day re-check overwrites it — but Google has been
-- observed (live probes, 11 Oct 2026, mid spam update) serving a #1 SERP
-- and a not-in-top-100 SERP for the SAME query, location and device,
-- minutes apart. Overwriting means only the last roll of that dice
-- survives and flux is invisible. This table keeps every roll: where the
-- SERP was fetched from, on what device, how many organic results it had,
-- how many watched domains ranked, and the provider task id. Written
-- best-effort by the collector; nothing reads it in the app yet.
create table if not exists public.serp_check_attempts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  keyword_id uuid not null references public.tracked_keywords(id) on delete cascade,
  check_date date not null default current_date,
  posted_location text,
  device text,
  organic_count integer,
  rankings_count integer,
  task_id text,
  created_at timestamptz not null default now()
);

create index if not exists serp_check_attempts_kw_date_idx
  on public.serp_check_attempts (keyword_id, check_date);

alter table public.serp_check_attempts enable row level security;

-- Members read their organisation's attempts; writes come from the
-- service-role collector only (no insert/update/delete policies).
create policy "serp_check_attempts member read" on public.serp_check_attempts
  for select using (
    organisation_id in (
      select organisation_id from public.organisation_users where user_id = auth.uid()
    )
  );
