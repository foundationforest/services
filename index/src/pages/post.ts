// `/profiles/<address>/post/<id>`: one post, at its own address under /profiles. Its photos, its
// fields in its market's order (the preview's first), who posted it and what that profile shows, and
// how to reach them: the contact the post gives, and a link to message the profile from each app
// lists/apps.json names. A post that is not listed has its page too, saying why, as its profile's
// page does.

import type { Check } from '../filter.ts'
import { parse } from '../store.ts'
import { byHtml, fieldLabel, fieldsOf, filesIn, firstHost, firstLine, messageHtml, messageOf, offerOf, type Post, postOf, priceText, type Result, type Shown, shownFor, valueText } from './common.ts'
import { html, type Page, type Raw } from './template.ts'

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
  /** Where to message its profile: one link per app this index lists. */
  message: Array<{ name: string; url: string }>
}

const descriptionOf = (o: PostPage) => (typeof o.post.body.description === 'string' ? o.post.body.description : '')

/** The price, then the description's first line, cut short. */
const headingOf = (o: PostPage) => [priceText(o.post.body), firstLine(descriptionOf(o), 60)].filter(Boolean).join(' · ') || 'A post'

/** A contact as its writer gave it, a link when it is an http or https URL or an email address. */
function contactHtml(contact: string): Raw {
  const text = contact.trim()
  if (/^https?:\/\/\S+$/i.test(text) && URL.canParse(text)) return html`<a href="${text}" rel="nofollow ugc">${contact}</a>`
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return html`<a href="mailto:${text}" rel="nofollow ugc">${contact}</a>`
  return html`${contact}`
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
    return {
      index: self,
      profile: found.profile,
      market: found.market,
      role: found.role,
      post: {
        ...postOf(base, found.address, parse(found.body), firstHost(found.entry === null ? null : parse(found.entry))),
        time: found.time,
        listed: found.listed === 1,
        ...(found.why !== null && found.listed !== 1 && { why: found.why }),
      },
      checks: found.checks === null ? [] : parse(found.checks),
      ...shown,
      fields: fieldsOf(found.market === null ? undefined : markets.market(found.market)),
      message: messageOf(lists.apps, found.profile),
    }
  },
  title: headingOf,
  description: (o) => descriptionOf(o) || null,
  body(o, base) {
    const body = o.post.body
    // The fields as its market orders them, then any the market does not name; never the standard's
    // `files`, a field that names files (drawn as photos), or `contact` (under How to reach them).
    const names = [...o.fields.filter((n) => n in body), ...Object.keys(body).filter((n) => !o.fields.includes(n))].filter((n) => n !== 'files' && n !== 'contact' && !filesIn(body, n).length)
    const alt = descriptionOf(o)
    const contact = typeof body.contact === 'string' && body.contact ? body.contact : ''
    return html`<h1>${headingOf(o)}</h1>
${o.post.listed ? '' : html`<p class="no">Not listed: ${o.post.why}.</p>`}
${o.post.photos.length ? html`<div class="photos">${o.post.photos.map((src) => html`<a href="${src}"><img src="${src}" alt="${alt}" loading="lazy"></a>`)}</div>` : ''}
${names.length ? html`<dl>${names.map((n) => html`<dt>${fieldLabel(n)}</dt><dd>${valueText(body[n])}</dd>`)}</dl>` : ''}
<p>Posted by ${byHtml(o, base)}.</p>
${contact || o.message.length ? html`<h2>How to reach them</h2>${contact ? html`<p>Contact, as they gave it: ${contactHtml(contact)}</p>` : ''}${messageHtml(o.message)}` : ''}`
  },
  ld(o, base, url) {
    return {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'ItemPage', '@id': url, url, mainEntity: offerOf(o as unknown as Result, base) }],
    }
  },
}
