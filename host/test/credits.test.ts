// The host's credits, through the real reference host on loopback: what joining, a 1 kB record, a
// 200 kB blob and a delete cost; a write refused with no balance, joining too, and leaving and taking
// down never blocked by it; a message to its own inbox priced, others' free up to the day's cap; a
// ticket collected; a payment checked against a stand-in RPC; the credit key made at the first
// start; and one end to end, a folder, a record and a blob, read back. The reference host's own tests
// are the standard's.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { inboxKey, mainKey, newSeed } from '@foundationforest/keys'
import { type BlobName, type SignedBlobRequest, type SignedMessage, type SignedRecord, base58, blobNameOf, blobRequest, deleteBlob, deliver, encodeRecord, getBlob, hostsRecord, ownerRecord, publish, putBlob, readProfile } from '@foundationforest/records'
import { message } from '@foundationforest/records/private'

import type { Rpc } from '../credits/seller.ts'
import { DIRECTORY_PATH, MILLIONTHS } from '../src/credits.ts'
import { MESSAGES_A_DAY, type RunningHost, pricedMessages, readConfig, startHost } from '../src/host.ts'
import { buy, collect, keyOf, spend, sponsor } from './buyer.ts'

const ORIGIN = 'http://127.0.0.1'
const gift = sponsor()
const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A host on loopback with a new data directory, or `dir`, taking `gift`'s tickets, and these settings. */
async function start(env: Record<string, string> = {}, stand: { rpc?: Rpc } = {}, dir?: string): Promise<RunningHost> {
  if (!dir) dirs.push((dir = mkdtempSync(join(tmpdir(), 'host-'))))
  return startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: ORIGIN, PORT: '0', SPONSORS: gift.address, ...env }), stand)
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
const put = (url: string, me: Folder, name: BlobName, bytes: Uint8Array) => putBlob([url], blobRequest(me, { action: 'put', ...name }, Date.now()) as SignedBlobRequest & { action: 'put' }, bytes)
const remove = (url: string, me: Folder, sha256: string) => deleteBlob([url], blobRequest(me, { action: 'delete', sha256 }, Date.now()) as SignedBlobRequest & { action: 'delete' })
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
const results = async (running: RunningHost, records: SignedRecord[]) => (await publish([running.url], records))[0]!.results

/** An offer whose canonical text is exactly `bytes` long. */
function offerOf(me: Folder, bytes: number, time: number): SignedRecord {
  const empty = Buffer.byteLength(encodeRecord(ownerRecord(me, 'offer/maths', { text: '' }, time)))
  const record = ownerRecord(me, 'offer/maths', { text: 'a'.repeat(bytes - empty) }, time)
  assert.equal(Buffer.byteLength(encodeRecord(record)), bytes)
  return record
}

test('the price of a 1 kB record, of a 200 kB blob, and of a delete', async () => {
  const running = await start()
  try {
    const me = await folder()
    await fund(running, me.address, 5)
    const spent = spending(running, me.address)
    const now = Date.now()
    // Joining costs a write: the folder's first hosts record, priced like any record. A later one is
    // free.
    const hosts = hostsRecord(me, [running.url], now)
    assert.ok((await results(running, [hosts]))[0]!.ok)
    assert.equal(spent(), running.credits.priceOf(Buffer.byteLength(encodeRecord(hosts))), 'the first hosts record, at its price')
    assert.ok((await results(running, [hostsRecord(me, [running.url], now + 1)]))[0]!.ok)
    assert.equal(spent(), 0, 'a later hosts record costs nothing')

    const offer = offerOf(me, 1000, now)
    assert.ok((await results(running, [offer]))[0]!.ok)
    assert.equal(spent(), 20_000, 'a 1 kB record: 0.01, and 0.01 for its kilobyte')
    assert.equal((await results(running, [offer]))[0]!.message, 'already here')
    assert.equal(spent(), 0, 'the same record again costs nothing')

    const photo = new Uint8Array(200_000).fill(7)
    const name = blobNameOf(photo, 'image/png')
    assert.ok((await put(running.url, me, name, photo))[0]!.ok)
    assert.equal(spent(), 2_010_000, 'a 200 kB blob: 0.01, and 0.01 for each of its 200 kilobytes')
    assert.equal((await put(running.url, me, name, photo))[0]!.message, 'already here')
    assert.equal(spent(), 0, 'the same bytes again cost nothing')

    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', null, now + 1)]))[0]!.ok)
    assert.equal(spent(), 10_000, 'taking a record down: the floor')
    assert.ok((await remove(running.url, me, name.sha256))[0]!.ok)
    assert.equal(spent(), 10_000, 'taking a blob down: the floor')
    assert.equal((await remove(running.url, me, name.sha256))[0]!.message, 'not here')
    assert.equal(spent(), 0, 'a delete of bytes the folder does not hold costs nothing')
  } finally {
    await running.close()
  }
})

