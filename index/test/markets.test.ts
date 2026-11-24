// The markets, read through the markets package from the tests' own (world.ts): a listing that does
// not fit its market (the package's checkEntry, whose own tests are the markets repo's) is kept, not
// listed, and says why in checkEntry's words, a place with a name, as before the eight pieces, a
// single price where a price is always a list, a range that runs backwards, and hours with no zone
// among them; a field holding several places, found near any of them; search's words, which find
// what people wrote and how their choices read, never a time zone's name, a code or a coordinate;
// a profile whose market has left the directory, out of search, its pages saying so; and spots,
// search's room for n, and how a listing's page reads them.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ListingPage } from '../src/pages/listing.ts'
import type { MarketPage } from '../src/pages/market.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
import { roomFor } from '../src/pages/search.ts'
import { loadMarkets } from '@foundationforest/markets'

import { at, index, MARKETS, verifier, page, post, profile, publishProfile, startHost, twin } from './world.ts'

const by = verifier()
let host: Awaited<ReturnType<typeof startHost>>
before(async () => {
  host = await startHost()
})
after(async () => {
  await host.close()
})

test('a listing that does not fit its market is kept, not listed, and its profile page says why', async () => {
  const tutor = await profile('lessons/tutor', [by])
  const student = await profile('lessons/student', [by])
  for (const p of [tutor, student]) await publishProfile(host.url, p)
  await post(host.url, [
    at(tutor, 'listing/good', { description: 'Maths, any level.', subjects: ['maths'] }),
    at(tutor, 'listing/odd', { description: 'Maths.', colour: 'red' }),
    at(tutor, 'listing/old', { description: 'Maths, in Madrid.', mode: ['in-person'], place: { lat: '40.42', lon: '-3.70', radiusKm: 1, area: 'Madrid' } }),
    at(tutor, 'listing/one', { description: 'Maths.', price: { amount: '30', currency: 'USD', per: 'hour' } }),
    at(tutor, 'listing/back', { description: 'Maths.', ages: { from: '11', to: '9' } }),
    at(tutor, 'listing/zone', { description: 'Maths.', hours: [{ every: ['monday'], start: '18:00' }] }),
    at(student, 'listing/physics', { description: 'Help with physics, please.', subjects: ['physics'] }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()

  const m = (await twin<MarketPage>(i, '/markets/lessons.json')).body
  assert.deepEqual(Object.keys(m.listings), ['tutor', 'student'])
  assert.deepEqual(m.listings.tutor!.map((r) => r.listing.address), [`${tutor.key.address}/listing/good`])
  assert.deepEqual(m.listings.student!.map((r) => r.listing.address), [`${student.key.address}/listing/physics`])

  const t = (await twin<ProfilePage>(i, `/profiles/${tutor.key.address}.json`)).body
  const odd = t.listings.find((p) => p.address.endsWith('/listing/odd'))!
  assert.equal(odd.listed, false)
  assert.equal(odd.why, 'a listing in lessons has no field colour')
  assert.deepEqual(odd.body, { description: 'Maths.', colour: 'red' })
  const old = t.listings.find((p) => p.address.endsWith('/listing/old'))!
  assert.deepEqual([old.listed, old.why], [false, 'place takes { lat, lon, radiusKm }: lat and lon as decimal text, and radiusKm in whole kilometres'])
  const why = (id: string) => t.listings.find((p) => p.address.endsWith(`/listing/${id}`))!
  assert.equal(why('one').listed, false)
  assert.match(why('one').why!, /^price takes a list of one or more, each different, each \{ amount, currency, per, count, note \}/)
  assert.equal(why('back').listed, false)
  assert.match(why('back').why!, /^ages takes .*from no more than to/)
  assert.equal(why('zone').listed, false)
  // A tutor's hours may hold their own spots, since lessons' spots is for tutors.
  assert.match(why('zone').why!, /^hours takes .*with zone, a time zone by name such as Europe\/Madrid; and, if wanted, its own spots for that time, .*, where "0" is full$/)
  // In checkEntry's own words.
  assert.equal(why('zone').why, loadMarkets(MARKETS).checkEntry('lessons', 'tutor', 'listing', { description: 'Maths.', hours: [{ every: ['monday'], start: '18:00' }] }))
  assert.equal(t.listings.find((p) => p.address.endsWith('/listing/good'))!.listed, true)
  assert.equal('why' in t.listings.find((p) => p.address.endsWith('/listing/good'))!, false)
  await i.close()
})

test('a field holding several places: a search near any of them finds the listing, at the nearest', async () => {
  // Courts in Madrid and in Seville, each a circle of 1 km, in one field.
  const player = await profile('matches/player', [by])
  await publishProfile(host.url, player)
  const madrid = { lat: '40.42', lon: '-3.70', radiusKm: 1 }
  const seville = { lat: '37.39', lon: '-5.98', radiusKm: 1 }
  await post(host.url, [at(player, 'listing/both', { description: 'A match, in either town.', courts: [madrid, seville] })])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()
  const near = async (q: string) => (await twin<{ results: Array<{ listing: { address: string }; km: number }> }>(i, `/search.json?${q}`)).body.results.map((r) => [r.listing.address, r.km])
  const both = `${player.key.address}/listing/both`
  assert.deepEqual(await near('near=40.42,-3.70&km=1'), [[both, 0]])
  assert.deepEqual(await near('near=37.40,-5.98&km=1'), [[both, 1.1]])
  // Between the two towns, far from either circle: nothing.
  assert.deepEqual(await near('near=39.00,-4.80&km=10'), [])
  // Its page says each place in words, with a link to its point on the map: here with no places
  // service to name them, by their size alone.
  const html = (await page(i, `/profiles/${both}`)).text
  assert.match(html, /<dt>Courts<\/dt><dd>Within 1 km<br><a href="https:\/\/www\.openstreetmap\.org\/\?mlat=40\.42[^"]*">See on a map<svg[\s\S]*?<\/a><br>Within 1 km<br><a href="https:\/\/www\.openstreetmap\.org\/\?mlat=37\.39[^"]*">See on a map<svg/)
  assert.deepEqual((await twin<ListingPage>(i, `/profiles/${both}.json`)).body.captions, { courts: [null, null] })
  await i.close()
})

test("search's words: what people wrote, its title among it, and how their choices read; never a time zone, a code, a coordinate or an amount", async () => {
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  // Its only Madrid is its hours' zone; es is Spanish; 40.42 and 25 are a coordinate and an amount;
  // only its title says quantum.
  await post(host.url, [
    at(tutor, 'listing/zoned', {
      title: 'Quantum physics tutor',
      description: 'Physics, by video.',
      languages: ['es'],
      mode: ['in-person'],
      place: { lat: '40.42', lon: '-3.70', radiusKm: 5 },
      price: [{ amount: '25', currency: 'EUR', per: 'hour' }],
      hours: [{ every: ['monday'], start: '18:00', zone: 'Europe/Madrid' }],
    }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()
  const found = async (q: string) => (await twin<{ results: Array<{ listing: { address: string } }> }>(i, `/search.json?q=${encodeURIComponent(q)}`)).body.results.map((r) => r.listing.address)
  const zoned = `${tutor.key.address}/listing/zoned`
  for (const q of ['physics video', 'spanish', 'in person', 'quantum', 'quantum video']) assert.deepEqual(await found(q), [zoned], q)
  for (const q of ['madrid', 'europe', 'es', '40', '25', 'eur', 'monday']) assert.deepEqual(await found(q), [], q)
  await i.close()
})

test('a profile whose market has left the directory: out of search, its pages open and say so', async () => {
  // Verified for its label, with a listing that fitted its market while the market was there.
  const seller = await profile('old-market/seller', [by])
  await publishProfile(host.url, seller)
  await post(host.url, [at(seller, 'listing/coat', { description: 'A wool coat.' })])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()
  assert.equal((await twin<{ total: number }>(i, '/search.json?q=coat')).body.total, 0)
  assert.equal((await page(i, '/markets/old-market')).status, 404)
  const p = await twin<ProfilePage>(i, `/profiles/${seller.key.address}.json`)
  assert.equal(p.status, 200)
  assert.deepEqual([p.body.checks, p.body.listings[0]!.listed, p.body.listings[0]!.why], [[], false, 'its profile does not count here'])
  const line = '<p class="s">Its market, Old market, is no longer in the markets directory, so nothing here counts.</p>'
  const profileHtml = (await page(i, `/profiles/${seller.key.address}`)).text
  assert.ok(profileHtml.includes(line))
  const l = await twin<ListingPage>(i, `/profiles/${seller.key.address}/listing/coat.json`)
  assert.deepEqual([l.status, l.body.market, l.body.fields], [200, 'old-market', []])
  const listingHtml = (await page(i, `/profiles/${seller.key.address}/listing/coat`)).text
  // Its market in words, with no icon: the directory no longer gives it one.
  assert.ok(listingHtml.includes(line) && listingHtml.includes('<span class="mk">Old market</span>'))
  // A profile in a market the directory lists shows no such line.
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  await i.pass()
  assert.ok(!(await page(i, `/profiles/${tutor.key.address}`)).text.includes('no longer in the markets directory'))
  await i.close()
})

test("spots: room for n, a time's own over the listing's, a full time skipped, a listing that says none left out; each as the markets read it", async () => {
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  const zone = 'Europe/Lisbon'
  const weekly = { every: ['monday'], start: '18:00', zone }
  await post(host.url, [
    // Its own spots win for each time: 6 on the 9th; the 16th is full.
    at(tutor, 'listing/own', { description: 'Own.', spots: '1', hours: [{ on: '2027-01-09', start: '10:00', zone, spots: '6' }, { on: '2027-01-16', start: '10:00', zone, spots: '0' }] }),
    // A time with no spots of its own has the listing's; with no time, the listing's.
    at(tutor, 'listing/plain', { description: 'Plain.', spots: '3', hours: [weekly] }),
    at(tutor, 'listing/bare', { description: 'Bare.', spots: '2' }),
    // Full, as a listing and at its one time.
    at(tutor, 'listing/full', { description: 'Full.', spots: '0' }),
    at(tutor, 'listing/allfull', { description: 'All full.', spots: '5', hours: [{ on: '2027-01-09', start: '10:00', zone, spots: '0' }] }),
    // No spots on the listing: only its time that says some counts.
    at(tutor, 'listing/some', { description: 'Some.', hours: [{ on: '2027-01-09', start: '10:00', zone, spots: '4' }, weekly] }),
    at(tutor, 'listing/none', { description: 'None.', hours: [weekly] }),
  ])
  const i = await index({ hosts: [host.url], keys: [{ key: by.key, verifier: by.name, label: 'face check', confidence: 0.75 }] })
  await i.pass()
  const ids = async (q: string) =>
    (await twin<{ results: Array<{ listing: { address: string } }> }>(i, `/search.json?${q}&limit=100`)).body.results
      .filter((r) => r.listing.address.startsWith(`${tutor.key.address}/`))
      .map((r) => r.listing.address.split('/').at(-1))
      .sort()
  const all = ['allfull', 'bare', 'full', 'none', 'own', 'plain', 'some']
  assert.deepEqual(await ids('market=lessons'), all)
  assert.deepEqual(await ids('market=lessons&spots=2'), ['bare', 'own', 'plain', 'some'])
  assert.deepEqual(await ids('market=lessons&spots=3'), ['own', 'plain', 'some'])
  assert.deepEqual(await ids('market=lessons&spots=4'), ['own', 'some'])
  assert.deepEqual(await ids('market=lessons&spots=6'), ['own'])
  assert.deepEqual(await ids('market=lessons&spots=7'), [])
  // Spots that are no whole number from 1 filter nothing, and without a market spots is no filter.
  for (const n of ['0', 'abc', '2.5', '-1', '']) assert.deepEqual(await ids(`market=lessons&spots=${n}`), all, n)
  assert.deepEqual(await ids('spots=7'), all)
  assert.deepEqual((await twin<{ query: object }>(i, '/search.json?market=lessons&spots=3')).body.query, { market: 'lessons', spots: '3' })
  // On a request the same count is the most it is for: a request for 2 has room in 3, not in 1.
  const markets = loadMarkets(MARKETS)
  const lessons = markets.market('lessons')!
  assert.deepEqual(['3', '2', '1'].map((n) => roomFor(markets, lessons, false, { spots: '2' }, n)), [true, true, false])
  assert.deepEqual(['3', '2', '1'].map((n) => roomFor(markets, lessons, true, { spots: '2' }, n)), [false, true, true])
  assert.deepEqual([roomFor(markets, lessons, false, {}, '1'), roomFor(markets, lessons, false, { spots: '0' }, '1')], [false, false])
  // Its page shows each as the markets read it: the listing's a number, a time's own after its hours.
  const own = (await page(i, `/profiles/${tutor.key.address}/listing/own`)).text
  assert.ok(own.includes('<div class="kv"><dt>Group size</dt><dd>1</dd></div>'))
  assert.ok(own.includes(`<div class="kv"><dt>Days and times</dt><dd>${markets.read({ piece: 'date' }, { on: '2027-01-09', start: '10:00', spots: '6' })} (${zone}); ${markets.read({ piece: 'date' }, { on: '2027-01-16', start: '10:00', spots: '0' })} (${zone})</dd></div>`))
  assert.ok(own.includes(', 10:00, 6 spots (Europe/Lisbon); ') && own.includes(', 10:00, full (Europe/Lisbon)</dd>'))
  assert.ok((await page(i, `/profiles/${tutor.key.address}/listing/full`)).text.includes('<div class="kv"><dt>Group size</dt><dd>0</dd></div>'))
  await i.close()
})
