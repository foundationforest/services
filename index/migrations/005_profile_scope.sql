-- A profile lives in one market, as one side of it (shapes/README.md): its record names `market` and
-- `role`. A badge counts for the profile only under that scope, `market/role`.
alter table profiles add column market text;
alter table profiles add column role text;

-- A post names no market or side: they are its author profile's, read from `profiles` when a page
-- is built. The search column read `market_written` and `role`, so it is rebuilt without them.
alter table posts drop column search;
alter table posts drop column market_written;
alter table posts drop column market;
alter table posts drop column role;
alter table posts add column search tsvector generated always as (
  to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(area, ''))
) stored;
create index posts_search on posts using gin (search);
create index profiles_market on profiles (market);
