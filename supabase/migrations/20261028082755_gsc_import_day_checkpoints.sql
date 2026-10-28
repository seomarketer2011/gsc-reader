-- A completed API read can contain no performance rows. Keep that progress
-- separately so empty periods, restarts, and gaps never stall the importer.
-- Do not seed from existing performance rows: the old importer could write
-- incomplete days and their presence does not prove a complete API read.
create table public.gsc_import_days (
  gsc_property_id uuid not null references public.gsc_properties(id) on delete cascade,
  date date not null,
  rows_imported integer not null check (rows_imported >= 0),
  completed_at timestamptz not null default now(),
  primary key (gsc_property_id, date)
);

alter table public.gsc_import_days enable row level security;
-- Import bookkeeping is server-only. The existing import route verifies the
-- signed-in user's organisation membership before using its service client.
revoke all on public.gsc_import_days from public, anon, authenticated;
grant select, insert, update on public.gsc_import_days to service_role;

comment on table public.gsc_import_days is
  'Successful complete GSC day reads, including empty days; server-only import checkpoints.';
