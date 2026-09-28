-- Thin-SERP detection. Some postcode-district geo-targets make Google
-- return a degenerate SERP — a fraction of the requested depth, dominated
-- by directories and social pages — from which watched sites are filtered
-- out entirely, so "not in the top 100" can be an artifact of the
-- checkpoint rather than a real verdict.
--
-- organic_count records how many organic results the checked SERP actually
-- returned, so a zero backed by a 19-result SERP is tellable apart from a
-- zero on a full one. search_location records where the SERP was actually
-- fetched from when collection fell back to a town-level location; null
-- means the keyword's own stored location.
alter table public.serp_checks
  add column if not exists organic_count integer,
  add column if not exists search_location text;
