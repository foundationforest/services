# loop

Devnet only: the loop runs against the devnet services and leaves everything it makes on devnet.
Nothing is shipped.

Up: [the repo](../README.md). What it runs against: [docs/devnet.md](../docs/devnet.md). The test
board it writes to: [board/](board/README.md).

The loop is one script, `loop.ts`, that takes two new people through Forest end to end on the
services this repo deploys, the way two phones and an assistant would: a face check, a badge each,
a profile and an offer, two paid deals, reviews both ways, and the index showing all of it. It is
the proof that the deployed services work together. It is not deployed; someone runs it by hand.

## What a run does

Each run makes two new people, a seller and a buyer, in the market `tutoring`:

1. **Setup.** Each person's token accounts for the two test dollars, and some dollars: 5.00
   USDC-shaped to the seller; 15.00 USDC-shaped and 10.00 Open-USD-shaped to the buyer. The
   relayer's Open-USD-shaped account, once. The deploy key pays; nothing a person does later needs
   SOL.
2. **Two phones.** Headless Chromium, each person with a virtual authenticator (PRF on). Each makes
   a passkey on the approval page's origin; the seed comes from its PRF output, and the profile key
   and identity secret from the seed, as forest's keys recipe says.
3. **The issuer's list.** Each opens a face check (the stand-in passes it), submits its commitment,
   and waits for the next batch. The loop checks the roots file (canonical, signed by the issuer the
   index trusts, its newest root the list's root), then rebuilds the whole list from the issuer's
   notes on chain alone and checks it equals `list.json` and that every root is forest's `listRoot`
   of its prefix.
4. **Badges through the relayer.** Each proves against the list and sends its registry line through
   the relayer, paying in the USDC-shaped dollar: `tutoring/seller` and `tutoring/buyer`.
5. **Records through approvals.** Each person's app writes its folder on the test board. Then an
   assistant drafts through connections (`forest_draft`): each profile, the seller's offer (one hour
   of maths, 1 USDC-shaped dollar), and later each review. The phone opens the approval link, the
   page shows the record, one tap and the passkey sign it and post it to the board, and connections
   reports it published.
6. **Two deals on escrow v2,** the buyer paying from the offer, the relayer paid in the deal's own
   dollar:
   - USDC-shaped: one tap, one transaction (deposit address, create, pay, release).
   - Open-USD-shaped: the loop first asks the relayer for the one tap as one transaction and checks
     Kora 2.0.5 refuses it (nothing is sent; [docs/kora-issue.md](../docs/kora-issue.md)), then
     pays, and releases once the payment is confirmed.
7. **Reviews** both ways for each deal, each naming its escrow.
8. **The index shows it all:** both badges counted and vouched for by the devnet issuer, the offer,
   both deals released to the seller with two reviews each, and each profile's two reviews counted
   at full weight (`oneSidedConfirmed`: the buyer opened the escrow and the seller reviewed the
   deal).

Every address, signature and page goes to `runs/<start time>.json`, whether the run passes or not.
The script exits 0 when it passes, 1 when it fails.

## What it trusts

- **The devnet keys** forest's `devnet/keys.sh` derives from the devnet phrase, read from outside
  the repo. It uses three: `deploy` (pays setup), `test-dollar-authority` (mints the USDC-shaped
  dollar) and `payer`, the relayer's key, which is also the Open-USD-shaped dollar's issuer and
  mints it, signing directly, never through Kora.
- **The addresses in `devnet.json`:** the five services, the devnet programs, the issuer's did:key,
  the two test dollars and the market.

## Run it

Node 22.18 or later. From the repo root:

```
./forest.sh records keys registry/client registry/artifacts escrow/v2/client
(cd forest/registry/artifacts && npm run fetch)     # the proving files
cd loop && npm ci
npm run check
npm run loop                                        # about three minutes
```

| Variable | Default | What |
|---|---|---|
| `FOREST_DEVNET_KEYS` | `~/.forest-devnet/keys` | The folder holding `deploy.json`, `test-dollar-authority.json` and `payer.json` |
| `HELIUS_API_KEY` | none | Use Helius's devnet RPC; otherwise `https://api.devnet.solana.com`. The key is redacted from the run's record |
| `CHROME_PATH` | `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` | Chromium. Behind a TLS-intercepting proxy, the proxy's certificates must be in Chromium's NSS store (`~/.pki/nssdb`) |

## Limits

- **Every run is permanent on devnet:** two more people on the devnet issuer's list, two badges,
  their records on the test board, and two receipts. About 0.01 SOL of the deploy key's per run.
- **It needs the devnet issuer's stand-in face check,** which passes everyone, and the issuer's
  devnet session limit (20 an hour per address) so a few runs an hour fit.
- **It mints test dollars with the relayer's own key,** outside Kora: a devnet shortcut only.
- **Not in CI.** It needs the devnet keys and the live services.
