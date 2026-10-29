// Every tool, through the MCP SDK's own client, as an AI app calls it after the person logged in:
// the six and their marks; how Forest works first, then the index's guide; the markets; the index's
// answers whole, a field and a filter this copy has never seen among them. Then, in the person's
// two tutoring profiles, with the access keys their app keeps in the connection: my_profiles by
// label, with the switches each profile entry lists; read of an entry, public and locked, and of
// the inbox, each message opened and its sender checked, one from before the login left unopened;
// write, public against the market (the markets package's checkEntry), refused naming the field, a
// file named and not, a delete, locked anywhere but profile and key/…; message, which the recipient
// opens, signed by the access key; once the profile entry no longer lists the key, the host
// refusing its next write and its entries counting for nothing; and once the person's app removes
// it, its note and access entry gone with it. No answer, in the whole run, holds one of the
// person's own addresses.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type Body, entry, leave, nextTime, readFolder, readInbox, senderCounts, write } from '@foundationforest/folders'
import { inboxEntry, lock, lockCount, openInbox, openLocked } from '@foundationforest/folders/locked'
import { mainKey, newAccessKey, openingHalf, payAddresses } from '@foundationforest/keys'
import { WORD } from '../src/forest.ts'
import { serve } from '../src/server.ts'
import { HOW } from '../src/tools.ts'
import { SKILL, TUTORING, type World, aiApp, lesson, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }

let w: World
let client: Client
/** The address of the access key this login holds for the tutor profile, as its profile entry lists it. */
let tutorKey: string
/** Every answer an AI app got in this file. */
const answers: string[] = []

const TUTOR = 'tutoring/tutor'
const STUDENT = 'tutoring/student'
const SWITCHES = ['read-inbox', 'read', 'write', 'message']

/** A message from the stranger to the person's tutor, signed by `key` when given, else its main key. */
async function strangerWrites(text: string, key?: Awaited<ReturnType<typeof newAccessKey>>) {
  const to = w.own[TUTOR]!
  const theirs = (await readFolder([w.host], to, Date.now())).current.get('profile')!.entry.body
  const writer = key ? { profile: w.stranger.address, key } : w.stranger.tutor
  const [o] = await leave([w.host], [await inboxEntry(writer, to, { text }, Date.now(), theirs, w.host)])
  assert.ok(o!.results[0]?.ok, JSON.stringify(o))
}

before(async () => {
  w = await world()
  await strangerWrites('Before the login: are you there?')
  // A locked note in the tutor's folder from before the login: locked to its main key alone.
  const main = await mainKey(w.seed, TUTOR)
  await write([w.host], [entry(main, 'notes/old', await lock({ text: 'mine' }, [(await openingHalf(main.secret)).openKey]), Date.now())])
  const c = await aiApp(w.mcp.origin)
  await logIn(c)
  client = c.client
  tutorKey = (await w.app.keys(TUTOR)).at(-1)!.key
  await strangerWrites('Hello from a stranger: do you teach physics too?')
})
after(async () => {
  await client.close()
  await w.close()
})

/** A tool's call: its answer as JSON, or its refusal as `{ refused }`. */
async function call(name: string, args: { [key: string]: unknown } = {}, as = client): Promise<any> {
  const r = (await as.callTool({ name, arguments: args })) as Result
  const text = r.content[0]!.text
  answers.push(text)
  return r.isError ? { refused: text } : JSON.parse(text)
}

/** The current entry at `path` in the person's profile `label`, as its hosts serve it. */
async function at(label: string, path: string) {
  return (await readFolder([w.host], w.own[label]!, Date.now())).current.get(path)?.entry ?? null
}

/** What the index said at `path`, as the AI is shown it: whole, with where it was read and whose word it is. */
const said = (path: string) => ({ url: `${w.index}${path}`, word: WORD, answer: w.said[path.split('?')[0]!] })

