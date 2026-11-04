// `/profiles/<address>/post/<id>`: one post, at its own address under /profiles. Its photos, its
// fields in its market's order (the preview's first) with each one's type, who posted it and what
// that profile shows, and how to reach them: the contact the post gives, and a link to message the
// profile from each app lists/apps.json names. A post that is not listed has its page too, saying
// why, as its profile's page does.
//
// Drawn as the app would show it: its photos, the description's first line as its heading, the
// price under it, the rest of the description, the facts list of its other fields (a choice by its
// labels, a place with no area linked to its point on the map), who posted it in one row, the
// buttons to reach them, and a fold saying what the profile's words and numbers mean.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { choiceText, fieldLabel, fieldsOf, firstHost, firstLine, inWords, labelsOf, meaningHtml, messageHtml, messageOf, offerOf, placeHtml, type Post, postedByHtml, postOf, priceText, type Result, type Shown, shownFor, typesOf, valueText } from './common.ts'
import { backHtml, html, type Page, type Raw, urls } from './template.ts'

export type PostPage = {
  index: string
  /** The address of the profile that posted it. */
  profile: string
  /** Its profile's market and role; null when the profile has no profile entry here. */
  market: string | null
  role: string | null
  /** The post, with its entry's time, whether it is listed and, when not, why. */
  post: Post & { time: number; listed: boolean; why?: string }
  checks: Check[]
} & Shown & {
  /** Its market's post fields, in the order this page shows them: the preview's first, then the rest in the market's order. */
  fields: string[]
  /** Each of `fields`' type, as its market names it: a `file` field names photos. */
  types: { [field: string]: string }
  /** For each choice field it holds, the labels its market gives the values it holds, such as `{ size: { xl: "XL" } }`. */
  labels: { [field: string]: { [value: string]: string } }
  /** Where to message its profile: one link per app this index lists. */
  message: Array<{ name: string; url: string }>
}

const descriptionOf = (o: PostPage) => (typeof o.post.body.description === 'string' ? o.post.body.description : '')

/** The price, then the description's first line, cut short. */
const headingOf = (o: PostPage) => [priceText(o.post.body), firstLine(descriptionOf(o), 60)].filter(Boolean).join(' · ') || 'A post'

/**
 * The heading, the description's first line, and the text under it, the rest. A first line longer
 * than a heading holds is cut short, and then the whole description is the text, so none is lost.
 */
function headOf(description: string): { head: string; rest: string } {
  const [first = '', ...more] = description.split('\n')
  const line = first.trim()
  return line.length <= 100 ? { head: line, rest: more.join('\n').trim() } : { head: firstLine(line, 100), rest: description.trim() }
}

/**
 * A contact as its writer gave it: an outlined button when it is an http or https URL, its label
 * without the scheme or a trailing slash ("wa.me/34600000000"), or an email address, its label the
 * address alone; else its words.
 */
function contactHtml(contact: string): Raw {
  const text = contact.trim()
  if (/^https?:\/\/\S+$/i.test(text) && URL.canParse(text)) return html`<a class="button" href="${text}" rel="nofollow ugc">${text.replace(/^https?:\/\//i, '').replace(/\/$/, '')}</a>`
  const address = text.replace(/^mailto:/i, '')
  if (/^[^\s@:]+@[^\s@]+\.[^\s@]+$/.test(address)) return html`<a class="button" href="mailto:${address}" rel="nofollow ugc">${address}</a>`
  return html`<p>Contact, as they gave it: ${contact}</p>`
}

export const post: Page<PostPage> = {
  data({ store, lists, markets, self, base }, [address, id]) {
    const found = store.db
      .prepare('select p.address, p.profile, p.body, p.time, p.listed, p.why, f.body as entry, f.market, f.role, f.checks from posts p left join profiles f on f.address = p.profile where p.address = ?')
      .get(`${address}/post/${id}`) as
      | { address: string; profile: string; body: string; time: number; listed: number; why: string | null; entry: string | null; market: string | null; role: string | null; checks: string | null }
      | undefined
    if (!found) return null
    const { statement: _, signature: __, ...shown } = shownFor(store, found.profile)
    const m = found.market === null ? undefined : markets.market(found.market)
    const body = parse<{ [key: string]: unknown }>(found.body)
    return {
      index: self,
      profile: found.profile,
      market: found.market,
      role: found.role,
      post: {
        ...postOf(base, found.address, body, firstHost(found.entry === null ? null : parse(found.entry))),
        time: found.time,
        listed: found.listed === 1,
        ...(found.why !== null && found.listed !== 1 && { why: found.why }),
      },
      checks: found.checks === null ? [] : parse(found.checks),
      ...shown,
      fields: fieldsOf(m),
      types: typesOf(m),
      labels: labelsOf(m, body),
      message: messageOf(lists.apps, found.profile),
    }
  },
  title: headingOf,
  description: (o) => descriptionOf(o) || null,
  body(o, base) {
    const body = o.post.body
    // The facts: its fields as its market orders them, then any the market does not name; never
    // one drawn above or below them (the description, the price, the contact), a field its market
    // types `file` (drawn as photos), or the standard's `files`, the list of what the files are.
    const drawn = ['description', 'price', 'contact', 'files']
    const names = [...o.fields.filter((n) => n in body), ...Object.keys(body).filter((n) => !o.fields.includes(n))].filter((n) => !drawn.includes(n) && o.types[n] !== 'file' && valueText(body[n]))
    const { head, rest } = headOf(descriptionOf(o))
    const price = priceText(body)
    const [photo, ...more] = o.post.photos
    const alt = descriptionOf(o)
    const contact = typeof body.contact === 'string' && body.contact ? body.contact : ''
    return html`${o.market ? backHtml(urls(base).market(o.market), inWords(o.market)) : backHtml(urls(base).home, 'Markets')}
${photo ? html`<a class="photo" href="${photo}"><img src="${photo}" alt="${alt}" loading="lazy"></a>` : ''}${more.length ? html`<div class="tiles">${more.map((src) => html`<a href="${src}"><img src="${src}" alt="${alt}" loading="lazy"></a>`)}</div>` : ''}
<div class="lead"><h1>${head || price || 'A post'}</h1>${price ? html`<p class="price">${price}</p>` : ''}${rest ? html`<p class="text">${rest}</p>` : ''}</div>
${o.post.listed ? '' : html`<p class="red">Not listed: ${o.post.why}.</p>`}
${names.length ? html`<dl class="facts">${names.map((n) => html`<div><dt>${fieldLabel(n)}</dt><dd>${o.types[n] === 'choice' ? choiceText(body[n], o.labels[n]) : o.types[n] === 'place' ? placeHtml(body[n]) : valueText(body[n])}</dd></div>`)}</dl>` : ''}
<section><h2>Posted by</h2>${postedByHtml(o, base)}</section>
${contact || o.message.length ? html`<section><h2>How to reach them</h2>${contact ? contactHtml(contact) : ''}${messageHtml(o.message)}</section>` : ''}
${meaningHtml('Its profile', o)}`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'ItemPage', '@id': url, url, mainEntity: offerOf(o as unknown as Result, base) }],
    }
  },
}
