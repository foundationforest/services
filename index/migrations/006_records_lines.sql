-- The records layer and the registry changed (forest records/SPEC.md, registry/README.md). Records
-- are signed entries read from hosts, and a profile is named by its did:key; a badge is a registry
-- line holding one issuer's root, plus membership records in the profile's folder for more issuers.
-- What the firehose and the earlier registry stored is dropped: the hosts' feeds and the registry's
-- own accounts fill it again. The escrows' archive stays.

delete from review_weights;
delete from scores;
delete from profiles;
delete from posts;
delete from reviews;
delete from credentials;
delete from cursors where source like 'firehose:%';
drop table badges;

-- An entry's id replaces the record's content id in `cid`; nothing replaces a repository's `rev`.
-- `wallet` is the profile key's own address: the profile key is the wallet.
alter table profiles drop column rev;

-- Every entry this index took from each host, as its canonical text, in the order it took them from
-- that host. Per host and profile that is the host's own order, which is what the merge reads
-- (records/SPEC.md §5).
create table host_entries (
  host     text not null,
  id       text not null,
  seq      bigserial not null,
  profile  text not null,
  text     text not null,
  primary key (host, id)
);
create index host_entries_profile on host_entries (profile, host, seq);

-- One row per registry line, as the registry's own account holds it (the bump aside). A line never
-- changes after it is written. `code` and `root` are 32 bytes as lowercase hex; `label` is split at
-- the first slash into `market` and `role`. Whether it counts is decided when it is read.
create table lines (
  address  text primary key,
  code     text not null unique,
  did      text not null,
  wallet   text not null,
  label    text not null,
  market   text not null,
  role     text,
  root     text not null,
  time     timestamptz not null,
  payer    text not null
);
create index lines_did on lines (did);
create index lines_root on lines (root);

-- The roots each trusted issuer published, from its signed roots file. Only ever added to.
create table issuer_roots (
  issuer  text not null,
  root    text not null,
  size    integer not null,
  time    timestamptz not null,
  primary key (issuer, root)
);
create index issuer_roots_root on issuer_roots (root);

-- Proofs of the membership kind (`proof/<id>` in a profile's folder): the same human's line, vouched
-- for by one more issuer. `status` is the last check: valid; invalid (the proof fails, for good for
-- this version of the record); or pending, with why (no line yet, an issuer this index does not
-- trust, a root that issuer has not published).
create table memberships (
  uri         text primary key,
  did         text not null,
  cid         text not null,
  record      jsonb not null,
  issuer      text not null,
  label       text not null,
  code        text not null,
  root        text not null,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now(),
  status      text not null default 'pending' check (status in ('valid', 'invalid', 'pending')),
  why         text,
  checked_at  timestamptz
);
create index memberships_did on memberships (did);
create index memberships_code on memberships (code);

-- Escrow v2's objection: which side objected, and when. It moves no money.
alter table escrow_receipts add column objected_by text check (objected_by in ('buyer', 'seller'));
alter table escrow_receipts add column objected_at timestamptz;
