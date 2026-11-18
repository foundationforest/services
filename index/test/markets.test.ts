// The markets, read through the markets package from the tests' own (world.ts): a listing that does
// not fit its market (the package's checkEntry, whose own tests are the markets repo's) is kept, not
// listed, and says why in checkEntry's words, a place with a name, as before the eight pieces, a
// single price where a price is always a list, a range that runs backwards, and hours with no zone
// among them; a field holding several places, found near any of them; search's words, which find
// what people wrote and how their choices read, never a time zone's name, a code or a coordinate;
// and a profile whose market has left the directory, out of search, its pages saying so.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { ListingPage } from '../src/pages/listing.ts'
import type { MarketPage } from '../src/pages/market.ts'
import type { ProfilePage } from '../src/pages/profile.ts'
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
  assert.match(why('zone').why!, /^hours takes .*with zone, a time zone by name such as Europe\/Madrid$/)
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
  // Its page links each place to its point on the map.
  const html = (await page(i, `/profiles/${both}`)).text
  assert.match(html, /<dt>Courts<\/dt><dd><a href="https:\/\/www\.openstreetmap\.org\/\?mlat=40\.42[^"]*">Around 40\.42, -3\.70, 1 km<svg[\s\S]*?<\/a>, <a href="https:\/\/www\.openstreetmap\.org\/\?mlat=37\.39[^"]*">Around 37\.39, -5\.98, 1 km<svg/)
  await i.close()
})

test("search's words: what people wrote and how their choices read; never a time zone, a code, a coordinate or an amount", async () => {
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  // Its only Madrid is its hours' zone; es is Spanish; 40.42 and 25 are a coordinate and an amount.
  await post(host.url, [
    at(tutor, 'listing/zoned', {
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
  for (const q of ['physics video', 'spanish', 'in person']) assert.deepEqual(await found(q), [zoned], q)
  for (const q of ['madrid', 'europe', 'es', '40', '25', 'eur', 'monday']) assert.deepEqual(await found(q), [], q)
  await i.close()
})

test('a profile whose market has left the directory: out of search, its pages open and say so, their back links home', async () => {
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
  const back = '<a class="round back" href="https://index.test.example/" aria-label="Back">'
  const profileHtml = (await page(i, `/profiles/${seller.key.address}`)).text
  assert.ok(profileHtml.includes(line) && profileHtml.includes(back))
  const l = await twin<ListingPage>(i, `/profiles/${seller.key.address}/listing/coat.json`)
  assert.deepEqual([l.status, l.body.market, l.body.fields], [200, 'old-market', []])
  const listingHtml = (await page(i, `/profiles/${seller.key.address}/listing/coat`)).text
  assert.ok(listingHtml.includes(line) && listingHtml.includes('<a class="round clear back" href="https://index.test.example/" aria-label="Back">'))
  // A profile in a market the directory lists shows no such line.
  const tutor = await profile('lessons/tutor', [by])
  await publishProfile(host.url, tutor)
  await i.pass()
  assert.ok(!(await page(i, `/profiles/${tutor.key.address}`)).text.includes('no longer in the markets directory'))
  await i.close()
})
