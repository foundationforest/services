// The host's credits, through the whole host on loopback, its plug and its front: what joining, a
// 1 kB entry, a 200 kB file and a delete cost; a write refused with no balance, joining too, and
// leaving and taking down never blocked by it; a file paid by a folder that names it; inbox entries
// free up to the day's cap; a ticket collected, and no other proof; the credit key made at the first
// start; and one end to end, a folder, an entry and a file, read back. The plug's own tests are
// plug.test.ts and its neighbours, and the standard's host check is check.test.ts.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'

import { mainKey, newSeed, openingHalf } from '@foundationforest/keys'
import { type Body, type InboxEntry, type SignedEntry, base58, encodeEntry, entry, fetchFile, fileOf, leave, readFolder, upload, write } from '@foundationforest/folders'
import { inboxEntry } from '@foundationforest/folders/locked'

import { DIRECTORY_PATH, MILLIONTHS } from '../src/credits.ts'
import { INBOX_A_DAY, type RunningHost, cappedInbox, readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'

const ORIGIN = 'http://127.0.0.1'
const gift = sponsor()
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A host on loopback with a new data directory, or `dir`, taking `gift`'s tickets, and these settings. */
async function start(env: Record<string, string> = {}, dir?: string): Promise<RunningHost> {
  if (!dir) dirs.push((dir = mkdtempSync(join(tmpdir(), 'host-'))))
  return startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: ORIGIN, PORT: '0', SPONSORS: gift.address, ...env }))
}

/** `count` credits bought with a ticket from `gift`, and spent into `folder`. */
async function fund(running: RunningHost, folder: string, count: number): Promise<void> {
  const b = await buy(ORIGIN, await keyOf(running.url), count)
  const got = await collect(running.url, b.bytes, `ticket ${gift.ticket(ORIGIN, b.reference, count)}`)
  assert.equal(got.status, 200)
  assert.equal((await spend(running.url, folder, await b.finish(got.body))).status, 200)
}

const folder = async () => mainKey(newSeed(), 'tutoring/seller')
type Folder = Awaited<ReturnType<typeof folder>>
const balance = (running: RunningHost, folder: string) => running.credits.balance(folder)
/** What a folder spent since the last time this was asked, in millionths of a credit. */
function spending(running: RunningHost, folder: string): () => number {
  const held = () => Math.round(balance(running, folder) * MILLIONTHS)
  let last = held()
  return () => {
    const now = held()
    const spent = last - now
    last = now
    return spent
  }
}
const results = async (running: RunningHost, entries: SignedEntry[]) => (await write([running.url], entries))[0]!.results
const put = async (running: RunningHost, bytes: Uint8Array, type: string) => (await upload([running.url], bytes, type))[0]!
const profileOf = (running: RunningHost, more: Body = {}): Body => ({ market: 'tutoring', role: 'seller', hosts: [running.url], ...more })
/** An entry naming these bytes. */
const naming = (me: Folder, path: string, bytes: Uint8Array, type: string, time: number) => entry(me, path, { files: [fileOf(bytes, type)] }, time)

/** An offer whose canonical text is exactly `bytes` long. */
function offerOf(me: Folder, bytes: number, time: number): SignedEntry {
  const empty = Buffer.byteLength(encodeEntry(entry(me, 'post/maths', { text: '' }, time)))
  const offer = entry(me, 'post/maths', { text: 'a'.repeat(bytes - empty) }, time)
  assert.equal(Buffer.byteLength(encodeEntry(offer)), bytes)
  return offer
}

