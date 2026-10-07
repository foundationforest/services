-- Tiers (forest/records/README.md, "Proofs"): the person proofs on a profile's card that checked
-- against their rows when it was stored, each as {issuer, label, stamp, tier}, as the card gives
-- them. A row weighs its issuer's weight at the tier shown for its stamp. Every card is stored
-- again by the readers' start, which checks its proofs then: nothing to fill in here.

alter table profiles add column tiers jsonb not null default '[]';
