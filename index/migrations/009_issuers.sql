-- Issuers (forest/registry/README.md): what this index called a keeper is an issuer, in forest's
-- words since its 3 October pin. The same rows, under the new names. The scores' `details` name
-- issuers from the readers' first recompute, which runs at start.

alter table rows rename column keeper to issuer;
alter table rows rename column keeper_signature to issuer_signature;
alter table rows rename column keeper_signed to issuer_signed;