describe('reading, with no login', () => {
  test('six tools, each with a title and marked: four only read, write may destroy, message reaches out', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name), ['markets', 'message', 'my_profiles', 'read', 'search', 'write'])
    for (const t of tools) assert.ok(t.title && t.annotations?.title === t.title, t.name)
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)
    assert.deepEqual(readOnly, ['markets', 'my_profiles', 'read', 'search'])
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
    assert.equal(byName.write!.destructiveHint, true)
    assert.equal(byName.message!.destructiveHint, false)
    assert.equal(byName.message!.openWorldHint, true)
  })

  test("how Forest works first, then the index's guide, its own word, read as a chat starts", async () => {
    const instructions = client.getInstructions()!
    assert.ok(instructions.startsWith(HOW))
    assert.ok(instructions.includes(`from ${w.index}/skill.md:\n\n${SKILL}`))
    const lost = await serve({ dataDir: w.dataDir, read: { index: 'http://127.0.0.1:9' } }, '127.0.0.1', 0)
    try {
      const { client: other } = await aiApp(lost.origin)
      assert.match(other.getInstructions()!, /The index gave no guide \(http:\/\/127\.0\.0\.1:9\/skill\.md: .*\): read its answers as they come\.$/)
      await other.close()
    } finally {
      await lost.close()
    }
  })

  test('markets: every market, or one market’s file with its preview and kinds, each with its fields; a market not in the directory refused', async () => {
    const all = await call('markets')
    assert.ok(all.markets.some((m: { name: string; roles: unknown[] }) => m.name === 'tutoring' && m.roles.length === 2))
    const one = await call('markets', { name: 'tutoring' })
    assert.deepEqual(Object.keys(one.kinds), ['post', 'review', 'vouch', 'report'])
    assert.deepEqual(one.kinds.post, TUTORING.post, "a post's fields are the file's")
    assert.deepEqual(Object.keys(one.kinds.review), ['subject', 'score', 'text', 'post'], 'the fields every review holds, the file adding none')
    assert.deepEqual(Object.keys(one.kinds.vouch), ['subject', 'text'])
    assert.deepEqual(one.market.preview, TUTORING.preview)
    assert.ok(one.market.post.price)
    assert.match((await call('markets', { name: 'knitting' })).refused, /knitting is not a market in the directory/)
  })

  test("search: the index's search, filters passed as they are, badge among them; or a profile's page; each whole", async () => {
    const filters = { q: 'physics', market: 'tutoring', badge: 'early' }
    const found = await call('search', { filters })
    assert.deepEqual(found.index, { ...said(`/search.json?${new URLSearchParams(filters)}`), answer: { ...(w.said['/search.json'] as object), asked: filters } })
    assert.equal(found.index.answer.badge, 'early', 'a field this copy has never seen, passed on')
    assert.match((await call('search', { filters: { minRating: 8 } })).refused, /each filter's value is text: minRating is not/)
    const page = await call('search', { address: w.stranger.address })
    assert.deepEqual(page.index, said(`/profiles/${w.stranger.address}.json`))
    assert.match((await call('search', { address: 'nobody' })).refused, /nobody is not a profile's address/)
    const nobody = (await mainKey(new Uint8Array(32).fill(5), 'tutoring/tutor')).address
    assert.match((await call('search', { address: nobody, filters: {} })).refused, /filters, or an address, not both/)
    assert.match((await call('search', { address: nobody })).refused, /the index gave nothing for/)
  })
})

