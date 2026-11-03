// The pages: the four JSON answers the mcp reads, every field they gave kept and the fields added
// beside them, each entry's time on a profile's page, each page drawn from its JSON twin alone, the
// JSON-LD every page carries, a post's own page and its twin, its photos linked at its profile
// entry's first host, the apps a page links to for messaging a profile, the profile page's order
// and its fold, search's filters and sort, and every URL the files for AI agents name.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { checkBytes, unpackSignature } from '@foundationforest/keys'
import type { Market } from '@foundationforest/markets'
import { b64u, base58 } from '@foundationforest/folders'

import { ROOT } from '../src/index.ts'
import { loadLists } from '../src/lists.ts'
import { fieldsOf, photosOf } from '../src/pages/common.ts'
import { home } from '../src/pages/home.ts'
import { market } from '../src/pages/market.ts'
import { post as postPage, type PostPage } from '../src/pages/post.ts'
import { profile as profilePage, type ProfilePage } from '../src/pages/profile.ts'
import { search } from '../src/pages/search.ts'
import { draw, esc, type Page } from '../src/pages/template.ts'
import { validateJsonLd } from './schemaorg/validate.ts'
import { at, index, listsDir, verifier, MARKETS, page, post, profile, publishProfile, startHost, TEST_APPS, twin } from './world.ts'

const BASE = 'https://index.test.example'
/** The first host the seller's profile entry names: its photos are linked there, though this index reads another. */
const PHOTOS = 'https://photos.test.example'
const COAT = ['04ea806c667cd600b86061122fb9a7192c76405d58e14d63d29c51825dc7ec86', 'a'.repeat(64)]
const by = verifier()
const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
let host: Awaited<ReturnType<typeof startHost>>
let i: Awaited<ReturnType<typeof index>>
const people: { [name: string]: Awaited<ReturnType<typeof profile>> } = {}
/** Each entry written below, by its address, `<profile>/<path>`, with its own time. */
const times = new Map<string, number>()

before(async () => {
  host = await startHost()
  for (const [name, label] of Object.entries({ a: 'tutoring/tutor', b: 'tutoring/tutor', c: 'tutoring/tutor', s1: 'tutoring/student', s2: 'tutoring/student', seller: 'clothing/seller' })) {
    people[name] = await profile(label, [by])
  }
  people.uncounted = await profile('tutoring/tutor')
  for (const [name, p] of Object.entries(people)) await publishProfile(host.url, p, name === 'seller' ? { hosts: [PHOTOS, host.url] } : {})
  const { a, b, c, s1, s2, seller, uncounted } = people as { [k: string]: (typeof people)[string] }
  const written = [
    at(a!, 'post/a', { description: 'Maths and physics, in Madrid.', subjects: ['maths', 'physics'], price: { amount: '30', currency: 'USD', per: 'hour' }, place: { lat: '40.42', lon: '-3.70', precisionKm: 1, area: 'Madrid' }, contact: 'https://wa.me/34600000000' }),
    at(b!, 'post/b', { description: 'Maths, online.', subjects: ['maths'], place: { online: true } }),
    at(c!, 'post/c', { description: 'Chemistry, in Lisbon.', subjects: ['chemistry'], place: { lat: '38.72', lon: '-9.14', precisionKm: 1, area: 'Lisbon' } }),
    at(s1!, 'post/need', { description: 'Help with maths homework.', subjects: ['maths'] }),
    // A place that is an area alone, with no point.
    at(seller!, 'post/coat', {
      description: 'A wool coat, worn twice.',
      kind: 'coat',
      price: { amount: '40', currency: 'EUR' },
      location: { area: 'Madrid' },
      photos: COAT,
      files: COAT.map((sha256, n) => ({ sha256, type: 'image/jpeg', size: 1000 + n })),
      contact: 'seller@example.com',
    }),
    at(uncounted!, 'post/u', { description: 'Maths, uncounted.' }),
    at(s1!, 'review/a', { subject: a!.key.address, score: '9', post: `${a!.key.address}/post/a`, text: 'Very clear.' }),
    at(s2!, 'review/a', { subject: a!.key.address, score: '9', post: `${a!.key.address}/post/a` }),
    at(s2!, 'review/b', { subject: b!.key.address, score: '4', post: `${b!.key.address}/post/b` }),
    at(uncounted!, 'review/a', { subject: a!.key.address, score: '1' }),
    // Its writer does not count, so neither changes a rating, a trust or search's order.
    at(uncounted!, 'vouch/a', { subject: a!.key.address, text: 'Real.' }),
    at(uncounted!, 'report/a', { subject: a!.key.address }),
  ]
  for (const e of written) times.set(`${e.profile}/${e.path}`, e.time)
  await post(host.url, written)
  i = await index({ hosts: [host.url], keys })
  await i.pass()
})
after(async () => {
  await i.close()
  await host.close()
})

