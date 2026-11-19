// The pages: the JSON answers, every field they gave kept and the fields added beside them, each
// entry's time on a profile's page, each page drawn from its JSON twin and the site's fixed parts
// alone, the JSON-LD every page carries, the top bar and the foot, the font served here and nothing
// asked of another site, the forms with no script, the one rule for the greens; the results in their
// one look, a grid or a list by their market's preview; search's filters and its three orders; Where,
// against this repo's places on its own small world; a market's page, its sides and its one filters
// form; a listing's page and its twin, its photos, its prices and places in the app's words, who
// posted it and the reviews they received, and the app's link about it; the profile page; the front
// page's tiles; the About page and places' credit; and every URL the files for AI agents name.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { checkBytes, unpackSignature } from '@foundationforest/keys'
import { loadMarkets } from '@foundationforest/markets'
import { b64u, base58 } from '@foundationforest/folders'

import { animalOf } from '../src/animals.ts'
import { colorFor } from '../src/avatar.ts'
import { ROOT } from '../src/index.ts'
import { loadLists } from '../src/lists.ts'
import { answerText, BETA, inWords, layoutOf, photosOf, titleOf, valueText } from '../src/pages/common.ts'
import { home } from '../src/pages/home.ts'
import { market, type MarketPage } from '../src/pages/market.ts'
import { listing as listingPage, type ListingPage } from '../src/pages/listing.ts'
import { profile as profilePage, type ProfilePage } from '../src/pages/profile.ts'
import { search, type SearchPage } from '../src/pages/search.ts'
import { about } from '../src/pages/about.ts'
import { draw, esc, type Page, short, siteOf } from '../src/pages/template.ts'
import { validateJsonLd } from './schemaorg/validate.ts'
import { at, index, listsDir, verifier, MARKETS, page, post, profile, publishProfile, startHost, startPlaces, TEST_APPS, twin } from './world.ts'

const BASE = 'https://index.test.example'
/** The site's fixed parts, as the index draws its pages with them: the markets, and the apps the test lists name. */
const SITE = siteOf(loadMarkets(MARKETS), TEST_APPS)
const DIRECTORY = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; summary: string; description: string; number: number; roles: Array<{ role: string; listings: string }> }> }
/** Each market's color, by its number. */
const colorOf = (market: string) => colorFor(DIRECTORY.markets.find((m) => m.name === market)?.number)
/** The first host the seller's profile entry names: its photos are linked there, though this index reads another. */
const PHOTOS = 'https://photos.test.example'
const COAT = ['04ea806c667cd600b86061122fb9a7192c76405d58e14d63d29c51825dc7ec86', 'a'.repeat(64)]
const by = verifier()
const keys = [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }]
let host: Awaited<ReturnType<typeof startHost>>
let places: Awaited<ReturnType<typeof startPlaces>>
let i: Awaited<ReturnType<typeof index>>
const people: { [name: string]: Awaited<ReturnType<typeof profile>> } = {}
/** Each entry written below, by its address, `<profile>/<path>`, with its own time. */
const times = new Map<string, number>()

before(async () => {
  host = await startHost()
  places = await startPlaces()
  for (const [name, label] of Object.entries({ a: 'lessons/tutor', b: 'lessons/tutor', c: 'lessons/tutor', s1: 'lessons/student', s2: 'lessons/student', seller: 'wardrobe/seller', repairer: 'repairs/repairer' })) {
    people[name] = await profile(label, [by])
  }
  people.uncounted = await profile('lessons/tutor')
  // A profile with no profile entry here: it is never published, so a review about it names a
  // subject this index holds nothing of.
  const ghost = await profile('lessons/tutor')
  for (const [name, p] of Object.entries(people)) await publishProfile(host.url, p, name === 'seller' ? { hosts: [PHOTOS, host.url] } : {})
  const { a, b, c, s1, s2, seller, repairer, uncounted } = people as { [k: string]: (typeof people)[string] }
  const written = [
    // Its languages by ISO code, from the markets' shared list; its minutes in the market's unit; its
    // ages a range; a count with no unit; two prices, one for 2 months, 650 MXN a month, with a note;
    // its hours weekly, in its zone; its place in Madrid.
    at(a!, 'listing/a', {
      description: 'Maths and physics, in Madrid.',
      subjects: ['maths', 'physics'],
      languages: ['en', 'es'],
      minutes: '60',
      ages: { from: '9', to: '11' },
      groupSize: '4',
      price: [
        { amount: '30', currency: 'USD', per: 'hour' },
        { amount: '1300', currency: 'MXN', per: 'month', count: '2', note: 'The first lesson is free' },
      ],
      mode: ['in-person'],
      place: { lat: '40.42', lon: '-3.70', radiusKm: 5 },
      hours: [{ every: ['tuesday', 'thursday'], start: '18:00', end: '20:00', zone: 'Europe/Madrid' }],
      contact: 'https://wa.me/34600000000',
    }),
    // Online only: no place, as lessons asks for one only in person. Its ages with no top. 25 USD for
    // 0.75 hours, its 45 minutes: 33.33 an hour, the dearest per hour.
    at(b!, 'listing/b', { description: 'Maths, online.', subjects: ['maths'], languages: ['es'], minutes: '45', ages: { from: '18' }, price: [{ amount: '25', currency: 'USD', per: 'hour', count: '0.75' }], mode: ['online'], contact: 'http://example.com/maths/' }),
    // 100 USD for 5 hours: 20 an hour, the cheapest per hour.
    at(c!, 'listing/c', { description: 'Chemistry, in Lisbon.', subjects: ['chemistry'], price: [{ amount: '100', currency: 'USD', per: 'hour', count: '5' }], mode: ['in-person'], place: { lat: '38.72', lon: '-9.14', radiusKm: 5 } }),
    // A request: one age, a number in a field that takes a range; its budget the most it would pay.
    at(s1!, 'listing/need', { description: 'Help with maths homework.', subjects: ['maths'], ages: '10', price: [{ amount: '15', currency: 'GBP', per: 'hour', count: '2' }], contact: 'mailto:s1@example.com' }),
    // Its size a value its market labels, xl as XL; its place 8.9 km north of a's.
    at(seller!, 'listing/coat', {
      description: 'A wool coat, worn twice.\nCamel, long and warm.',
      wearer: ['women'],
      kind: 'coat',
      size: 'xl',
      condition: 'like-new',
      price: [{ amount: '40', currency: 'EUR' }],
      location: { lat: '40.50', lon: '-3.70', radiusKm: 2 },
      photos: COAT,
      files: COAT.map((sha256, n) => ({ sha256, type: 'image/jpeg', size: 1000 + n })),
      contact: 'seller@example.com',
    }),
    // A photo field named pastWork, not photos: the details leave it out by its piece.
    at(repairer!, 'listing/taps', { description: 'Leaks and taps fixed.', repairs: ['plumbing'], base: { lat: '37.39', lon: '-5.98', radiusKm: 10 }, licences: 'Gas', pastWork: [COAT[0]], files: [{ sha256: COAT[0], type: 'image/jpeg', size: 1000 }] }),
    at(uncounted!, 'listing/u', { description: 'Maths, uncounted.' }),
    at(s1!, 'review/a', { subject: a!.key.address, score: '9', listing: `${a!.key.address}/listing/a`, text: 'Very clear.' }),
    at(s2!, 'review/a', { subject: a!.key.address, score: '9', listing: `${a!.key.address}/listing/a` }),
    at(s2!, 'review/b', { subject: b!.key.address, score: '4', listing: `${b!.key.address}/listing/b` }),
    at(uncounted!, 'review/a', { subject: a!.key.address, score: '1' }),
    // Its writer does not count, so neither changes a rating, a trust or search's order.
    at(uncounted!, 'vouch/a', { subject: a!.key.address, text: 'Real.' }),
    at(uncounted!, 'report/a', { subject: a!.key.address }),
    // About a profile with no profile entry here, so it counts for nothing.
    at(s2!, 'review/ghost', { subject: ghost.key.address, score: '5' }),
  ]
  for (const e of written) times.set(`${e.profile}/${e.path}`, e.time)
  await post(host.url, written)
  i = await index({ hosts: [host.url], keys }, { places: places.url })
  await i.pass()
})
after(async () => {
  await i.close()
  await host.close()
  await places.close()
})

const keysOf = (o: object) => Object.keys(o).sort()
const RESULT = ['checks', 'listing', 'market', 'profile', 'ratings', 'role', 'trust', 'uniqueness']
const SHOWN = ['ratings', 'trust', 'uniqueness']
/** Every field a listing gave before listings had pages, and the two added beside them: its page and its photos. */
const LISTING = ['address', 'body']
const LISTING_ADDED = ['photos', 'url']
const both = (old: string[], added: string[]) => [...old, ...added].sort()
/** Added beside every field a review, a vouch and a report gave: the other profile's market, role and checks. */
const OTHER = ['checks', 'market', 'role']
const addressOf = (name: string) => people[name]!.key.address
/** A page's main part: what it draws from its object, without the head's JSON-LD, which repeats some of it. */
const mainOf = (html: string) => /<main>[\s\S]*<\/main>/.exec(html)![0]
/** An icon as the pages draw it, its drawing left out. */
const ICON = (name: string) => new RegExp(`<svg class="i[^"]*" data-icon="${name}"[^>]*>.*?</svg>`)
/** Who a search's results are, by the names above. */
const who = (r: { results: Array<{ profile: string }> }) => r.results.map((x) => Object.keys(people).find((k) => people[k]!.key.address === x.profile))
const s = async (q: string) => (await twin<SearchPage>(i, `/search.json?${q}`)).body
/** Where text is on a page, failing when it is not. */
const finder = (html: string) => (text: string) => {
  const n = html.indexOf(text)
  assert.ok(n >= 0, text)
  return n
}
const inOrder = (html: string, parts: string[]) => {
  const at = finder(html)
  for (let n = 1; n < parts.length; n++) assert.ok(at(parts[n - 1]!) < at(parts[n]!), parts[n])
}

