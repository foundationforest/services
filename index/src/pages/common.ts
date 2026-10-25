// What several pages share: a profile's rating and checks as the JSON gives them, a search or market
// result, and how the HTML draws each from the object.

import type { Check } from '../filter.ts'
import { parse, type Store } from '../store.ts'
import { html, type Raw, short, urls } from './template.ts'

/** `backing` is the trust behind the rating; `reviews` is how many writers reviewed the profile. */
export type Rating = { value: number | null; backing: number; reviews: number; statement?: string; signature?: string }
export type Post = { address: string; body: { [key: string]: unknown } }
export type Result = { profile: string; market: string; role: string; post: Post; rating: Rating; checks: Check[] }

type RatingColumns = { value: number | null; backing: number | null; reviews: number | null; statement: string | null; signature: string | null }

export function ratingOf(held: Partial<RatingColumns> | undefined): Rating {
  if (!held || held.reviews === null || held.reviews === undefined) return { value: null, backing: 0, reviews: 0 }
  return { value: held.value ?? null, backing: held.backing ?? 0, reviews: held.reviews, statement: held.statement!, signature: held.signature! }
}

/** A profile's rating, as the ratings table holds it; a profile that does not count has none. */
export function ratingFor(store: Store, address: string): Rating {
  return ratingOf(store.db.prepare('select value, backing, reviews, statement, signature from ratings where profile = ?').get(address) as RatingColumns | undefined)
}

/**
 * The listed posts, with their profiles, sorted by rating, then the newest post; a profile with no
 * rating after every rated one, since the rating is the one score there is. `where` narrows them.
 */
export function results(store: Store, where = '', params: Array<string | number> = []): Array<Result & { time: number }> {
  const found = store.db
    .prepare(
      `select p.address, p.profile, p.body, p.time, f.market, f.role, f.checks, r.value, r.backing, r.reviews, r.statement, r.signature
       from posts p join profiles f on f.address = p.profile left join ratings r on r.profile = p.profile
       where p.listed = 1 ${where}
       order by r.value is null, r.value desc, p.time desc, p.address`,
    )
    .all(...params) as Array<RatingColumns & { address: string; profile: string; body: string; time: number; market: string; role: string; checks: string }>
  return found.map((r) => ({
    profile: r.profile,
    market: r.market,
    role: r.role,
    post: { address: r.address, body: parse(r.body) },
    rating: ratingOf(r),
    checks: parse(r.checks),
    time: r.time,
  }))
}

/** "9.2 · backing 1.4 (14 reviews)", or "No reviews yet". */
export function ratingText(r: Rating): string {
  if (r.value === null) return 'No reviews yet'
  return `${r.value.toFixed(1)} · backing ${r.backing.toFixed(1)} (${r.reviews} review${r.reviews === 1 ? '' : 's'})`
}

export function checksText(checks: Check[]): string {
  return checks.length ? checks.map((c) => `${c.label} by ${c.verifier}`).join(', ') : 'No check this index counts'
}

/** A field's value as words on a page: each of the markets' nine types, read by its shape. */
export function valueText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(valueText).join(', ')
  if (v && typeof v === 'object') {
    const o = v as { [key: string]: unknown }
    if ('amount' in o && 'currency' in o) return `${o.amount} ${o.currency}${o.per ? ` per ${o.per}` : ''}`
    if ('area' in o) return `${o.area}${o.online ? ', and online' : ''}${o.reachKm !== undefined ? `, up to ${o.reachKm} km away` : ''}`
    if (o.online === true) return 'online'
    if ('sha256' in o) return `a file (${o.mimeType}, ${o.size} bytes)`
    if ('from' in o && 'to' in o) return `${o.from} to ${o.to}`
    if ('zone' in o && Array.isArray(o.slots)) return `${(o.slots as Array<{ days: string[]; from: string; to: string }>).map((s) => `${s.days.join(', ')} ${s.from} to ${s.to}`).join('; ')} (${o.zone})`
    return Object.entries(o)
      .map(([k, x]) => `${k}: ${valueText(x)}`)
      .join(', ')
  }
  return ''
}

/** A post's fields, its description first. */
export function postFields(body: { [key: string]: unknown }): Raw {
  const { description, ...rest } = body
  return html`${typeof description === 'string' ? html`<p>${description}</p>` : ''}${Object.keys(rest).length ? html`<ul>${Object.entries(rest).map(([k, v]) => html`<li>${k}: ${valueText(v)}</li>`)}</ul>` : ''}`
}

/** One result, as a market page and the search page draw it. */
export function resultHtml(r: Result, base: string): Raw {
  return html`<section><p><a href="${urls(base).profile(r.profile)}">${r.market} ${r.role} ${short(r.profile)}</a>. ${ratingText(r.rating)} · ${checksText(r.checks)}.</p>${postFields(r.post.body)}</section>`
}

/** A Person node for a profile, by its page. */
export const personOf = (address: string, base: string) => ({ '@type': 'Person', url: urls(base).profile(address), identifier: address })

/** A schema.org AggregateRating for a rating, or null when it has none. */
export function aggregateOf(r: Rating): { [key: string]: unknown } | null {
  if (r.value === null || !r.reviews) return null
  return { '@type': 'AggregateRating', ratingValue: r.value, bestRating: 10, worstRating: 1, reviewCount: r.reviews }
}

/** A post as a schema.org Offer, with its seller's rating. */
export function offerOf(r: Result, base: string): { [key: string]: unknown } {
  const body = r.post.body
  const price = body.price as { amount?: string; currency?: string } | undefined
  const rating = aggregateOf(r.rating)
  return {
    '@type': 'Offer',
    identifier: r.post.address,
    url: urls(base).profile(r.profile),
    ...(typeof body.description === 'string' && { description: body.description }),
    seller: personOf(r.profile, base),
    ...(price?.amount && price.currency && { price: price.amount, priceCurrency: price.currency }),
    ...(rating && { aggregateRating: rating }),
  }
}
