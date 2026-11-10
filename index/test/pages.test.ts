// The pages: the four JSON answers the MCP server reads, every field they gave kept and the fields
// added beside them, each entry's time on a profile's page, each page drawn from its JSON twin and
// the site's fixed parts alone, the JSON-LD every page carries, the top bar and the foot, the fonts
// served here and nothing asked of another site, the forms with no script, a listing's own page and
// its twin, its fields without its file fields, its photos linked at its profile entry's first host,
// the apps a page links to for messaging a profile, the badges and the avatars and their colors, the
// profile page's order and its folds, the numbers only in a fold, the market page's sides, the About
// page, search's filters, sort, chips and form, and every URL the files for AI agents name.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { checkBytes, unpackSignature } from '@foundationforest/keys'
import { loadMarkets, type Market } from '@foundationforest/markets'
import { b64u, base58 } from '@foundationforest/folders'

import { colorIn, colorsFor } from '../src/avatar.ts'
import { ROOT } from '../src/index.ts'
import { loadLists } from '../src/lists.ts'
import { fieldsOf, inWords, photosOf, placeHtml, valueText } from '../src/pages/common.ts'
import { home } from '../src/pages/home.ts'
import { market } from '../src/pages/market.ts'
import { listing as listingPage, type ListingPage } from '../src/pages/listing.ts'
import { profile as profilePage, type ProfilePage } from '../src/pages/profile.ts'
import { search } from '../src/pages/search.ts'
import { about } from '../src/pages/about.ts'
import { draw, esc, type Page, short, siteOf } from '../src/pages/template.ts'
import { validateJsonLd } from './schemaorg/validate.ts'
import { at, index, listsDir, verifier, MARKETS, page, post, profile, publishProfile, startHost, TEST_APPS, twin } from './world.ts'

const BASE = 'https://index.test.example'
/** The site's fixed parts, as the index draws its pages with them: the markets, and the apps the test lists name. */
const SITE = siteOf(loadMarkets(MARKETS), TEST_APPS)
/** Each market's color, by the rule the app shares, over the directory in its order. */
const DIRECTORY = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; description: string; roles: Array<{ role: string; listings: string }> }> }
const COLORS = colorsFor(DIRECTORY.markets.map((m) => m.name))
const colorOf = (market: string) => colorIn(COLORS, market)
/** An entry's time as its date on a page, in UTC. */
const dateOf = (ms: number) => `<time datetime="${new Date(ms).toISOString().slice(0, 10)}">${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(ms)}</time>`
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
  for (const [name, label] of Object.entries({ a: 'tutoring/tutor', b: 'tutoring/tutor', c: 'tutoring/tutor', s1: 'tutoring/student', s2: 'tutoring/student', seller: 'clothing/seller', repairer: 'home-repair/repairer' })) {
    people[name] = await profile(label, [by])
  }
  people.uncounted = await profile('tutoring/tutor')
  for (const [name, p] of Object.entries(people)) await publishProfile(host.url, p, name === 'seller' ? { hosts: [PHOTOS, host.url] } : {})
  const { a, b, c, s1, s2, seller, repairer, uncounted } = people as { [k: string]: (typeof people)[string] }
  const written = [
    at(a!, 'listing/a', { description: 'Maths and physics, in Madrid.', subjects: ['maths', 'physics'], price: { amount: '30', currency: 'USD', per: 'hour' }, mode: ['in-person'], place: { lat: '40.42', lon: '-3.70', radiusKm: 5, area: 'Madrid' }, contact: 'https://wa.me/34600000000' }),
    // Online only: no place, as tutoring asks for one only in person.
    at(b!, 'listing/b', { description: 'Maths, online.', subjects: ['maths'], mode: ['online'], contact: 'http://example.com/maths/' }),
    at(c!, 'listing/c', { description: 'Chemistry, in Lisbon.', subjects: ['chemistry'], mode: ['in-person'], place: { lat: '38.72', lon: '-9.14', radiusKm: 5, area: 'Lisbon' } }),
    at(s1!, 'listing/need', { description: 'Help with maths homework.', subjects: ['maths'], contact: 'mailto:s1@example.com' }),
    // Its size a value its market labels, xl as XL; its place 8.9 km north of a's.
    at(seller!, 'listing/coat', {
      description: 'A wool coat, worn twice.',
      wearer: ['women'],
      kind: 'coat',
      size: 'xl',
      condition: 'like-new',
      price: { amount: '40', currency: 'EUR' },
      location: { lat: '40.50', lon: '-3.70', radiusKm: 2, area: 'Madrid' },
      photos: COAT,
      files: COAT.map((sha256, n) => ({ sha256, type: 'image/jpeg', size: 1000 + n })),
      contact: 'seller@example.com',
    }),
    // A file field named pastWork, not photos: the facts leave it out by its type. A place with no area.
    at(repairer!, 'listing/taps', { description: 'Leaks and taps fixed.', repairs: ['plumbing'], base: { lat: '37.39', lon: '-5.98', radiusKm: 10 }, licences: 'Gas', pastWork: [COAT[0]], files: [{ sha256: COAT[0], type: 'image/jpeg', size: 1000 }] }),
    at(uncounted!, 'listing/u', { description: 'Maths, uncounted.' }),
    at(s1!, 'review/a', { subject: a!.key.address, score: '9', listing: `${a!.key.address}/listing/a`, text: 'Very clear.' }),
    at(s2!, 'review/a', { subject: a!.key.address, score: '9', listing: `${a!.key.address}/listing/a` }),
    at(s2!, 'review/b', { subject: b!.key.address, score: '4', listing: `${b!.key.address}/listing/b` }),
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
const RESULT = ['checks', 'listing', 'market', 'profile', 'ratings', 'role', 'trust', 'uniqueness']
const SHOWN = ['ratings', 'trust', 'uniqueness']
/** Every field a listing gave before listings had pages, and the two added beside them: its page and its photos. */
const LISTING = ['address', 'body']
const LISTING_ADDED = ['photos', 'url']
const both = (old: string[], added: string[]) => [...old, ...added].sort()
const addressOf = (name: string) => people[name]!.key.address
/** A page's main part: what it draws from its object, without the head's JSON-LD, which repeats some of it. */
const mainOf = (html: string) => /<main>[\s\S]*<\/main>/.exec(html)![0]
/** An icon as the pages draw it, its drawing left out. */
const ICON = (name: string) => new RegExp(`<svg class="i[^"]*" data-icon="${name}"[^>]*>.*?</svg>`)

test('the four answers the mcp reads, in their shapes: every field they gave, and those added beside them', async () => {
  const home = (await twin<{ index: string; markets: Array<{ name: string; description: string; roles: string[]; listed: { [role: string]: number }; words: { [role: string]: string } }> }>(i, '/index.json')).body
  assert.deepEqual(keysOf(home), ['index', 'lists', 'markets'])
  assert.equal(home.index, i.address)
  const directory = JSON.parse(readFileSync(join(MARKETS, 'directory.json'), 'utf8')) as { markets: Array<{ name: string; description: string; roles: Array<{ role: string; listings: string }> }> }
  // Each market as the directory gives it, and, added, how many listings each role has listed and each role's word for its listings.
  assert.deepEqual(home.markets.map(({ listed: _, words: __, ...m }) => m), directory.markets.map((m) => ({ name: m.name, description: m.description, roles: m.roles.map((r) => r.role) })))
  assert.deepEqual(home.markets.map((m) => m.words), directory.markets.map((m) => Object.fromEntries(m.roles.map((r) => [r.role, r.listings]))))
  const listed = Object.fromEntries(home.markets.map((m) => [m.name, m.listed]))
  assert.deepEqual(listed.tutoring, { tutor: 3, student: 1 })
  assert.deepEqual(listed.clothing, { seller: 1, buyer: 0 })

  const m = (await twin<{ index: string; market: unknown; listings: { [role: string]: Array<{ [k: string]: unknown }> } }>(i, '/markets/tutoring.json')).body
  assert.deepEqual(keysOf(m), ['index', 'listings', 'market'])
  // The market's file verbatim, its preview among the rest.
  const file = JSON.parse(readFileSync(join(MARKETS, 'markets/tutoring.json'), 'utf8')) as { preview?: string[] }
  assert.deepEqual(m.market, file)
  assert.ok(file.preview?.length)
  assert.deepEqual((m.market as { preview: string[] }).preview, file.preview)
  assert.deepEqual(Object.keys(m.listings), ['tutor', 'student'])
  for (const r of Object.values(m.listings).flat()) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.listing as object), both(LISTING, LISTING_ADDED))
    assert.deepEqual(keysOf(r.ratings as object), ['count', 'value'])
    for (const c of r.checks as object[]) assert.deepEqual(keysOf(c), ['key', 'label', 'verifier'])
  }

  const s = (await twin<{ index: string; total: number; results: Array<{ [k: string]: unknown }>; query: unknown; markets: unknown }>(i, '/search.json?q=maths&km=&offset=0')).body
  // Added beside them: the filters as given, an empty one left out, and every market's name, for the form.
  assert.deepEqual(keysOf(s), ['index', 'markets', 'query', 'results', 'total'])
  assert.deepEqual(s.query, { q: 'maths', offset: '0' })
  assert.deepEqual(s.markets, directory.markets.map((m) => m.name))
  for (const r of s.results) {
    assert.deepEqual(keysOf(r), RESULT)
    assert.deepEqual(keysOf(r.listing as object), both(LISTING, LISTING_ADDED))
  }

  const p = (await twin<{ [k: string]: unknown }>(i, `/profiles/${people.a!.key.address}.json`)).body
  assert.deepEqual(keysOf(p), both(['address', 'checks', 'index', 'listings', 'profile', 'proofs', 'reports', 'reviews', 'signature', 'statement', 'vouches', 'words', ...SHOWN], ['message']))
  for (const x of p.listings as object[]) assert.deepEqual(keysOf(x), both([...LISTING, 'listed', 'time'], LISTING_ADDED))
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

