-- The reputation tree (forest/circuits/README.md) and the proofs profiles carry.
--
-- `rows.market_stamp`: the row's market stamp, 64 hex, read from the `register` transaction that wrote
-- the row and kept only when the row's address is derived from it (src/chain/registry.ts). Null until
-- it is found; looked for again on every poll.
alter table rows add column market_stamp text;

-- The reputation proofs on a profile's card that checked when it was stored: index, root, time,
-- signature, score and label, as the card gives them. Whether one is shown is decided per page.
alter table profiles add column proofs jsonb not null default '[]';

-- Every root this index signed, newest last. A root whose leaves did not change keeps its row.
create table reputation_roots (
  id         bigserial primary key,
  root       text not null,
  time       bigint not null,
  signature  text not null,
  leaves     integer not null
);

-- The newest root's leaves, in the tree's order. Rebuilt whole when they change.
create table reputation_leaves (
  position  integer primary key,
  stamp     text not null,
  scope     text not null,
  score     bigint not null,
  count     bigint not null
);
