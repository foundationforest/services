-- Rows and keepers (forest/registry/README.md, forest/records/README.md). A profile is named by its
-- address, and its records are read from the hosts in lists/hosts.json, each host in full. A
-- registry row is one market stamp on a keeper's list, and counts when lists/keepers.json names its
-- keeper and the keeper's signature on its root checks: no issuer's roots, no memberships, no proof
-- records. Everything below is read again from the hosts and the chain; the escrow's archive of
-- log lines stays, and the receipts of the escrow this index reads.

drop table memberships;
drop table credentials;
drop table issuer_roots;
drop table kept;
drop table host_entries;
drop table lines;
drop table review_weights;
drop table scores;
drop table reviews;
drop table posts;
drop table profiles;
delete from cursors where source not like 'chain:%';
-- Escrow v1, a separate program, is no longer read; its receipts go. Its log lines stay archived.
delete from escrow_receipts where program_id = '3vAVLwiwFkCUG4AHV3gK3t15HoyRSuKNEuBFvvy9CbeR';

-- Every record read from each host, as its canonical text, in the order this index took them from
-- that host. The view of a profile is computed from all of them (forest's `viewProfile`).
create table host_records (
  host     text not null,
  id       text not null,
  seq      bigserial not null,
  profile  text not null,
  path     text not null,
  text     text not null,
  primary key (host, id)
);
create index host_records_profile on host_records (profile);

-- One row per registry row of a keeper this index trusts, as the program holds it. A row never
-- changes. `root` is 32 bytes as 64 hex, `keeper_signature` 64 bytes as 128 hex; `keeper_signed`
-- is whether that signature checks. `label` is split at the first slash into `market` and `role`.
create table rows (
  address           text primary key,
  profile           text not null,
  keeper            text not null,
  root              text not null,
  keeper_signature  text not null,
  keeper_signed     boolean not null,
  payer             text not null,
  label             text not null,
  market            text not null,
  role              text
);
create index rows_profile on rows (profile);

-- The live content of each profile holding a counted row, from its view. Every other profile's
-- records stay in host_records only. `id` is the id of the record that holds the path now.
create table profiles (
  address     text primary key,
  id          text not null,
  record      jsonb not null,
  name        text not null,
  market      text,
  role        text,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now()
);
create index profiles_market on profiles (market);

create table offers (
  uri           text primary key,
  profile       text not null,
  rkey          text not null,
  id            text not null,
  record        jsonb not null,
  direction     text not null,
  description   text not null,
  price_amount  text,
  price_mint    text,
  price_per     text,
  remote        boolean,
  lat           double precision,
  lon           double precision,
  precision_km  integer,
  area          text,
  expires       timestamptz,
  created_at    timestamptz,
  indexed_at    timestamptz not null default now(),
  search        tsvector generated always as (
    to_tsvector('simple', coalesce(description, '') || ' ' || coalesce(area, ''))
  ) stored
);
create index offers_profile on offers (profile);
create index offers_search on offers using gin (search);

create table reviews (
  uri         text primary key,
  reviewer    text not null,
  rkey        text not null,
  id          text not null,
  record      jsonb not null,
  subject     text not null,
  overall     numeric(3, 1),
  text        text,
  deal_id     text,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now()
);
create index reviews_subject on reviews (subject);
create index reviews_reviewer on reviews (reviewer);
create index reviews_deal on reviews (deal_id);

-- How each review was weighed in the last recompute. Derived, like the scores; rebuilt whole each time.
create table review_weights (
  uri              text primary key,
  counted          boolean not null,
  skipped          text,
  evidence_kind    text not null,
  evidence_note    text,
  evidence_weight  double precision not null,
  reviewer_weight  double precision not null,
  contribution     double precision not null
);

-- Scores, recomputed as data arrives. `kind` is 'uniqueness' (one row per counted label), 'standing'
-- or 'rating' (label ''). The value is in millionths. Each row carries the statement the index
-- signed and both signatures; a row whose value has not changed keeps its old statement.
create table scores (
  profile       text not null,
  kind          text not null,
  label         text not null,
  value_micro   bigint not null,
  details       jsonb not null,
  statement     text not null,
  message       text not null,
  sig_ed25519   text not null,
  sig_eddsa     jsonb not null,
  computed_at   bigint not null,
  primary key (profile, kind, label)
);
