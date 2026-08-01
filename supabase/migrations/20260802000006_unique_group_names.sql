-- Site groups (campaigns) must have unique names per organisation.
-- Repeated form submissions could previously insert the same group many
-- times; this removes those duplicates (keeping the oldest of each name —
-- campaign_sites rows cascade away with them) and blocks new ones.

delete from public.campaigns c
using public.campaigns k
where c.organisation_id = k.organisation_id
  and c.name = k.name
  and c.id <> k.id
  and (k.created_at < c.created_at or (k.created_at = c.created_at and k.id < c.id));

create unique index if not exists uniq_campaigns_org_name
  on public.campaigns (organisation_id, name);