test('the price of joining, of a 1 kB entry, of a 200 kB file, and of a delete', async () => {
  const running = await start()
  try {
    const me = await folder()
    await fund(running, me.address, 5)
    const spent = spending(running, me.address)
    const now = Date.now()
    // Joining costs a write: the folder's first profile entry, priced like any entry. A later one is
    // free.
    const profile = entry(me, 'profile', profileOf(running), now)
    assert.ok((await results(running, [profile]))[0]!.ok)
    assert.equal(spent(), running.credits.priceOf(Buffer.byteLength(encodeEntry(profile))), 'the first profile entry, at its price')
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running, { subjects: ['maths'] }), now + 1)]))[0]!.ok)
    assert.equal(spent(), 0, 'a later profile entry costs nothing')

    const offer = offerOf(me, 1000, now)
    assert.ok((await results(running, [offer]))[0]!.ok)
    assert.equal(spent(), 20_000, 'a 1 kB entry: 0.01, and 0.01 for its kilobyte')
    assert.equal((await results(running, [offer]))[0]!.message, 'already here')
    assert.equal(spent(), 0, 'the same entry again costs nothing')

    const photo = new Uint8Array(200_000).fill(7)
    const named = naming(me, 'photo/1', photo, 'image/png', now)
    assert.ok((await results(running, [named]))[0]!.ok)
    assert.equal(spent(), running.credits.priceOf(Buffer.byteLength(encodeEntry(named))), 'the entry naming it, at its own price')
    assert.ok((await put(running, photo, 'image/png')).ok)
    assert.equal(spent(), 2_010_000, 'a 200 kB file: 0.01, and 0.01 for each of its 200 kilobytes')
    assert.equal((await put(running, photo, 'image/png')).message, 'already here')
    assert.equal(spent(), 0, 'the same bytes again cost nothing')

    assert.ok((await results(running, [entry(me, 'post/maths', null, now + 1)]))[0]!.ok)
    assert.equal(spent(), 10_000, 'taking an entry down: the floor')
  } finally {
    await running.close()
  }
})

test('a write is refused with no balance, joining too; leaving and taking your own things down never are', async () => {
  // A write costs exactly one credit here: three credits pay for joining, one offer and one entry naming a photo.
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const me = await folder()
    const now = Date.now()
    const join = (await results(running, [entry(me, 'profile', profileOf(running), now)]))[0]!
    assert.deepEqual([join.ok, join.error], [false, 'refused'], 'joining costs a write')
    assert.match(join.message!, /costs 1 credit, and the folder holds 0 here/)
    const refused = (await results(running, [entry(me, 'post/maths', { text: 'maths' }, now)]))[0]!
    assert.deepEqual([refused.ok, refused.error], [false, 'refused'])

    await fund(running, me.address, 3)
    const photo = new Uint8Array(1000).fill(1)
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running), now)]))[0]!.ok)
    assert.ok((await results(running, [entry(me, 'post/maths', { text: 'maths' }, now)]))[0]!.ok)
    assert.ok((await results(running, [naming(me, 'photo/1', photo, 'image/jpeg', now)]))[0]!.ok)
    assert.equal(balance(running, me.address), 0)
    const short = await put(running, photo, 'image/jpeg')
    assert.deepEqual([short.ok, short.error], [false, 'refused'], 'bytes too')
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running, { hosts: [running.url, 'https://elsewhere.example'] }), now + 1)]))[0]!.ok, 'a later profile entry, an update, needs no balance')

    assert.ok((await results(running, [entry(me, 'post/maths', null, now + 1)]))[0]!.ok, 'a live entry taken down, free')
    assert.ok((await results(running, [entry(me, 'photo/1', null, now + 1)]))[0]!.ok, 'and the one naming the photo')
    assert.equal(balance(running, me.address), 0)
    const nothing = (await results(running, [entry(me, 'post/physics', null, now)]))[0]!
    assert.deepEqual([nothing.ok, nothing.error], [false, 'refused'], 'a null body where nothing stands is a write like any other')
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running, { hosts: ['https://elsewhere.example'] }), now + 2)]))[0]!.ok, 'leaving needs no balance')
  } finally {
    await running.close()
  }
})

