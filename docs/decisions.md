# Decisions

Devnet only: nothing here is shipped, and nothing is on mainnet.

Up: [the repo](../README.md).

Why these services are shaped the way they are: one line per decision, with its reason. Each holds
for the code today. Smaller choices live in comments beside the code and in git history. A new
decision that shapes these services goes here, in the same form.

## The repo

- **Forest at one pinned commit, fetched by `forest.sh`; not a submodule, not a copy:** Railway must
  build every image from the repo root, and a copy would drift from forest.
- **CI runs every fast check from a clean install and fails on any skip:** a missing piece must
  never pass as green.

## Index

- **It keeps only profiles holding a line a trusted issuer vouches for, plus other lined profiles'
  proof records:** an unvouched profile is no one the index can weigh, and a membership among those
  proofs may earn one trust.
- **A board's `badged` flag is a hint; the index checks every line itself:** a board decides only
  what it sends, never who is badged.
- **Boards in `HOSTS` are read in full; any other only while a kept profile's folder names it, and
  for badged profiles only:** crawling grows with the profiles the index keeps, not with the
  network.
- **A board still answering after 60 seconds is skipped until it finishes:** one slow board never
  holds up the rest.
- **By default the index trusts no issuer:** a key nobody runs must never vouch, and each operator
  names the issuers it trusts.
- **It reads an issuer's roots, never its list, from its signed file or its notes on chain, either
  one:** counting a line needs only its root, and either source proves the issuer published it.
- **A badge counts only as `market/role`, the market a directory name byte for byte, under the
  profile's own market and role:** any other spelling counting would give one person two badges in
  one market.
- **The market directory is read from the `markets` repo itself, never copied, and only the fields
  the index reads are checked:** one source of names, and forest holds no market-file validator.
- **Escrow events are read only as each program itself wrote them, and their logs archived in the
  index's own table:** another program can print the same bytes, and RPC nodes are not an archive.
- **Every score is signed twice, Ed25519 and EdDSA-Poseidon, and a score that did not change keeps
  its signatures:** anyone can check the first, a later zero-knowledge proof can check the second
  cheaply, and a signature someone holds stays good.
- **Every page is plain HTML with a JSON twin at the same address, the very object the page renders,
  plus `llms.txt` and the read skill:** people and AI agents read the same facts, and the two never
  disagree.
- **Pages state facts and advise nothing about an offer's or a receipt's escrow options:** what to
  say is each app's.
- **The Pay link names the offer and its entry id, never the seller's key:** a forged link cannot
  redirect money.

## Issuer

- **A session and a commitment are never stored side by side:** two tables with no timestamps or
  row numbers, deleted bytes overwritten, the file rewritten after every batch, so nothing ties a
  face check to a place on the list.
- **Batches, shuffled, hourly or at 50:** a place on the list cannot be matched to a face check by
  when it arrived.
- **The list and its signed roots are two files the issuer serves itself; the registry never sees
  a list:** issuers are an open slot, and the program checks no root.
- **The roots file is signed as a record is, under its own label after `0xff`:** neither signature
  can pass for the other, or for a Solana transaction.
- **Each batch also goes on chain, its root and members in memo notes its key signs, each note
  repeating the root's line:** the whole list can be rebuilt from the chain alone, and every note
  reads alone.
- **`POSSIBLE_DUPLICATED_FACE` refuses like `DUPLICATED_FACE`, and every Didit session carries a
  fresh random `vendor_data`:** "not a duplicate" is not what Didit said, and the random id names
  nobody.
- **Everything an app sends is a POST body, never in a URL:** hosting platforms log paths.
- **The session limit lives in memory as keyed hashes, an IPv6 address counted by its /64:** it
  stops one person running up the Didit bill without writing down an address.
- **A refused or failed submit uses nothing up:** a session in review may be approved later.

## Relayer

- **Kora 2.0.5, the latest stable release, configured only:** no custom code, and the 2.2 betas are
  not stable.
- **Margin 0, and no compute budget program:** the charge is the cost, and the relayer never pays a
  priority fee it did not agree to.
- **The relayer's key may only fund new accounts it is paid for:** no transaction can make it move
  its own SOL or tokens.
- **Paid in USDC, USDT, Open USD or EURC on mainnet, each its issuer's own mint, the issuers' freeze
  and Open USD's permanent delegate accepted:** people pay in what they hold (the founder's choice,
  2026-10-01).
- **No API key:** a page in a browser cannot keep a secret, and every transaction pays its way.

## Connections and the test board

- **Forest's connections service, unchanged, behind a pass-through front, serving forest's own
  approval page with its hash beside it:** forest's listens on loopback only, and the published hash
  must be the hash of what is served.
- **The test board lives in `loop/`, for devnet testing only:** the foundation runs no board.
