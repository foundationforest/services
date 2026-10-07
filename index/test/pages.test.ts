// The pages for people and machines, on part one's story (test/fixture.ts) in a fresh database,
// served over a local node:http server:
//   1. every page and its twin renders;
//   2. every JSON-LD block parses and validates against schema.org's vocabulary;
//   3. each twin matches its page;
//   4. the sitemap lists exactly the pages there are, and each resolves;
//   5. robots.txt lets everyone in; llms.txt says what Forest is and its links resolve;
//   6. every URL in the read skill resolves;
//   7. no crypto word anywhere a person reads;
//   8. the Pay link reads back to the offer's own terms, and the pay page checks it;
//   9. markets: two numbers, one label per profile, role names, near, no price, review fields, and
//      no word of the index's own on an offer's or a receipt's options (a market's own text may say
//      anything);
//  10. records: the access rule, by forest's view, and private records left alone;
//  11. pictures: shown from a host that holds them, with the type the record names; none when no
//      host does.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { startWeb } from '../src/main.ts'
import type { Web } from '../src/web/routes.ts'
import { serve } from '../src/web/server.ts'
import { parsePayLink } from '../src/web/paylink.ts'
import * as w from '../src/web/words.ts'
import { BUYER, CLIP, DEAL, EXCHANGE, FOLDER, HOST, ISSUER, ISSUER_NAME, LISBON, MADE_UP_DEAL, MARKET, NO_PHOTO, OFFERS, PEER, PHOTO, SELLER, ana, ben, cleo, dara, eve, makeFixture } from './fixture.ts'
import { validateJsonLd } from './schemaorg/validate.ts'

// -----------------------------------------------------------------------------------------------
// Reading a page the way a person or a crawler does
// -----------------------------------------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** What a person reads: the text, and the attributes a browser shows (title, alt, placeholder, labels, the description). */
function readable(html: string): string {
  const noCode = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  const attrs = [...noCode.matchAll(/\s(?:title|alt|placeholder|aria-label|content)="([^"]*)"/g)].map((m) => m[1])
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ''
  return decode([title, ...attrs, noCode.replace(/<[^>]+>/g, ' ')].join(' ')).replace(/\s+/g, ' ')
}

const linkRel = (html: string, rel: string) => {
  const m = new RegExp(`<link rel="${rel}"(?: type="[^"]+")? href="([^"]+)">`).exec(html)
  return m ? decode(m[1]) : null
}
const jsonLd = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))

const BANNED = /\b(wallets?|usdc|chains?|blockchains?|gas|crypto(currency)?|tokens?|solana|mints?)\b/i