test("every page is drawn from its twin's object and the site's fixed parts, runs no script, and its JSON-LD passes schema.org's vocabulary", async () => {
  const pages: Array<[string, Page<never>]> = [
    ['/', home as Page<never>],
    ['/about', about as Page<never>],
    ['/markets/tutoring', market as Page<never>],
    ['/markets/tennis-matches', market as Page<never>],
    ['/markets/clothing', market as Page<never>],
    [`/profiles/${people.a!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.uncounted!.key.address}`, profilePage as Page<never>],
    [`/profiles/${people.seller!.key.address}`, profilePage as Page<never>],
    ['/search?q=maths', search as Page<never>],
    ['/search', search as Page<never>],
    [`/profiles/${people.a!.key.address}/listing/a`, listingPage as Page<never>],
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
    // No script but the JSON-LD, and no handler on any element; every form a GET to search. The top
    // bar: the Forest mark and its name, a search box on every page but home, About, and the first
    // app's own address. The foot: this index's web address, how it ranks, the twin and the source.
    assert.equal(served.text.match(/<script/g)!.length, 1, path)
    assert.ok(!/\son[a-z]+=/i.test(served.text.replace(/<script[\s\S]*?<\/script>/, '')), path)
    for (const form of served.text.match(/<form[^>]*>/g) ?? []) assert.match(form, /^<form class="[^"]+" (?:id="filters" )?action="https:\/\/index\.test\.example\/search" method="get"/, path)
    const header = /<header class="ibar">[\s\S]*?<\/header>/.exec(served.text)![0]
    assert.match(header, /^<header class="ibar"><a class="ibrand" href="https:\/\/index\.test\.example\/"><svg class="mark"[^>]*>.*?<\/svg>Forest index<\/a>/, path)
    assert.equal(header.includes('<form'), bare !== '/', path)
    assert.ok(header.endsWith(`<a class="btn text fit" href="${BASE}/about">About</a><a class="btn soft sm open" href="https://app.test.example/">Open the app</a></header>`), path)
    const twinUrl = `${BASE}${bare === '/' ? '/index' : bare}.json${query ? `?${esc(query)}` : ''}`
    assert.equal(
      /<footer[\s\S]*<\/footer>/.exec(served.text)![0],
      `<footer class="ifoot"><span>Ranked by index.test.example</span><a href="${BASE}/about">How it ranks</a><a href="${twinUrl}">JSON</a><a href="https://github.com/foundationforest/services/tree/main/index">Source</a></footer>`,
      path,
    )
    // Nothing asked of another site: no stylesheet or script by link, and the style names only the fonts here.
    assert.ok(!/<link rel="stylesheet"|<script src/.test(served.text), path)
    const style = /<style>([\s\S]*?)<\/style>/.exec(served.text)![1]!
    const named = [...style.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]!)
    assert.ok(named.length > 0 && named.every((u) => u.startsWith('/fonts/')), `${path}: ${named.join(' ')}`)
    for (const u of named) fonts.add(u)
  }
  // Every file the style names is served here, as the font it is: Figtree and Bricolage Grotesque.
  assert.ok(['figtree-latin-wght-normal', 'bricolage-grotesque-latin-opsz-normal'].every((f) => [...fonts].some((u) => u.includes(f))), [...fonts].join(' '))
  for (const u of fonts) {
    const res = i.pages.handle(new Request(`${BASE}${u}`))
    assert.equal(res.status, 200, u)
    assert.equal(res.headers.get('content-type'), 'font/woff2', u)
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'wOF2', u)
  }
  assert.ok([...fonts].some((u) => u.includes('latin')))
  assert.equal((await page(i, '/fonts/nowhere.woff2')).status, 404)
  assert.equal((await page(i, '/fonts/../package.json')).status, 404)
})

