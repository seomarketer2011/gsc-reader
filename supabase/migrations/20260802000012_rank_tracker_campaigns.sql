-- Rank-tracker campaigns: a campaign owns its own domain list and its own
-- keyword list, so one organisation can track a single client site with five
-- keywords alongside a 292-site network without the two mixing — and without
-- a check on one paying for the other.
--
-- campaign_id has existed on both tables since the tracker shipped but was
-- never written. This makes it required, backfills everything already
-- tracked into one campaign per organisation, and moves the uniqueness rules
-- under the campaign so two campaigns can track the same keyword or domain
-- independently.

-- 1 · A campaign to hold whatever each organisation already tracks. Reuses a
-- same-named group if one exists (campaign names are unique per org).
insert into public.campaigns (organisation_id, name)
select distinct t.organisation_id, 'Rank tracker'
  from (
    select organisation_id from public.tracked_domains where campaign_id is null
    union
    select organisation_id from public.tracked_keywords where campaign_id is null
  ) t
 where not exists (
   select 1
     from public.campaigns c
    where c.organisation_id = t.organisation_id
      and c.name = 'Rank tracker'
 );

update public.tracked_domains d
   set campaign_id = c.id
  from public.campaigns c
 where d.campaign_id is null
   and c.organisation_id = d.organisation_id
   and c.name = 'Rank tracker';

update public.tracked_keywords k
   set campaign_id = c.id
  from public.campaigns c
 where k.campaign_id is null
   and c.organisation_id = k.organisation_id
   and c.name = 'Rank tracker';

-- 2 · GSC-connected sites used to be watched implicitly by every check. A
-- campaign now watches exactly its own domain list, so make that membership
-- explicit for the campaign that inherited the existing setup — otherwise
-- those sites would silently drop out of the results.
insert into public.tracked_domains (organisation_id, campaign_id, domain)
select distinct
       s.organisation_id,
       c.id,
       split_part(regexp_replace(lower(s.domain), '^(https?://)?(www\.)?', ''), '/', 1)
  from public.sites s
  join public.campaigns c
    on c.organisation_id = s.organisation_id
   and c.name = 'Rank tracker'
 where not exists (
   select 1
     from public.tracked_domains d
    where d.campaign_id = c.id
      and d.domain =
          split_part(regexp_replace(lower(s.domain), '^(https?://)?(www\.)?', ''), '/', 1)
 );

-- 3 · Required from here on; deleting a campaign takes its domains, keywords
-- and (by cascade from tracked_keywords) their ranking history with it.
alter table public.tracked_domains alter column campaign_id set not null;
alter table public.tracked_keywords alter column campaign_id set not null;

alter table public.tracked_domains
  drop constraint if exists tracked_domains_campaign_id_fkey,
  add constraint tracked_domains_campaign_id_fkey
    foreign key (campaign_id) references public.campaigns (id) on delete cascade,
  drop constraint if exists tracked_domains_organisation_id_domain_key,
  drop constraint if exists tracked_domains_campaign_id_domain_key,
  add constraint tracked_domains_campaign_id_domain_key unique (campaign_id, domain);

alter table public.tracked_keywords
  drop constraint if exists tracked_keywords_campaign_id_fkey,
  add constraint tracked_keywords_campaign_id_fkey
    foreign key (campaign_id) references public.campaigns (id) on delete cascade,
  drop constraint if exists tracked_keywords_organisation_id_keyword_location_name_key,
  drop constraint if exists tracked_keywords_campaign_id_keyword_location_name_key,
  add constraint tracked_keywords_campaign_id_keyword_location_name_key
    unique (campaign_id, keyword, location_name);

create index if not exists idx_tracked_domains_campaign
  on public.tracked_domains (campaign_id);
create index if not exists idx_tracked_keywords_campaign
  on public.tracked_keywords (campaign_id);
