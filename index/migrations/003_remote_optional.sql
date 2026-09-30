-- A post's `remote` is optional in shapes/' post lexicon: a post may say it happens online, name a
-- place, or say neither. Null is "the post doesn't say".
alter table posts alter column remote drop not null;