test('the JSON answers, in their shapes: every field they gave, and those added beside them', async () => {
  const home = (await twin<{ index: string; markets: Array<{ name: string; summary: string; description?: string; roles: string[]; listed: { [role: string]: number }; words: { [role: string]: string } }> }>(i, '/index.json')).body
  assert.deepEqual(keysOf(home), ['index', 'lists', 'markets'])
  assert.equal(home.index, i.address)
  const directory = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; summary: string; description?: string; status: string; roles: Array<{ role: string; listings: string }> }> }
  // Each market as the directory gives it, its summary and status among it, and, added, how many listings each role has listed and each role's word for its listings.
  // A market with no description, wardrobe, gives none.
  assert.deepEqual(home.markets.map(({ listed: _, words: __, ...m }) => m), directory.markets.map((m) => ({ name: m.name, summary: m.summary, ...(m.description !== undefined && { description: m.description }), status: m.status, roles: m.roles.map((r) => r.role) })))
  assert.ok(!('description' in home.markets.find((m) => m.name === 'wardrobe')!))
  assert.deepEqual(new Set(home.markets.map((m) => (m as unknown as { status: string }).status)), new Set(['beta', 'live']))
  assert.deepEqual(home.markets.map((m) => m.words), directory.markets.map((m) => Object.fromEntries(m.roles.map((r) => [r.role, r.listings]))))
  const listed = Object.fromEntries(home.markets.map((m) => [m.name, m.listed]))
  assert.deepEqual(listed.lessons, { tutor: 3, student: 1 })
  assert.deepEqual(listed.wardrobe, { seller: 1, buyer: 0 })

  // A market's page: its file, every listing by role, as before; and, added, the side it shows and
  // what the query finds on it, a page of it, with its place and the currencies its prices are in.
  const m = (await twin<MarketPage>(i, '/markets/lessons.json')).body
  assert.deepEqual(keysOf(m), both(['index', 'listings', 'market'], ['currencies', 'place', 'query', 'results', 'role', 'total']))
  const file = JSON.parse(readFileSync(join(MARKETS, 'markets/lessons.json'), 'utf8')) as { preview?: string[] }
  assert.deepEqual(m.market, file)
  assert.ok(file.preview?.length)
  assert.deepEqual(Object.keys(m.listings), ['tutor', 'student'])
  for (const r of [...Object.values(m.listings).flat(), ...m.results]) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.listing as object), both(LISTING, LISTING_ADDED))
    assert.deepEqual(keysOf(r.ratings as object), ['count', 'value'])
    for (const c of r.checks as object[]) assert.deepEqual(keysOf(c), ['key', 'label', 'verifier'])
  }
  // With no query: the first side, all of it, in the order its listings give, and no place.
  assert.deepEqual([m.role, m.query, m.place, m.total], ['tutor', {}, null, 3])
  assert.deepEqual(m.results, m.listings.tutor)
  // Each listing counts once per currency: USD for a, b and c, MXN for a.
  assert.deepEqual(m.currencies, ['USD', 'MXN'])
  const students = (await twin<MarketPage>(i, '/markets/lessons.json?role=student')).body
  assert.deepEqual([students.role, students.query, students.total, students.currencies], ['student', { role: 'student' }, 1, ['GBP']])
  assert.deepEqual(students.results, students.listings.student)
  // A role the market does not have: its first side, the query saying nothing of it.
  const odd = (await twin<MarketPage>(i, '/markets/lessons.json?role=seller')).body
  assert.deepEqual([odd.role, odd.query], ['tutor', {}])

  const found = (await twin<SearchPage>(i, '/search.json?q=maths&km=&offset=0')).body
  // Added beside them: the filters as given, an empty one left out, every market's name, the place,
  // and how many results each market holds.
  assert.deepEqual(keysOf(found), both(['index', 'markets', 'query', 'results', 'total'], ['found', 'place']))
  assert.deepEqual(found.query, { q: 'maths', offset: '0' })
  assert.deepEqual(found.markets, directory.markets.map((m) => m.name))
  assert.deepEqual([found.place, found.found], [null, { lessons: 3 }])
  for (const r of found.results) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.listing as object), both(LISTING, LISTING_ADDED))
  }
  assert.deepEqual((await s('')).found, { lessons: 4, repairs: 1, wardrobe: 1 })

  const p = (await twin<{ [k: string]: unknown }>(i, `/profiles/${people.a!.key.address}.json`)).body
  assert.deepEqual(keysOf(p), both(['address', 'checks', 'index', 'listings', 'profile', 'proofs', 'reports', 'reviews', 'signature', 'statement', 'vouches', 'words', ...SHOWN], ['message']))
  for (const x of p.listings as object[]) assert.deepEqual(keysOf(x), both([...LISTING, 'listed', 'time'], LISTING_ADDED))
  assert.deepEqual(p.message, [{ name: 'Forest app', url: `https://app.test.example/message?to=${addressOf('a')}` }])
  const reviews = p.reviews as { received: Array<{ [k: string]: unknown }>; given: unknown[] }
  assert.deepEqual(keysOf(reviews), ['given', 'received'])
  for (const r of reviews.received) assert.deepEqual(keysOf(r), both(['address', 'body', 'counted', 'reviewer', 'time', 'weight', ...(r.counted ? [] : ['why'])].sort(), OTHER))
  for (const kind of ['vouches', 'reports', 'words']) assert.deepEqual(keysOf(p[kind] as object), ['given', 'received'])
  for (const kind of ['vouches', 'reports']) {
    const received = (p[kind] as { received: Array<{ [k: string]: unknown }> }).received
    assert.equal(received.length, 1, kind)
    for (const r of received) assert.deepEqual(keysOf(r), both(['address', 'body', 'counted', 'time', 'writer', ...(r.counted ? [] : ['why'])].sort(), OTHER))
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

test("each listing, review, vouch and report on a profile's page gives its entry's own time", async () => {
  const seen = new Map<string, unknown>()
  for (const who of Object.values(people)) {
    const p = (await twin<ProfilePage>(i, `/profiles/${who.key.address}.json`)).body
    const all = [p.listings, p.reviews.received, p.reviews.given, p.vouches.received, p.vouches.given, p.reports.received, p.reports.given].flat()
    for (const x of all) {
      assert.equal(x.time, times.get(x.address), x.address)
      seen.set(x.address, x.time)
    }
  }
  // Every entry written is on a page, each kind among them, and each time is a plain number.
  assert.deepEqual([...seen.keys()].sort(), [...times.keys()].sort())
  assert.deepEqual(new Set([...seen.keys()].map((a) => a.split('/')[1])), new Set(['listing', 'review', 'vouch', 'report']))
  for (const t of seen.values()) assert.ok(Number.isSafeInteger(t), `${t}`)
})

test("each review, vouch and report on a profile's page gives the other profile's market, role and checks: its writer's on one received, its subject's on one given", async () => {
  const pageOf = async (name: string) => (await twin<ProfilePage>(i, `/profiles/${addressOf(name)}.json`)).body
  const [a, s1, s2, u] = await Promise.all(['a', 's1', 's2', 'uncounted'].map(pageOf))
  const of = (r: { market: unknown; role: unknown; checks: unknown }) => ({ market: r.market, role: r.role, checks: r.checks })
  const find = <T extends { address: string }>(list: T[], address: string) => list.find((r) => r.address === address)!
  assert.deepEqual(s1!.checks, [{ verifier: by.name, key: by.key, label: 'face check' }])
  assert.deepEqual(of(find(a!.reviews.received, `${addressOf('s1')}/review/a`)), { market: 'lessons', role: 'student', checks: s1!.checks })
  const fromU = [find(a!.reviews.received, `${addressOf('uncounted')}/review/a`), find(a!.vouches.received, `${addressOf('uncounted')}/vouch/a`), find(a!.reports.received, `${addressOf('uncounted')}/report/a`)]
  for (const r of fromU) assert.deepEqual(of(r), { market: 'lessons', role: 'tutor', checks: [] }, r.address)
  const toA = [find(s1!.reviews.given, `${addressOf('s1')}/review/a`), find(u!.reviews.given, `${addressOf('uncounted')}/review/a`), find(u!.vouches.given, `${addressOf('uncounted')}/vouch/a`), find(u!.reports.given, `${addressOf('uncounted')}/report/a`)]
  assert.ok(a!.checks.length)
  for (const r of toA) assert.deepEqual(of(r), { market: 'lessons', role: 'tutor', checks: a!.checks }, r.address)
  assert.deepEqual(of(find(s2!.reviews.given, `${addressOf('s2')}/review/ghost`)), { market: null, role: null, checks: [] })
})

test("every page is drawn from its twin's object and the site's fixed parts, runs no script, keeps the one rule for the greens, and its JSON-LD passes schema.org's vocabulary", async () => {
  const pages: Array<[string, Page<never>]> = [
    ['/', home as Page<never>],
    ['/about', about as Page<never>],
    ['/markets/lessons', market as Page<never>],
    ['/markets/lessons?role=student&minRating=8&where=chamberi', market as Page<never>],
    ['/markets/lessons?languages=es&minutes.min=50&price.max=40&price.currency=USD&price.per=hour&sort=price', market as Page<never>],
    ['/markets/matches', market as Page<never>],
    ['/markets/wardrobe', market as Page<never>],
    [`/profiles/${people.a!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.seller!.key.address}`, profilePage as Page<never>],
    ['/search?q=maths', search as Page<never>],
    ['/search', search as Page<never>],
    ['/search?where=chamberi&sort=near', search as Page<never>],
    ['/search?near=40.53,-3.70&km=25&limit=1&offset=1', search as Page<never>],
    ['/search?q=maths&market=lessons&languages=es&minutes.min=50', search as Page<never>],
    ['/search?market=lessons&ages.min=10&price.currency=USD&price.per=hour&price.max=25&sort=price', search as Page<never>],
    [`/profiles/${people.a!.key.address}/listing/a`, listingPage as Page<never>],
    [`/profiles/${people.s1!.key.address}/listing/need`, listingPage as Page<never>],
    [`/profiles/${people.seller!.key.address}/listing/coat`, listingPage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}/listing/u`, listingPage as Page<never>],
    [`/profiles/${people.repairer!.key.address}/listing/taps`, listingPage as Page<never>],
  ]
  const fonts = new Set<string>()
  for (const [path, module] of pages) {
    const served = await page(i, path)
    assert.equal(served.status, 200, path)
    const [bare, query] = path.split('?')
    const o = (await twin<never>(i, `${bare === '/' ? '/index' : bare}.json${query ? `?${query}` : ''}`)).body
    assert.equal(served.text, draw(module, o, BASE, `${BASE}${path}`, SITE), path)
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(served.text)![1]!
    assert.deepEqual(validateJsonLd(JSON.parse(ld)), [], path)
    // No script but the JSON-LD, and no handler on any element; every form a GET to search or to a
    // market's page. The top bar: the mark alone, a link home; the Search Forest pill on every page
    // but home; Open Forest, outlined, at the first app's own address. The foot: three quiet links.
    assert.equal(served.text.match(/<script/g)!.length, 1, path)
    assert.ok(!/\son[a-z]+=/i.test(served.text.replace(/<script[\s\S]*?<\/script>/, '')), path)
    for (const form of served.text.match(/<form[^>]*>/g) ?? []) assert.match(form, /^<form (?:class="[^"]+" )?(?:id="filters" )?action="https:\/\/index\.test\.example\/(?:search|markets\/[a-z-]+)" method="get"/, path)
    const header = /<header class="top">[\s\S]*?<\/header>/.exec(served.text)![0]
    assert.match(header, /^<header class="top"><a class="home" href="https:\/\/index\.test\.example\/" aria-label="Forest index, home"><svg class="mark"[^>]*>.*?<\/svg><\/a>/, path)
    assert.equal(header.includes('<form class="pill" action="https://index.test.example/search" method="get" role="search">'), bare !== '/', path)
    assert.ok(header.endsWith('<span class="grow"></span><a class="btn out sm open" href="https://app.test.example/">Open Forest</a></header>'), path)
    assert.equal(
      /<footer[\s\S]*<\/footer>/.exec(served.text)![0],
      `<footer class="foot"><a href="${BASE}/about">About this index</a><a href="${BASE}/skill.md">For AI agents</a><a href="https://app.test.example/">Open Forest</a></footer>`,
      path,
    )
    // Strong green does something, and only these: Search, Message, Show offers or requests.
    for (const go of served.text.matchAll(/<(a|button) class="btn go[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/(?:a|button)>/g)) assert.ok(['Search', 'Message', 'Show offers', 'Show requests'].includes(go[2]!), `${path}: ${go[2]}`)
    // Nothing asked of another site: no stylesheet or script by link, and the style names only the font here.
    assert.ok(!/<link rel="stylesheet"|<script src/.test(served.text), path)
    const style = /<style>([\s\S]*?)<\/style>/.exec(served.text)![1]!
    const named = [...style.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!)
    assert.ok(named.length > 0 && named.every((u) => u.startsWith('/fonts/')), `${path}: ${named.join(' ')}`)
    for (const u of named) fonts.add(u)
  }
  // Every file the style names is served here, as the font it is: Figtree, the only one.
  assert.ok([...fonts].some((u) => u.includes('figtree-latin-wght-normal')) && [...fonts].every((u) => u.includes('figtree')), [...fonts].join(' '))
  for (const u of fonts) {
    const res = await i.pages.handle(new Request(`${BASE}${u}`))
    assert.equal(res.status, 200, u)
    assert.equal(res.headers.get('content-type'), 'font/woff2', u)
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', u)
  }
  assert.equal((await page(i, '/fonts/nowhere.woff2')).status, 404)
  assert.equal((await page(i, '/fonts/bricolage-grotesque-latin-opsz-normal.woff2')).status, 404)
  assert.equal((await page(i, '/fonts/../package.json')).status, 404)
})

test('results, one look: a picture and three lines in a grid, or two lines in a list, by the market\'s preview; no profile picture, no New', async () => {
  // Wardrobe's preview starts with its photos: a grid; the rest, a list.
  assert.deepEqual(DIRECTORY.markets.map((m) => [m.name, layoutOf(SITE, m.name)]), [['lessons', 'list'], ['matches', 'list'], ['repairs', 'list'], ['wardrobe', 'grid']])
  const coat = `${BASE}/profiles/${addressOf('seller')}/listing/coat`
  // In its market: the photo, square, no mark; its title, the description's first line, on a line
  // of its own; its price under it; no rating, so no quiet line's words.
  const wardrobe = mainOf((await page(i, '/markets/wardrobe')).text)
  assert.ok(wardrobe.includes(`<div class="grid"><a class="result" href="${coat}"><span class="pic" style="--h:${colorOf('wardrobe')}"><img src="${PHOTOS}/v1/files/${COAT[0]}" alt="" loading="lazy"></span><span class="t">A wool coat, worn twice.</span><span class="p">€40</span><span class="l2"></span></a></div>`))
  // A request's long price on its own line too, the title left whole.
  assert.ok(mainOf((await page(i, '/search?q=homework')).text).includes('<span class="t">Help with maths homework.</span><span class="p">Up to £15 for 2 hours</span><span class="l2"></span></a>'))
  // In search, the market's mark on the photo; with no photo, the market's icon on its tint.
  const found = mainOf((await page(i, '/search')).text)
  assert.ok(found.includes(`<img src="${PHOTOS}/v1/files/${COAT[0]}" alt="" loading="lazy"><span class="av mk" style="--h:${colorOf('wardrobe')}" aria-hidden="true"><svg class="i" data-icon="coat-hanger"`))
  assert.match(found, new RegExp(`<a class="result" href="${BASE}/profiles/${addressOf('a')}/listing/a"><span class="pic" style="--h:${colorOf('lessons')}"><span class="none" aria-hidden="true">${ICON('graduation-cap').source}</span></span>`))
  // A list: two lines, no picture: its title and price, then its rating with how many raters.
  const lessons = mainOf((await page(i, '/markets/lessons')).text)
  assert.match(lessons, new RegExp(`<div class="list box"><a class="result" href="${BASE}/profiles/${addressOf('a')}/listing/a"><span class="l1"><span class="t">Maths and physics, in Madrid\\.</span><span class="p">\\$30 an hour</span></span><span class="l2"><span class="rate">${ICON('star').source}9\\.0</span><span>\\(2\\)</span></span></a>`))
  assert.ok(!lessons.includes('class="pic"'))
  // A request's price is the most it would pay.
  assert.ok(mainOf((await page(i, '/markets/lessons?role=student')).text).includes('<span class="t">Help with maths homework.</span><span class="p">Up to £15 for 2 hours</span>'))
  // With a place, the distance after the rating; no rating, the distance alone.
  const north = mainOf((await page(i, '/search?near=40.53,-3.70&km=10')).text)
  assert.match(north, new RegExp(`\\/listing\\/a"[\\s\\S]*?<span class="l2"><span class="rate">${ICON('star').source}9\\.0</span><span>\\(2\\)</span><span>·</span><span>12\\.2 km</span></span>`))
  assert.ok(north.includes('<span class="l2"><span>3.3 km</span></span>'))
  // No profile's picture, name or badge on a result, and no New.
  for (const path of ['/markets/lessons', '/markets/wardrobe', '/search', '/search?q=maths']) {
    const html = mainOf((await page(i, path)).text)
    for (const text of ['class="av animal', 'class="vb', '>New<', 'Lessons tutor']) assert.ok(!html.includes(text), `${path}: ${text}`)
  }
  // A title with no description: the first of its preview's fields it holds, in words.
  assert.equal(titleOf(SITE, 'wardrobe', 'seller', { kind: 'shoes', footLength: '27' }), '27 centimetres')
  assert.equal(titleOf(SITE, 'wardrobe', 'seller', { kind: 'shoes', footLength: 27 }), '27')
  assert.equal(titleOf(SITE, 'lessons', 'tutor', {}), 'A listing')
})

test('trust and uniqueness only in a fold', async () => {
  const outsideFolds = (html: string) => mainOf(html).replace(/<details[\s\S]*?<\/details>/g, '')
  for (const path of ['/', '/markets/lessons', '/markets/wardrobe', '/search?q=maths', `/profiles/${addressOf('a')}`, `/profiles/${addressOf('a')}/listing/a`, `/profiles/${addressOf('uncounted')}`]) {
    const html = outsideFolds((await page(i, path)).text)
    assert.ok(!/trust|uniqueness/i.test(html), path)
  }
})

test("search: words, market, role, a place, a rating, raters, pages; Top rated by ratings with the market's average added", async () => {
  // Every score here weighs the same: two students no one has said a word about, neither picky. So
  // the market's average is 22 / 3, about 7.33, and with one unit of it added a, two 9s, sorts at
  // about 7.7; c, unrated, at the average itself; b, one 4, at about 6.92.
  assert.deepEqual(who(await s('market=lessons&role=tutor')), ['a', 'c', 'b'])
  assert.deepEqual(who(await s('q=maths')), ['a', 's1', 'b'])
  assert.deepEqual(who(await s('q=math&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('q=chem')), ['c'])
  assert.deepEqual(who(await s('q=maths%20lisbon')), [])
  // Near a point: those within reach, still Top rated; b, online, has no place.
  assert.deepEqual(who(await s('near=40.4,-3.7&km=50')), ['a', 'seller'])
  assert.deepEqual(who(await s('near=38.7,-9.1')), ['c'])
  assert.deepEqual(who(await s('minRating=7.5')), ['a'])
  assert.deepEqual(who(await s('minReviews=1&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('q=coat')), ['seller'])
  assert.deepEqual(who(await s('market=wardrobe&role=seller')), ['seller'])
  // With a market, its fields, each by the markets' match: a choice by a value, one of a field's
  // several answers among them; a number by a range, in its unit, either end left open. A listing
  // without the field is left out, though the markets match a missing answer; with no market, a field
  // filter is no filter, and the query leaves it out.
  assert.deepEqual(who(await s('market=lessons&languages=es')), ['a', 'b'])
  assert.deepEqual(who(await s('market=lessons&languages=en')), ['a'])
  assert.deepEqual(who(await s('market=lessons&languages=fr')), [])
  assert.deepEqual(who(await s('market=wardrobe&size=xl')), ['seller'])
  assert.deepEqual(who(await s('market=lessons&minutes.min=50')), ['a'])
  assert.deepEqual(who(await s('market=lessons&minutes.max=50')), ['b'])
  assert.deepEqual(who(await s('market=lessons&minutes.min=45&minutes.max=60')), ['a', 'b'])
  assert.deepEqual(who(await s('market=lessons&languages=es&minutes.max=50')), ['b'])
  assert.deepEqual(who(await s('languages=fr&q=maths')), ['a', 's1', 'b'])
  assert.ok(SITE.markets.match(SITE.markets.market('lessons')!.listing.groupSize!, undefined, { from: '1' }))
  assert.deepEqual(who(await s('market=lessons&groupSize.min=1')), ['a'])
  assert.deepEqual(who(await s('market=lessons&minutes.min=long')), who(await s('market=lessons')))
  // A number field that takes a range matches on overlap, each missing end limiting nothing: a's 9 to
  // 11, b's 18 and over, s1's 10, one number, the range from itself to itself.
  assert.deepEqual(who(await s('market=lessons&ages.min=10&ages.max=10')), ['a', 's1'])
  assert.deepEqual(who(await s('market=lessons&ages.min=30')), ['b'])
  assert.deepEqual(who(await s('market=lessons&ages.max=9')), ['a'])
  assert.deepEqual(who(await s('market=lessons&ages.max=8')), [])
  assert.deepEqual(who(await s('market=lessons&ages.min=11&ages.max=18')), ['a', 'b'])
  const echoed = (await s('market=lessons&role=tutor&languages=es&minutes.min=&minutes.max=50&size=xl&near=')).query
  assert.deepEqual(echoed, { market: 'lessons', role: 'tutor', languages: 'es', 'minutes.max': '50' })
  assert.deepEqual((await s('languages=fr')).query, {})
  // A place has no name, so a town's name finds a listing only where its writer wrote it.
  assert.deepEqual(who(await s('q=madrid')).sort(), ['a'])
  const paged = await s('role=tutor&limit=1&offset=1')
  assert.equal(paged.total, 3)
  assert.deepEqual(who(paged), ['c'])
  // The uncounted profile's listing is never a result.
  assert.ok(!who(await s('q=uncounted')).length)
})

test('search: a price filter, on once it gives an amount or sort=price, compares within one currency and one per', async () => {
  // By what one of its per costs, its amount divided by its count: a's 30 an hour, b's 25 for 0.75
  // hours, 33.33, c's 100 for 5 hours, 20.
  const hourly = 'price.currency=USD&price.per=hour'
  assert.deepEqual(who(await s(`${hourly}&price.max=25`)), ['c'])
  assert.deepEqual(who(await s(`${hourly}&price.min=26`)), ['a', 'b'])
  assert.deepEqual(who(await s(`${hourly}&price.min=20&price.max=20`)), ['c'])
  assert.deepEqual(who(await s(`${hourly}&sort=price`)), ['c', 'a', 'b'])
  assert.deepEqual(who(await s(`${hourly}&sort=price&price.max=30`)), ['c', 'a'])
  assert.deepEqual(who(await s(`${hourly}&sort=price&price.max=34`)), ['c', 'a', 'b'])
  // a's 1,300 MXN for 2 months is 650 a month; the coat's 40 EUR is for the whole deal.
  assert.deepEqual(who(await s('price.currency=MXN&price.per=month&price.max=650')), ['a'])
  assert.deepEqual(who(await s('price.currency=MXN&price.per=month&price.max=649')), [])
  assert.deepEqual(who(await s('price.currency=MXN&price.per=hour&price.max=1000')), [])
  assert.deepEqual(who(await s('price.currency=EUR&price.max=1000')), ['seller'])
  assert.deepEqual(who(await s('price.currency=USD&price.max=1000')), [])
  // A currency and a per with no amount filter nothing: a page's form sends both every time.
  for (const q of [hourly, 'price.currency=EUR', 'price.currency=MXN&price.per=hour']) assert.deepEqual(who(await s(q)), who(await s('')), q)
  // Without a currency, neither bounds nor sort=price do anything: no rate between currencies holds.
  assert.deepEqual(who(await s('price.per=hour&price.max=1')), who(await s('')))
  assert.deepEqual(who(await s('market=lessons&role=tutor&sort=price')), ['a', 'c', 'b'])
  // Cheapest first, ties in Top rated's order; with a place, those within reach.
  assert.deepEqual(who(await s(`${hourly}&sort=price&near=40.4,-3.7&km=20000`)), ['c', 'a'])
  assert.deepEqual((await s(`${hourly}&price.max=25&sort=price&price.min=`)).query, { 'price.currency': 'USD', 'price.per': 'hour', 'price.max': '25', sort: 'price' })
  // As the markets' own match: b's price meets a request whose budget is 34 an hour, not one of 30.
  const price = SITE.markets.market('lessons')!.listing.price!
  const b = [{ amount: '25', currency: 'USD', per: 'hour', count: '0.75' }]
  assert.equal(SITE.markets.match(price, b, [{ amount: '30', currency: 'USD', per: 'hour' }]), false)
  assert.equal(SITE.markets.match(price, b, [{ amount: '34', currency: 'USD', per: 'hour' }]), true)
})

test("search's orders: Top rated by default, a place reordering nothing; Nearest with sort=near; each result its distance", async () => {
  // From 12.2 km north of a's point, past km 10 alone; a's place reaches 5 km round it, so the two
  // circles touch. The coat is 3.3 km away, but a is rated and the coat is not: Top rated puts a
  // first; Nearest the coat.
  const north = await s('near=40.53,-3.70&km=10')
  assert.deepEqual(who(north), ['a', 'seller'])
  assert.deepEqual(north.results.map((r) => (r as { km?: number }).km), [12.2, 3.3], 'between the two centres, to one decimal')
  assert.deepEqual(keysOf(north.results[0]!), [...RESULT, 'km'].sort())
  const nearest = await s('near=40.53,-3.70&km=10&sort=near')
  assert.deepEqual([who(nearest), nearest.results.map((r) => (r as { km?: number }).km)], [['seller', 'a'], [3.3, 12.2]])
  assert.deepEqual(who(await s('near=40.53,-3.70&km=5')), ['seller'])
  // Every listing with a place, in every market: Top rated, as with no place; nearest with sort=near.
  const everywhere = await s('near=40.4,-3.7&km=20000')
  const placed = new Set(who(everywhere))
  assert.deepEqual(who(everywhere), who(await s('')).filter((x) => placed.has(x)))
  assert.deepEqual(who(await s('near=40.4,-3.7&km=20000&sort=near')), ['a', 'seller', 'repairer', 'c'])
  // Nearest needs a place, and Cheapest a price filter: without one, Top rated.
  assert.deepEqual(who(await s('sort=near')), who(await s('')))
  assert.deepEqual(who(await s('sort=price')), who(await s('')))
  assert.deepEqual(who(await s('sort=rating')), who(await s('')))
  assert.ok((await s('q=madrid')).results.every((r) => !('km' in r)))
  // The order fold offers only the orders that apply, the one in force marked.
  const fold = async (path: string) => [...(/<details class="drop end order">[\s\S]*?<\/details>/.exec(mainOf((await page(i, path)).text))![0].matchAll(/<a href="([^"]*)"( aria-current="true")?>([^<]+)<\/a>/g))].map((m) => `${m[3]}${m[2] ? '*' : ''}`)
  assert.deepEqual(await fold('/search'), ['Top rated*'])
  assert.deepEqual(await fold('/search?near=40.53,-3.70'), ['Top rated*', 'Nearest'])
  assert.deepEqual(await fold('/search?near=40.53,-3.70&sort=near'), ['Top rated', 'Nearest*'])
  assert.deepEqual(await fold('/search?price.currency=USD&price.per=hour&price.max=40'), ['Top rated*', 'Cheapest'])
  assert.deepEqual(await fold('/search?price.currency=USD&price.per=hour'), ['Top rated*'])
  assert.deepEqual(await fold('/markets/lessons?near=40.53,-3.70&price.currency=USD&price.max=40&sort=price'), ['Top rated', 'Nearest', 'Cheapest*'])
  const links = /<details class="drop end order">[\s\S]*?<\/details>/.exec(mainOf((await page(i, '/search?q=maths&near=40.53,-3.70&near.name=North&sort=near')).text))![0]
  assert.ok(links.includes(`<a href="${BASE}/search?q=maths&amp;near=40.53%2C-3.70&amp;near.name=North&amp;km=10">Top rated</a>`), links)
})

test('Where: typed words become near and the place\'s name, by places; every link carries them, never the words', async () => {
  const asked = (await (await fetch(`${places.url}/v1/find?q=chamberi`)).json()) as { places: Array<{ caption: string; place: { lat: string; lon: string } }> }
  const chamberi = { near: `${asked.places[0]!.place.lat},${asked.places[0]!.place.lon}`, name: asked.places[0]!.caption, km: 10 }
  assert.equal(chamberi.name, 'Chamberí, Madrid')
  // The first place places finds: its point is near, its caption the name; the words stay in the
  // query as given. The results are those within reach, still Top rated.
  const typed = await s('where=chamberi')
  assert.deepEqual([typed.place, typed.query], [chamberi, { where: 'chamberi' }])
  assert.deepEqual(who(typed), ['a', 'seller'])
  assert.deepEqual((await s('where=chamberi&km=2')).place, { ...chamberi, km: 2 })
  // An AI's link carries near alone: places names it now, as a circle of km there.
  assert.deepEqual((await s('near=40.53,-3.70')).place, { near: '40.53,-3.70', name: 'Chamberí, Madrid', km: 10 })
  // A link that carries the name is not asked again.
  assert.deepEqual((await s('near=40.53,-3.70&near.name=North of Madrid')).place, { near: '40.53,-3.70', name: 'North of Madrid', km: 10 })
  // The form sends back the name it showed: the same words are no new words; an emptied box clears
  // the place; other words are looked up.
  const carried = 'near=40.53,-3.70&near.name=Chamber%C3%AD%2C+Madrid'
  assert.deepEqual((await s(`where=Chamber%C3%AD%2C+Madrid&${carried}`)).place, { near: '40.53,-3.70', name: 'Chamberí, Madrid', km: 10 })
  assert.equal((await s(`where=&${carried}`)).place, null)
  assert.deepEqual((await s(`where=chamberi&${carried}`)).place, chamberi)
  // With no name carried, an empty box is no new words: the place stays.
  assert.deepEqual((await s('where=&near=40.53,-3.70')).place, { near: '40.53,-3.70', name: 'Chamberí, Madrid', km: 10 })
  // Nothing found: no place, every listing, and one line saying so.
  const none = await s('where=zzzz')
  assert.deepEqual([none.place, none.total], [null, (await s('')).total])
  const noneHtml = mainOf((await page(i, '/search?where=zzzz')).text)
  assert.ok(noneHtml.includes('<p class="s">No place found for “zzzz”.</p>'))
  assert.ok(noneHtml.includes('<summary class="chip"><svg class="i" data-icon="map-pin"') && noneHtml.includes('Anywhere'))

  // The page: the Where chip soft green with the place and how far; every link carries near, its
  // name and km, and never the words; the pill and the forms carry them too.
  const html = (await page(i, '/search?where=chamberi&q=maths')).text
  const main = mainOf(html)
  assert.match(main, new RegExp(`<summary class="chip on">${ICON('map-pin').source}Chamberí, Madrid · 10 km`))
  // Its twin, the same address as JSON, is the one link that keeps the words: it is this page; and
  // Anywhere, below, drops the place.
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!).filter((h) => (h.startsWith(`${BASE}/search`) || h.startsWith(`${BASE}/markets`)) && !h.startsWith(`${BASE}/search.json`) && h !== `${BASE}/search?q=maths`)
  assert.ok(hrefs.length > 2)
  for (const h of hrefs) assert.ok(!h.includes('where=') && h.includes(`near=${encodeURIComponent(chamberi.near)}`) && h.includes('near.name=Chamber%C3%AD%2C+Madrid') && h.includes('km=10'), h)
  assert.ok(hrefs.includes(`${BASE}/markets/lessons?q=maths&amp;near=${encodeURIComponent(chamberi.near)}&amp;near.name=Chamber%C3%AD%2C+Madrid&amp;km=10`), hrefs.join('\n'))
  const pill = /<form class="pill"[\s\S]*?<\/form>/.exec(html)![0]
  assert.ok(pill.includes('value="maths"') && pill.includes(`<input type="hidden" name="near" value="${chamberi.near}"><input type="hidden" name="near.name" value="Chamberí, Madrid"><input type="hidden" name="km" value="10">`), pill)
  // The Where box: the name it shows, the place as the link carries it, how far as chips, 10 picked.
  const where = /<details class="drop where">[\s\S]*?<\/details>/.exec(main)![0]
  assert.ok(where.includes('<input type="text" name="where" value="Chamberí, Madrid" placeholder="A city or neighbourhood" aria-label="Where">'), where)
  assert.ok(where.includes(`<input type="hidden" name="near" value="${chamberi.near}"><input type="hidden" name="near.name" value="Chamberí, Madrid">`))
  assert.deepEqual([...where.matchAll(/<input type="radio" name="km" value="(\d+)"( checked)?>/g)].map((m) => `${m[1]}${m[2] ? '*' : ''}`), ['2', '5', '10*', '25', '50'])
  assert.ok(where.includes('<input type="hidden" name="q" value="maths">') && where.includes('<button class="btn go" type="submit">Search</button>'))
  assert.ok(where.includes(`<a class="link" href="${BASE}/search?q=maths">Anywhere</a>`))
})

test("places' answers are kept: a name asked once is not asked again, and a page with no answer still opens, its place unnamed", async () => {
  const own = await startPlaces()
  const kept = await index({ hosts: [host.url], keys }, { places: own.url })
  try {
    await kept.pass()
    const a = addressOf('a')
    assert.deepEqual((await twin<ListingPage>(kept, `/profiles/${a}/listing/a.json`)).body.captions, { place: ['Madrid, Spain'] })
    assert.equal((await twin<SearchPage>(kept, '/search.json?where=chamberi')).body.place!.name, 'Chamberí, Madrid')
    await own.close()
    // Places is gone: what it said is kept; what it was never asked has no name, and the pages open.
    assert.deepEqual((await twin<ListingPage>(kept, `/profiles/${a}/listing/a.json`)).body.captions, { place: ['Madrid, Spain'] })
    assert.equal((await twin<SearchPage>(kept, '/search.json?where=chamberi')).body.place!.name, 'Chamberí, Madrid')
    assert.deepEqual((await twin<SearchPage>(kept, '/search.json?near=10.00,10.00')).body.place, { near: '10.00,10.00', name: null, km: 10 })
    assert.equal((await twin<SearchPage>(kept, '/search.json?where=munich')).body.place, null)
    const coat = await page(kept, `/profiles/${addressOf('seller')}/listing/coat`)
    assert.equal(coat.status, 200)
    assert.ok(coat.text.includes('<dt>Location</dt><dd>Within 2 km<br>'))
    assert.ok(mainOf((await page(kept, '/search?near=10.00,10.00')).text).includes('10.00, 10.00 · 10 km'))
  } finally {
    await kept.close()
  }
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
  assert.ok(sitemap.includes(`<loc>${BASE}/about</loc>`))
  for (const listed of [`${addressOf('a')}/listing/a`, `${addressOf('seller')}/listing/coat`, `${addressOf('s1')}/listing/need`]) assert.ok(sitemap.includes(`<loc>${BASE}/profiles/${listed}</loc>`), listed)
  assert.ok(!sitemap.includes(people.uncounted!.key.address))
  assert.match((await page(i, '/robots.txt')).text, /Sitemap: https:\/\/index\.test\.example\/sitemap\.xml/)
  assert.equal((await page(i, '/markets/knitting')).status, 404)
  assert.equal((await page(i, `/profiles/${base58.encode(randomBytes(32))}.json`)).status, 404)
  assert.equal((await page(i, '/nowhere')).status, 404)
  for (const path of ['/about/more', '/about/more.json', '/search/more', '/markets/lessons/filters']) assert.equal((await page(i, path)).status, 404, path)
  for (const path of [`/profiles/${addressOf('a')}/listing/nowhere`, `/profiles/${addressOf('a')}/listing/nowhere.json`, `/profiles/${addressOf('a')}/listings/a`, `/profiles/${addressOf('a')}/listing`, `/profiles/${addressOf('a')}/listing/a/more`]) {
    assert.equal((await page(i, path)).status, 404, path)
  }
  assert.equal((await i.pages.handle(new Request(`${BASE}/`, { method: 'POST' }))).status, 405)
  const head = await i.pages.handle(new Request(`${BASE}/index.json`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('access-control-allow-origin'), '*')
})

test("a listing's page and its twin: its fields in its market's order, its places named, who posted it and the reviews they received, and the app's link about it", async () => {
  const a = addressOf('a')
  const { status, body: o } = await twin<ListingPage>(i, `/profiles/${a}/listing/a.json`)
  assert.equal(status, 200)
  assert.deepEqual(keysOf(o), both(['checks', 'fields', 'index', 'listing', 'market', 'message', 'profile', 'role', ...SHOWN], ['captions', 'labels', 'pieces', 'reviews', 'units']))
  assert.deepEqual(keysOf(o.listing), both([...LISTING, 'listed', 'time'], LISTING_ADDED))
  assert.deepEqual([o.index, o.profile, o.market, o.role, o.listing.address, o.listing.url, o.listing.listed], [i.address, a, 'lessons', 'tutor', `${a}/listing/a`, `${BASE}/profiles/${a}/listing/a`, true])
  const p = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  assert.deepEqual([o.checks, o.ratings, o.trust, o.uniqueness], [p.checks, p.ratings, p.trust, p.uniqueness])
  assert.deepEqual(o.listing.body, p.listings.find((x) => x.address === `${a}/listing/a`)!.body)
  // Its message link is each app's about: the profile, and the listing's full address.
  assert.deepEqual(o.message, [{ name: 'Forest app', url: `https://app.test.example/message?to=${a}&listing=${encodeURIComponent(`${a}/listing/a`)}` }])
  // The fields the market asks a tutor, in the markets' ask's order: the preview first, place after
  // the mode its when names, then the rest, contact last.
  assert.deepEqual(o.fields, ['subjects', 'description', 'price', 'mode', 'place', 'languages', 'levels', 'minutes', 'ages', 'groupSize', 'hours', 'contact'])
  const lessons = JSON.parse(readFileSync(join(MARKETS, 'markets/lessons.json'), 'utf8')) as { listing: { [name: string]: { piece: string } } }
  assert.deepEqual(o.pieces, { ...Object.fromEntries(Object.entries(lessons.listing).map(([name, f]) => [name, f.piece])), contact: 'text' })
  assert.deepEqual(o.units, { minutes: 'minutes', ages: 'years' })
  assert.deepEqual(o.labels, { subjects: { maths: 'Maths', physics: 'Physics' }, languages: { en: 'English', es: 'Spanish' }, mode: { 'in-person': 'In person' } })
  // Its place named by places at its centre: Madrid, whose size times 5 reaches its 5 km.
  assert.deepEqual(o.captions, { place: ['Madrid, Spain'] })
  // The reviews its profile received that count: how many, and the two newest, as its page gives them.
  assert.equal(o.reviews.count, 2)
  assert.deepEqual(o.reviews.latest, p.reviews.received.filter((r) => r.counted).slice(0, 2))
  assert.deepEqual(o.reviews.latest.map((r) => r.reviewer), [addressOf('s2'), addressOf('s1')])
  assert.equal((await twin<ListingPage>(i, `/profiles/${addressOf('s1')}/listing/need.json`)).body.fields.includes('groupSize'), false)

  const html = (await page(i, `/profiles/${a}/listing/a`)).text
  assert.match(html, /<title>\$30 an hour · Maths and physics, in Madrid\.<\/title>/)
  assert.match(html, /<meta name="description" content="Maths and physics, in Madrid\.">/)
  const about = `https://app.test.example/message?to=${a}&amp;listing=${encodeURIComponent(`${a}/listing/a`)}`
  // No photos: the same page, with no top. Its market and role; its title; each price in words, a
  // note under its price; Message, with its price, opening the app; who posted it; its details, each
  // label above its value, its place in words with a map, the contact last; its reviews; the foot.
  inOrder(mainOf(html), [
    `<main>\n<div class="lpage"><div class="side"><div class="sum"><div class="from"><span class="mk"><span class="av xs" style="--h:${colorOf('lessons')}" aria-hidden="true">`,
    'Lessons</span><span class="flag">Tutor</span></div>',
    '<h1>Maths and physics, in Madrid.</h1><div class="prices"><p><span class="d">$30 an hour</span></p><p><span class="d">MX$1,300 for 2 months</span><br><span class="note">The first lesson is free</span></p></div>',
    `<div class="dock"><span class="dp"><b class="d">$30 an hour</b><span class="xs">Opens the Forest app</span></span><a class="btn go" href="${about}"><svg class="i" data-icon="paper-plane-tilt"`,
    'Message</a></div>',
    `<a class="poster" href="${BASE}/profiles/${a}"><span class="av animal md" style="--h:${colorOf('lessons')}" aria-hidden="true"><svg class="i" data-animal="${animalOf(a)[0]}"`,
    `<b>${short(a)}<span class="badges"><span class="vb" role="img" aria-label="Verified with a selfie" title="Verified with a selfie">`,
    '9.0</span><span class="s">· 2 reviews</span></span>',
    '<section class="reviews box" aria-label="Reviews"><h2>Reviews</h2><div class="rv"><span class="line"><span class="rate">',
    `<a class="link" href="${BASE}/profiles/${a}#reviews">All 2 reviews</a></section></div>\n<dl class="details box">`,
    '<dl class="details box"><div class="kv"><dt>Subjects</dt><dd>Maths and physics</dd></div>',
    '<div class="kv"><dt>Online or in person</dt><dd>In person</dd></div><div class="kv"><dt>Area</dt><dd>Within 5 km of Madrid, Spain<br><a href="https://www.openstreetmap.org/?mlat=40.42&amp;mlon=-3.70#map=15/40.42/-3.70">See on a map<svg',
    '<div class="kv"><dt>Languages</dt><dd>English and Spanish</dd></div>',
    '<div class="kv"><dt>Lesson length</dt><dd>60 minutes</dd></div>',
    '<div class="kv"><dt>Ages</dt><dd>9 to 11 years</dd></div>',
    '<div class="kv"><dt>Group size</dt><dd>4</dd></div>',
    '<div class="kv"><dt>Days and times</dt><dd>Tuesdays and Thursdays, 18:00 to 20:00 (Europe/Madrid)</dd></div>',
    '<div class="kv"><dt>Contact</dt><dd><a href="https://wa.me/34600000000" rel="nofollow ugc">wa.me/34600000000<svg',
    `<p class="listed">Listed by this index. For AI agents: <a href="${BASE}/profiles/${a}/listing/a.json">this page as JSON</a></p></div>\n</main>`,
  ])
  // Each review: its score with its star, its month, its text.
  assert.match(html, new RegExp(`<div class="rv"><span class="line"><span class="rate">${ICON('star').source}9</span><span class="xs"><time datetime="\\d{4}-\\d{2}">[A-Z][a-z]{2} \\d{4}</time></span></span><span class="text">Very clear\\.</span></div>`))
  for (const text of ['<dt>Description</dt>', '<dt>Price</dt>', '<section class="about"', '<div class="gal"']) assert.ok(!mainOf(html).includes(text), text)

  // A link's words have no scheme and no trailing slash; an email address is a link to write to
  // it, its words the address alone, with or without its mailto:.
  assert.ok((await page(i, `/profiles/${addressOf('b')}/listing/b`)).text.includes('<dt>Contact</dt><dd><a href="http://example.com/maths/" rel="nofollow ugc">example.com/maths<svg'))
  assert.ok((await page(i, `/profiles/${addressOf('seller')}/listing/coat`)).text.includes('<dt>Contact</dt><dd><a href="mailto:seller@example.com" rel="nofollow ugc">seller@example.com</a></dd>'))
  // A request: its price the most it would pay, its animal light, its profile no reviews yet.
  const need = (await page(i, `/profiles/${addressOf('s1')}/listing/need`)).text
  assert.ok(need.includes('<dt>Contact</dt><dd><a href="mailto:s1@example.com" rel="nofollow ugc">s1@example.com</a></dd>'))
  assert.ok(need.includes('<title>Up to £15 for 2 hours · Help with maths homework.</title>') && need.includes('<b class="d">Up to £15 for 2 hours</b>'))
  assert.ok(need.includes(`<span class="av animal md look" style="--h:${colorOf('lessons')}" aria-hidden="true"><svg class="i" data-animal="${animalOf(addressOf('s1'))[0]}"`))
  assert.ok(need.includes('<span class="rated"><span class="s">No reviews yet</span></span>') && !need.includes('class="reviews'))
  assert.ok(need.includes('<div class="kv"><dt>Ages</dt><dd>10 years</dd></div>'))
  assert.ok((await page(i, `/profiles/${addressOf('b')}/listing/b`)).text.includes('<div class="kv"><dt>Ages</dt><dd>18 years or more</dd></div>'))
  // A listing that is not listed has its page, saying why.
  const u = await twin<ListingPage>(i, `/profiles/${addressOf('uncounted')}/listing/u.json`)
  assert.deepEqual([u.status, u.body.listing.listed, u.body.listing.why], [200, false, 'its profile does not count here'])
  const uHtml = (await page(i, `/profiles/${addressOf('uncounted')}/listing/u`)).text
  assert.ok(uHtml.includes('<p class="red">Not listed: its profile does not count here.</p>') && uHtml.includes('<span class="rated"><span class="s">Not verified here</span></span>'))

  // The details leave out every photo field, whatever it is called: the repairer's past work is a
  // photo, and its licences a field.
  const taps = (await twin<ListingPage>(i, `/profiles/${addressOf('repairer')}/listing/taps.json`)).body
  assert.deepEqual([taps.listing.listed, taps.pieces.pastWork, taps.listing.photos], [true, 'photo', [`${host.url}/v1/files/${COAT[0]}`]])
  const tapsHtml = (await page(i, `/profiles/${addressOf('repairer')}/listing/taps`)).text
  assert.ok(!tapsHtml.includes('<dt>Past work</dt>') && !tapsHtml.includes('<dt>Files</dt>'))
  assert.ok(tapsHtml.includes('<div class="kv"><dt>Licences</dt><dd>Gas</dd></div>'))
  // Each date answer with hours says its zone beside them; one with none, none.
  const days = { piece: 'date', several: true } as const
  assert.equal(
    answerText(SITE.markets, days, [{ every: ['saturday'], start: '09:00', end: '12:00', zone: 'Europe/London' }, { on: '2031-06-02' }]),
    'Saturdays, 9:00 to 12:00 (Europe/London); Monday 2 June 2031',
  )
  assert.equal(valueText({ from: '9', to: '11' }), 'from: 9, to: 11')

  // Every place that shows the listing links to its page.
  for (const where of ['/markets/lessons', '/search?q=maths', `/profiles/${a}`]) assert.ok((await page(i, where)).text.includes(`<a class="result" href="${BASE}/profiles/${a}/listing/a">`), where)
  // Its JSON-LD: the Offer at the listing's own page, each price a unit price for its count of its per.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual([ld['@graph'][0]['@type'], ld['@graph'][0].mainEntity['@type'], ld['@graph'][0].mainEntity.url], ['ItemPage', 'Offer', `${BASE}/profiles/${a}/listing/a`])
  assert.deepEqual(ld['@graph'][0].mainEntity.priceSpecification, [
    { '@type': 'UnitPriceSpecification', price: '30', priceCurrency: 'USD', referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: 'hour' } },
    { '@type': 'UnitPriceSpecification', price: '1300', priceCurrency: 'MXN', referenceQuantity: { '@type': 'QuantitativeValue', value: 2, unitText: 'month' } },
  ])
})

test("photos: each file a listing's fields name, linked at its profile entry's first host, never kept here; on its page one at a time, numbered", async () => {
  const seller = addressOf('seller')
  const links = COAT.map((sha) => `${PHOTOS}/v1/files/${sha}`)
  const o = (await twin<ListingPage>(i, `/profiles/${seller}/listing/coat.json`)).body
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.profile.hosts, [PHOTOS, host.url])
  assert.deepEqual(o.listing.photos, links)
  for (const path of ['/search.json?q=coat', '/markets/wardrobe.json']) {
    const r = (await twin<{ results: Array<{ listing: { photos: string[] } }> }>(i, path)).body
    assert.deepEqual(r.results[0]!.listing.photos, links, path)
  }
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.listings[0]!.photos, links)
  assert.deepEqual(o.captions, { location: ['Chamberí, Madrid'] })

  // At the top, each a figure at its own anchor, with the description as its text, "1 / 2", and round
  // arrows to the one before and after, round the ends; the first loaded at once, the rest lazily.
  const html = (await page(i, `/profiles/${seller}/listing/coat`)).text
  const alt = 'A wool coat, worn twice.\nCamel, long and warm.'
  assert.ok(html.includes(`<div class="lpage"><div class="gal" style="--h:${colorOf('wardrobe')}"><figure class="ph" id="photo-1"><img src="${links[0]}" alt="${esc(alt)}"><a class="round back" href="#photo-2" aria-label="Previous photo">`), html)
  assert.ok(html.includes(`<a class="round next" href="#photo-2" aria-label="Next photo">`) && html.includes('<span class="at">1 / 2</span></figure>'))
  assert.ok(html.includes(`<figure class="ph" id="photo-2"><img src="${links[1]}" alt="${esc(alt)}" loading="lazy"><a class="round back" href="#photo-1"`) && html.includes('<span class="at">2 / 2</span></figure></div>'))
  for (const text of ['<dt>Photos</dt>', '<dt>Files</dt>', 'a file (', `<dd>${COAT[0]}`]) assert.ok(!html.includes(text), text)
  // A choice's value as the markets read it: in words, or by its label where its field has one.
  assert.ok(html.includes('<div class="kv"><dt>Kind</dt><dd>Coat</dd></div>'))
  assert.ok(html.includes('<div class="kv"><dt>Condition</dt><dd>Like new</dd></div>'))
  assert.ok(html.includes('<div class="kv"><dt>Size</dt><dd>XL</dd></div>'))
  assert.deepEqual(o.labels, { wearer: { women: 'Women' }, kind: { coat: 'Coat' }, size: { xl: 'XL' }, condition: { 'like-new': 'Like new' } })
  // Its place named by places: Chamberí, the nearest, whose size times 5 reaches its 2 km.
  assert.ok(html.includes('<div class="kv"><dt>Location</dt><dd>Within 2 km of Chamberí, Madrid<br><a href="https://www.openstreetmap.org/?mlat=40.50&amp;mlon=-3.70#map=15/40.50/-3.70">See on a map<svg'))
  // Its title, the description's first line; the rest under About, in full.
  assert.ok(html.includes('<h1>A wool coat, worn twice.</h1><div class="prices"><p><span class="d">€40</span></p></div>'))
  assert.ok(html.includes('<section class="about"><h2>About</h2><p class="text">Camel, long and warm.</p></section>'))
  // A result shows the first, square; the profile's own page too, as its market shows them.
  for (const where of ['/markets/wardrobe', '/search?q=coat', `/profiles/${seller}`]) {
    const shown = mainOf((await page(i, where)).text)
    assert.ok(shown.includes(`<span class="pic" style="--h:${colorOf('wardrobe')}"><img src="${links[0]}" alt="" loading="lazy">`), where)
    assert.ok(!shown.includes(links[1]!), where)
  }
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual(ld['@graph'][0].mainEntity.image, links)
  // One photo: no arrows. A value names a file only when the body lists it; a listing with no files has no photos.
  assert.ok(!(await page(i, `/profiles/${addressOf('repairer')}/listing/taps`)).text.includes('class="round back"'))
  assert.deepEqual(photosOf({ photos: [COAT[0]], files: [] }, PHOTOS), [])
  assert.deepEqual(photosOf({ description: COAT[0]! }, PHOTOS), [])
  assert.deepEqual((await twin<ListingPage>(i, `/profiles/${addressOf('a')}/listing/a.json`)).body.listing.photos, [])
})

test('the apps a page links to: lists/apps.json, a message link and an about link each, none without it, and one that does not read stops the start', async () => {
  const keysList = { hosts: [host.url], keys }
  assert.deepEqual(loadLists(listsDir(keysList)).apps, TEST_APPS)
  assert.deepEqual(loadLists(ROOT).apps, [{ name: 'Forest app', message: 'https://app.forest.foundation/message?to={address}', about: 'https://app.forest.foundation/message?to={address}&listing={listing}' }])
  assert.deepEqual(loadLists(listsDir({ ...keysList, apps: null })).apps, [])

  // Without the file, and with no places: a profile's page and a listing's page link to no app, and
  // a place shows by its size alone.
  const none = await index({ ...keysList, apps: null })
  try {
    await none.pass()
    const a = addressOf('a')
    assert.deepEqual((await twin<ProfilePage>(none, `/profiles/${a}.json`)).body.message, [])
    assert.deepEqual((await twin<ListingPage>(none, `/profiles/${a}/listing/a.json`)).body.message, [])
    assert.deepEqual((await twin<ListingPage>(none, `/profiles/${a}/listing/a.json`)).body.captions, { place: [null] })
    for (const path of ['/', `/profiles/${a}`, `/profiles/${a}/listing/a`]) {
      const text = (await page(none, path)).text
      assert.ok(!text.includes('app.test.example') && !text.includes('Open Forest') && !text.includes('class="dock"') && !text.includes('btn go wide'), path)
    }
    assert.ok((await page(none, `/profiles/${a}/listing/a`)).text.includes('<dt>Area</dt><dd>Within 5 km<br>'))
    assert.equal((await twin<SearchPage>(none, '/search.json?where=chamberi')).body.place, null)
    assert.equal((await twin<{ credit: unknown }>(none, '/about.json')).body.credit, null)
  } finally {
    await none.close()
  }

  const about = 'For a test.'
  const app = TEST_APPS[0]!
  const bad = [
    'not an object',
    { apps: TEST_APPS },
    { about, apps: 'Forest app' },
    { about, apps: [{ message: app.message, about: app.about }] },
    { about, apps: [{ name: 'Forest app', message: 'https://app.test.example/message', about: app.about }] },
    { about, apps: [{ name: 'Forest app', message: 'javascript:alert(1)//{address}', about: app.about }] },
    { about, apps: [{ name: 'Forest app', message: app.message }] },
    { about, apps: [{ name: 'Forest app', message: app.message, about: app.message }] },
    { about, apps: [{ name: 'Forest app', message: app.message, about: 'javascript:{address}{listing}' }] },
  ]
  for (const apps of bad) await assert.rejects(index({ ...keysList, apps }), /^Error: lists\/apps\.json: /, JSON.stringify(apps))
})

test('the profile page: its animal, name, badges and rating, Message; the numbers fold; its listings as its market shows them and the reviews it received; then everything', async () => {
  const a = addressOf('a')
  const html = mainOf((await page(i, `/profiles/${a}`)).text)
  const o = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  const meaning = html.indexOf('<details class="fold wide mean"><summary>')
  const lists = html.indexOf('<div class="lists">')
  const fold = html.indexOf('<details class="fold all"><summary>')
  const end = html.indexOf('</details>', fold)
  assert.ok(meaning > 0 && lists > meaning && fold > lists && end > fold)
  const at = finder(html)
  inOrder(html, [
    `<div class="phead"><div class="me"><span class="av animal lg" style="--h:${colorOf('lessons')}" aria-hidden="true"><svg class="i" data-animal="${animalOf(a)[0]}"`,
    '<h1>Lessons tutor<span class="badges"><span class="vb lg" role="img" aria-label="Verified with a selfie" title="Verified with a selfie">',
    `<span class="s">${short(a)}</span><span class="rated"><span class="rate">`,
    '9.0</span><span class="s">· 2 reviews</span></span>',
    `<a class="btn go wide" href="https://app.test.example/message?to=${a}">`,
    'Message</a></div>',
    '<h2>Offers</h2>',
    // As lessons shows its listings: a list, each its title and its first price.
    `<div class="list box"><a class="result" href="${BASE}/profiles/${a}/listing/a"><span class="l1"><span class="t">Maths and physics, in Madrid.</span><span class="p">$30 an hour</span></span><span class="l2"></span></a></div>`,
    '<h2 id="reviews">Reviews</h2>',
  ])
  assert.ok(at('Message</a></div>') < meaning)
  const numbers = html.slice(meaning, lists)
  for (const text of ['<span class="d">9.0</span><p class="s">The average of 2 people&#39;s reviews', `<span class="d">${o.trust}</span><p class="s">Trust, 0 to 100`, '<span class="d">75</span><p class="s">Uniqueness, 0 to 100']) assert.ok(numbers.includes(text), text)
  // The reviews it received, newest first: each its score, its month, its text, its writer's animal
  // and short name, a link to them; one that does not count says why. Vouches are in the fold.
  const reviews = html.slice(at('<h2 id="reviews">'), fold).match(/<div class="rv">[\s\S]*?<\/div>/g)!
  assert.equal(reviews.length, 3)
  const s1 = addressOf('s1')
  assert.match(reviews.find((r) => r.includes(s1))!, new RegExp(`^<div class="rv"><span class="line"><span class="rate">${ICON('star').source}9</span><span class="xs"><time datetime="[\\d-]{7}">[^<]+</time></span></span><span class="text">Very clear\\.</span><a class="who" href="${BASE}/profiles/${s1}"><span class="av animal xs look" style="--h:${colorOf('lessons')}" aria-hidden="true"><svg class="i" data-animal="${animalOf(s1)[0]}"[^>]*>.*?</svg></span><span>${short(s1)}</span></a></div>$`))
  assert.ok(reviews.find((r) => r.includes(addressOf('uncounted')))!.includes('<span class="s red">Does not count: '))
  assert.ok(!html.slice(lists, fold).includes('Vouch'))
  const inFold = [`<code>${a}</code>`, '<h3>Reviews received</h3>', '<h3>Reviews given</h3>', '<h3>Vouches and reports received</h3>', '<h3>Vouches and reports given</h3>', '<h3>Words</h3>', '<h3>Proofs</h3>', '<h3>Signed statement</h3>', `<code>${esc(o.statement!)}</code>`, `<code>${o.signature}</code>`, 'Counts, weight ']
  for (const text of inFold) assert.ok(at(text) > fold && at(text) < end, text)
  // A profile no verification counts for: no badge, no rating, and 0 and 0 in its fold.
  const u = mainOf((await page(i, `/profiles/${addressOf('uncounted')}`)).text)
  assert.ok(u.includes(`<h1>Lessons tutor</h1><span class="s">${short(addressOf('uncounted'))}</span><span class="rated"><span class="s">Not verified here</span></span>`))
  assert.ok(u.includes('<span class="d">–</span><p class="s">No rating: no one this index counts has rated it.</p>'))
  assert.equal(u.match(/<span class="d">0<\/span>/g)!.length, 2)
  // Wardrobe shows its listings as a grid; a student's animal is light.
  assert.ok(mainOf((await page(i, `/profiles/${addressOf('seller')}`)).text).includes('<h2>Offers</h2>\n<div class="grid">'))
  assert.ok((await page(i, `/profiles/${s1}`)).text.includes(`<span class="av animal lg look" style="--h:${colorOf('lessons')}"`))
  // An ID check gives the ID card, a black square as the face's: here the same key, listed as an ID key.
  const both = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'ID check', confidence: 0.95 }] })
  try {
    await both.pass()
    const text = (await page(both, `/profiles/${a}`)).text
    assert.ok(text.includes('<span class="vb lg" role="img" aria-label="Verified with ID" title="Verified with ID"><svg class="i" data-icon="identification-card"'))
    assert.ok(!text.includes('Verified with a selfie'))
  } finally {
    await both.close()
  }
})

test("the front page: one search box, and a tile per market filled with its color, its icon big, its name and every side's count, 0 among them", async () => {
  const html = mainOf((await page(i, '/')).text)
  assert.match(html, /^<main>\n<h1 class="hide">Forest index<\/h1>\n<form class="ask" action="https:\/\/index\.test\.example\/search" method="get" role="search"><label><svg class="i" data-icon="magnifying-glass"[^>]*>.*?<\/svg><input type="search" name="q" placeholder="Search Forest" aria-label="Search Forest"><\/label><button class="btn go" type="submit">Search<\/button><\/form>/)
  assert.equal(html.match(/<form/g)!.length, 1)
  const tileOf = (name: string) => new RegExp(`<a class="tile" style="--h:[^"]*" href="${BASE}/markets/${name}">.*?</a>`).exec(html)![0]
  assert.deepEqual([...html.matchAll(/<a class="tile" style="--h:([^"]*)" href="[^"]*\/markets\/([^"]*)">/g)].map((m) => [m[2], m[1]]), DIRECTORY.markets.map((m) => [m.name, colorOf(m.name)]))
  // Its icon, big and quiet; its name; every side's count in its own word, 0 included.
  assert.match(tileOf('lessons'), new RegExp(`<span class="big" aria-hidden="true">${ICON('graduation-cap').source}</span><span class="name">Lessons</span><span class="n">3 offers · 1 request</span></a>$`))
  assert.ok(tileOf('wardrobe').endsWith('<span class="name">Wardrobe</span><span class="n">1 offer · 0 requests</span></a>'))
  assert.ok(tileOf('repairs').endsWith('<span class="name">Repairs</span><span class="n">1 offer · 0 requests</span></a>'))
  // One side, none listed: its first letter for a market that names no icon.
  assert.ok(tileOf('matches').endsWith('<span class="big" aria-hidden="true"><span class="letter">M</span></span><span class="name">Matches</span><span class="n">0 requests</span></a>'))
  // No summary, no description, no Beta: they are on the market's page.
  for (const text of ['Tutors teach school subjects', 'Beta', 'What it reads', i.address]) assert.ok(!html.includes(text), text)
})

test('the search page: the pill holding the words, Where, a chip per market with its results, how many and the order, the grid, Show more', async () => {
  const text = (await page(i, '/search?q=maths')).text
  const html = mainOf(text)
  assert.ok(/<header[\s\S]*<\/header>/.exec(text)![0].includes('<input type="search" name="q" value="maths" placeholder="Search Forest" aria-label="Search Forest"></label></form>'))
  // Where, then a chip per market with results, each to its page with the words kept, its count black.
  assert.match(html, new RegExp(`^<main>\n<div class="seek"><details class="drop where"><summary class="chip">${ICON('map-pin').source}Anywhere`))
  const chips = /<nav class="chips" aria-label="Markets">[\s\S]*?<\/nav>/.exec(html)![0]
  assert.deepEqual([...chips.matchAll(/<a class="chip" href="([^"]*)">[\s\S]*?<\/span>([^<]*) <span class="n">(\d+)<\/span><\/a>/g)].map((m) => [m[1], m[2], m[3]]), [[`${BASE}/markets/lessons?q=maths`, 'Lessons', '3']])
  assert.deepEqual([...mainOf((await page(i, '/search')).text).matchAll(/<a class="chip" href="[^"]*\/markets\/(\w+)">/g)].map((m) => m[1]), ['lessons', 'repairs', 'wardrobe'])
  // How many, and the order; then the grid.
  assert.ok(html.includes('<div class="count"><p><b>3</b> results</p><details class="drop end order"><summary class="chip" aria-label="Order: Top rated">Top rated'))
  assert.equal(html.match(/<a class="result"/g)!.length, 3)
  assert.ok(html.includes('<div class="grid">'))
  // Show more, outlined, a link to the next page, while there is one.
  const first = mainOf((await page(i, '/search?q=maths&limit=2')).text)
  assert.ok(first.includes(`<a class="btn out more" href="${BASE}/search?q=maths&amp;limit=2&amp;offset=2">Show more</a>`))
  assert.ok(!mainOf((await page(i, '/search?q=maths&limit=2&offset=2')).text).includes('Show more'))
  assert.ok(!html.includes('Show more'))
  // One result: "1 result". What was searched is text in the pill, never markup.
  assert.ok(mainOf((await page(i, '/search?q=chem')).text).includes('<p><b>1</b> result</p>'))
  assert.ok((await page(i, '/search?q=%22%3E%3Cb%3E')).text.includes('<input type="search" name="q" value="&quot;&gt;&lt;b&gt;" placeholder'))
})

test("a market's page: its head, the description folded, its sides as tabs, Where and the filters as one form, how many and the order, its results, Show more", async () => {
  const lessons = mainOf((await page(i, '/markets/lessons')).text)
  // The head: its icon on its color, its name with Beta beside it, its summary, and what beta means.
  assert.ok(lessons.startsWith(`<main>\n<div class="mhead"><span class="av md" style="--h:${colorOf('lessons')}" aria-hidden="true"><svg class="i" data-icon="graduation-cap"`))
  // Its description behind a quiet link with its caret, no box, under the rest of its head.
  assert.match(lessons, new RegExp(`<h1>Lessons<span class="flag" title="${BETA}">Beta</span></h1><p class="s">Tutors teach school subjects one on one\\.</p><p class="xs">${BETA}</p><details class="more"><summary>More about this market${ICON('caret-down').source}</summary><p class="s">Lessons are paid by the hour or by the month, in person or online\\.</p></details></div></div>`))
  assert.ok(!lessons.includes('<details class="fold">'))
  // Its sides: each a link that keeps the words and the place, with how many it lists; the one shown soft green.
  assert.ok(lessons.includes(`<nav class="sides" aria-label="Sides"><a href="${BASE}/markets/lessons?role=tutor" aria-current="page">Offers <span class="n">3</span></a><a href="${BASE}/markets/lessons?role=student">Requests <span class="n">1</span></a></nav>`))
  const kept = mainOf((await page(i, '/markets/lessons?q=maths&near=40.53,-3.70&near.name=North&languages=es')).text)
  assert.ok(kept.includes(`<a href="${BASE}/markets/lessons?q=maths&amp;near=40.53%2C-3.70&amp;near.name=North&amp;km=10&amp;role=student">Requests <span class="n">1</span></a>`))
  // On a phone, two chips opening the form at #filters; how many, in the side's word; the order.
  assert.match(lessons, new RegExp(`<div class="controls"><div class="bar"><a class="chip" href="#filters">${ICON('map-pin').source}Anywhere</a><a class="chip" href="#filters">${ICON('sliders-horizontal').source}Filters</a></div><form class="filters" id="filters"`))
  assert.ok(lessons.includes('<div class="count"><p><b>3</b> offers</p></div><details class="drop end order">'))
  // Wardrobe: live, no description, a grid. Matches: one side, nothing listed.
  const wardrobe = mainOf((await page(i, '/markets/wardrobe')).text)
  assert.ok(wardrobe.includes('<h1>Wardrobe</h1><p class="s">People sell clothes and shoes they own.</p></div></div>') && !wardrobe.includes('Beta') && !wardrobe.includes('More about this market'))
  assert.ok(wardrobe.includes('<div class="grid">'))
  const matches = mainOf((await page(i, '/markets/matches')).text)
  assert.ok(matches.includes(`<nav class="sides" aria-label="Sides"><a href="${BASE}/markets/matches?role=player" aria-current="page">Requests <span class="n">0</span></a></nav>`))
  assert.ok(matches.includes('<p><b>0</b> requests</p>') && !matches.includes('class="result"'))
  // Show more, keeping the side.
  assert.ok(mainOf((await page(i, '/markets/lessons?role=tutor&limit=2')).text).includes(`<a class="btn out more" href="${BASE}/markets/lessons?role=tutor&amp;limit=2&amp;offset=2">Show more</a>`))
  // Words a market's page takes as search does: in the pill, carried along.
  assert.ok((await page(i, '/markets/lessons?q=chem')).text.includes('<input type="search" name="q" value="chem" placeholder="Search Forest"'))
  assert.ok(mainOf((await page(i, '/markets/lessons?q=chem')).text).includes('<p><b>1</b> offer</p>'))
})

test("a market's filters: one GET form, Where, each field the side is asked, the price in its most used currency, the rating; Clear all and Show", async () => {
  const lessons = mainOf((await page(i, '/markets/lessons?q=maths')).text)
  const form = /<form class="filters"[\s\S]*?<\/form>/.exec(lessons)![0]
  assert.ok(form.startsWith(`<form class="filters" id="filters" action="${BASE}/markets/lessons" method="get" aria-label="Filters"><div class="fhead"><a class="round" href="#" aria-label="Close">`))
  // The words carried along; then a fold for Where, each choice and number field a tutor is asked,
  // the price and the rating, each with its own Show button; Clear all and one Show at its foot.
  assert.ok(form.includes('<h2>Filters</h2></div><input type="hidden" name="q" value="maths"><details class="drop">'))
  assert.deepEqual([...form.matchAll(/<summary class="chip"><span>([^<]+)<\/span>/g)].map((m) => m[1]), ['Where', 'Subjects', 'Languages', 'Levels', 'Lesson length', 'Ages', 'Group size', 'Online or in person', 'Price', 'Rating'])
  assert.equal(form.match(/<button class="btn go show" type="submit">Show offers<\/button>/g)!.length, 10)
  assert.ok(form.endsWith(`<div class="ffoot"><a class="link" href="${BASE}/markets/lessons?q=maths">Clear all</a><button class="btn go" type="submit">Show offers</button></div></form>`))
  assert.deepEqual([...new Set([...form.matchAll(/ name="([^"]+)"/g)].map((m) => m[1]))], ['q', 'where', 'km', 'subjects', 'languages', 'levels', 'minutes.min', 'minutes.max', 'ages.min', 'ages.max', 'groupSize.min', 'groupSize.max', 'mode', 'price.max', 'price.per', 'price.currency', 'minRating'])
  // A choice as chips, Any first and picked; one with more than 12 values, the languages, as a picker.
  assert.deepEqual([...form.matchAll(/<input type="radio" name="subjects" value="([^"]*)"( checked)?>([^<]+)</g)].map((m) => `${m[3]}${m[2] ? '*' : ''}`), ['Any*', 'Maths', 'Physics', 'Chemistry', 'Biology'])
  const languages = /<select name="languages"[\s\S]*?<\/select>/.exec(form)![0]
  assert.ok(languages.startsWith('<select name="languages" aria-label="Languages"><option value="">Any</option>') && languages.includes('<option value="es">Spanish</option>'))
  assert.equal(languages.split('<option').length - 2, Object.keys(SITE.markets.lists.languages!).length)
  // A number as a range in its unit, a count with none.
  assert.ok(form.includes('<div class="range"><label class="inp"><input type="number" name="minutes.min" step="any" placeholder="From" aria-label="Lesson length, from"></label><label class="inp"><input type="number" name="minutes.max" step="any" placeholder="To" aria-label="Lesson length, to"></label><span class="s">minutes</span></div>'))
  assert.ok(form.includes('<div class="range"><label class="inp"><input type="number" name="groupSize.min" step="any" placeholder="From" aria-label="Group size, from"></label><label class="inp"><input type="number" name="groupSize.max" step="any" placeholder="To" aria-label="Group size, to"></label></div>'))
  // The price: up to an amount, per the market's own pers, the first picked, or in all; in the
  // currency the side's listings use most, USD here.
  assert.ok(form.includes('<div class="price"><span class="s">Up to</span><label class="inp"><input type="number" name="price.max" step="any" min="0" placeholder="Amount" aria-label="Up to"></label><label class="inp unit"><select name="price.per" aria-label="Per"><option value="hour" selected>an hour</option><option value="month">a month</option><option value="">in all</option></select></label><label class="inp unit"><select name="price.currency" aria-label="Currency"><option value="USD" selected>USD</option><option value="MXN">MXN</option></select></label></div>'))
  assert.deepEqual([...form.matchAll(/<input type="radio" name="minRating" value="([^"]*)"( checked)?>([^<]+)</g)].map((m) => `${m[3]}${m[2] ? '*' : ''}`), ['Any*', '8 or more', '9 or more'])
  // A student is asked no group size, and its button says requests; its price in GBP.
  const students = /<form class="filters"[\s\S]*?<\/form>/.exec(mainOf((await page(i, '/markets/lessons?role=student')).text))![0]
  assert.ok(!students.includes('groupSize') && students.includes('Show requests</button>') && students.includes('<option value="GBP" selected>GBP</option>'))
  assert.ok(students.includes('<input type="hidden" name="role" value="student">') && students.includes(`<a class="link" href="${BASE}/markets/lessons?role=student">Clear all</a>`))
  // Wardrobe's price has no per: the amount and the currency alone.
  const coats = /<form class="filters"[\s\S]*?<\/form>/.exec(mainOf((await page(i, '/markets/wardrobe')).text))![0]
  assert.ok(coats.includes('aria-label="Up to"></label><label class="inp unit"><select name="price.currency" aria-label="Currency"><option value="EUR" selected>EUR</option></select></label></div>'))

  // Filters on: each fold says its value, soft green; the chip counts them; the form holds them;
  // the results are those that match all; Cheapest is offered once the price is on.
  const on = '/markets/lessons?languages=es&minutes.min=50&price.max=40&price.currency=USD&price.per=hour&minRating=8'
  const onHtml = mainOf((await page(i, on)).text)
  assert.deepEqual([...onHtml.matchAll(/<summary class="chip on"><span>([^<]+)<span class="on">: ([^<]+)<\/span><\/span>/g)].map((m) => `${m[1]}: ${m[2]}`), ['Languages: Spanish', 'Lesson length: 50 minutes or more', 'Price: Up to $40 an hour', 'Rating: 8 or more'])
  assert.match(onHtml, new RegExp(`<a class="chip on" href="#filters">${ICON('sliders-horizontal').source}Filters <span class="n">4</span></a>`))
  assert.ok(onHtml.includes('<option value="es" selected>Spanish</option>') && onHtml.includes('<input type="number" name="minutes.min" value="50"') && onHtml.includes('<input type="number" name="price.max" value="40"') && onHtml.includes('<input type="radio" name="minRating" value="8" checked>'))
  assert.ok(onHtml.includes('<p><b>1</b> offer</p>'))
  assert.deepEqual(who((await twin<MarketPage>(i, `${on.replace('/markets/lessons', '/markets/lessons.json')}`)).body), ['a'])
  assert.ok(onHtml.includes(`>Cheapest</a>`))
  // A currency and a per with no amount, as the form sends them: no filter, none counted.
  const sent = mainOf((await page(i, '/markets/lessons?where=&km=10&subjects=&price.max=&price.per=hour&price.currency=USD&minRating=')).text)
  assert.ok(sent.includes('<p><b>3</b> offers</p>') && !sent.includes('>Cheapest</a>'))
  assert.match(sent, new RegExp(`<a class="chip" href="#filters">${ICON('sliders-horizontal').source}Filters</a>`))
  // Where on a market's page: typed words, a place within reach; the chip soft green.
  const near = mainOf((await page(i, '/markets/lessons?where=chamberi')).text)
  assert.match(near, new RegExp(`<a class="chip on" href="#filters">${ICON('map-pin').source}Chamberí, Madrid · 10 km</a>`))
  assert.ok(near.includes('<p><b>1</b> offer</p>') && near.includes('<summary class="chip on"><span>Where<span class="on">: Chamberí, Madrid · 10 km</span></span>'))
})

test('the About page and its twin: what this index is, its links, what it reads, its address, and the credit for the names of places', async () => {
  const { status, body: o } = await twin<{ index: string; lists: unknown; credit: string }>(i, '/about.json')
  assert.equal(status, 200)
  assert.deepEqual(keysOf(o), ['credit', 'index', 'lists'])
  assert.equal(o.index, i.address)
  assert.deepEqual(o.lists, (await twin<{ lists: unknown }>(i, '/index.json')).body.lists)
  // Places' own credit, as its answers carry it: GeoNames and Correos de México, each CC BY 4.0.
  assert.equal(o.credit, ((await (await fetch(`${places.url}/`)).json()) as { credit: string }).credit)
  assert.match(o.credit, /GeoNames[\s\S]*CC BY 4\.0[\s\S]*Correos de México[\s\S]*CC BY 4\.0/)
  const html = mainOf((await page(i, '/about')).text)
  inOrder(html, [
    '<h1>About this index</h1>',
    'It reads every listing, review, vouch and report on the hosts it lists, and ranks them with open rules. It runs no ads, and nobody can pay to be higher.',
    "A profile counts once it's verified as one real person.",
    'Anyone can run another index with its own lists and rules, starting from this code.',
    `<a class="li" href="${BASE}/index.json">`,
    'Everything as JSON',
    `<a class="li" href="${BASE}/skill.md">`,
    '<a class="li" href="https://github.com/foundationforest/services/tree/main/index">',
    '<h2>What it reads</h2>',
    `<code>${host.url}</code>`,
    `The face check of ${by.name}, confidence 0.75: <code>${by.key}</code>`,
    `Test index: <code>${i.address}</code>`,
    'or one it signed in the last 30 days.',
    `<span class="s">Its address</span><code>${i.address}</code>`,
    `<span class="s">Names of places</span><span>${esc(o.credit)}</span>`,
  ])
  assert.equal(inWords('home-cleaning'), 'Home cleaning')
})
