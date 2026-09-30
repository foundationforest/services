// The pay page's model: a pay link read back and checked against the offer as this index holds it.
// The index only checks and shows; the app the person pays with does the paying.

import { type Ctx, type Offer, offerByUri } from './data.ts'
import { type PayLink, linkDiffers, parsePayLink, payLink } from './paylink.ts'

export type PayModel = {
  kind: 'pay'
  url: string
  json: string
  /** The link as read, or null when it is not a complete one. */
  link: PayLink | null
  errors: string[]
  /**
   *   matches   the link is the offer as indexed now
   *   changed   the offer was edited since (another cid); `offer` shows it as it is now
   *   differs   same cid, other price or terms: the link was altered
   *   notLive   the offer expired or is no longer an offer in a directory market
   *   noPrice   the offer names no price, so it has no Pay link
   *   noKey     the seller's profile names no key to be paid at
   *   notFound  no offer at that address in this index
   *   invalid   not a complete link
   */
  check: 'matches' | 'changed' | 'differs' | 'notLive' | 'noPrice' | 'noKey' | 'notFound' | 'invalid'
  differences: string[]
  offer: Offer | null
}

export async function pay(ctx: Ctx, search: URLSearchParams): Promise<PayModel> {
  const parsed = parsePayLink(search)
  const raw = `${ctx.urls.base}/pay?${search.toString()}`
  if (!parsed.ok) return { kind: 'pay', url: raw, json: ctx.urls.json(raw), link: null, errors: parsed.errors, check: 'invalid', differences: [], offer: null }
  const link = parsed.link
  const offer = await offerByUri(ctx, link.offer)
  // The canonical form of the same link, so the page's URL does not depend on parameter order.
  const url = payLink(ctx.urls.base, { uri: link.offer, cid: link.cid, record: { price: link.price, terms: link.terms } })
  const out = { kind: 'pay' as const, url, json: ctx.urls.json(url), link, errors: [], differences: [] as string[], offer }
  if (!offer) return { ...out, check: 'notFound' }
  if (offer.cid === link.cid) {
    const differences = linkDiffers(link, offer)
    if (differences.length) return { ...out, check: 'differs', differences }
  }
  const live = offer.direction === 'offer' && offer.market !== null && !(offer.expires && new Date(offer.expires) <= new Date())
  if (!live) return { ...out, check: 'notLive' }
  if (!offer.price) return { ...out, check: 'noPrice' }
  // A live offer with no pay link is one whose profile names no key.
  if (!offer.payLink) return { ...out, check: 'noKey' }
  if (offer.cid !== link.cid) return { ...out, check: 'changed', differences: linkDiffers(link, offer) }
  return { ...out, check: 'matches' }
}
