-- The index's data, part one. Plain SQL, applied in file order by src/db.ts, each once, recorded in
-- schema_migrations. Everything here can be rebuilt from the firehose and the chain archive; the
-- archive of the chain's logs (chain_transactions) is the one table worth keeping for its own sake.

-- Records, one table per shape. Each row is a record whose commit verified against its DID
-- document and whose value passed shapes/' lexicon check. `record` is the value as signed, in
-- AT Protocol's JSON form.

create table profiles (
  did         text primary key,
  cid         text not null,
  rev         text not null,
  record      jsonb not null,
  name        text not null,
  -- The wallet the profile declares. A badge counts for this DID only when its entry names it.
  wallet      text,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now()
);
create index profiles_wallet on profiles (wallet);

create table posts (
  uri             text primary key,
  did             text not null,
  rkey            text not null,
  cid             text not null,
  record          jsonb not null,
  direction       text not null,
  -- The market name as the post wrote it, and the directory name it resolves to through the
  -- directory and the aliases (null when it resolves to none: stored, never listed).
  market_written  text not null,
  market          text,
  role            text not null,
  description     text not null,
  price_amount    text not null,
  price_mint      text not null,
  price_per       text not null,
  remote          boolean not null,
  location        text,
  expires         timestamptz,
  created_at      timestamptz,
  indexed_at      timestamptz not null default now(),
  search          tsvector generated always as (
    to_tsvector('simple', coalesce(market_written, '') || ' ' || coalesce(role, '') || ' ' ||
                          coalesce(description, '') || ' ' || coalesce(location, ''))
  ) stored
);
create index posts_did on posts (did);
create index posts_market on posts (market, direction);
create index posts_search on posts using gin (search);

create table reviews (
  uri         text primary key,
  reviewer    text not null,
  rkey        text not null,
  cid         text not null,
  record      jsonb not null,
  subject     text not null,
  rating      integer,
  text        text,
  deal_id     text,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now()
);
create index reviews_subject on reviews (subject);
create index reviews_reviewer on reviews (reviewer);
create index reviews_deal on reviews (deal_id);

create table credentials (
  uri         text primary key,
  did         text not null,
  rkey        text not null,
  cid         text not null,
  record      jsonb not null,
  issuer      text not null,
  created_at  timestamptz,
  indexed_at  timestamptz not null default now()
);
create index credentials_did on credentials (did);

-- The chain. Only transactions that succeeded, and only log lines the program itself wrote, are
-- decoded (the clients' own rule). The raw logs are kept: RPC nodes are not an archive.

create table chain_transactions (
  signature   text primary key,
  program_id  text not null,
  slot        bigint not null,
  block_time  timestamptz,
  logs        jsonb not null,
  indexed_at  timestamptz not null default now()
);

-- One row per `Registered` entry. `scope` is the name the proof was made for, byte for byte;
-- `market` and `role` are it split at the first colon. Whether it counts is decided when it is
-- read: the market must be a directory name and the profile must declare `wallet`.
create table badges (
  signature   text not null references chain_transactions (signature),
  ix          integer not null,
  scope       text not null,
  market      text not null,
  role        text,
  did         text not null,
  wallet      text not null,
  code        text not null unique,
  list_index  integer not null,
  list_owner  text not null,
  slot        bigint not null,
  block_time  timestamptz,
  primary key (signature, ix)
);
create index badges_did on badges (did);

-- One row per escrow address: the permanent receipt, rebuilt from the escrow program's own events
-- through src/chain/escrow.ts. A never-funded escrow that closes is marked closed; if its address
-- is opened again, the new `Created` starts the row afresh.
create table escrow_receipts (
  escrow       text primary key,
  program_id   text not null,
  buyer        text not null,
  seller       text not null,
  mint         text not null,
  amount       numeric(20, 0) not null,
  created_at   timestamptz,
  funded_at    timestamptz,
  accepted_at  timestamptz,
  ended_at     timestamptz,
  outcome      text,
  to_seller    numeric(20, 0),
  to_buyer     numeric(20, 0),
  -- An `Objected` with no ending after it: the mark on both parties.
  locked       boolean not null default false,
  closed       boolean not null default false,
  signature    text not null,
  updated_at   timestamptz not null default now()
);
create index escrow_receipts_buyer on escrow_receipts (buyer);
create index escrow_receipts_seller on escrow_receipts (seller);

-- Where each reader is: the firehose's last sequence number per service, the last transaction
-- read per program.
create table cursors (
  source  text primary key,
  value   text not null
);

-- How each review was weighed in the last recompute: the evidence under it and its reviewer's
-- weight. Derived, like the scores; rebuilt whole each time.
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

-- Scores, recomputed as data arrives. `kind` is 'uniqueness' (one row per counted badge scope)
-- or 'trust' (scope ''). The value is in millionths. Each row carries the statement the index
-- signed and both signatures; a row whose value has not changed keeps its old statement.
create table scores (
  did           text not null,
  kind          text not null,
  scope         text not null,
  value_micro   bigint not null,
  details       jsonb not null,
  statement     text not null,
  message       text not null,
  sig_ed25519   text not null,
  sig_eddsa     jsonb not null,
  computed_at   bigint not null,
  primary key (did, kind, scope)
);
