-- A card's name is optional (forest/records/schemas/profile.json, since the standard's dcec0f9): a
-- card without one is stored with no name, and the pages call it by its market and role word.
alter table profiles alter column name drop not null;
