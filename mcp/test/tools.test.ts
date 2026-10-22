// Every tool, against the standard's reference host on loopback and the stand-in index, and every
// refusal: a key not listed for its path, refused before the host is written to; a body that fails
// its market's fields, naming the field; a review's score out of range; a path the main key wrote;
// no key, or one spelled wrong. What lands on the host is read back with the records library and
// the owners' own keys, never through this tool.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { MainKey } from '@foundationforest/keys'
import { deliver, pull, pullRequest, readProfile } from '@foundationforest/records'
import { message, openMessage } from '@foundationforest/records/private'
import { Refusal } from '../src/forest.ts'
import { checkArgs } from '../src/params.ts'
import { TOOLS } from '../src/tools.ts'
import { ANSWERS, DIRECTORY, KEYS, RESULT, TUTORING, type World, buyer, lesson, quiet, reader, reviewer, student, studentInbox, tutor, tutorInbox, world, writer } from './setup.ts'

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

const run = async (name: string, args: { [name: string]: unknown }): Promise<any> => {
  const tool = TOOLS.find((t) => t.name === name)!
  return tool.run(checkArgs(tool, args), w.ctx)
}
const refused = (promise: Promise<unknown>, why: string) =>
  assert.rejects(promise, (err: Error) => {
    assert.ok(err instanceof Refusal, err.stack)
    assert.equal(err.message, why)
    return true
  })

/** The tutor acting, with its write key or its read key. */
const asTutor = { profile: tutor.address, writeKey: KEYS.write }
const reading = { profile: tutor.address, readKey: KEYS.read }

/** A profile's folder, as its host serves it now. */
const live = async (owner: MainKey) => (await readProfile([w.host], owner.address, Date.now())).current
/** Every message to `owner`, pulled by its main key. */
const pulled = async (owner: MainKey) => (await pull(w.host, pullRequest(owner, 0, Date.now()))).messages
const writes = () => w.counts.get('POST /v1/records') ?? 0
const deliveries = () => w.counts.get('POST /v1/inbox') ?? 0

describe('reading, with no key', () => {
  test('markets: the directory this copy reads, and the markets the index lists', async () => {
    const out = await run('markets', {})
    assert.deepEqual(out.markets, DIRECTORY.markets)
    assert.deepEqual(out.index, { url: `${w.index}/index.json`, index: ANSWERS.index.index, markets: ['tutoring', 'clothing'] })
  })

  test('market: its file, verbatim, and its posts by role from the index', async () => {
    const out = await run('market', { market: 'tutoring' })
    assert.deepEqual(out.market, TUTORING)
    assert.deepEqual(out.index.posts, { tutor: [], student: [RESULT] })
    await refused(run('market', { market: 'astrology' }), 'astrology is not a market in the directory; markets lists them')
  })

  test('search: every filter passed to the index, and its answer passed on', async () => {
    const filters = { q: 'maths', market: 'tutoring', role: 'student', near: '40.42,-3.70', km: 10, minRating: 8.5, minReviews: 3, limit: 5, offset: 0 }
    const out = await run('search', filters)
    assert.deepEqual(Object.fromEntries(w.searched()!), Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)])))
    assert.deepEqual([out.total, out.results], [1, [RESULT]])
    await refused(run('search', { limit: 0 }), 'limit is a whole number, from 1')
  })

  test('profile: its profile record, posts and reviews from its hosts, and the index’s checks and rating', async () => {
    const out = await run('profile', { address: student.address })
    assert.deepEqual(out.profile, { market: 'tutoring', role: 'student', inbox: { senders: 'anyone' } }, 'its inbox key left out')
    assert.deepEqual(out.posts, [{ address: `${student.address}/offer/maths`, body: { description: 'Maths for the exam in June.' } }])
    assert.deepEqual(out.hosts, [w.host])
    assert.deepEqual(out.index, { url: `${w.index}/profiles/${student.address}.json`, index: ANSWERS.index.index, checks: RESULT.checks, rating: RESULT.rating })
    const tutors = await run('profile', { address: tutor.address })
    assert.match(tutors.index.unread, /answered 404/, 'a down index never hides what the hosts gave')
    assert.equal(tutors.posts[0].address, `${tutor.address}/offer/owned`)
    await refused(run('profile', { address: 'not-an-address' }), "not-an-address is not a profile's address")
  })
})

