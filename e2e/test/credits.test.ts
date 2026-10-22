// The credits buyer (credits/client.ts). First against the host's own code, started here on loopback
// as it runs (host/src/host.ts): a host that sells only for its sponsors' tickets, and one that sells
// for a dollar on Solana, its payment checked through a stand-in RPC; each bought from, collected,
// finished and spent into a folder, as the loop and an app do. Then the client alone, against a
// stand-in service made of Cloudflare's own Privacy Pass issuer and origin: the directory, the buy,
// the credits finished and listed, a buy finished later from what the vault keeps, and every answer
// that must finish nothing. The host's own checks of a credit are tested in host/.

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Token, genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad as b64u } from '@scure/base'

import { ticketMessage } from '../../host/credits/credit.ts'
import type { Rpc } from '../../host/credits/seller.ts'
import { type RunningHost, readConfig, startHost } from '../../host/src/host.ts'
import { CREDIT_TYPE, DIRECTORY_PATH, PAYMENT_HEADER, type Pending, buy, challengeOf, checkPending, creditList, finish, referenceOf, serviceOf } from '../credits/client.ts'

const { BLIND_RSA, BlindRSAMode, Issuer, Origin, getPublicKeyBytes } = publicVerif
const T = Date.UTC(2026, 9, 9)
const TEST_DOLLAR = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'

// ---- The host, as it runs ----

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const running: { host: RunningHost; dir: string }[] = []
after(async () => {
  for (const r of running) {
    await r.host.close()
    rmSync(r.dir, { recursive: true, force: true })
  }
})

/** The host on loopback with these settings, as `npm start` reads them. */
async function host(settings: Record<string, string>, rpc?: Rpc) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const dir = mkdtempSync(join(tmpdir(), 'e2e-credits-'))
  const h = await startHost(readConfig({ DATA_DIR: dir, PUBLIC_ORIGIN: origin, PORT: String(port), ...settings }), rpc ? { rpc } : {})
  running.push({ host: h, dir })
  return { origin, url: h.url }
}