test('a write is refused with no balance, joining too; leaving and taking your own things down never are', async () => {
  // A write costs exactly one credit here: three credits pay for joining, one record and one blob.
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const me = await folder()
    const now = Date.now()
    const join = (await results(running, [hostsRecord(me, [running.url], now)]))[0]!
    assert.deepEqual([join.ok, join.error], [false, 'refused'], 'joining costs a write')
    assert.match(join.message!, /costs 1 credit, and the folder holds 0 here/)
    const refused = (await results(running, [ownerRecord(me, 'offer/maths', { text: 'maths' }, now)]))[0]!
    assert.deepEqual([refused.ok, refused.error], [false, 'refused'])
    const photo = new Uint8Array(1000).fill(1)
    const name = blobNameOf(photo, 'image/jpeg')
    const short = await put(running.url, me, name, photo)
    assert.deepEqual([short[0]!.ok, short[0]!.error], [false, 'refused'], 'bytes too')

    await fund(running, me.address, 3)
    assert.ok((await results(running, [hostsRecord(me, [running.url], now)]))[0]!.ok)
    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', { text: 'maths' }, now)]))[0]!.ok)
    assert.ok((await put(running.url, me, name, photo))[0]!.ok)
    assert.equal(balance(running, me.address), 0)
    assert.ok((await results(running, [hostsRecord(me, [running.url, 'https://elsewhere.example'], now + 1)]))[0]!.ok, 'a later hosts record, an update, needs no balance')

    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', null, now + 1)]))[0]!.ok, 'a live record taken down, free')
    assert.ok((await remove(running.url, me, name.sha256))[0]!.ok, 'a blob taken down, free')
    assert.equal(await getBlob([running.url], name.sha256), null)
    assert.equal(balance(running, me.address), 0)
    const nothing = (await results(running, [ownerRecord(me, 'offer/physics', null, now)]))[0]!
    assert.deepEqual([nothing.ok, nothing.error], [false, 'refused'], 'a null body where nothing stands is a write like any other')
    assert.ok((await results(running, [hostsRecord(me, ['https://elsewhere.example'], now + 2)]))[0]!.ok, 'leaving needs no balance')
  } finally {
    await running.close()
  }
})

test('a message to its own inbox is priced like a record from its folder; others’ messages are free', async () => {
  // A write costs exactly one credit here: joining, the profile record, and one message to itself.
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const me = await folder()
    await fund(running, me.address, 3)
    const now = Date.now()
    const profile = { market: 'tutoring', role: 'seller', inboxKey: (await inboxKey(me.secret)).encryptTo, inbox: { senders: 'anyone' } }
    assert.ok((await results(running, [hostsRecord(me, [running.url], now), ownerRecord(me, 'profile', profile, now)])).every((r) => r.ok))
    const send = async (from: Folder, text: string) => (await deliver([running.url], [await message(from, me.address, { text }, Date.now(), profile)]))[0]!.results[0]!
    assert.ok((await send(me, 'A note to my other devices.')).ok)
    assert.equal(balance(running, me.address), 0, 'one credit, as a record of its size')
    const short = await send(me, 'Another note.')
    assert.deepEqual([short.ok, short.error], [false, 'refused'], 'refused when the folder cannot pay')
    assert.match(short.message!, /costs 1 credit, and the folder holds 0 here/)
    assert.ok((await send(await mainKey(newSeed(), 'tutoring/buyer'), 'Is the coat still for sale?')).ok, 'someone else’s message is free')
  } finally {
    await running.close()
  }
})

