// What several pages share: what a profile shows (its ratings, trust, uniqueness, pickiness and
// checks) as the JSON gives it, a search or market result, and how the HTML draws each from the
// object.

import type { Check } from '../filter.ts'
import type { Pickiness } from '../rank.ts'
import { parse, type Store } from '../store.ts'
import { html, type Raw, short, urls } from './template.ts'

/**
 * What a profile shows: its ratings, from 1 to 10 to one decimal, with how many raters scored it;
 * its trust and uniqueness, whole numbers from 0 to 100; and its pickiness as a word. A profile
 * that does not count shows no rating, 0, 0 and no pickiness.
 */
export type Shown = { ratings: { value: number | null; count: number }; trust: number; uniqueness: number; pickiness: Pickiness | null }
export type Post = { address: string; body: { [key: string]: unknown } }
export type Result = { profile: string; market: string; role: string; post: Post } & Shown & { checks: Check[] }

type ShownColumns = { value: number | null; count: number | null; trust: number | null; uniqueness: number | null; pickiness: Pickiness | null }

export function shownOf(held: Partial<ShownColumns> | undefined): Shown {
  if (!held || held.count === null || held.count === undefined) return { ratings: { value: null, count: 0 }, trust: 0, uniqueness: 0, pickiness: null }
  return { ratings: { value: held.value ?? null, count: held.count }, trust: held.trust ?? 0, uniqueness: held.uniqueness ?? 0, pickiness: held.pickiness ?? null }
}

/** What a profile shows, as the ratings table holds it, with its statement and signature; a profile that does not count has neither. */
export function shownFor(store: Store, address: string): Shown & { statement?: string; signature?: string } {
  const held = store.db.prepare('select value, count, trust, uniqueness, pickiness, statement, signature from ratings where profile = ?').get(address) as
    | (ShownColumns & { statement: string; signature: string })
    | undefined
  return { ...shownOf(held), ...(held && { statement: held.statement, signature: held.signature }) }
}

/**
 * The listed posts, with their profiles, sorted as search sorts them: by the profile's ratings with
 * one unit of its market's average added (rank.ts), then the newest post. `where` narrows them.
 */
export function results(store: Store, where = '', params: Array<string | number> = []): Array<Result & { time: number }> {
  const found = store.db
    .prepare(
      `select p.address, p.profile, p.body, p.time, f.market, f.role, f.checks, r.value, r.count, r.trust, r.uniqueness, r.pickiness
       from posts p join profiles f on f.address = p.profile left join ratings r on r.profile = p.profile
       where p.listed = 1 ${where}
       order by r.sort is null, r.sort desc, p.time desc, p.address`,
    )
    .all(...params) as Array<ShownColumns & { address: string; profile: string; body: string; time: number; market: string; role: string; checks: string }>
  return found.map((r) => ({
    profile: r.profile,
    market: r.market,
    role: r.role,
    post: { address: r.address, body: parse(r.body) },
    ...shownOf(r),
    checks: parse(r.checks),
    time: r.time,
  }))
}

/** "Rated 9.2 by 14 · trust 42 · uniqueness 99", its checks as badges, "· pickiness average". */
export function shownHtml(s: Shown, checks: Check[]): Raw {
  const rated = s.ratings.value === null ? 'No ratings yet' : `Rated ${s.ratings.value.toFixed(1)} by ${s.ratings.count}`
  return html`${rated} · trust ${s.trust} · uniqueness ${s.uniqueness} ${checksHtml(checks)}${s.pickiness ? ` · pickiness ${s.pickiness}` : ''}`
}

/** Each check, as a badge. */
export function checksHtml(checks: Check[]): Raw {
  return checks.length ? html`${checks.map((c) => html`<span class="badge">${c.label} by ${c.verifier}</span> `)}` : html`<span class="muted">No check this index counts</span>`
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
    if ('sha256' in o) return `a file (${o.type}, ${o.size} bytes)`
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
  return html`<section><p><a href="${urls(base).profile(r.profile)}">${r.market} ${r.role} ${short(r.profile)}</a>. ${shownHtml(r, r.checks)}.</p>${postFields(r.post.body)}</section>`
}

/** A Person node for a profile, by its page. */
export const personOf = (address: string, base: string) => ({ '@type': 'Person', url: urls(base).profile(address), identifier: address })

/** A schema.org AggregateRating for a profile's ratings, or null when it has none. */
export function aggregateOf(s: Shown): { [key: string]: unknown } | null {
  if (s.ratings.value === null || !s.ratings.count) return null
  return { '@type': 'AggregateRating', ratingValue: s.ratings.value, bestRating: 10, worstRating: 1, ratingCount: s.ratings.count }
}

/** A post as a schema.org Offer, with its seller's rating. */
export function offerOf(r: Result, base: string): { [key: string]: unknown } {
  const body = r.post.body
  const price = body.price as { amount?: string; currency?: string } | undefined
  const rating = aggregateOf(r)
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
