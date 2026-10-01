# The loop

Forest end to end on Solana devnet, against the services this repo deploys on Railway, with the
stand-in face check. **Devnet only.** Nothing here is shipped.

`loop.ts` makes two new people each run and takes them through everything once, each step on the
public services (`devnet.json` has their addresses; `../docs/devnet.md` says what each is):

1. **Setup.** Each person's two dollar accounts (USDC-shaped and Open-USD-shaped test dollars) and
   some dollars; the relayer's Open-USD-shaped account once. The deploy key pays; nothing a person
   does later needs SOL.
2. **Two people, two phones.** Headless Chromium, each profile with its own virtual authenticator
   (PRF on). The app's first run makes a passkey on the approval page's origin and the seed from
   its PRF output; each person's profile key and identity come from the seed, as `forest/keys`
   says.
3. **The list.** Each opens a face check at the issuer (the stand-in passes it), submits its
   commitment, and waits for the issuer's batch (every two minutes on devnet). The loop checks the
   roots file (canonical, signed by the issuer the index trusts, its newest root the list's) and
   finds the batch's notes on chain. Then it rebuilds the whole list from the issuer's notes on
   chain alone, as a phone or an index could, and checks it is `list.json` and that every root in
   the roots file is forest's `listRoot` of its prefix.
4. **Badges through the relayer.** Each proves against the list (`buildRegistration`) and sends the
   line through the relayer, paying its fee in the USDC-shaped dollar: `tutoring/seller` and
   `tutoring/buyer`.
5. **Approvals.** Each person's app writes its folder on the test board (`board/`); a folder is never
   requested. Then an assistant drafts through connections' MCP (`forest_draft`): the profile, the
   seller's offer (one hour of maths, 1 USDC-shaped dollar), and later each review. Connections
   answers with the approval link; the person's phone opens it, the page shows the note, one tap
   and the passkey sign it and post it to the board; connections reads the board and says
   "Published".
6. **Two deals on escrow v2**, the buyer paying from the offer, the relayer's fee paid in the deal's
   own dollar:
   - USDC-shaped: one tap, one transaction (deposit address, create, pay, release).
   - Open-USD-shaped: the loop first asks Kora for the one tap as one transaction and records its
     refusal (nothing is sent: Kora 2.0.5's bug, `../docs/kora-issue.md`); then pays, and releases
     once the payment is confirmed: two transactions from one approval.
7. **Reviews** both ways for each deal, each naming its escrow.
8. **The index shows it all:** both badges counted and vouched by the devnet issuer, the offer, both
   deals ended and released to the seller, and each profile's two reviews counted at full weight:
   the buyer opened each escrow and the seller reviewed the deal (`oneSidedConfirmed`,
   `../index/SCORING.md`).

Everything it did goes to `runs/<time>.json`: every address, signature and page.

## Run it

```
./forest.sh records keys registry/client registry/artifacts escrow/v2/client   # from the repo root
(cd forest/registry/artifacts && npm run fetch)                                 # the proving files
cd loop && npm ci
npm run check
npm run loop
```

- **Keys:** the devnet keys forest's `devnet/keys.sh` derives from the devnet phrase, in
  `FOREST_DEVNET_KEYS` (default `~/.forest-devnet/keys`), outside the repo. It uses three: `deploy`
  (pays setup), `test-dollar-authority` (mints the USDC-shaped dollar) and `payer`, the relayer's
  key, which is the Open-USD-shaped dollar's issuer (mints it, signed directly, never through Kora).
- **RPC:** Helius's devnet RPC when `HELIUS_API_KEY` is set, else `https://api.devnet.solana.com`.
- **Chromium** at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or `CHROME_PATH`. Behind a
  TLS-intercepting proxy, its CA must be in Chromium's NSS store (`~/.pki/nssdb`).
- **The issuer's limit:** five face checks an hour per address by default; the devnet issuer allows
  twenty, so a few runs an hour fit.

Each run adds two people to the devnet issuer's list and leaves their profiles, offer, reviews and
receipts on devnet for good. It costs the deploy key about 0.01 SOL of account deposits a run; the
relayer fronts the rest and is paid back in test dollars.

## `board/`

The test board: forest's reference host, for devnet testing only (`board/README.md`). It lives
here because the foundation runs no board.