const keysOf = (o: object) => Object.keys(o).sort()
const RESULT = ['checks', 'market', 'post', 'profile', 'ratings', 'role', 'trust', 'uniqueness']
const SHOWN = ['ratings', 'trust', 'uniqueness']
/** Every field a post gave before posts had pages, and the two added beside them: its page and its photos. */
const POST = ['address', 'body']
const POST_ADDED = ['photos', 'url']
const both = (old: string[], added: string[]) => [...old, ...added].sort()
const addressOf = (name: string) => people[name]!.key.address
/** A page's main part: what it draws from its object, without the head's JSON-LD, which repeats some of it. */
const mainOf = (html: string) => /<main>[\s\S]*<\/main>/.exec(html)![0]

test('the four answers the mcp reads, in their shapes: every field they gave, and those added beside them', async () => {
  const home = (await twin<{ index: string; markets: Array<{ name: string; description: string; roles: string[]; listed: { [role: string]: number } }> }>(i, '/index.json')).body
  assert.deepEqual(keysOf(home), ['index', 'lists', 'markets'])
  assert.equal(home.index, i.address)
  const directory = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; description: string; roles: Array<{ role: string }> }> }
  // Each market as the directory gives it, and, added, how many posts each role has listed.
  assert.deepEqual(home.markets.map(({ listed: _, ...m }) => m), directory.markets.map((m) => ({ name: m.name, description: m.description, roles: m.roles.map((r) => r.role) })))
  const listed = Object.fromEntries(home.markets.map((m) => [m.name, m.listed]))
  assert.deepEqual(listed.tutoring, { tutor: 3, student: 1 })
  assert.deepEqual(listed.clothing, { seller: 1, buyer: 0 })

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
    assert.deepEqual(keysOf(r.post as object), both(POST, POST_ADDED))
    assert.deepEqual(keysOf(r.ratings as object), ['count', 'value'])
    for (const c of r.checks as object[]) assert.deepEqual(keysOf(c), ['key', 'label', 'verifier'])
  }

  const s = (await twin<{ index: string; total: number; results: Array<{ [k: string]: unknown }> }>(i, '/search.json?q=maths')).body
  assert.deepEqual(keysOf(s), ['index', 'results', 'total'])
  for (const r of s.results) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.post as object), both(POST, POST_ADDED))
  }

  const p = (await twin<{ [k: string]: unknown }>(i, `/profiles/${people.a!.key.address}.json`)).body
  assert.deepEqual(keysOf(p), both(['address', 'checks', 'index', 'posts', 'profile', 'proofs', 'reports', 'reviews', 'signature', 'statement', 'vouches', 'words', ...SHOWN], ['message']))
  for (const x of p.posts as object[]) assert.deepEqual(keysOf(x), both([...POST, 'listed', 'time'], POST_ADDED))
  assert.deepEqual(p.message, [{ name: 'Forest app', url: `https://app.test.example/message?to=${addressOf('a')}` }])
  const reviews = p.reviews as { received: Array<{ [k: string]: unknown }>; given: unknown[] }
  assert.deepEqual(keysOf(reviews), ['given', 'received'])
  for (const r of reviews.received) assert.deepEqual(keysOf(r), ['address', 'body', 'counted', 'reviewer', 'time', 'weight', ...(r.counted ? [] : ['why'])].sort())
  for (const kind of ['vouches', 'reports', 'words']) assert.deepEqual(keysOf(p[kind] as object), ['given', 'received'])
  for (const kind of ['vouches', 'reports']) {
    const received = (p[kind] as { received: Array<{ [k: string]: unknown }> }).received
    assert.equal(received.length, 1, kind)
    for (const r of received) assert.deepEqual(keysOf(r), ['address', 'body', 'counted', 'time', 'writer', ...(r.counted ? [] : ['why'])].sort())
  }
  const words = (p.words as { received: Array<{ [k: string]: unknown }> }).received
  assert.deepEqual(words.map((w) => [keysOf(w), w.word]), [0, 1].map(() => [['subject', 'weight', 'word', 'writer'], 'vouch']))
  // Two raters of 9: a rating of 9, shown as it is. Each is a vouch, so a's trust is above a
  // newcomer's half of its uniqueness, and never above it.
  assert.deepEqual(p.ratings, { value: 9, count: 2 })
  assert.equal(p.uniqueness, 75)
  assert.ok((p.trust as number) > 38 && (p.trust as number) < 75, `${p.trust}`)

  // The statement of what it shows, signed by the index's key.
  const { statement, signature } = p as unknown as { statement: string; signature: string }
  assert.deepEqual(JSON.parse(statement), { index: i.address, profile: people.a!.key.address, ratings: { value: '9.0', count: 2 }, trust: p.trust, uniqueness: 75, time: JSON.parse(statement).time })
  assert.ok(checkBytes(i.address, new TextEncoder().encode(statement), unpackSignature(b64u.decode(signature))!))

  // A profile that does not count has a page, and no rating, trust or uniqueness.
  const u = (await twin<{ [k: string]: unknown }>(i, `/profiles/${people.uncounted!.key.address}.json`)).body
  assert.deepEqual([u.ratings, u.trust, u.uniqueness, u.statement], [{ value: null, count: 0 }, 0, 0, undefined])
  assert.deepEqual(u.checks, [])
})

