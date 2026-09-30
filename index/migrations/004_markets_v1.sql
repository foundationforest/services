-- Markets v1 (shapes/README.md). A post's price is optional, since a market may have no money, and
-- its location is a point and a place: `lat` and `lon` in degrees (decimal text in the record), how
-- far the point may be from the real place in whole kilometres (0 for an exact point), and the place
-- in words. The search column read the old `location`, so it is rebuilt on `area`.
alter table posts drop column search;
alter table posts drop column location;
alter table posts add column lat double precision;
alter table posts add column lon double precision;
alter table posts add column precision_km integer;
alter table posts add column area text;
alter table posts alter column price_amount drop not null;
alter table posts alter column price_mint drop not null;
alter table posts alter column price_per drop not null;
alter table posts add column search tsvector generated always as (
  to_tsvector('simple', coalesce(market_written, '') || ' ' || coalesce(role, '') || ' ' ||
                        coalesce(description, '') || ' ' || coalesce(area, ''))
) stored;
create index posts_search on posts using gin (search);

-- A review rates by name, from 1.0 to 10.0. The index reads `overall`; the rest stay in `record`.
alter table reviews drop column rating;
alter table reviews add column overall numeric(3, 1);

-- Trust is now called standing, and the rating is a score of its own. A trust row's statement says
-- `kind trust`, so it is dropped and the next recompute signs it afresh as standing.
delete from scores where kind = 'trust';
