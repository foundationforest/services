// The pages: the four JSON answers the mcp reads, each page drawn from its JSON twin alone, the
// JSON-LD every page carries, search's filters and sort, and every URL the files for AI agents name.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { discriminator } from '@foundationforest/escrow-client'
import { checkBytes, unpackSignature } from '@foundationforest/keys'
import { b64u, base58 } from '@foundationforest/records'

import { ESCROW_PROGRAM } from '../src/chain.ts'
import { ROOT } from '../src/index.ts'
import { deal } from '../src/pages/deal.ts'
import { home } from '../src/pages/home.ts'
import { market } from '../src/pages/market.ts'
import { profile as profilePage } from '../src/pages/profile.ts'
import { search } from '../src/pages/search.ts'
import { draw, type Page } from '../src/pages/template.ts'
import { validateJsonLd } from './schemaorg/validate.ts'
import { at, CHAIN, DOLLAR, index, verifier, MARKETS, page, post, profile, publishProfile, startHost, startRpc, twin } from './world.ts'

const BASE = 'https://index.test.example'
const by = verifier()
const keys = [{ key: by.key, verifier: by.name, label: 'face check', points: 1 }]
let host: Awaited<ReturnType<typeof startHost>>
let rpc: Awaited<ReturnType<typeof startRpc>>
let i: Awaited<ReturnType<typeof index>>
const people: { [name: string]: Awaited<ReturnType<typeof profile>> } = {}
const escrow = base58.encode(randomBytes(32))

const u64 = (n: bigint) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, n, true)
  return b
}
const bytes = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]))