test("each post, review, vouch and report on a profile's page gives its entry's own time", async () => {
  const seen = new Map<string, unknown>()
  for (const who of Object.values(people)) {
    const p = (await twin<ProfilePage>(i, `/profiles/${who.key.address}.json`)).body
    const all = [p.posts, p.reviews.received, p.reviews.given, p.vouches.received, p.vouches.given, p.reports.received, p.reports.given].flat()
    for (const x of all) {
      assert.equal(x.time, times.get(x.address), x.address)
      seen.set(x.address, x.time)
    }
  }
  // Every entry written is on a page, each kind among them, and each time is a plain number.
  assert.deepEqual([...seen.keys()].sort(), [...times.keys()].sort())
  assert.deepEqual(new Set([...seen.keys()].map((a) => a.split('/')[1])), new Set(['post', 'review', 'vouch', 'report']))
  for (const t of seen.values()) assert.ok(Number.isSafeInteger(t), `${t}`)
})

test("every page is drawn from its twin's object, and its JSON-LD passes schema.org's vocabulary", async () => {
  const pages: Array<[string, Page<never>]> = [
    ['/', home as Page<never>],
    ['/markets/tutoring', market as Page<never>],
    ['/markets/tennis-matches', market as Page<never>],
    ['/markets/clothing', market as Page<never>],
    [`/profiles/${people.a!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.seller!.key.address}`, profilePage as Page<never>],
    ['/search?q=maths', search as Page<never>],
    ['/search', search as Page<never>],
    [`/profiles/${people.a!.key.address}/post/a`, postPage as Page<never>],
    [`/profiles/${people.seller!.key.address}/post/coat`, postPage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}/post/u`, postPage as Page<never>],
  ]
  for (const [path, module] of pages) {
    const served = await page(i, path)
    assert.equal(served.status, 200, path)
    const [bare, query] = path.split('?')
    const o = (await twin<never>(i, `${bare === '/' ? '/index' : bare}.json${query ? `?${query}` : ''}`)).body
    assert.equal(served.text, draw(module, o, BASE, `${BASE}${path}`, i.address), path)
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(served.text)![1]!
    assert.deepEqual(validateJsonLd(JSON.parse(ld)), [], path)
    // No script but the JSON-LD; the Forest mark in the header; the key in the footer.
    assert.equal(served.text.match(/<script/g)!.length, 1, path)
    assert.match(served.text, /<header><a class="home" href="https:\/\/index\.test\.example\/"><svg class="mark"[^>]*>.*<\/svg>Forest index<\/a>/, path)
    for (const words of ['Verified by face, or by face and ID', 'Rated 9.2 by 14', 'A new profile starts at half its uniqueness', "Each profile is one person in one market and role, and nothing here links one person's profiles."]) {
      assert.ok(/<footer>[\s\S]*<\/footer>/.exec(served.text)![0].includes(words), `${path}: ${words}`)
    }
  }
})

test("search: words, market, role, a place, an area alone, a rating, raters, pages; sorted by ratings with the market's average added", async () => {
  const s = async (q: string) => (await twin<{ total: number; results: Array<{ profile: string; post: { address: string } }> }>(i, `/search.json?${q}`)).body
  const who = (r: { results: Array<{ profile: string }> }) => r.results.map((x) => Object.keys(people).find((k) => people[k]!.key.address === x.profile))
  // Every score here weighs the same: two students no one has said a word about, neither picky. So
  // the market's average is 22 / 3, about 7.33, and with one unit of it added a, two 9s, sorts at
  // about 7.7; c, unrated, at the average itself; b, one 4, at about 6.92.
  assert.deepEqual(who(await s('market=tutoring&role=tutor')), ['a', 'c', 'b'])
  // The student's request, unrated, sorts at the average too.
  assert.deepEqual(who(await s('q=maths')), ['a', 's1', 'b'])
  assert.deepEqual(who(await s('q=math&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('q=chem')), ['c'])
  assert.deepEqual(who(await s('q=maths%20lisbon')), [])
  assert.deepEqual(who(await s('near=40.4,-3.7&km=50')), ['a'])
  assert.deepEqual(who(await s('near=38.7,-9.1')), ['c'])
  assert.deepEqual(who(await s('minRating=7.5')), ['a'])
  assert.deepEqual(who(await s('minReviews=1&role=tutor')), ['a', 'b'])
  // The coat's location is an area alone: found by its words, market and role, and never near, as
  // near reads a place's point. 20000 km from Madrid reaches both posts with a point.
  assert.deepEqual(who(await s('q=coat')), ['seller'])
  assert.deepEqual(who(await s('market=clothing&role=seller')), ['seller'])
  assert.deepEqual(who(await s('near=40.4,-3.7&km=20000')), ['a', 'c'])
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
  assert.ok(sitemap.includes(`<loc>${BASE}/profiles/${people.a!.key.address}</loc>`))
  // Every listed post, and no other.
  for (const listed of [`${addressOf('a')}/post/a`, `${addressOf('seller')}/post/coat`, `${addressOf('s1')}/post/need`]) assert.ok(sitemap.includes(`<loc>${BASE}/profiles/${listed}</loc>`), listed)
  assert.ok(!sitemap.includes(people.uncounted!.key.address))
  assert.match((await page(i, '/robots.txt')).text, /Sitemap: https:\/\/index\.test\.example\/sitemap\.xml/)
  assert.equal((await page(i, '/markets/knitting')).status, 404)
  assert.equal((await page(i, `/profiles/${base58.encode(randomBytes(32))}.json`)).status, 404)
  assert.equal((await page(i, '/nowhere')).status, 404)
  for (const path of [`/profiles/${addressOf('a')}/post/nowhere`, `/profiles/${addressOf('a')}/post/nowhere.json`, `/profiles/${addressOf('a')}/posts/a`, `/profiles/${addressOf('a')}/post`, `/profiles/${addressOf('a')}/post/a/more`]) {
    assert.equal((await page(i, path)).status, 404, path)
  }
  assert.equal(i.pages.handle(new Request(`${BASE}/`, { method: 'POST' })).status, 405)
  const head = i.pages.handle(new Request(`${BASE}/index.json`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('access-control-allow-origin'), '*')
})

test("a post's page and its twin: its fields in its market's order, who posted it, and how to reach them", async () => {
  const a = addressOf('a')
  const { status, body: o } = await twin<PostPage>(i, `/profiles/${a}/post/a.json`)
  assert.equal(status, 200)
  assert.deepEqual(keysOf(o), ['checks', 'fields', 'index', 'market', 'message', 'post', 'profile', 'role', ...SHOWN].sort())
  assert.deepEqual(keysOf(o.post), both([...POST, 'listed', 'time'], POST_ADDED))
  assert.deepEqual([o.index, o.profile, o.market, o.role, o.post.address, o.post.url, o.post.listed], [i.address, a, 'tutoring', 'tutor', `${a}/post/a`, `${BASE}/profiles/${a}/post/a`, true])
  // The same profile, as its own page shows it.
  const p = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  assert.deepEqual([o.checks, o.ratings, o.trust, o.uniqueness, o.message], [p.checks, p.ratings, p.trust, p.uniqueness, p.message])
  assert.deepEqual(o.post.body, p.posts.find((x) => x.address === `${a}/post/a`)!.body)
  // The market's preview first, then the rest of its post fields in its order.
  const tutoring = JSON.parse(readFileSync(join(MARKETS, 'markets/tutoring.json'), 'utf8')) as { post: object; preview: string[] }
  assert.deepEqual(o.fields, [...tutoring.preview, ...Object.keys(tutoring.post).filter((f) => !tutoring.preview.includes(f))])
  // A market with no preview: the markets manual's, description, price, then its first place field.
  const cleaning = (await twin<{ market: Market }>(i, '/markets/home-cleaning.json')).body.market
  assert.ok(!('preview' in cleaning))
  assert.deepEqual(fieldsOf(cleaning).slice(0, 3), ['description', 'price', 'place'])
  assert.deepEqual(new Set(fieldsOf(cleaning)), new Set(Object.keys(cleaning.post)))

  const html = (await page(i, `/profiles/${a}/post/a`)).text
  assert.match(html, /<title>30 USD per hour · Maths and physics, in Madrid\.<\/title>/)
  assert.match(html, /<meta name="description" content="Maths and physics, in Madrid\.">/)
  const at = (text: string) => {
    const n = html.indexOf(text)
    assert.ok(n >= 0, text)
    return n
  }
  const order = ['<h1>30 USD per hour · Maths and physics, in Madrid.</h1>', '<dt>Subjects</dt><dd>maths, physics</dd>', '<dt>Description</dt>', '<dt>Price</dt><dd>30 USD per hour</dd>', '<dt>Place</dt><dd>Madrid</dd>', 'Posted by <a href', '<h2>How to reach them</h2>', 'Contact, as they gave it: <a href="https://wa.me/34600000000" rel="nofollow ugc">https://wa.me/34600000000</a>', `Message this profile from a Forest app: <a href="https://app.test.example/message?to=${a}">Forest app</a>.`]
  for (let n = 1; n < order.length; n++) assert.ok(at(order[n - 1]!) < at(order[n]!), order[n])
  assert.ok(!html.includes('<dt>Contact</dt>'))
  assert.ok(html.includes(`Posted by <a href="${BASE}/profiles/${a}">tutoring tutor `))
  assert.ok(html.includes('Verified by face · Rated 9.0 by 2 <span class="nums">trust'))

  // An email address is a mailto link; a post that is not listed has its page, saying why.
  assert.ok((await page(i, `/profiles/${addressOf('seller')}/post/coat`)).text.includes('<a href="mailto:seller@example.com" rel="nofollow ugc">seller@example.com</a>'))
  const u = await twin<PostPage>(i, `/profiles/${addressOf('uncounted')}/post/u.json`)
  assert.deepEqual([u.status, u.body.post.listed, u.body.post.why], [200, false, 'its profile does not count here'])
  assert.match((await page(i, `/profiles/${addressOf('uncounted')}/post/u`)).text, /<p class="no">Not listed: its profile does not count here\.<\/p>[\s\S]*Not verified here · No reviews yet/)

  // Every place that shows the post links to its page.
  for (const where of ['/markets/tutoring', '/search?q=maths', `/profiles/${a}`]) assert.ok((await page(i, where)).text.includes(`<a href="${BASE}/profiles/${a}/post/a">`), where)
  // Its JSON-LD: the Offer at the post's own page.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual([ld['@graph'][0]['@type'], ld['@graph'][0].mainEntity['@type'], ld['@graph'][0].mainEntity.url], ['ItemPage', 'Offer', `${BASE}/profiles/${a}/post/a`])
})

test("photos: each file a post's fields name, linked at its profile entry's first host, never kept here", async () => {
  const seller = addressOf('seller')
  const links = COAT.map((sha) => `${PHOTOS}/v1/files/${sha}`)
  const o = (await twin<PostPage>(i, `/profiles/${seller}/post/coat.json`)).body
  // The profile entry names the photos' host first, then the host this index reads it from.
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.profile.hosts, [PHOTOS, host.url])
  assert.deepEqual(o.post.photos, links)
  for (const path of ['/search.json?q=coat', '/markets/clothing.json']) {
    const r = (await twin<{ results?: Array<{ post: { photos: string[] } }>; posts?: { seller: Array<{ post: { photos: string[] } }> } }>(i, path)).body
    assert.deepEqual((r.results ?? r.posts!.seller)[0]!.post.photos, links, path)
  }
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.posts[0]!.photos, links)

  // Drawn as images, lazily, with the description as their text; neither the file field nor the
  // standard's files list is drawn as a field.
  const html = (await page(i, `/profiles/${seller}/post/coat`)).text
  for (const link of links) assert.ok(html.includes(`<img src="${link}" alt="A wool coat, worn twice." loading="lazy">`), link)
  for (const text of ['<dt>Photos</dt>', '<dt>Files</dt>', 'a file (', `<dd>${COAT[0]}`]) assert.ok(!html.includes(text), text)
  assert.ok(html.includes('<dt>Kind</dt><dd>coat</dd>'))
  // A card shows the first.
  for (const where of ['/markets/clothing', '/search?q=coat', `/profiles/${seller}`]) {
    const card = mainOf((await page(i, where)).text)
    assert.ok(card.includes(`<img src="${links[0]}" alt="A wool coat, worn twice." loading="lazy">`), where)
    assert.ok(!card.includes(links[1]!), where)
  }
  // The JSON-LD's Offer carries the same links.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual(ld['@graph'][0].mainEntity.image, links)
  // A value names a file only when the body lists it; a post with no files has no photos.
  assert.deepEqual(photosOf({ photos: [COAT[0]], files: [] }, PHOTOS), [])
  assert.deepEqual(photosOf({ description: COAT[0]! }, PHOTOS), [])
  assert.deepEqual((await twin<PostPage>(i, `/profiles/${addressOf('a')}/post/a.json`)).body.post.photos, [])
})

test('the apps a page links to for messaging a profile: lists/apps.json, none without it, and one that does not read stops the start', async () => {
  const keysList = { hosts: [host.url], keys }
  assert.deepEqual(loadLists(listsDir(keysList)).apps, TEST_APPS)
  assert.deepEqual(loadLists(ROOT).apps, [{ name: 'Forest app', message: 'https://app.forest.foundation/message?to={address}' }])
  assert.deepEqual(loadLists(listsDir({ ...keysList, apps: null })).apps, [])

  // Without the file, a profile's page and a post's page link to no app.
  const none = await index({ ...keysList, apps: null })
  try {
    await none.pass()
    const a = addressOf('a')
    assert.deepEqual((await twin<ProfilePage>(none, `/profiles/${a}.json`)).body.message, [])
    assert.deepEqual((await twin<PostPage>(none, `/profiles/${a}/post/a.json`)).body.message, [])
    for (const path of [`/profiles/${a}`, `/profiles/${a}/post/a`]) assert.ok(!(await page(none, path)).text.includes('Message this profile'), path)
  } finally {
    await none.close()
  }

  const about = 'For a test.'
  const bad = [
    'not an object',
    { apps: TEST_APPS },
    { about, apps: 'Forest app' },
    { about, apps: [{ message: TEST_APPS[0]!.message }] },
    { about, apps: [{ name: 'Forest app', message: 'https://app.test.example/message' }] },
    { about, apps: [{ name: 'Forest app', message: 'javascript:alert(1)//{address}' }] },
  ]
  for (const apps of bad) await assert.rejects(index({ ...keysList, apps }), /^Error: lists\/apps\.json: /, JSON.stringify(apps))
})

test("the profile page, for a buyer: what it is and shows, how to message it, its posts and the reviews it got; the rest in one fold", async () => {
  const a = addressOf('a')
  const html = mainOf((await page(i, `/profiles/${a}`)).text)
  const o = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  const fold = html.indexOf('<details><summary>Everything this index read about this profile</summary>')
  const end = html.indexOf('</details>')
  assert.ok(fold > 0 && end > fold)
  const at = (text: string) => {
    const n = html.indexOf(text)
    assert.ok(n >= 0, text)
    return n
  }
  const order = ['<h1>tutoring tutor</h1>', '<p>Verified by face · Rated 9.0 by 2 <span class="nums">trust', `Message this profile from a Forest app: <a href="https://app.test.example/message?to=${a}">`, '<h2>Posts</h2>', `<a href="${BASE}/profiles/${a}/post/a">Maths and physics, in Madrid.</a>`, '<h2>Reviews received</h2>', 'Very clear.']
  for (let n = 1; n < order.length; n++) assert.ok(at(order[n - 1]!) < at(order[n]!), order[n])
  assert.ok(at(order.at(-1)!) < fold)
  // Everything else is in the fold, and only there.
  const inFold = [`<code>${a}</code>`, '<h2>Reviews given</h2>', '<h2>Vouches and reports received</h2>', '<h2>Vouches and reports given</h2>', '<h2>Words</h2>', '<h2>Proofs</h2>', '<h2>Signed statement</h2>', `<code>${esc(o.statement!)}</code>`, `<code>${o.signature}</code>`]
  for (const text of inFold) assert.ok(at(text) > fold && at(text) < end, text)
  // A card per post, with its price and area.
  assert.match(html, /<article class="card"><p><a href="[^"]+\/post\/a">Maths and physics, in Madrid\.<\/a><\/p><p>30 USD per hour · Madrid<\/p><\/article>/)
  // A profile no verification counts for, in words.
  assert.ok((await page(i, `/profiles/${addressOf('uncounted')}`)).text.includes('<p>Not verified here · No reviews yet <span class="nums">trust 0 · uniqueness 0</span></p>'))
})

test('the home page: a search box with every market, and how many posts each role has listed; the search page asks words and a market', async () => {
  const html = (await page(i, '/')).text
  const directory = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string }> }
  assert.match(html, /<form action="https:\/\/index\.test\.example\/search" method="get"><input name="q"[^>]*> <select name="market"[^>]*><option value="">Any market<\/option>/)
  for (const m of directory.markets) assert.ok(html.includes(`<option value="${m.name}">${m.name}</option>`), m.name)
  assert.ok(html.includes('<p class="muted">3 tutor posts · 1 student post</p>'))
  assert.ok(html.includes('<p class="muted">1 seller post · 0 buyer posts</p>'))
  const form = /<form[\s\S]*?<\/form>/.exec((await page(i, '/search?near=40.4,-3.7&km=50')).text)![0]
  assert.deepEqual([...form.matchAll(/name="(\w+)"/g)].map((m) => m[1]), ['q', 'market'])
})
