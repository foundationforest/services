-- Scores are signed once, with ed25519 over the statement's text (src/scores/sign.ts). The second
-- signature, EdDSA over Poseidon on Baby Jubjub over one field element, and that field element go:
-- nothing read them. Each score's statement and ed25519 signature stay as they were.

alter table scores drop column message;
alter table scores drop column sig_eddsa;