before(async () => {
  host = await startHost()
  for (const [name, label] of Object.entries({ a: 'tutoring/tutor', b: 'tutoring/tutor', c: 'tutoring/tutor', s1: 'tutoring/student', s2: 'tutoring/student' })) {
    people[name] = await profile(label, [by])
  }
  people.uncounted = await profile('tutoring/tutor')
  for (const p of Object.values(people)) await publishProfile(host.url, p)
  const { a, b, c, s1, s2, uncounted } = people as { [k: string]: (typeof people)[string] }
  await post(host.url, [
    at(a!, 'offer/a', { description: 'Maths and physics, in Madrid.', subjects: ['maths', 'physics'], price: { amount: '30', currency: 'USD', per: 'hour' }, place: { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid' } }),
    at(b!, 'offer/b', { description: 'Maths, online.', subjects: ['maths'], place: { online: true } }),
    at(c!, 'offer/c', { description: 'Chemistry, in Lisbon.', subjects: ['chemistry'], place: { lat: '38.72', lon: '-9.14', precisionKm: 1, area: 'Lisbon' } }),
    at(s1!, 'offer/need', { description: 'Help with maths homework.', subjects: ['maths'] }),
    at(uncounted!, 'offer/u', { description: 'Maths, uncounted.' }),
    at(s1!, 'review/a', { subject: a!.key.address, score: '9', offer: `${a!.key.address}/offer/a`, text: 'Very clear.', evidence: `${CHAIN}:${escrow}` }),
    at(s2!, 'review/a', { subject: a!.key.address, score: '9', offer: `${a!.key.address}/offer/a` }),
    at(s2!, 'review/b', { subject: b!.key.address, score: '4', offer: `${b!.key.address}/offer/b` }),
    at(uncounted!, 'review/a', { subject: a!.key.address, score: '1' }),
  ])
  const signature = base58.encode(randomBytes(64))
  const key = (x: string) => base58.decode(x)
  const empty = bytes(Uint8Array.of(0), ...Array.from({ length: 4 }, () => new Uint8Array(10)), Uint8Array.of(0))
  const created = bytes(discriminator('event', 'Created'), key(escrow), Uint8Array.of(3), u64(1n), key(s1!.pay.solana), key(a!.pay.solana), Uint8Array.of(0), new Uint8Array(32), key(DOLLAR), randomBytes(32), randomBytes(32), u64(30_000_000n), empty, u64(1_790_000_000n))
  const ended = bytes(discriminator('event', 'Ended'), key(escrow), Uint8Array.of(0), u64(30_000_000n), u64(30_000_000n), u64(0n), u64(30_000_000n), u64(1_790_000_100n), randomBytes(32), u64(0n), u64(1_790_000_050n))
  const logs = [`Program ${ESCROW_PROGRAM} invoke [1]`, ...[created, ended].map((e) => `Program data: ${Buffer.from(e).toString('base64')}`), `Program ${ESCROW_PROGRAM} success`]
  rpc = await startRpc((method, params) =>
    method === 'getSignaturesForAddress' ? ((params[1] as { until?: string }).until ? [] : [{ signature, err: null }]) : { blockTime: 1_790_000_200, meta: { err: null, logMessages: logs } },
  )
  i = await index({ hosts: [host.url], keys }, rpc.url)
  await i.pass()
})
after(async () => {
  await i.close()
  await host.close()
  await rpc.close()
})

const keysOf = (o: object) => Object.keys(o).sort()
const RESULT = ['checks', 'market', 'post', 'profile', 'rating', 'role']
const RATING = ['reviews', 'signature', 'statement', 'value', 'withPayment']

test('the four answers the mcp reads, in their shapes', async () => {
  const home = (await twin<{ index: string; markets: Array<{ name: string; description: string; roles: string[] }> }>(i, '/index.json')).body
  assert.deepEqual(keysOf(home), ['index', 'lists', 'markets'])
  assert.equal(home.index, i.address)
  const directory = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; description: string; roles: Array<{ role: string }> }> }
  assert.deepEqual(home.markets, directory.markets.map((m) => ({ name: m.name, description: m.description, roles: m.roles.map((r) => r.role) })))

  const m = (await twin<{ index: string; market: unknown; posts: { [role: string]: Array<{ [k: string]: unknown }> } }>(i, '/markets/tutoring.json')).body
  assert.deepEqual(keysOf(m), ['index', 'market', 'posts'])
  // The market's file verbatim, its preview among the rest.
  const file = JSON.parse(readFileSync(join(MARKETS, 'markets/tutoring.json'), 'utf8')) as { preview?: string[] }
  assert.deepEqual(m.market, file)
  assert.ok(file.preview?.length)
  assert.deepEqual((m.market as { preview: string[] }).preview, file.preview)
  assert.deepEqual(Object.keys(m.posts), ['tutor', 'student'])
  for (const r of Object.values(m.posts).flat()) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.post as object), ['address', 'body'])
    assert.deepEqual(keysOf(r.rating as object), RATING)
    for (const c of r.checks as object[]) assert.deepEqual(keysOf(c), ['key', 'label', 'verifier'])
  }

  const s = (await twin<{ index: string; total: number; results: Array<{ [k: string]: unknown }> }>(i, '/search.json?q=maths')).body
  assert.deepEqual(keysOf(s), ['index', 'results', 'total'])
  for (const r of s.results) assert.deepEqual(keysOf(r), RESULT)

  const p = (await twin<{ [k: string]: unknown }>(i, `/profiles/${people.a!.key.address}.json`)).body
  assert.deepEqual(keysOf(p), ['address', 'checks', 'index', 'posts', 'profile', 'proofs', 'rating', 'reviews'])
  assert.deepEqual(keysOf(p.rating as object), RATING)
  for (const x of p.posts as object[]) assert.deepEqual(keysOf(x), ['address', 'body', 'listed'])
  const reviews = p.reviews as { received: Array<{ [k: string]: unknown }>; given: unknown[] }
  assert.deepEqual(keysOf(reviews), ['given', 'received'])
  for (const r of reviews.received) assert.deepEqual(keysOf(r), ['address', 'body', 'counted', 'evidence', 'reviewer', 'weight', ...(r.counted ? [] : ['why'])].sort())
  assert.deepEqual(p.rating, { ...(p.rating as object), value: 9, reviews: 2, withPayment: 1 })

  // The rating's statement, signed by the index's key.
  const rating = p.rating as unknown as { statement: string; signature: string }
  assert.deepEqual(JSON.parse(rating.statement), { ...JSON.parse(rating.statement), index: i.address, profile: people.a!.key.address, rating: '9.0', reviews: 2, withPayment: 1 })
  assert.ok(checkBytes(i.address, new TextEncoder().encode(rating.statement), unpackSignature(b64u.decode(rating.signature))!))

  // A profile that does not count has a page, and no rating.
  const u = (await twin<{ rating: unknown; checks: unknown[] }>(i, `/profiles/${people.uncounted!.key.address}.json`)).body
  assert.deepEqual(u.rating, { value: null, reviews: 0, withPayment: 0 })
  assert.deepEqual(u.checks, [])
})