const directoryAt = async (url: string) => (await fetch(`${url}${DIRECTORY_PATH}`)).json()
const collect = async (service: { requestUri: string }, bytes: Uint8Array, payment: string) => {
  const res = await fetch(service.requestUri, {
    method: 'POST',
    headers: { 'content-type': 'application/private-token-generic-batch-request', [PAYMENT_HEADER]: payment },
    body: bytes as Uint8Array<ArrayBuffer>,
  })
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
}
const spend = async (url: string, folder: string, credits: string[]) =>
  (await fetch(`${url}/credits/spend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder, credits }) })).json()
const json = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString('utf8'))
const folder = () => base58.encode(randomBytes(32))
const signature = () => base58.encode(randomBytes(64))

test('a host that sells only for tickets: no address and no pay link; a ticket buys, a payment on Solana does not', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const sponsor = base58.encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
  const h = await host({ SPONSORS: sponsor })
  // The host's own URL is the origin it names: a credit carries its host, and a ticket its origin.
  const service = serviceOf(h.origin, await directoryAt(h.url))
  assert.deepEqual([service.address, service.mint, service.price, service.unit], [undefined, undefined, '0.01', 'writes at this host'])

  const b = await buy(service, 3)
  assert.equal(b.payLink, undefined, 'nothing to pay on Solana, so no link')
  const paid = await collect(service, b.buy, `solana ${signature()}`)
  assert.deepEqual([paid.status, json(paid.body).error], [503, 'payment_check_unavailable'])

  const ticket = `${sponsor}.3.${b64u.encode(sign(null, ticketMessage(h.origin, b.reference, 3), privateKey))}`
  const answered = await collect(service, b.buy, `ticket ${ticket}`)
  assert.equal(answered.status, 200)
  const credits = await finish(b.pending, answered.body)
  assert.equal(credits.length, 3)
  const mine = folder()
  assert.deepEqual(await spend(h.url, mine, creditList(credits)), { folder: mine, credits: 3 })
  assert.equal((await spend(h.url, folder(), creditList(credits))).error, 'spent', 'a credit is spent once')
})

test('a host that sells for a dollar: the pay link, and a payment one unit short refused, then one in full', async () => {
  const payTo = base58.encode(randomBytes(32))
  // The stand-in RPC: each signature pays what `paid` says, in the test dollar, naming the reference.
  const paid = new Map<string, { reference: string; units: bigint }>()
  const rpc: Rpc = async (method, params) => {
    assert.equal(method, 'getTransaction')
    const p = paid.get(params[0] as string)
    if (!p) return null
    const balance = (amount: bigint) => [{ accountIndex: 1, mint: TEST_DOLLAR, owner: payTo, uiTokenAmount: { amount: amount.toString(), decimals: 6 } }]
    return { meta: { err: null, preTokenBalances: balance(0n), postTokenBalances: balance(p.units) }, transaction: { message: { accountKeys: [payTo, p.reference] } } }
  }
  const h = await host({ CREDIT_MINT: TEST_DOLLAR, CREDIT_PAY_TO: payTo, RPC_URL: 'http://127.0.0.1:9' }, rpc)
  const service = serviceOf(h.origin, await directoryAt(h.url))
  assert.deepEqual([service.address, service.mint, service.price], [payTo, TEST_DOLLAR, '0.01'])

  const b = await buy(service, 4)
  assert.equal(b.payLink, `solana:${payTo}?amount=0.04&spl-token=${TEST_DOLLAR}&reference=${b.reference}&label=${encodeURIComponent(new URL(h.origin).host)}`)
  const short = signature()
  paid.set(short, { reference: b.reference, units: 39_999n })
  assert.deepEqual([(await collect(service, b.buy, `solana ${short}`)).status], [402], 'one unit short')
  const full = signature()
  paid.set(full, { reference: b.reference, units: 40_000n })
  const answered = await collect(service, b.buy, `solana ${full}`)
  assert.equal(answered.status, 200)
  const credits = await finish(b.pending, answered.body)
  const mine = folder()
  assert.deepEqual(await spend(h.url, mine, creditList(credits)), { folder: mine, credits: 4 })
})

// ---- The client alone, against Cloudflare's issuer ----

/** A stand-in service: an RSA-2048 credit key, Cloudflare's issuer for it, and its directory. */
async function service(origin: string) {
  const keys = await Issuer.generateKey(BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) })
  const issuer = new Issuer(BlindRSAMode.PSS, new URL(origin).host, keys.privateKey, keys.publicKey)
  const key = await getPublicKeyBytes(keys.publicKey)
  const directory = {
    'issuer-request-uri': '/credits/buy',
    'token-keys': [{ 'token-type': 2, 'token-key': b64u.encode(key), 'not-before': T / 1000 - 60 }],
    'forest-credit': { unit: 'writes at this host', address: base58.encode(new Uint8Array(32).fill(3)), mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', price: '0.25' },
  }
  // What the service does with a paid buy: sign every request in it, blind, and answer.
  const answer = async (bytes: Uint8Array) => (await new genericBatched.Issuer(issuer).issue(genericBatched.BatchedTokenRequest.deserialize(bytes))).serialize()
  return { origin, keys, issuer, key, directory, answer, info: serviceOf(origin, directory, T) }
}
const stand = await service('https://host-a.example')
const other = await service('https://host-b.example')

test('a service is what its Privacy Pass directory says, and its forest-credit entry', async () => {
  const s = stand.info
  assert.deepEqual(s.key, stand.key)
  assert.equal(s.requestUri, 'https://host-a.example/credits/buy')
  assert.deepEqual([s.unit, s.mint, s.price], ['writes at this host', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '0.25'])
  const d = stand.directory
  const later = { 'token-type': 2, 'token-key': b64u.encode(other.key), 'not-before': T / 1000 + 3600 }
  assert.deepEqual(serviceOf(stand.origin, { ...d, 'token-keys': [...d['token-keys'], later] }, T).key, stand.key, 'a key counts from its not-before')
  assert.deepEqual(serviceOf(stand.origin, { ...d, 'token-keys': [...d['token-keys'], later] }, T + 7200_000).key, other.key, 'then the latest counts')
  const { address, mint, ...ticketsOnly } = d['forest-credit']
  assert.equal(serviceOf(stand.origin, { ...d, 'forest-credit': ticketsOnly }, T).address, undefined, 'no address and no mint: only tickets buy')
  const bad: [string, unknown][] = [
    ['no forest-credit', { ...d, 'forest-credit': undefined }],
    ['no unit', { ...d, 'forest-credit': { ...d['forest-credit'], unit: '' } }],
    ['a price of 0', { ...d, 'forest-credit': { ...d['forest-credit'], price: '0.00' } }],
    ['a price as a number', { ...d, 'forest-credit': { ...d['forest-credit'], price: 0.25 } }],
    ['an address that is none', { ...d, 'forest-credit': { ...d['forest-credit'], address: 'x' } }],
    ['an address with no mint', { ...d, 'forest-credit': { ...ticketsOnly, address } }],
    ['a mint with no address', { ...d, 'forest-credit': { ...ticketsOnly, mint } }],
    ['no type 2 key', { ...d, 'token-keys': [{ ...d['token-keys'][0], 'token-type': 1 }] }],
    ['no request uri', { ...d, 'issuer-request-uri': undefined }],
  ]
  for (const [why, dir] of bad) assert.throws(() => serviceOf(stand.origin, dir, T), Error, why)
  assert.throws(() => serviceOf('http://host-a.example', d, T), /origin/, 'https, or loopback')
  assert.equal(challengeOf(stand.origin).issuerName, 'host-a.example')
  assert.equal(challengeOf(stand.origin).redemptionContext.length, 0, 'no context: bought ahead and kept')
})

test('a buy: blinded requests, the reference a payment carries, and the pay link anyone pays', async () => {
  const b = await buy(stand.info, 3)
  assert.equal(b.reference, base58.encode(createHash('sha256').update(b.buy).digest()))
  assert.equal(b.reference, await referenceOf(b.buy))
  assert.equal(b.payLink, `solana:${stand.info.address}?amount=0.75&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${b.reference}&label=host-a.example`)
  assert.equal([...genericBatched.BatchedTokenRequest.deserialize(b.buy)].length, 3)
  assert.equal(b.pending.blinds.length, 3)
  for (const blind of b.pending.blinds) {
    const nonce = Buffer.from(b64u.decode(blind.nonce))
    assert.equal(Buffer.from(b.buy).indexOf(nonce), -1, 'the nonce a credit will carry is nowhere in the buy')
  }
  const sol = await buy({ ...stand.info, mint: 'SOL', price: '0.001' }, 12)
  assert.match(sol.payLink!, /^solana:[1-9A-HJ-NP-Za-km-z]+\?amount=0\.012&reference=/, 'SOL: no spl-token')
  await assert.rejects(buy(stand.info, 0), /one credit or more/)
  await assert.rejects(buy(stand.info, 1.5), /one credit or more/)
})

test('the credits: finished from the answer, each a Privacy Pass token Cloudflare’s origin checks, listed for a spend', async () => {
  const b = await buy(stand.info, 2)
  const credits = await finish(b.pending, await stand.answer(b.buy))
  assert.equal(credits.length, 2)
  for (const [i, c] of credits.entries()) {
    assert.equal(c.service, stand.origin)
    const token = Token.deserialize(BLIND_RSA, b64u.decode(c.credit))
    assert.equal(token.authInput.tokenType, CREDIT_TYPE)
    assert.deepEqual(token.authInput.nonce, b64u.decode(b.pending.blinds[i]!.nonce), 'it carries the nonce the app kept')
    assert.equal(await new Origin(BlindRSAMode.PSS).verify(token, stand.keys.publicKey), true, 'a Privacy Pass token, as Cloudflare checks one')
  }
  const list = creditList(credits)
  assert.deepEqual(list, credits.map((c) => c.credit), 'each credit as the vault keeps it')
  assert.deepEqual(creditList(credits.map((c) => b64u.decode(c.credit))), list, 'the same from bytes')
  assert.throws(() => creditList([...list, 'AAAA']), /not a credit/)
})

test('the same buy collected twice gives the same credits; what the vault keeps finishes it later', async () => {
  const b = await buy(stand.info, 2)
  const first = await stand.answer(b.buy)
  const again = await stand.answer(b.buy)
  assert.deepEqual(again, first, 'a lost answer costs nothing: collecting again signs the same')
  const kept = JSON.parse(JSON.stringify(b.pending)) as Pending
  checkPending(kept)
  assert.deepEqual(await finish(kept, again), await finish(b.pending, first))
})

test('refused: an answer for another buy, an empty slot, a slot too few', async () => {
  const mine = await buy(stand.info, 1)
  const theirs = await buy(stand.info, 1)
  await assert.rejects(finish(mine.pending, await stand.answer(theirs.buy)), /does not hold for this buy/)
  const empty = new genericBatched.GenericBatchTokenResponse([new genericBatched.OptionalTokenResponse(null)]).serialize()
  await assert.rejects(finish(mine.pending, empty), /holds no credit/)
  const two = await buy(stand.info, 2)
  await assert.rejects(finish(two.pending, await stand.answer(mine.buy)), /1 slots for 2 credits/)
})

test('a pending buy’s shape is checked before it is finished', () => {
  const ok: Pending = { service: 'https://host-a.example', key: 'AA', buy: 'AA', blinds: [{ nonce: 'AA', inverse: 'AA' }] }
  checkPending(ok)
  const bad: unknown[] = [null, { ...ok, more: 1 }, { ...ok, service: 'host-a.example' }, { ...ok, blinds: [] }, { ...ok, blinds: [{ nonce: 'AA' }] }]
  for (const p of bad) assert.throws(() => checkPending(p))
})