test('trust and uniqueness only in a fold; a result shows its profile\'s avatar, name and badge, and its rating, or New', async () => {
  const outsideFolds = (html: string) => mainOf(html).replace(/<details[\s\S]*?<\/details>/g, '')
  for (const path of ['/', '/markets/tutoring', '/markets/clothing', '/search?q=maths', `/profiles/${addressOf('a')}`, `/profiles/${addressOf('a')}/listing/a`, `/profiles/${addressOf('uncounted')}`]) {
    const html = outsideFolds((await page(i, path)).text)
    assert.ok(!/trust|uniqueness/i.test(html), path)
  }
  const tutors = mainOf((await page(i, '/markets/tutoring')).text)
  const cardOf = (html: string, url: string) => new RegExp(`<a class="rcard" href="${url}">.*?</a>`).exec(html)![0]
  // a, rated 9.0 by two, verified with a selfie: its avatar, solid since tutors offer, its name, the
  // selfie badge with its words, and its rating with how many raters; c, rated by no one: New.
  const a = cardOf(tutors, `${BASE}/profiles/${addressOf('a')}/listing/a`)
  assert.ok(
    a.includes(`<span class="who"><span class="av xs" style="--h:${colorOf('tutoring')}" aria-hidden="true"><svg class="i" data-icon="graduation-cap"`) &&
      a.includes('<span class="nm">Tutoring <span class="role">tutor</span><span class="vb" role="img" aria-label="Verified with a selfie" title="Verified with a selfie"><svg class="i" data-icon="smiley"'),
    a,
  )
  assert.match(a, /<span class="rate"><svg class="i" data-icon="star"[^>]*>.*?<\/svg>9\.0<\/span><span class="xs">\(2\)<\/span><\/span><\/a>$/)
  assert.ok(cardOf(tutors, `${BASE}/profiles/${addressOf('c')}/listing/c`).endsWith('<span class="chip sm">New</span></span></a>'))
  // A student's request: its avatar light, since students request.
  assert.ok(cardOf(tutors, `${BASE}/profiles/${addressOf('s1')}/listing/need`).includes(`<span class="av xs look" style="--h:${colorOf('tutoring')}" aria-hidden="true">`))
})

test("search: words, market, role, a place, a rating, raters, pages; sorted by ratings with the market's average added", async () => {
  const s = async (q: string) => (await twin<{ total: number; results: Array<{ profile: string; listing: { address: string } }> }>(i, `/search.json?${q}`)).body
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
  // Near a point, nearest first: a at 2.2 km, the coat at 11.1; b, online, has no place.
  assert.deepEqual(who(await s('near=40.4,-3.7&km=50')), ['a', 'seller'])
  assert.deepEqual(who(await s('near=38.7,-9.1')), ['c'])
  assert.deepEqual(who(await s('minRating=7.5')), ['a'])
  assert.deepEqual(who(await s('minReviews=1&role=tutor')), ['a', 'b'])
  assert.deepEqual(who(await s('q=coat')), ['seller'])
  assert.deepEqual(who(await s('market=clothing&role=seller')), ['seller'])
  // 20000 km reaches every listing with a place, in every market, nearest first: Seville, then Lisbon.
  assert.deepEqual(who(await s('near=40.4,-3.7&km=20000')), ['a', 'seller', 'repairer', 'c'])
  // A town by its name, as skill.md says: q finds a place by its area.
  assert.deepEqual(who(await s('q=madrid')).sort(), ['a', 'seller'])
  const paged = await s('role=tutor&limit=1&offset=1')
  assert.equal(paged.total, 3)
  assert.deepEqual(who(paged), ['c'])
  // The uncounted profile's listing is never a result.
  assert.ok(!who(await s('q=uncounted')).length)
})

