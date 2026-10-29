// The host's credits, through the whole host on loopback, its plug and its front: what joining, an
// entry, a file and a delete cost, each counted as at least a kilobyte, at the rate of where it is
// kept; an entry larger than any inbox entry, paid by the byte, as entries up to a file's size are;
// a write refused with no balance, joining too, and leaving and taking down never; a file paid by a
// folder that names it; an inbox entry's one credit, its price kept and the rest the recipient's;
// a buy paid by a ticket, or from a folder's balance by its main key or an access key listed with
// message, and paid once; the credit key made at the first start; and one end to end, a folder, an
// entry and a file, read back. The plug's own tests are plug.test.ts and its neighbours, and the
// standard's host check is check.test.ts.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'

import { mainKey, newAccessKey, newSeed, openingHalf } from '@foundationforest/keys'
import { type Body, type SignedEntry, base58, encodeEntry, encodeInbox, entry, fetchFile, fileOf, leave, readFolder, upload, write } from '@foundationforest/folders'
import { inboxEntry } from '@foundationforest/folders/locked'

import { balancePayment, creditsPayment, inboxPayment } from '../client/client.ts'
import { DIRECTORY_PATH, MILLIONTHS } from '../src/credits.ts'
import { type RunningHost, readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'
import { freePort } from './helpers.ts'

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

/** `count` credits bought with a ticket from `gift`, at the host named `origin`. */
async function credits(running: RunningHost, count: number, origin = ORIGIN): Promise<string[]> {
  const b = await buy(origin, await keyOf(running.url), count)
  const got = await collect(running.url, b.bytes, `ticket ${gift.ticket(origin, b.reference, count)}`)
  assert.equal(got.status, 200)
  return b.finish(got.body)
}

/** `count` credits bought with a ticket from `gift`, and spent into `folder`. */
async function fund(running: RunningHost, folder: string, count: number, origin = ORIGIN): Promise<void> {
  assert.equal((await spend(running.url, folder, await credits(running, count, origin))).status, 200)
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

test('the price of joining, of an entry, of a file and of a delete: each at least a kilobyte, at the rate of where it is kept', async () => {
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
    assert.equal(spent(), 3000, 'the first profile entry, under a kilobyte: a kilobyte on the disk, 0.003')
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running, { subjects: ['maths'] }), now + 1)]))[0]!.ok)
    assert.equal(spent(), 0, 'a later profile entry costs nothing')

    const offer = offerOf(me, 2500, now)
    assert.ok((await results(running, [offer]))[0]!.ok)
    assert.equal(spent(), 7500, 'a 2.5 kB entry: 0.003 a kilobyte, 0.0075')
    assert.equal((await results(running, [offer]))[0]!.message, 'already here')
    assert.equal(spent(), 0, 'the same entry again costs nothing')

    const photo = new Uint8Array(200_000).fill(7)
    assert.ok((await results(running, [naming(me, 'photo/1', photo, 'image/png', now)]))[0]!.ok)
    assert.equal(spent(), 3000, 'the entry naming it, at its own price')
    assert.ok((await put(running, photo, 'image/png')).ok)
    assert.equal(spent(), 62_000, 'a 200 kB file: 0.00031 a kilobyte in the bucket, 0.062')
    assert.equal((await put(running, photo, 'image/png')).message, 'already here')
    assert.equal(spent(), 0, 'the same bytes again cost nothing')
    const icon = new Uint8Array(100).fill(8)
    assert.ok((await results(running, [naming(me, 'photo/2', icon, 'image/png', now)]))[0]!.ok)
    spent()
    assert.ok((await put(running, icon, 'image/png')).ok)
    assert.equal(spent(), 310, 'a 100-byte file: a kilobyte, 0.00031')

    assert.ok((await results(running, [entry(me, 'post/maths', null, now + 1)]))[0]!.ok)
    assert.equal(spent(), 0, 'taking an entry down: free')
  } finally {
    await running.close()
  }
})

test('entries up to 50,000,000 bytes, as a file, each paid by the byte; inbox entries up to 65,536', async () => {
  const running = await start()
  try {
    assert.deepEqual([running.host.maxEntryBytes, running.host.maxInboxBytes], [50_000_000, 65_536])
    const me = await folder()
    await fund(running, me.address, 5)
    const now = Date.now()
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running), now)]))[0]!.ok)
    const spent = spending(running, me.address)
    assert.ok((await results(running, [offerOf(me, 200_000, now)]))[0]!.ok, 'more than an inbox entry may hold')
    assert.equal(spent(), 600_000, 'a 200 kB entry: 0.003 for each of its 200 kilobytes')
  } finally {
    await running.close()
  }
})

