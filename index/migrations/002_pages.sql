-- Part two. The receipt follows the escrow as rewritten (escrow/README.md): no accept step and no
-- objection, so no `accepted_at` and no `locked`; instead who created the escrow (the seller, for an
-- invoice), and the two options it was created with, so a receipt says what both sides agreed to.
alter table escrow_receipts drop column accepted_at;
alter table escrow_receipts drop column locked;
alter table escrow_receipts add column creator text not null default 'buyer' check (creator in ('buyer', 'seller'));
alter table escrow_receipts alter column creator drop default;
alter table escrow_receipts add column arbiter text;
alter table escrow_receipts add column timer_days integer;
alter table escrow_receipts add column timer_to text check (timer_to in ('buyer', 'seller'));

-- What the readers tell the pages. The web process reads the database and nothing else, and never
-- holds the signing seed, so the readers write the index's public keys here when they start.
create table index_meta (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