test("search near a point: a listing's radius reaches past km, the nearest first, each with its distance", async () => {
  const s = async (q: string) => (await twin<{ results: Array<{ profile: string; km?: number }> }>(i, `/search.json?${q}`)).body
  const who = (r: { results: Array<{ profile: string }> }) => r.results.map((x) => Object.keys(people).find((k) => people[k]!.key.address === x.profile))
  // From 12.2 km north of a's point, past km 10 alone; a's place reaches 5 km round it, so the two
  // circles touch. The coat, 3.3 km away, comes first, though a is rated and the coat is not.
  const north = await s('near=40.53,-3.70&km=10')
  assert.deepEqual(who(north), ['seller', 'a'])
  assert.deepEqual(north.results.map((r) => r.km), [3.3, 12.2], 'between the two centres, to one decimal')
  assert.deepEqual(keysOf(north.results[0]!), [...RESULT, 'km'].sort())
  // At km 5 they no longer touch: 12.2 is more than 5 and 5.
  assert.deepEqual(who(await s('near=40.53,-3.70&km=5')), ['seller'])
  // With no point asked, no result carries a distance, and the order is search's.
  assert.ok((await s('q=madrid')).results.every((r) => !('km' in r)))
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
  // Every listing this index lists, and no other.
  for (const listed of [`${addressOf('a')}/listing/a`, `${addressOf('seller')}/listing/coat`, `${addressOf('s1')}/listing/need`]) assert.ok(sitemap.includes(`<loc>${BASE}/profiles/${listed}</loc>`), listed)
  assert.ok(!sitemap.includes(people.uncounted!.key.address))
  assert.match((await page(i, '/robots.txt')).text, /Sitemap: https:\/\/index\.test\.example\/sitemap\.xml/)
  assert.equal((await page(i, '/markets/knitting')).status, 404)
  assert.equal((await page(i, `/profiles/${base58.encode(randomBytes(32))}.json`)).status, 404)
  assert.equal((await page(i, '/nowhere')).status, 404)
  for (const path of ['/about/more', '/about/more.json', '/search/more']) assert.equal((await page(i, path)).status, 404, path)
  for (const path of [`/profiles/${addressOf('a')}/listing/nowhere`, `/profiles/${addressOf('a')}/listing/nowhere.json`, `/profiles/${addressOf('a')}/listings/a`, `/profiles/${addressOf('a')}/listing`, `/profiles/${addressOf('a')}/listing/a/more`]) {
    assert.equal((await page(i, path)).status, 404, path)
  }
  assert.equal(i.pages.handle(new Request(`${BASE}/`, { method: 'POST' })).status, 405)
  const head = i.pages.handle(new Request(`${BASE}/index.json`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('access-control-allow-origin'), '*')
})

test("a listing's page and its twin: its fields in its market's order with their types, who posted it, and how to reach them", async () => {
  const a = addressOf('a')
  const { status, body: o } = await twin<ListingPage>(i, `/profiles/${a}/listing/a.json`)
  assert.equal(status, 200)
  assert.deepEqual(keysOf(o), both(['checks', 'fields', 'index', 'listing', 'market', 'message', 'profile', 'role', ...SHOWN], ['labels', 'types']))
  assert.deepEqual(keysOf(o.listing), both([...LISTING, 'listed', 'time'], LISTING_ADDED))
  assert.deepEqual([o.index, o.profile, o.market, o.role, o.listing.address, o.listing.url, o.listing.listed], [i.address, a, 'tutoring', 'tutor', `${a}/listing/a`, `${BASE}/profiles/${a}/listing/a`, true])
  // The same profile, as its own page shows it.
  const p = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  assert.deepEqual([o.checks, o.ratings, o.trust, o.uniqueness, o.message], [p.checks, p.ratings, p.trust, p.uniqueness, p.message])
  assert.deepEqual(o.listing.body, p.listings.find((x) => x.address === `${a}/listing/a`)!.body)
  // The market's preview first, then the rest of its listing fields in its order.
  const tutoring = JSON.parse(readFileSync(join(MARKETS, 'markets/tutoring.json'), 'utf8')) as { listing: { [name: string]: { type: string } }; preview: string[] }
  assert.deepEqual(o.fields, [...tutoring.preview, ...Object.keys(tutoring.listing).filter((f) => !tutoring.preview.includes(f))])
  // Each field's type, as its market names it; tutoring labels none of its values.
  assert.deepEqual(o.types, Object.fromEntries(Object.entries(tutoring.listing).map(([name, f]) => [name, f.type])))
  assert.deepEqual(o.labels, {})
  // A market with no preview: the markets manual's, description, price, then its place fields.
  const { preview: _, ...cleaning } = (await twin<{ market: Market }>(i, '/markets/home-cleaning.json')).body.market
  assert.deepEqual(fieldsOf(cleaning).slice(0, 4), ['description', 'price', 'base', 'home'])
  assert.deepEqual(new Set(fieldsOf(cleaning)), new Set(Object.keys(cleaning.listing)))

  const html = (await page(i, `/profiles/${a}/listing/a`)).text
  assert.match(html, /<title>\$30 per hour · Maths and physics, in Madrid\.<\/title>/)
  assert.match(html, /<meta name="description" content="Maths and physics, in Madrid\.">/)
  const at = (text: string) => {
    const n = html.indexOf(text)
    assert.ok(n >= 0, text)
    return n
  }
  // A way back to its market; the description's first line, the price under it; its fields, which
  // the description and the price are not among, the contact last; who posted it, in a card linking
  // to their profile; the button to message them, in the role's word.
  const order = [
    `<a class="round clear back" href="${BASE}/markets/tutoring" aria-label="Back">`,
    '<h1>Maths and physics, in Madrid.</h1><p class="cost"><span class="d big">$30</span> <span class="s">per hour</span></p>',
    '<dl class="card divide"><div class="kv"><dt>Subjects</dt><dd>Maths, Physics</dd></div>',
    '<div class="kv"><dt>Mode</dt><dd>In person</dd></div><div class="kv"><dt>Place</dt><dd><a href="https://www.openstreetmap.org/?mlat=40.42&amp;mlon=-3.70#map=15/40.42/-3.70">Madrid, within 5 km<svg',
    '<div class="kv"><dt>Contact</dt><dd><a href="https://wa.me/34600000000" rel="nofollow ugc">wa.me/34600000000<svg',
    `<a class="card poster" href="${BASE}/profiles/${a}"><span class="av" style="--h:${colorOf('tutoring')}" aria-hidden="true">`,
    '<span class="nm">Tutoring <span class="role">tutor</span><span class="vb" role="img" aria-label="Verified with a selfie"',
    '<span class="rated"><span class="rate">',
    `<div class="foot"><a class="btn primary" href="https://app.test.example/message?to=${a}"><svg class="i" data-icon="paper-plane-tilt"`,
    'Message the tutor</a></div>',
  ]
  for (let n = 1; n < order.length; n++) assert.ok(at(order[n - 1]!) < at(order[n]!), order[n])
  for (const text of ['<dt>Description</dt>', '<dt>Price</dt>', '<details']) assert.ok(!mainOf(html).includes(text), text)
  // One forest-green button on the page, the first app's.
  assert.equal(mainOf(html).match(/class="[^"]*primary/g)!.length, 1)

  // A link's words have no scheme and no trailing slash; an email address is a link to write to
  // it, its words the address alone, with or without its mailto:. A listing that is not listed has
  // its page, saying why.
  assert.ok((await page(i, `/profiles/${addressOf('b')}/listing/b`)).text.includes('<dt>Contact</dt><dd><a href="http://example.com/maths/" rel="nofollow ugc">example.com/maths<svg'))
  assert.ok((await page(i, `/profiles/${addressOf('seller')}/listing/coat`)).text.includes('<dt>Contact</dt><dd><a href="mailto:seller@example.com" rel="nofollow ugc">seller@example.com</a></dd>'))
  assert.ok((await page(i, `/profiles/${addressOf('s1')}/listing/need`)).text.includes('<dt>Contact</dt><dd><a href="mailto:s1@example.com" rel="nofollow ugc">s1@example.com</a></dd>'))
  // A student asks: its avatar is light, and its button says the student.
  assert.ok((await page(i, `/profiles/${addressOf('s1')}/listing/need`)).text.includes('<span class="av look"'))
  assert.ok((await page(i, `/profiles/${addressOf('s1')}/listing/need`)).text.includes('Message the student</a>'))
  const u = await twin<ListingPage>(i, `/profiles/${addressOf('uncounted')}/listing/u.json`)
  assert.deepEqual([u.status, u.body.listing.listed, u.body.listing.why], [200, false, 'its profile does not count here'])
  assert.match((await page(i, `/profiles/${addressOf('uncounted')}/listing/u`)).text, /<p class="red">Not listed: its profile does not count here\.<\/p>[\s\S]*<span class="nm">Tutoring <span class="role">tutor<\/span><\/span><span class="rated"><span class="xs">Not verified here<\/span>/)

  // The fields leave out every one its market types file, whatever it is called: the repairer's
  // past work is a photo, and its licences a field.
  const taps = (await twin<ListingPage>(i, `/profiles/${addressOf('repairer')}/listing/taps.json`)).body
  assert.deepEqual([taps.listing.listed, taps.types.pastWork, taps.listing.photos], [true, 'file', [`${host.url}/v1/files/${COAT[0]}`]])
  const tapsHtml = (await page(i, `/profiles/${addressOf('repairer')}/listing/taps`)).text
  assert.ok(!tapsHtml.includes('<dt>Past work</dt>') && !tapsHtml.includes('<dt>Files</dt>'))
  assert.ok(tapsHtml.includes('<div class="kv"><dt>Licences</dt><dd>Gas</dd></div>'))
  // A place: a link to its point on the map, its area if it has one, then how far round it reaches.
  // On a card, which is a link already, the quiet line is the market's next field, as in the app.
  assert.ok(tapsHtml.includes('<div class="kv"><dt>Base</dt><dd><a href="https://www.openstreetmap.org/?mlat=37.39&amp;mlon=-5.98#map=15/37.39/-5.98">Within 10 km<svg'))
  assert.ok(mainOf((await page(i, '/markets/home-repair')).text).includes('<span class="title">Leaks and taps fixed.</span><span class="s">Plumbing</span>'))
  // Radius 0 is that exact spot: its area alone, or that it is an exact spot.
  const spot = { lat: '40.42', lon: '-3.70', radiusKm: 0 }
  assert.equal(valueText({ ...spot, area: 'Court 3' }), 'Court 3')
  assert.match(String(placeHtml(spot)), /^<a href="https:\/\/www\.openstreetmap\.org\/\?mlat=40\.42&amp;mlon=-3\.70#map=15\/40\.42\/-3\.70">An exact spot<svg[^>]*>.*<\/svg><\/a>$/)

  // Every place that shows the listing links to its page.
  for (const where of ['/markets/tutoring', '/search?q=maths']) assert.ok((await page(i, where)).text.includes(`<a class="rcard" href="${BASE}/profiles/${a}/listing/a">`), where)
  assert.ok((await page(i, `/profiles/${a}`)).text.includes(`<a class="card lcard" href="${BASE}/profiles/${a}/listing/a">`))
  // Its JSON-LD: the Offer at the listing's own page.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual([ld['@graph'][0]['@type'], ld['@graph'][0].mainEntity['@type'], ld['@graph'][0].mainEntity.url], ['ItemPage', 'Offer', `${BASE}/profiles/${a}/listing/a`])
})

