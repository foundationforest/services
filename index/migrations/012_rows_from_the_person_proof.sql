-- Rows from the person proof (forest/registry/README.md). The registry the index reads moved to a new
-- program whose rows come from the person proof: each holds the stamp, the issuer's key (a point on
-- Baby Jubjub, 128 hex characters, x then y) and the time the chain wrote it, and no root, no
-- signature. The rows of the registry before it count for nothing here, so they go; the chain reader
-- reads the new registry's rows on its next poll, and a profile left with no counted row is dropped
-- by the start's merge (src/records/hosts.ts). `stamp` replaces `market_stamp`, which the index read
-- from each row's transaction: a row now holds it.

delete from rows;
alter table rows drop column root;
alter table rows drop column issuer_signature;
alter table rows drop column issuer_signed;
alter table rows drop column market_stamp;
alter table rows add column stamp text not null;
alter table rows add column made bigint not null;
create index rows_issuer on rows (issuer);