test('a write is refused with no balance, joining too; leaving and taking your own things down never are', async () => {
  // A write of a kilobyte or less costs exactly one credit here: three credits pay for joining, one offer and one entry naming a photo.
  const running = await start({ ENTRY_PER_KB: '1', FILE_PER_KB: '1' })
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
  const running = await start({ ENTRY_PER_KB: '1', FILE_PER_KB: '1' })
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

test('an inbox entry carries one credit: the host keeps its price, and the rest goes into the recipient folder’s balance', async () => {
  const running = await start()
  try {
    const me = await folder()
    await fund(running, me.address, 1)
    const now = Date.now()
    const profile = profileOf(running, { openKey: (await openingHalf(me.secret)).openKey })
    assert.ok((await results(running, [entry(me, 'profile', profile, now)]))[0]!.ok)
    const received = spending(running, me.address)
    const letter = (text: string) => inboxEntry(me, me.address, { text }, Date.now(), profile)
    const left = async (entries: Awaited<ReturnType<typeof letter>>[], payment?: string) => (await leave([running.url], entries, { payment: () => payment }))[0]!.results
    const said = (r: { ok: boolean; error?: string; message?: string }[]) => r.map((x) => (x.ok ? 'ok' : `${x.error}: ${x.message}`))

    const one = await letter('A note to my other devices.')
    assert.match(said(await left([one]))[0]!, /^refused: an inbox entry here carries one credit, in the forest-payment header as `credits <credit> …`/, 'no credit, no inbox entry')
    assert.match(said(await left([one], 'credits not-a-credit'))[0]!, /^refused: the credit for this inbox entry does not hold/)

    const [a, b, c] = await credits(running, 3)
    assert.deepEqual(said(await left([one], creditsPayment([a!]))), ['ok'])
    const kept = running.credits.entryPrice(Buffer.byteLength(encodeInbox(one)))
    assert.ok(kept >= 3000 && kept < MILLIONTHS)
    assert.equal(-received(), MILLIONTHS - kept, 'the recipient gets the credit, but for the entry’s price on the disk')
    assert.match(said(await left([await letter('again')], creditsPayment([a!])))[0]!, /^refused: the credit for this inbox entry was spent already/)

    // One credit for each line, in order: a line refused before its price leaves its credit unspent.
    const batch = await left([one, await letter('two'), await letter('three')], creditsPayment([b!, c!]))
    assert.deepEqual(said(batch).map((r) => r.split(':')[0]), ['duplicate', 'ok', 'refused'])
    assert.deepEqual(said(await left([await letter('four')], creditsPayment([b!]))), ['ok'], 'the duplicate’s credit, unspent, pays for another')
  } finally {
    await running.close()
  }
})

test('at a rate where an inbox entry costs more than its credit, the recipient gets nothing, never less', async () => {
  const running = await start({ ENTRY_PER_KB: '1' })
  try {
    const me = await folder()
    await fund(running, me.address, 3)
    const profile = profileOf(running, { openKey: (await openingHalf(me.secret)).openKey })
    assert.ok((await results(running, [entry(me, 'profile', profile, Date.now())]))[0]!.ok)
    const held = balance(running, me.address)
    const e = await inboxEntry(me, me.address, { text: 'More than a kilobyte, locked.' }, Date.now(), profile)
    assert.ok(running.credits.entryPrice(Buffer.byteLength(encodeInbox(e))) > MILLIONTHS)
    const [credit] = await credits(running, 1)
    assert.deepEqual((await leave([running.url], [e], { payment: () => creditsPayment([credit!]) }))[0]!.results.map((r) => r.ok), [true])
    assert.equal(balance(running, me.address), held)
  } finally {
    await running.close()
  }
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

test('a buy paid from a folder’s balance: by its main key or an access key its profile entry lists with message, once, and only while it holds the credits', async () => {
  const running = await start()
  try {
    const forest = ((await (await fetch(`${running.url}${DIRECTORY_PATH}`)).json()) as { 'forest-credit': Record<string, unknown> })['forest-credit']
    assert.deepEqual(forest, { unit: 'writes at this host', price: '0.01', entry: '0.003', file: '0.00031' }, 'what a credit buys, its price, and a kilobyte’s on the disk and in the bucket')
    const me = await folder()
    const [messages, writes] = [await newAccessKey(), await newAccessKey()]
    await fund(running, me.address, 3)
    const keys = [{ key: messages.address, can: ['message'] }, { key: writes.address, can: ['write'] }]
    assert.ok((await results(running, [entry(me, 'profile', profileOf(running, { keys }), Date.now())]))[0]!.ok)
    const key = await keyOf(running.url)
    const paidBy = async (writer: Parameters<typeof balancePayment>[1], n: number) => {
      const b = await buy(ORIGIN, key, n)
      return { b, got: await collect(running.url, b.bytes, balancePayment(ORIGIN, writer, b.reference, n)) }
    }

    const byMain = await paidBy(me, 1)
    assert.equal(byMain.got.status, 200, 'its main key')
    assert.equal(balance(running, me.address), 1.997)
    assert.deepEqual((await collect(running.url, byMain.b.bytes, balancePayment(ORIGIN, me, byMain.b.reference, 1))).body, byMain.got.body, 'collected again: the same answer')
    assert.equal(balance(running, me.address), 1.997, 'and taken once')
    const other = await folder()
    assert.equal((await spend(running.url, other.address, await byMain.b.finish(byMain.got.body))).status, 200, 'its credits go into any folder')
    assert.equal(balance(running, other.address), 1)

    assert.equal((await paidBy({ profile: me.address, key: messages }, 1)).got.status, 200, 'an access key listed with message')
    assert.equal((await paidBy({ profile: me.address, key: writes }, 1)).got.status, 402, 'not one listed with write only')
    assert.equal((await paidBy({ profile: me.address, key: other }, 1)).got.status, 402, 'nor another folder’s main key')
    const poor = await paidBy(me, 1)
    assert.equal(poor.got.status, 402, 'nor more than the folder holds')
    assert.match(JSON.parse(Buffer.from(poor.got.body).toString()).detail, /this buy costs 1 credit, and the folder holds 0\.997 here/)
    assert.equal(balance(running, me.address), 0.997)

    // The standard's payment for inbox entries, from the client: a credit for each, bought from the
    // folder's balance by its access key. Its host names itself, port and all, as its credits do.
    const port = await freePort()
    const named = await start({ PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, PORT: String(port) })
    try {
      const to = await folder()
      await fund(named, me.address, 2, named.url)
      await fund(named, to.address, 1, named.url)
      assert.ok((await results(named, [entry(me, 'profile', profileOf(named, { keys }), Date.now())]))[0]!.ok)
      const profile = profileOf(named, { openKey: (await openingHalf(to.secret)).openKey })
      assert.ok((await results(named, [entry(to, 'profile', profile, Date.now())]))[0]!.ok)
      const from = { profile: me.address, key: messages }
      const e = await inboxEntry(from, to.address, { text: 'Is the coat still for sale?' }, Date.now(), profile)
      const received = spending(named, to.address)
      const [took] = await leave([named.url], [e], { payment: inboxPayment(from) })
      assert.deepEqual(took!.results.map((r) => r.ok), [true])
      assert.equal(balance(named, me.address), 0.997, 'its sender paid one credit')
      assert.equal(-received(), MILLIONTHS - named.credits.entryPrice(Buffer.byteLength(encodeInbox(e))), 'and its recipient got it, but for its price')
    } finally {
      await named.close()
    }
  } finally {
    await running.close()
  }
})

test('a buy is paid by a ticket or a balance, and any other proof is refused', async () => {
  const running = await start()
  try {
    const b = await buy(ORIGIN, await keyOf(running.url), 1)
    const signature = base58.encode(crypto.getRandomValues(new Uint8Array(64)))
    for (const proof of [`solana ${signature}`, 'ticket', 'balance', `ticket ${gift.ticket(ORIGIN, b.reference, 1)} more`]) {
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

    const price = (e: SignedEntry) => running.credits.entryPrice(Buffer.byteLength(encodeEntry(e)))
    const spent = price(profile) + price(offer) + running.credits.filePrice(photo.length)
    assert.equal(balance(running, me.address), (10 * MILLIONTHS - spent) / MILLIONTHS, 'each write at its price, the profile entry too')
  } finally {
    await running.close()
  }
})
