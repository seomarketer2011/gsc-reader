-- Whether a tracked keyword's location_name is a location DataForSEO will
-- actually accept, decided when the keyword was added (null = not checked,
-- e.g. the location list was unreachable at the time).
--
-- DataForSEO matches location_name exactly: an unknown name fails the check,
-- and there is no way to tell that apart from "this keyword doesn't rank"
-- without recording it here. Keywords added before this column existed keep
-- null and are re-validated the next time they are added or generated.

alter table public.tracked_keywords add column if not exists location_valid boolean;