describe('post', () => {
  test('posts, updates and removes with the write key, each read back from the host', async () => {
    const posted = await run('post', { action: 'post', id: 'physics', body: lesson('Physics, one hour.'), ...asTutor })
    assert.deepEqual([posted.address, posted.hosts], [`${tutor.address}/offer/physics`, [w.host]])
    let now = (await live(tutor)).get('offer/physics')!.record
    assert.deepEqual([now.by, now.body!.description], [writer.address, 'Physics, one hour.'])

    await run('post', { action: 'update', id: 'physics', body: { description: 'Physics, two hours.' }, ...asTutor })
    assert.deepEqual((await live(tutor)).get('offer/physics')!.record.body, { description: 'Physics, two hours.' })

    await run('post', { action: 'remove', id: 'physics', ...asTutor })
    assert.equal((await live(tutor)).get('offer/physics')!.record.body, null)

    const fresh = await run('post', { action: 'post', body: { description: 'Chemistry.' }, ...asTutor })
    assert.match(fresh.path, /^offer\/[0-9a-f]{16}$/, 'a fresh id when none is given')
    now = (await live(tutor)).get(fresh.path)!.record
    assert.equal(now.body!.description, 'Chemistry.')
  })

  test('a key not listed for its path is refused before the host is written to', async () => {
    const before = writes()
    await refused(run('post', { action: 'post', id: 'stray', body: lesson('From the review key.'), profile: tutor.address, writeKey: KEYS.review }), 'this key is not listed for offer/stray')
    await refused(run('post', { action: 'post', id: 'stray', body: lesson('From the read key.'), profile: tutor.address, writeKey: KEYS.read }), 'this key is not listed for offer/stray')
    assert.equal(writes(), before, 'no record reached the host')
    assert.equal((await live(tutor)).get('offer/stray'), undefined)
  })

  test('a body that fails its market’s fields is refused, naming the field', async () => {
    const before = writes()
    const tries: Array<[unknown, string]> = [
      [{ ...lesson('Astrology.'), subjects: ['astrology'] }, 'subjects takes a list, each different, each one of ' + TUTORING.offer.subjects.values.join(', ')],
      [{ ...lesson('Cheap.'), price: { amount: 30, currency: 'EUR' } }, 'price takes { amount, currency, per }: amount as decimal text, currency a code such as USD, per if wanted'],
      [{ ...lesson('Paid in kind.'), payment: ['barter'] }, 'payment takes a list, each different, each one of direct, session'],
      [{ ...lesson('Somewhere.'), place: { area: 'Madrid' } }, 'place takes { lat, lon, precisionKm, area }, lat and lon as decimal text, with online: true and reachKm if wanted; or { online: true }'],
      [{ description: 'Blue.', colour: 'blue' }, 'a post in tutoring has no field colour'],
    ]
    for (const [body, why] of tries) await refused(run('post', { action: 'post', id: 'bad', body, ...asTutor }), why)
    await refused(run('post', { action: 'post', id: 'bad', body: { description: 'Jeans.', photos: [] }, profile: buyer.address, writeKey: KEYS.buyer }), 'photos is for posts by seller')
    assert.equal(writes(), before)
  })

  test('the main key wins, and each action needs what it needs', async () => {
    await refused(run('post', { action: 'update', id: 'owned', body: lesson('Mine now.'), ...asTutor }), "the person's main key wrote offer/owned, and the main key wins: only their app can change it; use ask")
    await refused(run('post', { action: 'post', id: 'owned2', body: lesson('No key.'), profile: tutor.address }), "this needs the write key (writeKey), as the person's app gives it")
    await refused(run('post', { action: 'post', id: 'x', body: lesson('Hex.'), profile: tutor.address, writeKey: 'ab'.repeat(32) }), "the write key is its 32 bytes in base64url, 43 characters, as the person's app gives it")
    await refused(run('post', { action: 'update', body: lesson('Which?'), ...asTutor }), 'post update needs id')
    await refused(run('post', { action: 'remove', id: 'nothing', ...asTutor }), 'nothing at offer/nothing')
    await refused(run('post', { action: 'post', id: 'x', body: lesson('Who?'), writeKey: KEYS.write }), "no profile given: give profile, the address the person's app gives")
  })
})