test("photos: each file a listing's fields name, linked at its profile entry's first host, never kept here", async () => {
  const seller = addressOf('seller')
  const links = COAT.map((sha) => `${PHOTOS}/v1/files/${sha}`)
  const o = (await twin<ListingPage>(i, `/profiles/${seller}/listing/coat.json`)).body
  // The profile entry names the photos' host first, then the host this index reads it from.
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.profile.hosts, [PHOTOS, host.url])
  assert.deepEqual(o.listing.photos, links)
  for (const path of ['/search.json?q=coat', '/markets/clothing.json']) {
    const r = (await twin<{ results?: Array<{ listing: { photos: string[] } }>; listings?: { seller: Array<{ listing: { photos: string[] } }> } }>(i, path)).body
    assert.deepEqual((r.results ?? r.listings!.seller)[0]!.listing.photos, links, path)
  }
  assert.deepEqual((await twin<ProfilePage>(i, `/profiles/${seller}.json`)).body.listings[0]!.photos, links)

  // Drawn as images, lazily, with the description as their text; neither the file field nor the
  // standard's files list is drawn as a field.
  const html = (await page(i, `/profiles/${seller}/listing/coat`)).text
  for (const link of links) assert.ok(html.includes(`<img src="${link}" alt="A wool coat, worn twice." loading="lazy">`), link)
  for (const text of ['<dt>Photos</dt>', '<dt>Files</dt>', 'a file (', `<dd>${COAT[0]}`]) assert.ok(!html.includes(text), text)
  // A choice's value in words, as the markets manual writes them, or by its label where its field
  // has one; its JSON carries the labels of the values it holds, no other. Its place, by its area.
  assert.ok(html.includes('<div class="kv"><dt>Kind</dt><dd>Coat</dd></div>'))
  assert.ok(html.includes('<div class="kv"><dt>Condition</dt><dd>Like new</dd></div>'))
  assert.ok(html.includes('<div class="kv"><dt>Size</dt><dd>XL</dd></div>'))
  assert.deepEqual(o.labels, { size: { xl: 'XL' } })
  assert.ok(html.includes('<div class="kv"><dt>Location</dt><dd><a href="https://www.openstreetmap.org/?mlat=40.50&amp;mlon=-3.70#map=15/40.50/-3.70">Madrid, within 2 km<svg'))
  // In one row that scrolls sideways, on the market's color while they load; on a laptop, the
  // first big and the rest small under it, by the stylesheet alone. Its price in euros.
  assert.ok(html.includes(`<div class="gal" style="--h:${colorOf('clothing')}"><a href="${links[0]}"><img src="${links[0]}"`))
  assert.ok(html.includes(`</a><a href="${links[1]}"><img src="${links[1]}"`))
  assert.ok(html.includes('<p class="cost"><span class="d big">€40</span></p>'))
  // A card shows the first, its text empty since the card's says it.
  for (const where of ['/markets/clothing', '/search?q=coat', `/profiles/${seller}`]) {
    const card = mainOf((await page(i, where)).text)
    assert.ok(card.includes(`<img class="thumb" src="${links[0]}" alt="" loading="lazy">`), where)
    assert.ok(!card.includes(links[1]!), where)
  }
  // The JSON-LD's Offer carries the same links.
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!)
  assert.deepEqual(ld['@graph'][0].mainEntity.image, links)
  // A value names a file only when the body lists it; a listing with no files has no photos.
  assert.deepEqual(photosOf({ photos: [COAT[0]], files: [] }, PHOTOS), [])
  assert.deepEqual(photosOf({ description: COAT[0]! }, PHOTOS), [])
  assert.deepEqual((await twin<ListingPage>(i, `/profiles/${addressOf('a')}/listing/a.json`)).body.listing.photos, [])
})