test("every page is drawn from its twin's object, and its JSON-LD passes schema.org's vocabulary", async () => {
  const pages: Array<[string, Page<never>]> = [
    ['/', home as Page<never>],
    ['/markets/tutoring', market as Page<never>],
    ['/markets/tennis-matches', market as Page<never>],
    [`/profiles/${people.a!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}`, profilePage as Page<never>],
    [`/deals/${escrow}`, deal as Page<never>],
    ['/search?q=maths', search as Page<never>],
    ['/search', search as Page<never>],
  ]
  for (const [path, module] of pages) {
    const served = await page(i, path)
    assert.equal(served.status, 200, path)
    const [bare, query] = path.split('?')
    const o = (await twin<never>(i, `${bare === '/' ? '/index' : bare}.json${query ? `?${query}` : ''}`)).body
    assert.equal(served.text, draw(module, o, BASE, `${BASE}${path}`, i.address), path)
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(served.text)![1]!
    assert.deepEqual(validateJsonLd(JSON.parse(ld)), [], path)
  }
})

test('search: words, market, role, a place, a rating, reviews, pages; sorted by the shrunk rating', async () => {
  const s = async (q: string) => (await twin<{ total: number; results: Array<{ profile: string; post: { address: string } }> }>(i, `/search.json?${q}`)).body
  const who = (r: { results: Array<{ profile: string }> }) => r.results.map((x) => Object.keys(people).find((k) => people[k]!.key.address === x.profile))
  // a: two reviews of 9; b: one of 4; c: none, so its market's mean; a, c, b.
  assert.deepEqual(who(await s('market=tutoring&role=tutor')), ['a', 'c', 'b'])
  // The student's request has no rating, so its market's mean: between a and b.
  assert.deepEqual(who(await s('q=maths')), ['a', 's1', 'b'])
  assert.deepEqual(who(await s('q=math&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('q=chem')), ['c'])
  assert.deepEqual(who(await s('q=maths%20lisbon')), [])
  assert.deepEqual(who(await s('near=40.4,-3.7&km=50')), ['a'])
  assert.deepEqual(who(await s('near=38.7,-9.1')), ['c'])
  assert.deepEqual(who(await s('minRating=8')), ['a'])
  assert.deepEqual(who(await s('minReviews=1&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('market=clothing')), [])
  const paged = await s('role=tutor&limit=1&offset=1')
  assert.equal(paged.total, 3)
  assert.deepEqual(who(paged), ['c'])
  // The uncounted profile's post is never a result.
  assert.ok(!who(await s('q=uncounted')).length)
})

test('the files for AI agents: every URL of this index they name answers', async () => {
  for (const file of ['llms.txt', 'skill.md']) {
    const text = (await page(i, `/${file}`)).text
    assert.ok(!text.includes('https://index.forest.foundation'), file)
    const found = text.split(/[\s()`[\]]+/).filter((t) => t.startsWith(BASE) && !t.includes('<'))
    assert.ok(found.length > 3, file)
    for (const url of found) assert.equal((await page(i, url.slice(BASE.length))).status, 200, url)
    assert.equal(readFileSync(join(ROOT, file), 'utf8').replaceAll('https://index.forest.foundation', BASE), text)
  }
})

test('the sitemap, robots.txt, and what is not here', async () => {
  const sitemap = (await page(i, '/sitemap.xml')).text
  assert.ok(sitemap.includes(`${BASE}/profiles/${people.a!.key.address}`))
  assert.ok(!sitemap.includes(people.uncounted!.key.address))
  assert.ok(sitemap.includes(`${BASE}/deals/${escrow}`))
  assert.match((await page(i, '/robots.txt')).text, /Sitemap: https:\/\/index\.test\.example\/sitemap\.xml/)
  assert.equal((await page(i, '/markets/knitting')).status, 404)
  assert.equal((await page(i, `/profiles/${base58.encode(randomBytes(32))}.json`)).status, 404)
  assert.equal((await page(i, '/nowhere')).status, 404)
  assert.equal(i.pages.handle(new Request(`${BASE}/`, { method: 'POST' })).status, 405)
  const head = i.pages.handle(new Request(`${BASE}/index.json`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('access-control-allow-origin'), '*')
})