describe('review', () => {
  const review = { subject: student.address, score: '8.5', text: 'Clear and kind.', offer: `${student.address}/offer/maths` }

  test('posts, corrects and withdraws a review, each read back from the host', async () => {
    await run('review', { action: 'post', id: 'june', body: review, ...asTutor })
    assert.deepEqual((await live(tutor)).get('review/june')!.record.body, review)
    await run('review', { action: 'update', id: 'june', body: { ...review, score: '9' }, profile: tutor.address, writeKey: KEYS.review })
    const corrected = (await live(tutor)).get('review/june')!.record
    assert.deepEqual([corrected.by, corrected.body!.score], [reviewer.address, '9'], 'the review key, listed for review, corrects it')
    await run('review', { action: 'remove', id: 'june', ...asTutor })
    assert.equal((await live(tutor)).get('review/june')!.record.body, null)
  })

  test('a score out of range, or a field that fails, is refused, naming it', async () => {
    const before = writes()
    for (const score of ['11', '0', '8.55', '10.5', 9]) {
      await refused(run('review', { action: 'post', id: 'bad', body: { ...review, score }, ...asTutor }), 'score is "1" to "10" as decimal text, at most one decimal, such as "8.5"')
    }
    await refused(run('review', { action: 'post', id: 'bad', body: { ...review, subject: 'someone' }, ...asTutor }), 'subject is the address of the profile the review is about')
    await refused(run('review', { action: 'post', id: 'bad', body: { ...review, offer: `${student.address}/review/1` }, ...asTutor }), "offer is a post's address: <profile address>/offer/<id>")
    await refused(run('review', { action: 'post', id: 'bad', body: { score: '9' }, ...asTutor }), 'a review names its subject: the address of the profile it is about')
    await refused(run('review', { action: 'post', id: 'bad', body: { ...review, punctual: 'yes' }, ...asTutor }), 'a review in tutoring has no field punctual')
    // clothing's asDescribed is for reviews of a seller: the subject's profile record says it is a tutor.
    await refused(run('review', { action: 'post', id: 'bad', body: { subject: quiet.address, asDescribed: 'yes' }, profile: buyer.address, writeKey: KEYS.buyer }), 'asDescribed is for reviews of seller')
    assert.equal(writes(), before)
  })
})

