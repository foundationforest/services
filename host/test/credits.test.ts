// The host's credits, through the real reference host on loopback: what a 1 kB record, a 200 kB blob
// and a delete cost; a write refused with no balance, and taking down never blocked by it; a ticket
// collected; a payment checked against a stand-in RPC; the credit key made at the first start; and
// one end to end, a folder, a record and a blob, read back. The reference host's own tests are the
// standard's.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { mainKey, newSeed } from '@foundationforest/keys'
import { type BlobName, type SignedBlobRequest, type SignedRecord, base58, blobNameOf, blobRequest, deleteBlob, encodeRecord, getBlob, hostsRecord, ownerRecord, publish, putBlob, readProfile } from '@foundationforest/records'

import type { Rpc } from '../credits/seller.ts'
import { DIRECTORY_PATH, MILLIONTHS } from '../src/credits.ts'
import { type RunningHost, readConfig, startHost } from '../src/host.ts'
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
    const now = Date.now()
    // A hosts record is free: the standard's host never asks about it.
    assert.ok((await results(running, [hostsRecord(me, [running.url], now)]))[0]!.ok)
    assert.equal(balance(running, me.address), 5)

    const offer = offerOf(me, 1000, now)
    assert.ok((await results(running, [offer]))[0]!.ok)
    assert.equal(balance(running, me.address), 4.98, 'a 1 kB record: 0.01, and 0.01 for its kilobyte')
    assert.equal((await results(running, [offer]))[0]!.message, 'already here')
    assert.equal(balance(running, me.address), 4.98, 'the same record again costs nothing')

    const photo = new Uint8Array(200_000).fill(7)
    const name = blobNameOf(photo, 'image/png')
    assert.ok((await put(running.url, me, name, photo))[0]!.ok)
    assert.equal(balance(running, me.address), 2.97, 'a 200 kB blob: 0.01, and 0.01 for each of its 200 kilobytes')
    assert.equal((await put(running.url, me, name, photo))[0]!.message, 'already here')
    assert.equal(balance(running, me.address), 2.97, 'the same bytes again cost nothing')

    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', null, now + 1)]))[0]!.ok)
    assert.equal(balance(running, me.address), 2.96, 'taking a record down: the floor')
    assert.ok((await remove(running.url, me, name.sha256))[0]!.ok)
    assert.equal(balance(running, me.address), 2.95, 'taking a blob down: the floor')
    assert.equal((await remove(running.url, me, name.sha256))[0]!.message, 'not here')
    assert.equal(balance(running, me.address), 2.95, 'a delete of bytes the folder does not hold costs nothing')
  } finally {
    await running.close()
  }
})

test('a write is refused with no balance; taking your own things down never is', async () => {
  // A write costs exactly one credit here, so two credits pay for one record and one blob.
  const running = await start({ WRITE_FLOOR: '1', PER_KB: '0' })
  try {
    const me = await folder()
    const now = Date.now()
    assert.ok((await results(running, [hostsRecord(me, [running.url], now)]))[0]!.ok, 'a hosts record needs no balance')
    const refused = (await results(running, [ownerRecord(me, 'offer/maths', { text: 'maths' }, now)]))[0]!
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'refused')
    assert.match(refused.message!, /costs 1 credit, and the folder holds 0 here/)
    const photo = new Uint8Array(1000).fill(1)
    const name = blobNameOf(photo, 'image/jpeg')
    const short = await put(running.url, me, name, photo)
    assert.deepEqual([short[0]!.ok, short[0]!.error], [false, 'refused'], 'bytes too')

    await fund(running, me.address, 2)
    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', { text: 'maths' }, now)]))[0]!.ok)
    assert.ok((await put(running.url, me, name, photo))[0]!.ok)
    assert.equal(balance(running, me.address), 0)

    assert.ok((await results(running, [ownerRecord(me, 'offer/maths', null, now + 1)]))[0]!.ok, 'a live record taken down, free')
    assert.ok((await remove(running.url, me, name.sha256))[0]!.ok, 'a blob taken down, free')
    assert.equal(await getBlob([running.url], name.sha256), null)
    assert.equal(balance(running, me.address), 0)
    const nothing = (await results(running, [ownerRecord(me, 'offer/physics', null, now)]))[0]!
    assert.deepEqual([nothing.ok, nothing.error], [false, 'refused'], 'a null body where nothing stands is a write like any other')
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
    const profile = ownerRecord(me, 'profile', { market: 'tutoring', role: 'seller' }, now)
    const offer = ownerRecord(me, 'offer/maths', { text: 'Maths, an hour on Tuesdays.' }, now)
    const outcome = await publish([running.url], [hostsRecord(me, [running.url], now), profile, offer])
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
    const spent = price(Buffer.byteLength(encodeRecord(profile))) + price(Buffer.byteLength(encodeRecord(offer))) + price(photo.length)
    assert.equal(balance(running, me.address), (10 * MILLIONTHS - spent) / MILLIONTHS, 'each write at its price, the hosts record free')
  } finally {
    await running.close()
  }
})