test('the apps a page links to for messaging a profile: lists/apps.json, none without it, and one that does not read stops the start', async () => {
  const keysList = { hosts: [host.url], keys }
  assert.deepEqual(loadLists(listsDir(keysList)).apps, TEST_APPS)
  assert.deepEqual(loadLists(ROOT).apps, [{ name: 'Forest app', message: 'https://app.forest.foundation/message?to={address}' }])
  assert.deepEqual(loadLists(listsDir({ ...keysList, apps: null })).apps, [])

  // Without the file, a profile's page and a listing's page link to no app.
  const none = await index({ ...keysList, apps: null })
  try {
    await none.pass()
    const a = addressOf('a')
    assert.deepEqual((await twin<ProfilePage>(none, `/profiles/${a}.json`)).body.message, [])
    assert.deepEqual((await twin<ListingPage>(none, `/profiles/${a}/listing/a.json`)).body.message, [])
    // Neither a button to message the profile nor the top bar's app.
    for (const path of ['/', `/profiles/${a}`, `/profiles/${a}/listing/a`]) {
      const text = (await page(none, path)).text
      assert.ok(!text.includes('app.test.example') && !text.includes('Open the app') && !text.includes('btn primary" href'), path)
    }
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

test('the profile page, for a buyer: its header with its avatar, name, badge and rating, the message button; the numbers fold; its offers and the reviews and vouches it got; then everything', async () => {
  const a = addressOf('a')
  const html = mainOf((await page(i, `/profiles/${a}`)).text)
  const o = (await twin<ProfilePage>(i, `/profiles/${a}.json`)).body
  const meaning = html.indexOf('<details class="fold wide mean"><summary>')
  const lists = html.indexOf('<div class="lists">')
  const fold = html.indexOf('<details class="fold all"><summary>')
  const end = html.indexOf('</details>', fold)
  assert.ok(meaning > 0 && lists > meaning && fold > lists && end > fold)
  const at = (text: string) => {
    const n = html.indexOf(text)
    assert.ok(n >= 0, text)
    return n
  }
  const order = [
    `<div class="head tint profile-head" style="--h:${colorOf('tutoring')}"><a class="round back" href="${BASE}/markets/tutoring" aria-label="Back">`,
    `<span class="av lg" style="--h:${colorOf('tutoring')}" aria-hidden="true">`,
    '<h1 class="h2 titled">Tutoring tutor<span class="vb lg" role="img" aria-label="Verified with a selfie" title="Verified with a selfie">',
    '<span class="rated"><span class="rate">',
    '9.0</span><span class="s">2 reviews</span></span>',
    `<a class="btn primary" href="https://app.test.example/message?to=${a}">`,
    'Message</a></div>',
    '<h2>Offers</h2>',
    `<a class="card lcard" href="${BASE}/profiles/${a}/listing/a"><span class="what"><span class="title">Maths and physics, in Madrid.</span><span class="s">Maths, Physics</span></span><span class="price"><span class="d">$30</span><span class="xs">per hour</span></span></a>`,
    '<h2>Reviews</h2>',
  ]
  for (let n = 1; n < order.length; n++) assert.ok(at(order[n - 1]!) < at(order[n]!), order[n])
  assert.ok(at(order[6]!) < meaning && at(order[7]!) > meaning)
  // The numbers fold: its rating with how many people's reviews, its trust and its uniqueness.
  const numbers = html.slice(meaning, lists)
  for (const text of ['<span class="d">9.0</span><p class="s">The average of 2 people&#39;s reviews', `<span class="d">${o.trust}</span><p class="s">Trust, 0 to 100`, '<span class="d">75</span><p class="s">Uniqueness, 0 to 100']) assert.ok(numbers.includes(text), text)
  // The reviews and vouches it received, newest first, each linking to its writer, with its date.
  const cards = html.slice(lists, fold).match(/<a class="card said"[\s\S]*?<\/a>/g)!
  const s1 = addressOf('s1')
  const review = cards.find((c) => c.includes(s1))!
  assert.match(review, new RegExp(`^<a class="card said" href="${BASE}/profiles/${s1}"><span class="line"><span class="rate"><svg class="i" data-icon="star"[^>]*>.*?</svg>9</span><span class="grow"></span><span class="xs">${dateOf(times.get(`${s1}/review/a`)!)}</span></span><span class="text">Very clear\\.</span><span class="xs">From ${short(s1)}</span></a>$`))
  assert.equal(cards.length, 4)
  assert.ok(cards[0]!.includes('<span class="chip mint"><svg class="i" data-icon="handshake"') && cards[0]!.includes('Vouch</span>'))
  // One that does not count says why, in its card.
  assert.ok(cards[1]!.includes(`href="${BASE}/profiles/${addressOf('uncounted')}"`) && cards[1]!.includes('<span class="s red">Does not count: '))
  // Everything else is in the last fold, and only there: each review's weight among it.
  const inFold = [`<code>${a}</code>`, '<h3>Reviews received</h3>', '<h3>Reviews given</h3>', '<h3>Vouches and reports received</h3>', '<h3>Vouches and reports given</h3>', '<h3>Words</h3>', '<h3>Proofs</h3>', '<h3>Signed statement</h3>', `<code>${esc(o.statement!)}</code>`, `<code>${o.signature}</code>`, 'Counts, weight ']
  for (const text of inFold) assert.ok(at(text) > fold && at(text) < end, text)
  // A profile no verification counts for: no badge, no rating, and 0 and 0 in its fold.
  const u = mainOf((await page(i, `/profiles/${addressOf('uncounted')}`)).text)
  assert.ok(u.includes('<h1 class="h2 titled">Tutoring tutor</h1><span class="rated"><span class="s">Not verified here</span></span>'))
  assert.ok(u.includes('<span class="d">–</span><p class="s">No rating: no one this index counts has rated it.</p>'))
  assert.equal(u.match(/<span class="d">0<\/span>/g)!.length, 2)
  // An ID check gives the solid badge with an ID card: here the same key, listed as an ID key.
  const both = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'ID check', confidence: 0.95 }] })
  try {
    await both.pass()
    const text = (await page(both, `/profiles/${a}`)).text
    assert.ok(text.includes('<span class="vb id lg" role="img" aria-label="Verified with ID" title="Verified with ID"><svg class="i" data-icon="identification-card"'))
    assert.ok(!text.includes('Verified with a selfie'))
  } finally {
    await both.close()
  }
})