test('a file is paid by a folder whose current entry names it: the newest naming entry first, the first that can pay', async () => {
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const [paying, broke] = [await folder(), await folder()]
    await fund(running, paying.address, 3)
    await fund(running, broke.address, 2)
    const now = Date.now()
    const photo = new Uint8Array(1000).fill(2)
    assert.ok((await results(running, [entry(paying, 'profile', profileOf(running), now), naming(paying, 'photo/1', photo, 'image/jpeg', now)])).every((r) => r.ok))
    assert.ok((await results(running, [entry(broke, 'profile', profileOf(running), now), naming(broke, 'photo/1', photo, 'image/jpeg', now)])).every((r) => r.ok))
    assert.deepEqual([balance(running, paying.address), balance(running, broke.address)], [1, 0])
    assert.ok((await put(running, photo, 'image/jpeg')).ok)
    assert.deepEqual([balance(running, paying.address), balance(running, broke.address)], [0, 0], 'the newest namer could not pay, so the other did')

    const clip = new Uint8Array(1000).fill(3)
    await fund(running, broke.address, 1)
    assert.ok((await results(running, [naming(broke, 'clip/1', clip, 'video/mp4', now)]))[0]!.ok)
    const short = await put(running, clip, 'video/mp4')
    assert.deepEqual([short.ok, short.error], [false, 'refused'], 'none of the folders naming it can pay')
    assert.match(short.message!, /costs 1 credit, and the folder holds 0 here/)
  } finally {
    await running.close()
  }
})

test('inbox entries are free, whoever leaves them', async () => {
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const me = await folder()
    await fund(running, me.address, 1)
    const now = Date.now()
    const profile = profileOf(running, { openKey: (await openingHalf(me.secret)).openKey })
    assert.ok((await results(running, [entry(me, 'profile', profile, now)]))[0]!.ok)
    const left = async (from: Folder, text: string) => {
      const e = await inboxEntry(from, me.address, { text }, Date.now(), profile)
      return (await leave([running.url], [e]))[0]!.results[0]!
    }
    assert.ok((await left(me, 'A note to my other devices.')).ok)
    assert.ok((await left(await mainKey(newSeed(), 'tutoring/buyer'), 'Is the coat still for sale?')).ok)
    assert.equal(balance(running, me.address), 0, 'the profile entry took the one credit; nothing else')
  } finally {
    await running.close()
  }
})

test('an inbox takes INBOX_A_DAY inbox entries a day, from midnight UTC', async () => {
  assert.equal(INBOX_A_DAY, 1000)
  let clock = Date.UTC(2026, 9, 26, 23, 59)
  const choose = cappedInbox(2, () => clock)
  const [inbox, another] = [(await folder()).address, (await folder()).address]
  const to = (address: string): InboxEntry => ({ v: 1, to: address, private: '' })
  const stored = { entries: 0, bytes: 0 }
  assert.equal(await choose(to(inbox), stored), null)
  assert.equal(await choose(to(inbox), stored), null)
  assert.match((await choose(to(inbox), stored))!, /this inbox has taken 2 inbox entries today/)
  assert.equal(await choose(to(another), stored), null, 'each inbox counts its own')
  clock += 2 * 60_000
  assert.equal(await choose(to(inbox), stored), null, 'a new day, counted again')
})

test('a ticket is collected, once, and only from a sponsor this host lists', async () => {
  const running = await start()
  try {
    const key = await keyOf(running.url)
    const b = await buy(ORIGIN, key, 3)
    const ticket = `ticket ${gift.ticket(ORIGIN, b.reference, 3)}`
    assert.equal((await collect(running.url, b.bytes)).status, 402, 'nothing paid')
    assert.equal((await collect(running.url, b.bytes, `ticket ${sponsor().ticket(ORIGIN, b.reference, 3)}`)).status, 402, 'a sponsor it does not list')
    assert.equal((await collect(running.url, b.bytes, `ticket ${gift.ticket(ORIGIN, b.reference, 2)}`)).status, 402, 'a ticket for another count')
    const first = await collect(running.url, b.bytes, ticket)
    assert.equal(first.status, 200)
    assert.deepEqual((await collect(running.url, b.bytes, ticket)).body, first.body, 'collected again: the same answer')
    assert.deepEqual(running.credits.seller.bill(), { [gift.address]: 3 }, 'billed once')
    const other = await buy(ORIGIN, key, 3)
    assert.equal((await collect(running.url, other.bytes, ticket)).status, 402, 'a ticket pays for its own buy only')

    const me = await folder()
    const credits = await b.finish(first.body)
    assert.equal(credits.length, 3)
    assert.deepEqual(await spend(running.url, me.address, credits), { status: 200, body: { folder: me.address, credits: 3 } })
    assert.equal((await spend(running.url, me.address, credits)).status, 409, 'a credit is spent once')
  } finally {
    await running.close()
  }
})

