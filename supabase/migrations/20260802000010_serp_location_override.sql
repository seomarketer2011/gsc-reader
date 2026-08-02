-- Optional per-domain SERP checkpoint, separate from the town: the town
-- feeds keyword wording ("locksmith bickley") while serp_location is where
-- DataForSEO simulates the searcher (e.g. postcode district "BR1", or
-- "London Borough of Lewisham"). Null = derive from the town as before.

alter table public.tracked_domains add column if not exists serp_location text;
