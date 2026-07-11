-- Phase 2 user state: dismissed opportunities move from browser localStorage
-- into Postgres, and rollouts gain a text key so they can reference Phase 1
-- fixture opportunities (opportunity_id uuid takes over when Phase 4 writes
-- real opportunities to the database).

create table public.user_dismissals (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  opportunity_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, opportunity_key)
);

alter table public.user_dismissals enable row level security;
create policy org_members_all on public.user_dismissals
  for all using (public.is_org_member(organisation_id))
  with check (public.is_org_member(organisation_id));

alter table public.rollouts add column opportunity_key text;