test('only tickets buy: the directory names no address, and any other proof is refused', async () => {
  const running = await start()
  try {
    const forest = ((await (await fetch(`${running.url}${DIRECTORY_PATH}`)).json()) as { 'forest-credit': Record<string, unknown> })['forest-credit']
    assert.deepEqual(forest, { unit: 'writes at this host', price: '0.01', write: '0.01', kilobyte: '0.01' }, 'what a credit buys, and its price')
    const b = await buy(ORIGIN, await keyOf(running.url), 1)
    const signature = base58.encode(crypto.getRandomValues(new Uint8Array(64)))
    for (const proof of [`solana ${signature}`, 'ticket', `ticket ${gift.ticket(ORIGIN, b.reference, 1)} more`]) {
      assert.deepEqual([(await collect(running.url, b.bytes, proof)).status], [400], proof.slice(0, 12))
    }
  } finally {
    await running.close()
  }
})

test('the credit key is made on the volume at the first start, and kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-'))
  dirs.push(dir)
  const first = await start({}, dir)
  const key = await keyOf(first.url)
  await first.close()
  assert.equal(statSync(join(dir, 'credits', 'key.der')).mode & 0o777, 0o600)
  const again = await start({}, dir)
  try {
    assert.deepEqual(await keyOf(again.url), key)
  } finally {
    await again.close()
  }
})

test('a credit route that fails answers 500, and logs one line: its path and the error, any address taken out', async () => {
  const running = await start()
  const me = await folder()
  running.credits.spend = async () => {
    throw new Error(`the balance of ${me.address} was not kept`)
  }
  const logged = mock.method(console, 'error', () => {})
  try {
    const res = await fetch(`${running.url}/credits/spend`, { method: 'POST', body: JSON.stringify({ folder: me.address, credits: [] }) })
    assert.deepEqual([res.status, await res.text()], [500, ''])
    assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [['500 /credits/spend: the balance of <address> was not kept']])
  } finally {
    logged.mock.restore()
    await running.close()
  }
})

test('end to end: a folder, an entry and a file, through the whole host with credits on', async () => {
  const running = await start()
  try {
    const me = await folder()
    await fund(running, me.address, 10)
    const now = Date.now()
    const photo = crypto.getRandomValues(new Uint8Array(30_000))
    const profile = entry(me, 'profile', profileOf(running, { files: [fileOf(photo, 'image/jpeg')] }), now)
    const offer = entry(me, 'post/maths', { text: 'Maths, an hour on Tuesdays.' }, now)
    const outcome = await write([running.url], [profile, offer])
    assert.deepEqual(outcome[0]!.results.map((r) => [r.ok, r.error]), [[true, undefined], [true, undefined]])
    assert.ok((await put(running, photo, 'image/jpeg')).ok)

    const view = await readFolder([running.url], me.address, Date.now())
    assert.deepEqual(view.hosts, [running.url])
    assert.deepEqual(view.current.get('post/maths')?.entry.body, offer.body)
    assert.deepEqual(view.current.get('profile')?.entry.body, profile.body)
    assert.deepEqual((await fetchFile(view.hosts, fileOf(photo, 'image/jpeg').sha256))?.bytes, photo)

    const price = (bytes: number) => running.credits.priceOf(bytes)
    const spent = [profile, offer].reduce((sum, e) => sum + price(Buffer.byteLength(encodeEntry(e))), 0) + price(photo.length)
    assert.equal(balance(running, me.address), (10 * MILLIONTHS - spent) / MILLIONTHS, 'each write at its price, the profile entry too')
  } finally {
    await running.close()
  }
})