test('the home page: the question, one search box, and a tile per market in its color, with its listings counted in its roles\' words', async () => {
  const html = mainOf((await page(i, '/')).text)
  assert.ok(html.startsWith('<main>\n<h1 class="hello">What are you looking for?</h1>'))
  assert.match(html, /<form class="ask" action="https:\/\/index\.test\.example\/search" method="get" role="search"><label class="inp find"><svg class="i" data-icon="magnifying-glass"[^>]*>.*?<\/svg><input type="search" name="q" placeholder="A maths tutor, a wool coat, a plumber" aria-label="A maths tutor, a wool coat, a plumber"><\/label><button class="btn primary fit" type="submit">Search<\/button><\/form>/)
  assert.equal(html.match(/<form/g)!.length, 1)
  assert.equal(html.match(/class="[^"]*primary/g)!.length, 1)
  const tileOf = (name: string) => new RegExp(`<a class="tile tint" style="--h:[^"]*" href="${BASE}/markets/${name}">.*?</a>`).exec(html)![0]
  // Every market in the directory, in its order, each on its own color, its icon in it.
  assert.deepEqual([...html.matchAll(/<a class="tile tint" style="--h:([^"]*)" href="[^"]*\/markets\/([^"]*)">/g)].map((m) => [m[2], m[1]]), DIRECTORY.markets.map((m) => [m.name, colorOf(m.name)]))
  assert.match(tileOf('tutoring'), /<span class="hue" aria-hidden="true"><svg class="i" data-icon="graduation-cap"[^>]*>.*?<\/svg><\/span><span>Tutoring<span class="xs">3 offers<br>1 request<\/span><\/span><\/a>$/)
  // A role with none is left out; a market with none at all says so.
  assert.ok(tileOf('clothing').endsWith('<span>Clothing<span class="xs">1 offer</span></span></a>'))
  assert.ok(tileOf('tennis-matches').endsWith('<span>Tennis matches<span class="xs">None yet</span></span></a>'))
  // What this index reads is on the About page.
  assert.ok(!html.includes('What it reads') && !html.includes(i.address))
})

