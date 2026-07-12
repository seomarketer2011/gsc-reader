-- Standalone keyword research: store the 12-month history and competition
-- index DataForSEO already returns, so trends render without re-fetching.

alter table public.keyword_volumes add column monthly jsonb;
alter table public.keyword_volumes add column competition_index integer;
