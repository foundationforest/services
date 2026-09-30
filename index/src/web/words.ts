// Plain words for people. Everything a person reads on a page goes through here or is the
// people's own text; none of it says wallet, USDC, chain, gas, token or any other crypto word.
// The JSON twins keep the records' own field names, which are for machines.

import type { CurrencyConfig } from '../config.ts'

// -----------------------------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------------------------

/** A market or folder slug as a heading: `online-tutors` → `Online tutors`. */
export function title(slug: string): string {
  const s = slug.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A rating's or a field's name as words: `overall` → `Overall`, `onTime` → `On time`. */
export function nameWords(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// -----------------------------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------------------------

/** `12.5` → `12.50`, `25` → `25`, `25.000` → `25`: whole units as a price is written. */
function tidy(decimal: string): string {
  const [whole, frac = ''] = decimal.split('.')
  const f = frac.replace(/0+$/, '')
  if (!f) return whole.replace(/^0+(?=\d)/, '')
  return `${whole.replace(/^0+(?=\d)/, '')}.${f.length === 1 ? `${f}0` : f}`
}

/** Base units to whole units as decimal text: 25000000 at 6 decimals → "25". */
export function fromBaseUnits(base: string | bigint, decimals: number): string {
  const s = BigInt(base).toString().padStart(decimals + 1, '0')
  return tidy(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`)
}

export type Money = { known: true; code: string; text: string; decimal: string } | { known: false; text: string }

/** A price as a post writes it: whole units as decimal text, and the token that names the currency. */
export function money(amount: string, mint: string, currencies: CurrencyConfig): Money {
  const c = currencies[mint]
  if (!c || !/^\d+(\.\d+)?$/.test(amount)) return { known: false, text: 'a price in a currency this index doesn’t show' }
  const decimal = tidy(amount)
  return { known: true, code: c.code, text: `${c.symbol}${decimal}`, decimal }
}

/** An amount a receipt records, in base units. */
export function moneyFromBase(base: string, mint: string, currencies: CurrencyConfig): Money {
  const c = currencies[mint]
  if (!c) return { known: false, text: 'an amount in a currency this index doesn’t show' }
  return money(fromBaseUnits(base, c.decimals), mint, currencies)
}

export const PER: Record<string, string> = { hour: 'per hour', day: 'per day', job: 'for the job' }

/** An offer's price in words, or null when it names none. */
export function price(p: { amount: string; mint: string; per: string } | null, currencies: CurrencyConfig): string | null {
  if (!p) return null
  const m = money(p.amount, p.mint, currencies)
  return m.known ? `${m.text} ${PER[p.per] ?? ''}`.trim() : m.text.charAt(0).toUpperCase() + m.text.slice(1)
}

// -----------------------------------------------------------------------------------------------
// Dates and numbers
// -----------------------------------------------------------------------------------------------

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** `25 Sept 2026`: the same everywhere, whatever the reader's country. */
export function date(iso: string | null): string {
  return iso ? DATE.format(new Date(iso)) : ''
}

/** A score for reading: two decimals, or four when it is that small, with a real minus sign. */
export function score(v: number): string {
  if (v === 0) return '0'
  const s = Math.abs(v) >= 0.01 ? v.toFixed(2) : v.toFixed(4)
  return s.replace('-', '−')
}

export function signed(v: number): string {
  return v > 0 ? `+${score(v)}` : score(v)
}

export function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A rating out of 10, always with one decimal: `8.5`, `10.0`. */
export function outOf10(v: number): string {
  return v.toFixed(1)
}

/** A profile's rating: the weighted overall of the reviews that count, or none yet. */
export function rating(r: { value: number | null; reviews: number }): string {
  return r.value === null ? 'No rating yet' : `Rated ${outOf10(r.value)} of 10 from ${plural(r.reviews, 'review')}`
}

/** A review's own ratings, overall first: `Overall 9.5 of 10 · Patience 10.0 of 10`. */
export function ratings(rs: Record<string, number>): string {
  const names = Object.keys(rs).sort((a, b) => (a === 'overall' ? -1 : b === 'overall' ? 1 : a < b ? -1 : 1))
  return names.length ? names.map((n) => `${nameWords(n)} ${outOf10(rs[n])} of 10`).join(' · ') : 'No rating'
}

/** How many photos and videos a review carries: `With 2 photos and 1 video`. */
export function media(items: { mimeType: string | null }[]): string | null {
  const videos = items.filter((m) => m.mimeType?.startsWith('video/')).length
  const photos = items.length - videos
  const parts = [photos ? plural(photos, 'photo') : '', videos ? plural(videos, 'video') : ''].filter(Boolean)
  return parts.length ? `With ${parts.join(' and ')}` : null
}

/** A market's extra field and its value: `Sessions: 8`, `Subjects: portuguese, spanish`. */
export function field(name: string, value: unknown): string {
  const v = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
  return `${nameWords(name)}: ${v}`
}

// -----------------------------------------------------------------------------------------------
// Badges, evidence, receipts
// -----------------------------------------------------------------------------------------------

export const BADGE = 'Verified real person, one per market'

export function badgeWhyNot(why: string | null): string {
  switch (why) {
    case 'walletNotDeclared':
      return 'Not counted: this profile doesn’t name the key the badge was registered with.'
    case 'notInDirectory':
      return 'Not counted: registered under a name that isn’t a market in this index’s directory.'
    case 'noRole':
      return 'Not counted: registered for the market without a side, such as seller or buyer.'
    case 'notProfileScope':
      return 'Not counted: registered for another market or side than the one this profile is in.'
    default:
      return 'Not counted.'
  }
}

export function evidence(kind: string, note: string | null): string {
  switch (kind) {
    case 'both':
      return 'Backed by a payment both sides agreed to.'
    case 'oneSidedConfirmed':
      return 'Backed by a payment, and both sides reviewed it.'
    case 'oneSided':
      return 'Backed by a payment from one side only; it counts in full once the other side reviews it too.'
  }
  switch (note) {
    case 'noDealId':
      return 'No payment behind it, so it counts for little.'
    case 'noReceipt':
      return 'Names a payment this index can’t find, so it counts for little.'
    case 'notTheParties':
      return 'Names a payment between other people, so it counts for little.'
    case 'tokenNotCounted':
      return 'Backed by a payment in a currency this index doesn’t count, so it counts for little.'
    case 'notPaid':
      return 'Names a payment that hasn’t been made, so it counts for little.'
    default:
      return 'Counts for little.'
  }
}

export function skipped(why: string | null): string | null {
  if (why === 'self') return 'Not counted: a review of oneself.'
  if (why === 'replaced') return 'Not counted: a later review by the same person replaces it.'
  return null
}

/**
 * How a receipt ended, as a sentence. `buyer` and `seller` are the names to use; the amounts are
 * already money text.
 */
export function outcome(o: string, n: { buyer: string; seller: string; toSeller: string; toBuyer: string }): string {
  switch (o) {
    case 'releasedToSeller':
      return `${n.buyer} released the payment to ${n.seller}.`
    case 'releasedToBuyer':
      return `${n.seller} sent the payment back to ${n.buyer}.`
    case 'split':
      return `They agreed to split it: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    case 'arbitrated':
      return `The person they chose to decide split it: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    case 'timerReleased':
      return `The time they set ran out: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
    default:
      return `It ended: ${n.seller} got ${n.toSeller}, ${n.buyer} got ${n.toBuyer}.`
  }
}