test('the search page: its search box filled, the filters as chips and as one GET form, how many and in what order, then its cards', async () => {
  const html = mainOf((await page(i, '/search?q=maths&market=tutoring')).text)
  // A way back and the search box, holding the words and carrying the market along; the top bar's the same.
  assert.ok(html.startsWith(`<main>\n<div class="bar"><a class="round clear back" href="${BASE}/" aria-label="Back">`))
  const box = '<input type="search" name="q" value="maths" placeholder="Search listings" aria-label="Search listings"></label><input type="hidden" name="market" value="tutoring"></form>'
  assert.ok(html.includes(box))
  assert.ok((await page(i, '/search?q=maths&market=tutoring')).text.includes(`<header class="ibar">`) && /<header[\s\S]*<\/header>/.exec((await page(i, '/search?q=maths&market=tutoring')).text)![0].includes(box))
  // The chips: the market, with its avatar and a link that removes it; a rating to add; More, which opens the form.
  const chips = /<nav class="fchips"[\s\S]*?<\/nav>/.exec(html)![0]
  assert.ok(chips.includes(`<a class="fchip on" href="${BASE}/search?q=maths" aria-label="Remove Tutoring"><span class="av xs" style="--h:${colorOf('tutoring')}" aria-hidden="true">`))
  assert.ok(chips.includes(`<a class="fchip" href="${BASE}/search?q=maths&amp;market=tutoring&amp;minRating=8">`))
  assert.ok(chips.includes('<a class="fchip" href="#filters">') && !chips.includes('Near'))
  // The form: the words and the market carried along; each market a link that keeps the rest and
  // drops the side; the side, once a market is chosen, none picked here; the rating; Apply.
  const form = /<form class="filters"[\s\S]*?<\/form>/.exec(html)![0]
  assert.ok(form.startsWith(`<form class="filters" id="filters" action="${BASE}/search" method="get" aria-label="Filters"><input type="hidden" name="q" value="maths"><input type="hidden" name="market" value="tutoring">`))
  assert.ok(form.includes(`<a class="radio" href="${BASE}/search?q=maths"><span class="r"></span>All</a>`))
  assert.ok(form.includes(`<a class="radio" href="${BASE}/search?q=maths&amp;market=tutoring" aria-current="true"><span class="r"></span>Tutoring</a>`))
  assert.ok(form.includes(`<a class="radio" href="${BASE}/search?q=maths&amp;market=clothing"><span class="r"></span>Clothing</a>`))
  assert.deepEqual([...form.matchAll(/<input type="radio" name="(\w+)" value="([^"]*)"( checked)?>/g)].map((m) => `${m[1]}=${m[2]}${m[3] ? '*' : ''}`), ['role=tutor', 'role=student', 'minRating=*', 'minRating=8', 'minRating=9'])
  assert.ok(!form.includes('name="near"') && form.endsWith('<button class="btn plain sm" type="submit">Apply</button></form>'))
  // How many, in the words of what was asked; no side, so listings; then a card for each.
  assert.ok(html.includes('<p class="s"><b>3</b> listings for &quot;maths&quot; in Tutoring, best first</p></div>'))
  assert.equal(html.match(/<a class="rcard"/g)!.length, 3)
  // A side: its word, and a link to the other side; its radio picked.
  const tutors = mainOf((await page(i, '/search?q=maths&market=tutoring&role=tutor')).text)
  assert.ok(tutors.includes(`<p class="s"><b>2</b> offers for &quot;maths&quot; in Tutoring, best first</p><a class="btn text fit" href="${BASE}/search?q=maths&amp;market=tutoring&amp;role=student">Requests</a>`))
  assert.ok(tutors.includes('<input type="radio" name="role" value="tutor" checked>'))
  // Near shows only when the address carries a point: its chip removes it, and the form asks how far.
  const near = mainOf((await page(i, '/search?near=40.4,-3.7&km=50&minRating=7.5')).text)
  assert.ok(near.includes(`<a class="fchip on" href="${BASE}/search?minRating=7.5" aria-label="Remove near">`) && near.includes('Near 40.4, -3.7'))
  assert.ok(near.includes('<input type="hidden" name="near" value="40.4,-3.7">') && near.includes('<option value="50" selected>50 km</option>'))
  assert.ok(near.includes('<input type="radio" name="minRating" value="7.5" checked>'))
  assert.ok(near.includes('<b>1</b> listing, nearest first'))
  // What was searched is text in the box, never markup.
  assert.ok((await page(i, '/search?q=%22%3E%3Cb%3E')).text.includes('<input type="search" name="q" value="&quot;&gt;&lt;b&gt;" placeholder'))
})

test("a market's page: a header on its tint, its avatar, name, counts and description; a side per role, each with the tabs, a search box for that side, and its cards", async () => {
  const clothing = mainOf((await page(i, '/markets/clothing')).text)
  assert.ok(clothing.startsWith(`<main>\n<div class="head tint" style="--h:${colorOf('clothing')}"><a class="round back" href="${BASE}/" aria-label="Back">`))
  assert.ok(clothing.includes(`<div class="me"><span class="av lg" style="--h:${colorOf('clothing')}" aria-hidden="true"><svg class="i" data-icon="t-shirt"`))
  assert.ok(clothing.includes('<h1>Clothing</h1><span class="s">1 offer</span></div></div>\n<p>People sell clothes'))
  // Each side at its own anchor; the tabs link to them, the side's own marked; the stylesheet shows
  // the one the address names, the first when none.
  const sides = [...clothing.matchAll(/<section class="side" id="(\w+)" aria-label="([^"]+)">/g)].map((m) => [m[1], m[2]])
  assert.deepEqual(sides, [['seller', 'Seller offers'], ['buyer', 'Buyer requests']])
  assert.ok(clothing.includes('<nav class="ptabs" aria-label="Sides"><a href="#seller" aria-current="true">Seller offers</a><a href="#buyer">Buyer requests</a></nav>'))
  assert.ok(clothing.includes('<nav class="ptabs" aria-label="Sides"><a href="#seller">Seller offers</a><a href="#buyer" aria-current="true">Buyer requests</a></nav>'))
  // A search box for each side, carrying its market and role.
  assert.ok(clothing.includes('placeholder="Search clothing" aria-label="Search clothing"></label><input type="hidden" name="market" value="clothing"><input type="hidden" name="role" value="seller"></form>'))
  assert.match(clothing, /<section class="side" id="seller"[\s\S]*?<div class="list"><a class="rcard" href="[^"]+\/listing\/coat">/)
  assert.ok(clothing.includes('<p>No requests yet.</p></section>'))
  // One role: no tabs.
  const tennis = mainOf((await page(i, '/markets/tennis-matches')).text)
  assert.ok(!tennis.includes('ptabs') && tennis.includes('<p>No requests yet.</p></section>') && tennis.includes('<span class="s">None yet</span>'))
  assert.ok(mainOf((await page(i, '/markets/home-cleaning')).text).includes('<h1>Home cleaning</h1>'))
})

test('the About page and its twin: what this index is, its links, then what it reads and its address', async () => {
  const { status, body: o } = await twin<{ index: string; lists: unknown }>(i, '/about.json')
  assert.equal(status, 200)
  assert.deepEqual(keysOf(o), ['index', 'lists'])
  assert.equal(o.index, i.address)
  assert.deepEqual(o.lists, (await twin<{ lists: unknown }>(i, '/index.json')).body.lists)
  const html = mainOf((await page(i, '/about')).text)
  const at = (text: string) => {
    const n = html.indexOf(text)
    assert.ok(n >= 0, text)
    return n
  }
  const order = [
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
  ]
  for (let n = 1; n < order.length; n++) assert.ok(at(order[n - 1]!) < at(order[n]!), order[n])
})