test('pages for people and machines', { timeout: 120_000 }, async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not set')
  const fixture = await makeFixture(process.env.DATABASE_URL)
  const holder: { web?: Web } = {}
  const server = await serve({ handle: (req) => holder.web!.handle(req) }, 0, '127.0.0.1')
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    holder.web = (await startWeb(fixture.db, fixture.config({ PUBLIC_URL: base }), { listen: false })).web
    const get = async (url: string, init: RequestInit = {}) => {
      const res = await fetch(url.startsWith('http') ? url : base + url, { redirect: 'manual', ...init })
      return { status: res.status, headers: res.headers, text: await res.text() }
    }
    const json = async (url: string) => JSON.parse((await get(url)).text)

    const anaTwin = await json(`/profiles/${ana.address}.json`)
    const portuguese = anaTwin.offers.find((o: any) => o.uri === OFFERS.portuguese.uri)
    const spanish = anaTwin.offers.find((o: any) => o.uri === OFFERS.spanish.uri)
    const altered = new URL(portuguese.payLink)
    altered.searchParams.set('price.amount', '1')

    /** Every page, with the URL its canonical link must name. */
    const PAGES: { path: string; canonical: string }[] = [
      { path: '/', canonical: `${base}/` },
      { path: `/folders/${FOLDER}`, canonical: `${base}/folders/${FOLDER}` },
      { path: '/folders/learning', canonical: `${base}/folders/learning` },
      { path: `/markets/${MARKET}`, canonical: `${base}/markets/${MARKET}` },
      { path: `/markets/${EXCHANGE}`, canonical: `${base}/markets/${EXCHANGE}` },
      { path: `/markets/${EXCHANGE}?km=10&near=38.720,-9.14`, canonical: `${base}/markets/${EXCHANGE}?near=38.72,-9.14&km=10` },
      ...[ana, ben, cleo, dara].map((p) => ({ path: `/profiles/${p.address}`, canonical: `${base}/profiles/${p.address}` })),
      { path: `/deals/${DEAL}`, canonical: `${base}/deals/${DEAL}` },
      { path: `/deals/${MADE_UP_DEAL}`, canonical: `${base}/deals/${MADE_UP_DEAL}` },
      { path: '/search?q=portuguese', canonical: `${base}/search?q=portuguese` },
      { path: '/search?q=english&near=38.7,-9.1&km=25', canonical: `${base}/search?q=english&near=38.7,-9.1&km=25` },
      { path: '/search', canonical: `${base}/search?q=` },
      { path: new URL(portuguese.payLink).pathname + new URL(portuguese.payLink).search, canonical: portuguese.payLink },
      { path: new URL(spanish.payLink).pathname + new URL(spanish.payLink).search, canonical: spanish.payLink },
      { path: altered.pathname + altered.search, canonical: altered.toString() },
    ]
    const rendered = new Map<string, string>()
    for (const p of PAGES) rendered.set(p.path, (await get(p.path)).text)

    await t.test('1. every page and its twin renders', async () => {
      for (const p of PAGES) {
        const res = await get(p.path)
        assert.equal(res.status, 200, p.path)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', p.path)
        assert.equal(res.headers.get('set-cookie'), null, `${p.path}: no cookies`)
        assert.equal(res.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=300', p.path)
        assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/, p.path)
        assert.ok(res.text.startsWith('<!doctype html>'), p.path)
        assert.match(res.text, /<title>[^<]+<\/title>/, p.path)
        assert.equal(linkRel(res.text, 'canonical'), p.canonical, `${p.path}: canonical`)
        const twin = linkRel(res.text, 'alternate')
        assert.ok(twin, `${p.path}: links its twin`)
        assert.equal(res.headers.get('link'), `<${twin}>; rel="alternate"; type="application/json"`, `${p.path}: the twin in a header too`)
        assert.equal((await get(twin!)).status, 200, `${p.path}: its twin answers`)
        assert.equal(jsonLd(res.text).length, 1, `${p.path}: one JSON-LD block`)
        assert.equal([...res.text.matchAll(/<script\b/g)].length, 1, `${p.path}: no script but the data block`)
      }
      // Search engines are kept off search results, pay links and deals with no receipt.
      for (const p of PAGES) {
        const noindex = /<meta name="robots" content="noindex">/.test(rendered.get(p.path)!)
        assert.equal(noindex, p.path.startsWith('/search') || p.path.startsWith('/pay') || p.path.includes('near=') || p.path.endsWith(MADE_UP_DEAL), `${p.path}: noindex`)
      }

      // No aliases: another spelling of a market is no market here.
      assert.equal((await get('/markets/online-tutor')).status, 404)
      assert.equal((await get('/markets/online-tutor.json')).status, 404)
      for (const path of ['/profiles/Nobody1111111111111111111111111111111', '/markets/plumbers', '/folders/nothing', `/categories/${FOLDER}`, `/deals/${'00'.repeat(32)}`, '/nope', '/profiles/%E0%A4%A']) {
        const res = await get(path)
        assert.equal(res.status, 404, path)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', path)
      }
      const missing = await get('/profiles/Nobody1111111111111111111111111111111.json')
      assert.equal(missing.status, 404)
      assert.equal(JSON.parse(missing.text).error, 'NotFound')
      assert.deepEqual(JSON.parse((await get('/search.json')).text).offers, [], 'no words, no results: the twin of the empty search page')
      assert.equal((await get('/', { method: 'HEAD' })).text, '')
      assert.equal((await get('/', { method: 'POST' })).status, 405)
    })

    await t.test("2. every JSON-LD block is valid schema.org", async () => {
      for (const p of PAGES) {
        for (const doc of jsonLd(rendered.get(p.path)!)) assert.deepEqual(validateJsonLd(doc), [], p.path)
      }
      // What a shopping AI reads from Ana's page.
      const g: any[] = jsonLd(rendered.get(`/profiles/${ana.address}`)!)[0]['@graph']
      const person = g.find((n) => n['@type'] === 'Person')
      assert.equal(person.name, ana.name)
      assert.equal(person.identifier, ana.address)
      assert.deepEqual(person.makesOffer.map((o: any) => [o.price, o.priceCurrency, o.priceSpecification.unitText]), [['20', 'USD', 'hour'], ['25', 'USD', 'hour'], ['12.50', 'USD', 'hour']])
      const rating = g.find((n) => n['@type'] === 'AggregateRating')
      assert.equal(rating.ratingValue, Math.round(anaTwin.scores.rating.value * 10) / 10, 'the weighted overall')
      assert.deepEqual([rating.bestRating, rating.worstRating, rating.reviewCount], [10, 1, 2])
      assert.equal(rating.itemReviewed['@id'], person['@id'])
      // Each offer carries both numbers: the rating out of 10 and the standing, never blended.
      for (const o of person.makesOffer) {
        assert.deepEqual([o.aggregateRating.ratingValue, o.aggregateRating.bestRating], [rating.ratingValue, 10])
        assert.deepEqual([o.additionalProperty.name, o.additionalProperty.value], ['standing', anaTwin.scores.standing.value])
      }
      const reviews = g.filter((n) => n['@type'] === 'Review')
      assert.deepEqual(reviews.map((r) => [r.author.name, r.reviewRating.ratingValue, r.reviewRating.bestRating]).sort(), [['Ben Okafor', 10, 10], ['Cleo', 1, 10]])
      // Dara's offer names no price and a place: an Offer with no price, served in an area.
      const exchange: any = jsonLd(rendered.get(`/markets/${EXCHANGE}`)!)[0]['@graph'][0].mainEntity.itemListElement[0]
      assert.equal(exchange.price, undefined)
      assert.equal(exchange.itemOffered.areaServed, LISBON.area)
      // Cleo has no reviews: no rating at all rather than an empty one, or a zero.
      const cleoGraph: any[] = jsonLd(rendered.get(`/profiles/${cleo.address}`)!)[0]['@graph']
      assert.equal(cleoGraph.find((n) => n['@type'] === 'AggregateRating'), undefined)
      const pay: any = jsonLd(rendered.get(`/deals/${DEAL}`)!)[0]['@graph'].find((n: any) => n['@type'] === 'PayAction')
      assert.deepEqual([pay.agent.name, pay.recipient.name, pay.price, pay.priceCurrency], [ben.name, ana.name, '25', 'USD'])
      // The validator itself refuses what schema.org does: a rating on a Person, a made-up type.
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Person', aggregateRating: { '@type': 'AggregateRating', ratingValue: 5 } }).length > 0)
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Tutor', name: 'x' }).length > 0)
      assert.ok(validateJsonLd({ '@context': 'https://schema.org', '@type': 'Offer', price: true }).length > 0)
    })

    await t.test('3. each twin matches its page', async () => {
      const cur = (a: string, mint: string) => w.money(a, mint, fixture.config().currencies).text
      for (const p of PAGES) {
        const html = rendered.get(p.path)!
        const twin = await json(linkRel(html, 'alternate')!)
        assert.equal(twin.url, p.canonical, `${p.path}: the twin names the page`)
        assert.equal(twin.json, linkRel(html, 'alternate'), `${p.path}: and itself`)
        const text = readable(html)
        const facts: string[] = []
        const offer = (o: any) => facts.push(o.description, ...(o.price ? [w.price(o.price, fixture.config().currencies)!] : []))
        switch (twin.kind) {
          case 'home':
            for (const f of twin.folders) facts.push(w.title(f.folder), ...f.markets.map((m: any) => w.title(m.name)), ...f.markets.map((m: any) => w.plural(m.offers, 'offer')))
            break
          case 'folder':
            facts.push(w.title(twin.folder), ...twin.markets.map((m: any) => w.title(m.name)))
            break
          case 'market':
            facts.push(w.title(twin.market.name), twin.market.description, ...twin.market.howDealsGo.split(/\n+/), w.plural(twin.counts.offers, 'offer'))
            for (const o of twin.offers) offer(o), facts.push(o.name, w.score(o.standing), w.rating(o.rating))
            break
          case 'profile':
            facts.push(twin.profile.name, w.score(twin.scores.standing.value))
            if (twin.scores.rating) facts.push(`${w.outOf10(twin.scores.rating.value)} of 10`)
            if (twin.profile.about) facts.push(twin.profile.about)
            for (const u of twin.scores.uniqueness) facts.push(w.percent(u.value))
            for (const b of twin.stamps) facts.push(w.title(b.market), ...(b.counted ? [w.REAL_PERSON] : [w.stampWhyNot(b.why)]))
            twin.offers.forEach(offer)
            for (const r of [...twin.reviews.received, ...twin.reviews.given]) {
              facts.push(r.text, w.ratings(r.ratings), w.evidence(r.evidence.kind, r.evidence.note), ...Object.entries(r.fields).map(([k, x]) => w.field(k, x)))
            }
            break
          case 'deal':
            for (const r of twin.reviews) facts.push(r.text, r.reviewerName, r.subjectName)
            if (twin.receipt) {
              facts.push(w.moneyFromBase(twin.receipt.amount, twin.receipt.mint, fixture.config().currencies).text)
              for (const x of [...twin.receipt.buyerProfiles, ...twin.receipt.sellerProfiles]) facts.push(x.name, w.rating(x.rating), w.score(x.standing))
            }
            break
          case 'search':
            twin.offers.forEach(offer)
            if (twin.q) facts.push(twin.q)
            break
          case 'pay':
            if (twin.offer) offer(twin.offer)
            break
          default:
            assert.fail(`${p.path}: a twin of kind ${twin.kind}`)
        }
        for (const f of facts) assert.ok(text.includes(f), `${p.path}: the page shows "${f}"`)
        if (twin.kind !== 'search' || twin.q) assert.ok(facts.length > 0, `${p.path}: something to compare`)
      }
      // The numbers themselves. Ana and Ben vouch for each other on a deal both said yes to; Cleo, a
      // counted stranger (her weight 1) with a made-up deal id (0.05), takes 0.05 off Ana's.
      const ta = anaTwin.scores.standing.value
      const tb = (await json(`/profiles/${ben.address}.json`)).scores.standing.value
      assert.ok(Math.abs(tb - (1 + ta / (ta + 1))) < 1e-6, `Ben ${tb}`)
      assert.ok(Math.abs(ta - (1 + tb / (tb + 1) - 0.05)) < 1e-6, `Ana ${ta}`)
      assert.equal(cur('25', portuguese.price.mint), '$25')
      assert.equal(cur('12.5', portuguese.price.mint), '$12.50')
    })

    await t.test('4. the sitemap lists every page, and each resolves', async () => {
      const res = await get('/sitemap.xml')
      assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8')
      assert.match(res.text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/)
      const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]))
      const listed = PAGES.filter((p) => !/<meta name="robots" content="noindex">/.test(rendered.get(p.path)!)).map((p) => p.canonical)
      assert.deepEqual([...locs].sort(), [...listed].sort(), 'every page meant for search engines, and nothing else')
      for (const loc of locs) assert.equal((await get(loc)).status, 200, loc)
    })

    await t.test('5. robots.txt lets everyone in; llms.txt says what Forest is', async () => {
      const robots = await get('/robots.txt')
      assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8')
      assert.match(robots.text, /^User-agent: \*$/m)
      assert.match(robots.text, /^Allow: \/$/m)
      assert.doesNotMatch(robots.text, /Disallow/)
      assert.match(robots.text, new RegExp(`^Sitemap: ${base}/sitemap.xml$`, 'm'))

      const llms = (await get('/llms.txt')).text
      assert.match(llms, /^# Forest\n/)
      assert.equal([...llms.matchAll(/^> .+$/gm)].length, 3, 'what Forest is, in three lines')
      const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1])
      assert.ok(links.length >= 6)
      for (const link of links) {
        if (link.startsWith('https://github.com/foundationforest/services')) continue
        assert.ok(link.startsWith(base), `${link} is on this index`)
        assert.equal((await get(link)).status, 200, link)
      }
    })

    await t.test("6. every URL in the read skill resolves", async () => {
      const skill = await get('/skill.md')
      assert.equal(skill.headers.get('content-type'), 'text/markdown; charset=utf-8')
      assert.doesNotMatch(skill.text, /https:\/\/forest\.foundation/, 'written for forest.foundation, served with this index’s address')
      const found = [...skill.text.matchAll(/https?:\/\/[^\s`)"'<>]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''))
      const local = found.filter((u) => u.startsWith(base))
      assert.ok(local.length >= 10, `${local.length} examples`)
      for (const u of local) {
        let res = await get(u)
        if (res.status === 301) res = await get(res.headers.get('location')!)
        assert.equal(res.status, 200, u)
      }
      assert.ok(local.includes(portuguese.payLink), 'the Pay link example is the offer’s own link')
      for (const u of found.filter((x) => !x.startsWith(base))) assert.ok(u.startsWith('https://github.com/foundationforest/services'), u)
    })

    await t.test('7. no crypto word anywhere a person reads', async () => {
      const everyPage = [...rendered.values(), (await get('/nope')).text, (await get('/pay?v=1')).text, (await get(`/deals/${MADE_UP_DEAL}`)).text]
      for (const html of everyPage) {
        const text = readable(html)
        const hit = BANNED.exec(text)
        assert.equal(hit, null, `"${hit?.[0]}" in: …${hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : ''}…`)
      }
    })

    await t.test('8. the Pay link reads back to the offer’s own terms', async () => {
      const read = parsePayLink(new URL(spanish.payLink).searchParams)
      assert.ok(read.ok)
      assert.deepEqual(read.link, { v: 2, offer: OFFERS.spanish.uri, record: OFFERS.spanish.id, price: spanish.price, terms: { timer: { days: 30, to: 'buyer' } } })
      assert.equal(new URL(portuguese.payLink).searchParams.has('seller'), false, 'no other key in the link: the seller is the profile the offer names')
      const check = async (u: string) => (await json(`${base}/pay.json${new URL(u, base).search}`)).check
      assert.equal(await check(portuguese.payLink), 'matches')
      assert.equal(await check(altered.toString()), 'differs')
      const moved = new URL(portuguese.payLink)
      moved.searchParams.set('record', 'e'.repeat(64))
      assert.equal(await check(moved.toString()), 'changed')
      const gone = new URL(portuguese.payLink)
      gone.searchParams.set('offer', `${ben.address}/offer/nothing`)
      assert.equal(await check(gone.toString()), 'notFound')
      assert.equal(await check(`${base}/pay?v=1`), 'invalid')
      const alteredPage = readable(rendered.get(altered.pathname + altered.search)!)
      assert.match(alteredPage, /its price or terms were changed\./)
      assert.doesNotMatch(alteredPage, /Don’t pay/, 'the index shows; the app advises')
    })

    await t.test('9. markets: two numbers, one label per profile, role names, near, no price, review fields', async () => {
      // An offer's and a receipt's options are plain data in the twins; the index's own words say
      // nothing about them, not even for Ana's offer whose timer sends the money back to the buyer.
      // A market's "how deals go" is the market file's text, content that may say anything: the
      // tutors' market names a timer.
      assert.deepEqual([portuguese.terms, spanish.terms], [null, { timer: { days: 30, to: 'buyer' } }])
      assert.equal('options' in spanish, false)
      const names: string[] = (await json('/index.json')).folders.flatMap((f: any) => f.markets.map((m: any) => m.name))
      const content = (await Promise.all(names.map(async (n) => (await json(`/markets/${n}.json`)).market.howDealsGo as string))).flatMap((text) => text.split(/\n+/))
      assert.ok(content.some((line) => /timer/i.test(line)), 'the test market’s own text names a timer')
      for (const [path, html] of rendered) {
        const own = content.reduce((text, line) => text.split(line).join(' '), readable(html))
        assert.doesNotMatch(own, /arbiter|timer/i, path)
      }
      for (const o of ['releasedToSeller', 'releasedToBuyer', 'split', 'arbitrated', 'timerReleased', 'unknown']) {
        assert.doesNotMatch(w.outcome(o, { buyer: 'Ben', seller: 'Ana', toSeller: '$1.00', toBuyer: '$2.00' }), /arbiter|timer/i, o)
      }
      const anaPage = readable(rendered.get(`/profiles/${ana.address}`)!)
      assert.match(anaPage, /Tutor in\s+Online tutors/, 'the profile’s one market and side, in the market’s words')
      assert.match(anaPage, /In Online tutors\s*, as tutor/, 'the real-person line uses the role name')
      assert.deepEqual([anaTwin.profile.market, anaTwin.profile.role, anaTwin.profile.side], [MARKET, 'seller', 'tutor'])
      const deal = await json(`/deals/${DEAL}.json`)
      assert.equal('options' in deal.receipt, false)
      assert.deepEqual([deal.receipt.arbiter, deal.receipt.timer], [null, null])
      assert.equal(deal.receipt.market, MARKET, 'the seller’s market')
      assert.deepEqual(deal.receipt.sides, { seller: 'tutor', buyer: 'student' })
      assert.ok(readable(rendered.get(`/deals/${DEAL}`)!).includes('The tutor asked for this payment'))

      // The objection, a fact on the receipt: which side, and when; on the deal and on the profile's
      // reviews that name it. It changes no score.
      assert.deepEqual(deal.receipt.objection, { by: 'buyer', side: 'student', at: '2026-09-06T10:00:00.000Z' })
      assert.match(readable(rendered.get(`/deals/${DEAL}`)!), /Objection Ben Okafor · 6 Sept 2026/)
      assert.ok(anaPage.includes('The student objected on 6 Sept 2026.'))
      assert.deepEqual(anaTwin.reviews.received.find((r: any) => r.reviewer === ben.address).objection, deal.receipt.objection)

      // Two numbers for every profile an offer or a receipt shows: a rating out of 10, and standing.
      assert.equal(anaTwin.scores.rating.details.reviews, 2)
      const wBen = 1 + (await json(`/profiles/${ben.address}.json`)).scores.standing.value / (1 + (await json(`/profiles/${ben.address}.json`)).scores.standing.value)
      assert.ok(Math.abs(anaTwin.scores.rating.value - (10 * wBen + 0.05) / (wBen + 0.05)) < 1e-5, `Ana rated ${anaTwin.scores.rating.value}`)
      assert.deepEqual(portuguese.rating, { value: anaTwin.scores.rating.value, reviews: 2 })
      assert.equal(portuguese.standing, anaTwin.scores.standing.value)
      assert.deepEqual(deal.receipt.sellerProfiles[0].rating, portuguese.rating)
      assert.equal((await json(`/profiles/${cleo.address}.json`)).scores.rating, null, 'no review, no rating')
      assert.ok(readable(rendered.get(`/profiles/${cleo.address}`)!).includes('No review that counts gives an overall rating yet.'))

      // A review's market is its subject's: Ana lives in online-tutors, whose file adds `sessions`.
      const byBen = anaTwin.reviews.received.find((r: any) => r.reviewer === ben.address)
      assert.deepEqual([byBen.market, byBen.fields, byBen.ratings, byBen.overall], [MARKET, { sessions: 8 }, { overall: 10, patience: 10 }, 10])
      assert.deepEqual(byBen.media, [{ sha256: PHOTO.sha256, mimeType: 'image/jpeg', url: `${fixture.host}/v1/blobs/${PHOTO.sha256}` }])
      assert.ok(anaPage.includes('Overall 10.0 of 10 · Patience 10.0 of 10'))
      assert.ok(anaPage.includes('Sessions: 8 · With 1 photo'))
      // One label per profile: Ben lives in online-tutors as a buyer. His row in the language
      // exchange is under another label, so it does not count for this profile; that market would
      // be another profile, as Dara's is. A review of him takes online-tutors' review fields.
      const benTwin = await json(`/profiles/${ben.address}.json`)
      assert.equal(benTwin.reviews.received[0].market, MARKET)
      // A row counts when its issuer's key is one this index trusts.
      assert.deepEqual(anaTwin.stamps.map((b: any) => [b.label, b.counted, b.issuer]), [
        [SELLER, true, { key: ISSUER, name: ISSUER_NAME, weight: 1 }],
      ])
      assert.deepEqual(anaTwin.scores.uniqueness.map((u: any) => [u.label, u.value, u.details.issuers]), [
        [SELLER, 1, [{ issuer: ISSUER, name: ISSUER_NAME, weight: 1 }]],
      ])
      assert.ok(anaPage.includes(`Checked by ${ISSUER_NAME}.`))
      // Eve's row: its issuer is not one this index trusts, so it counts for nothing, and nothing of
      // hers is stored: no page, no offer, no review, no count.
      assert.equal((await get(`/profiles/${eve.address}`)).status, 404)
      assert.equal((await get(`/profiles/${eve.address}.json`)).status, 404)
      assert.equal(anaTwin.reviews.received.some((r: any) => r.reviewer === eve.address), false)
      assert.equal((await json(`/markets/${MARKET}.json`)).offers.some((o: any) => o.profile === eve.address), false)
      assert.deepEqual((await json(`/markets/${MARKET}.json`)).counts, { offers: 3, requests: 0, realPeople: 3 }, 'Ana, Ben and Cleo, counted in this market (buyers too); not Eve')
      assert.equal(readable(rendered.get('/sitemap.xml') ?? (await get('/sitemap.xml')).text).includes(eve.address), false)
      assert.deepEqual(
        benTwin.stamps.map((b: any) => [b.label, b.counted, b.why, b.side]).sort(),
        [[PEER, false, 'notTheProfilesLabel', null], [BUYER, true, null, 'student']],
      )
      assert.deepEqual(benTwin.scores.uniqueness.map((u: any) => u.label), [BUYER])
      assert.ok(readable(rendered.get(`/profiles/${ben.address}`)!).includes('Not counted: registered for another market or side than the one this profile is in.'))
      const daraTwin = await json(`/profiles/${dara.address}.json`)
      assert.deepEqual([daraTwin.profile.side, daraTwin.scores.uniqueness.map((u: any) => u.label)], [null, [PEER]])
      assert.match(readable(rendered.get(`/profiles/${dara.address}`)!), /In\s+Language exchange/, 'a one-sided market names no side')

      // An offer with no price has no Pay link; the market page says how deals go. The offer names
      // no market or side: they are Dara's profile's.
      const exchange = await json(`/markets/${EXCHANGE}.json`)
      assert.equal('money' in exchange.market, false)
      assert.deepEqual(exchange.market.roles, ['peer'])
      assert.deepEqual(exchange.counts, { offers: 1, requests: 0, realPeople: 1 })
      const [daraOffer] = exchange.offers
      assert.deepEqual([daraOffer.uri, daraOffer.price, daraOffer.payLink, daraOffer.location], [OFFERS.exchange.uri, null, null, LISBON])
      assert.deepEqual([daraOffer.market, daraOffer.role, 'marketWritten' in daraOffer], [EXCHANGE, 'peer', false])
      assert.ok(readable(rendered.get(`/markets/${EXCHANGE}`)!).includes('Arroios, Lisbon (within 2 km)'))
      assert.equal(
        (await json(`/pay.json?v=2&offer=${encodeURIComponent(OFFERS.exchange.uri)}&record=${OFFERS.exchange.id}&price.amount=1&price.mint=${portuguese.price.mint}&price.per=job`)).check,
        'differs',
        'a pay link for an offer with no price does not match it',
      )

      // near=lat,lon&km=N keeps the offers whose point is within km, and drops the rest.
      const near = async (path: string) => (await json(path)).offers.map((o: any) => o.uri)
      assert.deepEqual(await near(`/markets/${EXCHANGE}.json?near=38.72,-9.14&km=1`), [OFFERS.exchange.uri], 'the same point')
      assert.deepEqual(await near(`/markets/${EXCHANGE}.json?near=38.80,-9.14&km=10`), [OFFERS.exchange.uri], '8.9 km north, within 10')
      assert.deepEqual(await near(`/markets/${EXCHANGE}.json?near=38.80,-9.14&km=8`), [], '8.9 km north, not within 8')
      assert.deepEqual(await near(`/markets/${EXCHANGE}.json?near=40.42,-3.70&km=100`), [], 'Madrid')
      assert.deepEqual(await near(`/markets/${MARKET}.json?near=38.72,-9.14&km=20000`), [], 'offers that name no place are left out')
      assert.deepEqual(await near('/search.json?q=english&near=38.7,-9.1&km=25'), [OFFERS.exchange.uri])
      assert.deepEqual((await json(`/markets/${EXCHANGE}.json?near=38.72,-9.14&km=1`)).near, { lat: 38.72, lon: -9.14, km: 1 })
      for (const q of ['near=38.72&km=5', 'near=91,0&km=5', 'near=38.72,-9.14', 'near=38.72,-9.14&km=0', 'km=5', 'near=a,b&km=5']) {
        const bad = await get(`/markets/${EXCHANGE}.json?${q}`)
        assert.equal(bad.status, 400, q)
        assert.equal(JSON.parse(bad.text).error, 'BadRequest', q)
        assert.equal((await get(`/markets/${EXCHANGE}?${q}`)).status, 400, `${q}: the page too`)
      }
    })

    await t.test('10. records: the access rule, by forest’s view, and private records left alone', async () => {
      // Two keys Ana lists wrote an offer each into her profile: the access key she revoked, whose
      // offer counts, and her message key, whose offer does not: only a write key, or a revoked one,
      // writes. Neither is her own record, and the first counts in full: an offer is an offer,
      // whoever signed it for her.
      const uris = anaTwin.offers.map((o: any) => o.uri)
      assert.ok(uris.includes(OFFERS.french.uri), 'the revoked access key’s offer')
      assert.equal(uris.includes(`${ana.address}/offer/german`), false, 'the message key’s offer counts for nothing')
      // A private record at an offer's path: its readers open it, the index never stores it.
      assert.equal(uris.includes(`${ana.address}/offer/private`), false)
      assert.equal((await fixture.db.query("select count(*)::int as n from offers where uri like '%/offer/private'")).rows[0].n, 0)
      // Every record is kept as the host served it, the ones that do not count too.
      assert.equal((await fixture.db.query('select count(*)::int as n from host_records where profile = $1 and host = $2', [ana.address, HOST])).rows[0].n, 9)
    })

    await t.test('11. pictures: from a host that holds them, with the type the record names', async () => {
      const at = (p: { sha256: string }) => `${fixture.host}/v1/blobs/${p.sha256}`
      // Ben's photo of Ana's lesson: an image, from the host that holds it, whose bytes are its hash.
      const anaPage = rendered.get(`/profiles/${ana.address}`)!
      const byBen = anaTwin.reviews.received.find((r: any) => r.reviewer === ben.address)
      assert.deepEqual(byBen.media, [{ sha256: PHOTO.sha256, mimeType: 'image/jpeg', url: at(PHOTO) }])
      assert.ok(anaPage.includes(`<img src="${at(PHOTO)}" alt="A photo with this review" loading="lazy">`))
      const res = await fetch(at(PHOTO))
      assert.equal(res.headers.get('content-type'), 'image/jpeg')
      assert.equal(createHash('sha256').update(new Uint8Array(await res.arrayBuffer())).digest('hex'), PHOTO.sha256)
      // Dara's video: played with the type her offer names, wherever the offer is shown.
      assert.deepEqual((await json(`/markets/${EXCHANGE}.json`)).offers[0].media, [{ sha256: CLIP.sha256, mimeType: 'video/mp4', url: at(CLIP) }])
      for (const path of [`/markets/${EXCHANGE}`, `/profiles/${dara.address}`]) {
        assert.ok(rendered.get(path)!.includes(`<video controls preload="none"><source src="${at(CLIP)}" type="video/mp4"></video>`), path)
      }
      // Ana's photo: her card names it, no host holds it, so no page shows it.
      assert.deepEqual(anaTwin.profile.photo, { sha256: NO_PHOTO.sha256, mimeType: 'image/png', url: null })
      assert.equal(anaPage.includes(NO_PHOTO.sha256), false)
      assert.equal([...anaPage.matchAll(/<img\b/g)].length, 1, 'only Ben’s photo')
      // What the index keeps: which host holds which bytes, as which type. Never the bytes.
      const { rows } = await fixture.db.query('select sha256, host, type from blobs order by type')
      assert.deepEqual(rows, [
        { sha256: PHOTO.sha256, host: fixture.host, type: 'image/jpeg' },
        { sha256: CLIP.sha256, host: fixture.host, type: 'video/mp4' },
      ])
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fixture.drop()
  }
})
