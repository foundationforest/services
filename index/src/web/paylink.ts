// The Pay link on an offer, in the one format forest's escrow documents (escrow/README.md, "The pay
// link"). The index does not pay; it links. Any app that follows the escrow client opens the link,
// checks it against the offer record it names, and makes the payment itself.
//
//   {base}/pay?v=2&offer=<profile>/offer/<id>&record=<record id>&price.amount=<decimal>&price.mint=<mint>
//            &price.per=<hour|day|job>[&terms.arbiter=<key>][&terms.timer.days=<n>&terms.timer.to=<seller|buyer>]
//
// Every parameter after `record` is the offer record's own field, named by its path. Parameters come
// in exactly this order, so two builders write the same link. The seller is the profile the offer
// address names, whose address is where it is paid: the link carries no other key, so a forged link
// cannot send money anywhere else. Version 1 named profiles by did:key.

export const PAY_VERSION = '2'

export type PayLink = {
  v: 2
  /** The offer's address: its profile's address, then its path, `offer/<id>`. */
  offer: string
  /** The id of the record that holds the offer: which version of the offer the terms are from. */
  record: string
  price: { amount: string; mint: string; per: 'hour' | 'day' | 'job' }
  /** The escrow's two options, each off unless set. Null: neither. */
  terms: { arbiter?: string; timer?: { days: number; to: 'seller' | 'buyer' } } | null
}

const OFFER = /^[1-9A-HJ-NP-Za-km-z]{32,44}\/offer\/[a-z0-9][a-z0-9._-]{0,63}$/
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DECIMAL = /^\d{1,24}(\.\d{1,12})?$/

/** The link for an offer as the index holds it. */
export function payLink(base: string, offer: { uri: string; id: string; record: any }): string {
  const r = offer.record
  const params: [string, string][] = [
    ['v', PAY_VERSION],
    ['offer', offer.uri],
    ['record', offer.id],
    ['price.amount', r.price.amount],
    ['price.mint', r.price.mint],
    ['price.per', r.price.per],
  ]
  if (r.terms?.arbiter) params.push(['terms.arbiter', r.terms.arbiter])
  if (r.terms?.timer) params.push(['terms.timer.days', String(r.terms.timer.days)], ['terms.timer.to', r.terms.timer.to])
  return `${base}/pay?${new URLSearchParams(params).toString()}`
}

/** A link read back, or every way it is not one. Unknown parameters are ignored, so v1 can grow. */
export function parsePayLink(search: URLSearchParams): { ok: true; link: PayLink } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const get = (k: string) => search.get(k)
  if (get('v') !== PAY_VERSION) errors.push(`v must be ${PAY_VERSION}`)
  const offer = get('offer') ?? ''
  if (!OFFER.test(offer)) errors.push('offer must be an offer address, <profile>/offer/<id>')
  const record = get('record') ?? ''
  if (!/^[0-9a-f]{64}$/.test(record)) errors.push("record must be the id of the offer's record, 64 hex characters")
  const amount = get('price.amount') ?? ''
  if (!DECIMAL.test(amount)) errors.push('price.amount must be whole units as decimal text, such as 25 or 12.50')
  const mint = get('price.mint') ?? ''
  if (!BASE58_KEY.test(mint)) errors.push('price.mint must be a base58 key')
  const per = get('price.per') ?? ''
  if (!['hour', 'day', 'job'].includes(per)) errors.push('price.per must be hour, day or job')

  const terms: NonNullable<PayLink['terms']> = {}
  const arbiter = get('terms.arbiter')
  if (arbiter !== null) {
    if (!BASE58_KEY.test(arbiter)) errors.push('terms.arbiter must be a base58 key')
    else terms.arbiter = arbiter
  }
  const days = get('terms.timer.days')
  const to = get('terms.timer.to')
  if (days !== null || to !== null) {
    const n = Number(days)
    if (!Number.isInteger(n) || n < 1 || n > 65_535) errors.push('terms.timer.days must be a whole number from 1 to 65535')
    if (to !== 'seller' && to !== 'buyer') errors.push('terms.timer.to must be seller or buyer')
    if (errors.length === 0) terms.timer = { days: n, to: to as 'seller' | 'buyer' }
  }
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    link: {
      v: 2,
      offer,
      record,
      price: { amount, mint, per: per as PayLink['price']['per'] },
      terms: terms.arbiter || terms.timer ? terms : null,
    },
  }
}

/** Where a link and the offer as indexed now differ, field by field. Empty when they agree. */
export function linkDiffers(link: PayLink, offer: { price: PayLink['price'] | null; terms: PayLink['terms'] }): string[] {
  const out: string[] = []
  if (link.price.amount !== offer.price?.amount) out.push('price.amount')
  if (link.price.mint !== offer.price?.mint) out.push('price.mint')
  if (link.price.per !== offer.price?.per) out.push('price.per')
  if ((link.terms?.arbiter ?? null) !== (offer.terms?.arbiter ?? null)) out.push('terms.arbiter')
  const a = link.terms?.timer ?? null
  const b = offer.terms?.timer ?? null
  if (a === null ? b !== null : b === null || a.days !== b.days || a.to !== b.to) out.push('terms.timer')
  return out
}