describe('acting for the person', () => {
  test('my_profiles: the two tutoring profiles, by label, with every switch their profile entries list; no address', async () => {
    assert.deepEqual(await call('my_profiles'), { profiles: [{ label: STUDENT, can: SWITCHES }, { label: TUTOR, can: SWITCHES }] })
  })

  test('read of an entry: the profile entry, its pay addresses by label; one missing; a path that is none; a profile this login does not hold', async () => {
    const shown = await call('read', { label: TUTOR, path: 'profile' })
    assert.equal(shown.body.market, 'tutoring')
    assert.deepEqual(shown.body.pay, { solana: `${TUTOR}'s solana pay address`, evm: `${TUTOR}'s evm pay address` })
    assert.deepEqual(await call('read', { label: TUTOR, path: 'post/none' }), { path: 'post/none', found: false })
    assert.match((await call('read', { label: TUTOR, path: 'Post/x' })).refused, /Post\/x is no path/)
    assert.match((await call('read', { label: 'clothing/seller', path: 'profile' })).refused, /clothing\/seller is not a profile this login acts in/)
    assert.match((await call('read', { label: TUTOR })).refused, /a path, or inbox: true/)
  })

  test('write, public: a post, checked against the market, signed by the access key; refused naming the field', async () => {
    assert.deepEqual(Object.keys(await call('write', { label: TUTOR, path: 'post/maths', body: lesson('Maths, from the AI.') })), ['written', 'time', 'hosts'])
    const e = await at(TUTOR, 'post/maths')
    assert.equal(e?.key, tutorKey, 'signed by this login’s access key, and current')
    assert.equal((await call('read', { label: TUTOR, path: 'post/maths' })).body.description, 'Maths, from the AI.')
    const refusals: Array<[string, Body | null, RegExp]> = [
      ['post/x', { ...lesson('x'), colour: 'red' }, /a post in tutoring has no field colour/],
      ['post/x', { price: 30 }, /price takes \{ amount, currency, per \}/],
      ['post/x', { subjects: ['knitting'] }, /subjects takes a list, each different, each one of /],
      ['photo/x', { text: 'x' }, /photo is no kind of entry: the kinds are post, review, vouch, report/],
      ['post/a/b', lesson('x'), /one segment after the kind/],
      ['profile', { hosts: [w.host] }, /no access key writes profile/],
      ['review/x', { score: '9' }, /a review names its subject/],
      ['review/x', { subject: 'nobody', score: '9' }, /subject is the address of the profile the review is about/],
      ['review/x', { subject: w.stranger.address, score: '11' }, /score takes a number from "1" to "10"/],
      ['review/x', { subject: w.stranger.address, post: 'physics' }, /post takes a post's address/],
      ['review/x', { subject: w.stranger.address, post: 'nobody/post/physics' }, /post is a post's address: <profile address>\/post\/<id>/],
      ['vouch/x', { subject: w.stranger.address, score: '9' }, /a vouch in tutoring has no field score/],
    ]
    for (const [path, body, why] of refusals) assert.match((await call('write', { label: TUTOR, path, body })).refused, why, path)
    assert.equal(await at(TUTOR, 'post/x'), null, 'nothing written')
  })

  test('write, public: a review naming its post; a delete', async () => {
    const review = { subject: w.stranger.address, score: '9', text: 'Clear.', post: w.stranger.post }
    assert.equal((await call('write', { label: STUDENT, path: 'review/physics', body: review })).written, 'review/physics')
    assert.deepEqual((await at(STUDENT, 'review/physics'))?.body, review)
    await call('write', { label: TUTOR, path: 'post/gone', body: lesson('Gone soon.') })
    assert.equal((await call('write', { label: TUTOR, path: 'post/gone', body: null })).deleted, true)
    assert.deepEqual(Object.keys(await call('read', { label: TUTOR, path: 'post/gone' })), ['path', 'time', 'deleted'])
  })

  test('write, locked: any path but profile and key/…, the body unchecked, locked to the main key and each key that may read; no files', async () => {
    const plan = { text: 'Raise the price in June.', colour: 'red' }
    assert.equal((await call('write', { label: TUTOR, path: 'notes/plan', body: plan, locked: true })).locked, true)
    const e = await at(TUTOR, 'notes/plan')
    assert.equal(lockCount(e!.body as { private: string }), 2, "locked to the main key's open key and this login's key")
    const main = await mainKey(w.seed, TUTOR)
    assert.deepEqual(await openLocked(e!.body!, (await openingHalf(main.secret)).identity), plan, 'the person opens it')
    assert.deepEqual((await call('read', { label: TUTOR, path: 'notes/plan' })).body, plan, 'and so does this login')
    assert.deepEqual(await call('read', { label: TUTOR, path: 'notes/old' }), { path: 'notes/old', time: (await at(TUTOR, 'notes/old'))!.time, locked: true, opened: false }, 'one locked before the login it cannot open')
    assert.match((await call('write', { label: TUTOR, path: 'key/0123', body: { text: 'x' }, locked: true })).refused, /key\/… holds the person's notes/)
    assert.match((await call('write', { label: TUTOR, path: 'profile', body: { hosts: [w.host] }, locked: true })).refused, /no access key writes profile/)
    const photo = { sha256: '04ea806c667cd600b86061122fb9a7192c76405d58e14d63d29c51825dc7ec86', type: 'image/jpeg', size: 48213 }
    assert.match((await call('write', { label: TUTOR, path: 'notes/photo', body: { files: [photo] }, locked: true })).refused, /a locked entry carries no files/)
    assert.match((await call('write', { label: TUTOR, path: 'notes/odd', body: { amount: 1.5 }, locked: true })).refused, /not an entry/)
  })

  test("read of the inbox: each message opened, its sender checked, the index's word for a stranger; one from before the login unopened", async () => {
    const box = await call('read', { label: TUTOR, inbox: true })
    assert.equal(box.unopened, 1, 'the message from before the login was locked to keys this login is not among')
    assert.equal(box.older, 0)
    const hello = box.messages.find((m: { body: { text: string } }) => m.body.text.startsWith('Hello from a stranger'))
    assert.deepEqual(
      { from: hello.from, counts: hello.counts, index: hello.index },
      { from: w.stranger.address, counts: true, index: { url: `${w.index}/profiles/${w.stranger.address}.json`, word: WORD, market: 'tutoring', role: 'tutor', checks: (w.said[`/profiles/${w.stranger.address}.json`] as { checks: unknown }).checks } },
    )
  })

  test('message: to a stranger, who opens it, signed by the access key; to the person’s own profile, shown by its label; one whose key does not count', async () => {
    assert.deepEqual(await call('message', { label: TUTOR, to: w.stranger.address, body: { text: 'Yes, physics too.' } }), { sent: true, hosts: 1 })
    const page = await readInbox(w.host, w.stranger.address)
    const { message } = await openInbox(page.entries.at(-1)!.entry, w.stranger.identity)
    assert.deepEqual([message.from, message.key, message.host, message.body], [w.own[TUTOR], tutorKey, w.host, { text: 'Yes, physics too.' }])
    assert.ok(senderCounts(message, (await at(TUTOR, 'profile'))!.body), "the tutor's profile entry lists the key with message")

    await call('message', { label: STUDENT, to: w.own[TUTOR], body: { text: 'From the student.' } })
    await strangerWrites('Signed by a key my profile entry does not list.', await newAccessKey())
    const box = await call('read', { label: TUTOR, inbox: true })
    const mine = box.messages.find((m: { body: { text: string } }) => m.body.text === 'From the student.')
    assert.deepEqual([mine.fromLabel, mine.from, mine.counts, mine.index], [STUDENT, undefined, true, undefined])
    const forged = box.messages.find((m: { body: { text: string } }) => m.body.text.startsWith('Signed by a key'))
    assert.deepEqual([forged.from, forged.counts], [w.stranger.address, false])

    const nobody = (await mainKey(new Uint8Array(32).fill(5), 'tutoring/tutor')).address
    assert.match((await call('message', { label: TUTOR, to: nobody, body: { text: 'x' } })).refused, /no host this copy knows holds/)
  })

  test('another login, writing only, in the clothing profile: a photo named in files, and not; no message', async () => {
    w.choose({ profiles: ['clothing/seller'], can: ['write'] })
    const c = await aiApp(w.mcp.origin)
    try {
      await logIn(c)
      const photo = { sha256: '04ea806c667cd600b86061122fb9a7192c76405d58e14d63d29c51825dc7ec86', type: 'image/jpeg', size: 48213 }
      const coat = { description: 'A wool coat.', photos: [photo.sha256] }
      assert.match((await call('write', { label: 'clothing/seller', path: 'post/coat', body: coat }, c.client)).refused, /photos names a file the body's files do not list/)
      assert.equal((await call('write', { label: 'clothing/seller', path: 'post/coat', body: { ...coat, files: [photo] } }, c.client)).written, 'post/coat')
      assert.match((await call('message', { label: 'clothing/seller', to: w.stranger.address, body: { text: 'x' } }, c.client)).refused, /may not message as clothing\/seller/)
    } finally {
      w.choose({ profiles: [TUTOR, STUDENT] })
      await c.client.close()
    }
  })

  test("the key taken out of the tutor's profile entry alone: my_profiles shows no switch, the host refuses its next write, and what it wrote counts for nothing", async () => {
    await call('write', { label: TUTOR, path: 'post/physics', body: lesson('Physics, from the AI.') })
    assert.equal((await at(TUTOR, 'post/physics'))?.key, tutorKey)
    // A profile entry by the main key that no longer lists it, while the connection still holds it.
    const main = await mainKey(w.seed, TUTOR)
    const view = await readFolder([w.host], w.own[TUTOR]!, Date.now())
    const body = view.current.get('profile')!.entry.body!
    await write([w.host], [entry(main, 'profile', { ...body, keys: (body.keys as Body[]).filter((k) => k.key !== tutorKey) }, nextTime(Date.now(), view, 'profile'))])
    assert.deepEqual(await call('my_profiles'), { profiles: [{ label: STUDENT, can: SWITCHES }, { label: TUTOR, can: [] }] })
    assert.match((await call('write', { label: TUTOR, path: 'post/chemistry', body: lesson('Chemistry.') })).refused, /no host took it: .*\(unlisted: /)
    assert.equal(await at(TUTOR, 'post/physics'), null, 'its post no longer counts')
    assert.equal(await at(TUTOR, 'post/maths'), null)
  })

  test("the key removed by the person's app: its note and its access entry go with it, and the login acts as the tutor no more", async () => {
    await w.app.removeKey(TUTOR, tutorKey)
    assert.equal(await w.app.note(TUTOR, tutorKey), undefined, 'its note deleted with it')
    assert.deepEqual(await call('my_profiles'), { profiles: [{ label: STUDENT, can: SWITCHES }] })
    assert.match((await call('write', { label: TUTOR, path: 'post/chemistry', body: lesson('Chemistry.') })).refused, /tutoring\/tutor is not a profile this login acts in/)
  })

  test("no answer in this file holds one of the person's own addresses", async () => {
    const own: string[] = []
    for (const [label, address] of Object.entries(w.own)) own.push(address, ...Object.values(await payAddresses(w.seed, label)))
    const all = answers.join('\n').toLowerCase()
    assert.deepEqual(own.filter((a) => all.includes(a.toLowerCase())), [])
  })
})