describe('messages', () => {
  test('send seals so that only the owner’s inbox key opens it', async () => {
    const sent = await run('send', { to: student.address, body: { text: 'Is Tuesday at six free?' }, ...asTutor })
    assert.deepEqual([sent.from, sent.to, sent.hosts], [tutor.address, student.address, [w.host]])
    const got = (await pulled(student)).find((m) => m.id === sent.id)!
    assert.equal(got.message.key, writer.address, 'signed by the write key, for the tutor')
    assert.deepEqual((await openMessage(got.message, studentInbox.identity)).body, { text: 'Is Tuesday at six free?' })
    for (const identity of [tutorInbox.identity, reader.identity]) await assert.rejects(openMessage(got.message, identity), 'no other key opens it')
  })

  test('send to a profile with no inbox, or with a key not listed for the inbox, is refused before delivering', async () => {
    const before = deliveries()
    await refused(run('send', { to: quiet.address, body: { text: 'Hello?' }, ...asTutor }), `${quiet.address} declares no inbox this tool can read; nothing can be sent there`)
    await refused(run('send', { to: student.address, body: { text: 'Hello?' }, profile: tutor.address, writeKey: KEYS.review }), 'this key is not listed for inbox')
    assert.equal(deliveries(), before)
  })

  test('inbox pulls with the read key and opens what is sealed to it', async () => {
    const asked = await message(student, tutor.address, { text: 'Can we start in June?' }, Date.now(), (await live(tutor)).get('profile')!.record.body!)
    await deliver([w.host], [asked])
    const out = await run('inbox', reading)
    const got = out.messages.find((m: { from: string }) => m.from === student.address)
    assert.deepEqual(got.body, { text: 'Can we start in June?' })
    assert.ok(out.cursors[w.host] > 0)
    const later = await run('inbox', { ...reading, after: out.cursors })
    assert.deepEqual(later.messages, [], 'nothing after the cursors')
    await refused(run('inbox', { profile: tutor.address, readKey: KEYS.stray }), 'this key is not listed for inbox')
    await refused(run('inbox', { profile: tutor.address, readKey: KEYS.write }), 'this key is not listed for inbox')
  })

  test('ask lands in the owner’s inbox with its kind, and inbox marks it', async () => {
    const offer = `${student.address}/offer/maths`
    const asks: Array<[string, object]> = [
      ['post-offer', { body: lesson('Biology, asked for.'), id: 'biology' }],
      ['update-offer', { id: 'owned', body: lesson('Maths, two hours.') }],
      ['remove-offer', { id: 'owned' }],
      ['post-review', { body: { subject: student.address, score: '9', offer } }],
      ['pay', { offer, units: 2, note: 'Tuesday and Thursday.' }],
    ]
    const ids: string[] = []
    for (const [kind, params] of asks) {
      const sent = await run('ask', { kind, params, ...asTutor })
      assert.equal(sent.to, tutor.address)
      ids.push(sent.id)
    }
    const mine = await pulled(tutor)
    for (const [i, [kind, params]] of asks.entries()) {
      const got = mine.find((m) => m.id === ids[i])!
      assert.deepEqual((await openMessage(got.message, tutorInbox.identity)).body, { request: kind, ...params }, `${kind}, opened by the owner's inbox key`)
    }
    const inbox = await run('inbox', reading)
    assert.deepEqual(ids.map((id) => inbox.messages.find((m: { id: string }) => m.id === id).request), asks.map(([kind]) => kind))

    // A stranger's body that looks like a request is just a message.
    await deliver([w.host], [await message(student, tutor.address, { request: 'pay', offer }, Date.now(), (await live(tutor)).get('profile')!.record.body!)])
    const strangers = (await run('inbox', reading)).messages.filter((m: { from: string; body?: { request?: string } }) => m.from === student.address && m.body?.request)
    assert.ok(strangers.length && strangers.every((m: { request?: string }) => m.request === undefined))
  })

  test('ask checks what it asks for, as post and review do', async () => {
    const before = deliveries()
    await refused(run('ask', { kind: 'post-offer', params: { body: { ...lesson('Astrology.'), levels: ['kindergarten'] } }, ...asTutor }), 'levels takes a list, each different, each one of primary, secondary, university')
    await refused(run('ask', { kind: 'post-review', params: { body: { subject: student.address, score: '11' } }, ...asTutor }), 'score is "1" to "10" as decimal text, at most one decimal, such as "8.5"')
    await refused(run('ask', { kind: 'pay', params: { offer: student.address }, ...asTutor }), "offer is a post's address: <profile address>/offer/<id>")
    await refused(run('ask', { kind: 'pay', params: { offer: `${student.address}/offer/maths`, units: 0 }, ...asTutor }), 'units is a whole number, from 1')
    await refused(run('ask', { kind: 'pay', params: { offer: `${student.address}/offer/maths`, writeKey: KEYS.write }, ...asTutor }), 'ask pay takes no writeKey')
    await refused(run('ask', { kind: 'remove-offer', params: { id: 'owned' }, profile: quiet.address, writeKey: KEYS.write }), `${quiet.address} declares no inbox, so nothing reaches the person this way`)
    assert.equal(deliveries(), before)
  })
})
