-- Issuers' roots read from the chain (src/chain/roots.ts): the transaction a root's memo is in.
-- Null for a root seen only in its issuer's roots file.
alter table issuer_roots add column signature text;