test('others’ messages: an inbox takes MESSAGES_A_DAY of them a day, from midnight UTC', async () => {
  assert.equal(MESSAGES_A_DAY, 1000)
  const running = await start()
  try {
    let clock = Date.UTC(2026, 9, 26, 23, 59)
    const choose = pricedMessages(running.credits, 2, () => clock)
    const [inbox, another, sender] = [(await folder()).address, (await folder()).address, (await folder()).address]
    const to = (address: string) => ({ v: 1, from: sender, to: address, time: clock, body: { private: '' }, sig: '' }) as SignedMessage
    const stored = { messages: 0, bytes: 0 }
    assert.equal(await choose(to(inbox), stored), null)
    assert.equal(await choose(to(inbox), stored), null)
    assert.match((await choose(to(inbox), stored))!, /this inbox has taken 2 messages from others today/)
    assert.equal(await choose(to(another), stored), null, 'each inbox counts its own')
    clock += 2 * 60_000
    assert.equal(await choose(to(inbox), stored), null, 'a new day, counted again')
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

test('a payment on Solana is checked against the RPC', async () => {
  const MINT = base58.encode(new Uint8Array(32).fill(1))
  const PAY_TO = base58.encode(new Uint8Array(32).fill(2))
  const paid = new Map<string, unknown>()
  const rpc: Rpc = async (method, params) => {
    assert.equal(method, 'getTransaction')
    return paid.get(params[0] as string) ?? null
  }
  /** A transaction naming `reference`, in which `owner` gains `units` millionths of a dollar of `mint`. */
  const pay = (reference: string, units: number, mint = MINT, owner = PAY_TO) => {
    const signature = base58.encode(crypto.getRandomValues(new Uint8Array(64)))
    const balance = (amount: number) => [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } }]
    paid.set(signature, { meta: { err: null, preTokenBalances: balance(0), postTokenBalances: balance(units) }, transaction: { message: { accountKeys: ['payer', 'account', reference] } } })
    return `solana ${signature}`
  }

  const tickets = await start()
  try {
    const forest = ((await (await fetch(`${tickets.url}${DIRECTORY_PATH}`)).json()) as { 'forest-credit': Record<string, unknown> })['forest-credit']
    assert.deepEqual(forest, { unit: 'writes at this host', price: '0.01', write: '0.01', kilobyte: '0.01' }, 'with no payment set, the directory names no address')
    const b = await buy(ORIGIN, await keyOf(tickets.url), 1)
    assert.equal((await collect(tickets.url, b.bytes, pay(b.reference, 10_000))).status, 503, 'only tickets buy')
  } finally {
    await tickets.close()
  }

  const running = await start({ CREDIT_MINT: MINT, CREDIT_PAY_TO: PAY_TO, RPC_URL: 'http://127.0.0.1:9' }, { rpc })
  try {
    const forest = ((await (await fetch(`${running.url}${DIRECTORY_PATH}`)).json()) as { 'forest-credit': Record<string, unknown> })['forest-credit']
    assert.deepEqual([forest.address, forest.mint, forest.price], [PAY_TO, MINT, '0.01'])
    const b = await buy(ORIGIN, await keyOf(running.url), 2)
    assert.equal((await collect(running.url, b.bytes, pay(b.reference, 19_999))).status, 402, 'short by one unit')
    assert.equal((await collect(running.url, b.bytes, pay(b.reference, 20_000, base58.encode(new Uint8Array(32).fill(3))))).status, 402, 'another mint')
    assert.equal((await collect(running.url, b.bytes, pay(base58.encode(new Uint8Array(32).fill(4)), 20_000))).status, 402, 'another buy')
    const proof = pay(b.reference, 20_000)
    const got = await collect(running.url, b.bytes, proof)
    assert.equal(got.status, 200, 'two credits at a cent each, at face value')
    const me = await folder()
    assert.equal((await spend(running.url, me.address, await b.finish(got.body))).body.credits, 2)
  } finally {
    await running.close()
  }
})

test('the credit key is made on the volume at the first start, and kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-'))
  dirs.push(dir)
  const first = await start({}, {}, dir)
  const key = await keyOf(first.url)
  await first.close()
  assert.equal(statSync(join(dir, 'credits', 'key.der')).mode & 0o777, 0o600)
  const again = await start({}, {}, dir)
  try {
    assert.deepEqual(await keyOf(again.url), key)
  } finally {
    await again.close()
  }
})

test('end to end: a folder, a record and a blob, through the reference host with credits on', async () => {
  const running = await start()
  try {
    const me = await folder()
    await fund(running, me.address, 10)
    const now = Date.now()
    const hosts = hostsRecord(me, [running.url], now)
    const profile = ownerRecord(me, 'profile', { market: 'tutoring', role: 'seller' }, now)
    const offer = ownerRecord(me, 'offer/maths', { text: 'Maths, an hour on Tuesdays.' }, now)
    const outcome = await publish([running.url], [hosts, profile, offer])
    assert.deepEqual(outcome[0]!.results.map((r) => [r.ok, r.error]), [[true, undefined], [true, undefined], [true, undefined]])
    const photo = crypto.getRandomValues(new Uint8Array(30_000))
    const name = blobNameOf(photo, 'image/jpeg')
    assert.ok((await put(running.url, me, name, photo))[0]!.ok)

    const view = await readProfile([running.url], me.address, Date.now(), { post: true })
    assert.deepEqual(view.hosts, [running.url])
    assert.deepEqual(view.current.get('offer/maths')?.record.body, offer.body)
    assert.deepEqual(view.current.get('profile')?.record.body, profile.body)
    assert.deepEqual((await getBlob(view.hosts, name.sha256))?.bytes, photo)

    const price = (bytes: number) => running.credits.priceOf(bytes)
    const spent = [hosts, profile, offer].reduce((sum, r) => sum + price(Buffer.byteLength(encodeRecord(r))), 0) + price(photo.length)
    assert.equal(balance(running, me.address), (10 * MILLIONTHS - spent) / MILLIONTHS, 'each write at its price, the hosts record too')
  } finally {
    await running.close()
  }
})
