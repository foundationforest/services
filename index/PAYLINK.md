# The Pay link

The one format for paying for an offer from any app. The index shows a Pay link on every live offer
whose profile names a key to be paid at. **The index never pays and never holds money: it links.**
Any app that follows the escrow client (`escrow/client`) can open the link and make the payment.

**Nothing here is shipped.** Version 1 of the format, tested locally.

## The format

    https://forest.foundation/pay?v=1
      &offer=<the offer's record address>
      &cid=<the record's content id>
      &price.amount=<whole units, decimal text>
      &price.mint=<the currency, by its mint address>
      &price.per=<hour | day | job>
      [&terms.arbiter=<key>]
      [&terms.timer.days=<1..65535>&terms.timer.to=<seller | buyer>]

One line, parameters URL-encoded, always in this order, so two apps that build the same link write
the same string. Another index writes its own address in place of `https://forest.foundation`.

| Parameter | What |
|---|---|
| `v` | `1`. An app refuses a version it does not know |
| `offer` | The offer's record address: `at://<did>/foundation.forest.post/<rkey>` |
| `cid` | The record's content id: which version of the offer the terms below are from |
| `price.amount`, `price.mint`, `price.per` | The post record's own `price` block, field by field |
| `terms.arbiter` | The post's `terms.arbiter`, only if the offer names one |
| `terms.timer.days`, `terms.timer.to` | The post's `terms.timer`, only if the offer sets one; both or neither |

Every parameter after `cid` is the post record's own field, named by its path in the record
(`shapes/lexicons/foundation/forest/post.json`). An app ignores parameters it does not know, so
version 1 can grow. Only an offer with a price has a Pay link: a post's price is optional.

An example, from the index's test data:

    https://forest.foundation/pay?v=1&offer=at%3A%2F%2Fdid%3Aplc%3Aexampleana22222222222222%2Ffoundation.forest.post%2F3kzq2vrffxb2c&cid=bafyreiexampleanaportuguese2222&price.amount=25&price.mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&price.per=hour

## What is not in it, on purpose

**The seller's key.** A link can be forged by anyone, and a key in it would be the one field that
sends money somewhere. So the app must read the seller's key from the seller's own profile record:
the DID in `offer` names the folder, and its profile record names the key (`wallet`). A link that
lies about its price or terms is caught by the next step; a link cannot redirect a payment.

## What an app does with it

1. **Read it.** Check `v`, and that every parameter has the shape above.
2. **Check it against the record.** Fetch the offer record at `offer` (from the seller's own host
   through the DID document, or from any index: `/profiles/<did>.json` lists the offers with their
   `cid`). If the record's content id is not `cid`, the offer changed after the link was made:
   show the record's terms, not the link's. If the content id matches but a field differs, the link
   was altered.
3. **Find the seller's key** in the seller's profile record, as above.
4. **Agree the amount.** `price.amount` is per hour, per day or for the job; the app asks how many
   hours or days and multiplies, then converts whole units to base units by the currency's decimals.
5. **Make the escrow and pay,** with the escrow client: `termsFor(post.terms, { seller, amount })`,
   then `payInOneTap` to create, pay and release in one transaction, or `createIx` and a plain
   transfer to hold the money until the work is done. Before paying into an escrow someone else
   created, check it with `optionsNotAgreed` (see `escrow/client/src/terms.ts`).

The index's own page at the link (`/pay?…`) shows the offer in plain words and whether the link
still matches it; its twin (`/pay.json?…`) says the same for machines, in `check`:

| `check` | Meaning |
|---|---|
| `matches` | The link is the offer as indexed now |
| `changed` | The offer was edited since (another `cid`); the page shows it as it is now |
| `differs` | Same `cid`, another price or terms: the link was altered |
| `notLive` | The offer expired, or is no longer in a directory market |
| `noPrice` | The offer names no price, so it has no Pay link |
| `noKey` | The seller's profile names no key to be paid at |
| `notFound` | This index has no offer at that address |
| `invalid` | Not a complete link |

## The two links

The handoff's pay link is "a one-time Solana Pay link naming the escrow's address". That link needs
an escrow, and an escrow exists only once someone creates it: the buyer's app, or the seller
invoicing. So there are two links, one after the other:

- **This link, on an offer,** before any escrow: which offer, on what terms. The index makes it.
- **The escrow client's Solana Pay link** (`solanaPayUrl`, `invoice` in `escrow/client/src/pay.ts`),
  once an escrow exists: where to send exactly what is still missing. The app makes it, from the
  escrow as read from the chain.
