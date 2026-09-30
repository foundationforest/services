# Draft issue for Kora

For the founder to file at https://github.com/solana-foundation/kora/issues. Written from Kora
2.0.5's source (the `kora-lib` 2.0.5 crate) and from a refusal seen on Solana devnet
(`loop/`, below). Nothing in it names Forest's users.

---

**Title:** 2.0.5: a Token-2022 transfer out of an account created in the same transaction is refused as "Account … not found", even when it does not pay Kora

**Version:** Kora 2.0.5 (`ghcr.io/solana-foundation/kora:v2.0.5`, `kora-lib` 2.0.5).

**What happens**

A transaction is refused with `Account <address> not found` when it holds a Token-2022 transfer
whose **source** account is created earlier in the same transaction and whose **destination**
already exists, even though that transfer has nothing to do with paying Kora.

A common case: an escrow program's "pay and release in one transaction". The transaction

1. creates the escrow's deposit account (a top-level associated-token-account instruction);
2. the buyer transfers the amount into it (`transfer_checked`, Token-2022);
3. the escrow program releases: inside its own call it transfers from the deposit account to the
   seller's existing token account (`transfer_checked`, Token-2022, an inner instruction);
4. the buyer pays Kora its fee (a plain transfer to Kora's payment account).

Kora refuses it at step 3's transfer: the deposit account is not on chain yet, only in the
transaction. The same transaction with a classic SPL token passes. The same steps split in two
transactions (1, 2 and 4; then 3 and 4) pass.

**Why, in the source** (`kora-lib` 2.0.5, `src/token/token.rs`)

`TokenUtil::verify_token_payment` (line 529) walks every SPL transfer in the transaction, inner
instructions included (they come from the simulation, `versioned_transaction.rs` line 135). For
each Token-2022 transfer whose destination exists, it calls
`validate_token2022_extensions_for_payment` (line 577), which fetches the **source** account by RPC
(line 441) and fails with `AccountNotFound` when it is not on chain. Only after that (line 624) does
it check whether the transfer's destination is Kora's payment address, and skip it if not. So a
transfer that pays someone else can fail the whole transaction on an account Kora never needed to
read.

`2.2.0-beta.8` looks fixed: `calculate_payment_lamport_totals` resolves the source and destination
with `resolve_token_account_owner_and_mint`, which also finds accounts created in the transaction,
skips transfers that neither pay nor come from Kora, and runs the extension check only for a
transfer into Kora's account. We have not run the beta.

**Suggested fix for 2.0.x**

In `verify_token_payment`, check `destination_owner != *expected_destination_owner` (and the
supported-mint check) before calling `validate_token2022_extensions_for_payment`, so the extension
check runs only for transfers that pay Kora. Optionally, when the source is not found, look for its
creation in the transaction, as the destination branch already does
(`find_ata_creation_for_destination`).

**To reproduce**

- Kora 2.0.5 with the Token-2022 program in `allowed_programs`, any `price_source`.
- A Token-2022 mint; a payer holding it; a recipient whose associated token account exists.
- One transaction, Kora as fee payer: create an associated token account for a program-derived
  owner (the deposit account); `transfer_checked` into it; a program instruction that
  `transfer_checked`s from it to the recipient, signed by the program; a transfer paying Kora.
- `signAndSendTransaction` answers `Account <deposit account> not found`.

**Seen on Solana devnet:** see "The Kora refusal" in `docs/devnet.md` for the transaction as sent
and Kora's answer, from the run recorded there.

**Workaround we use:** send the payment and the release as two transactions from one approval, the
second once the first is confirmed.
