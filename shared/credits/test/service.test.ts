// Credits, a service's side: its key from PKCS #8, its seller's directory as the client reads it,
// a buy answered with Node's own RSA, byte for byte privacypass-ts's answer, and finished and taken
// by the client; nothing logged. Then each way a buy is paid: a Solana payment checked in one call,
// and a sponsor's ticket; every refusal; a proof that pays one buy only, the same answer again, and
// the bill counted once. And the spent list's hold, land and free, of one id or several together,
// kept across a restart, and inside a transaction the service opened.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58 } from '@scure/base'
import { buy, checkCredit, finish, serviceOf, ticket, ticketMessage } from '../src/index.ts'
import { type Rpc, type SellerConfig, SpentList, answer, keyFrom, seller } from '../src/service.ts'

const ORIGIN = 'https://payer.example'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ADDRESS = base58.encode(new Uint8Array(32).fill(3))
const pkcs8 = (bits: number) => new Uint8Array(generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'der' }))

const der = pkcs8(2048)
const key = await keyFrom(der)
const config: SellerConfig = { origin: ORIGIN, key, unit: 'one registration', requestUri: '/credits/buy', credit: { address: ADDRESS, mint: MINT, price: '0.5' }, maxBuy: 10, sponsors: [], rpc: null, path: ':memory:' }
const service = serviceOf(ORIGIN, seller(config).directory())

/** A sponsor: an Ed25519 key, its address, and the ticket it signs for a buy. */
function sponsor() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const address = base58.encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)))
  const signs = (origin: string, reference: string, credits: number) => ticket(address, credits, new Uint8Array(sign(null, ticketMessage(origin, reference, credits), privateKey)))
  return { address, signs }
}

test('its key, from PKCS #8, and its directory, as the client reads it', async () => {
  assert.deepEqual(service.key, key.published)
  assert.deepEqual([service.requestUri, service.unit, service.address, service.mint, service.price], [`${ORIGIN}/credits/buy`, 'one registration', ADDRESS, MINT, '0.5'])
  await assert.rejects(keyFrom(pkcs8(1024)), /RSA-2048/)
  await assert.rejects(keyFrom(new Uint8Array(32)))
  assert.throws(() => seller({ ...config, sponsors: ['not-an-address'] }), /sponsor/)
})

test('a buy answered with Node’s RSA: byte for byte privacypass-ts’s answer; the client finishes it and the service takes each credit', async () => {
  const b = await buy(service, 3)
  const answered = await answer(b.buy, key)
  assert.deepEqual(await answer(b.buy, key), answered, 'the same buy gets the same answer')
  // privacypass-ts's own issuer, from the same private key, answers the same bytes: RSA signing is deterministic.
  const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' }
  const privateKey = await crypto.subtle.importKey('pkcs8', der as Uint8Array<ArrayBuffer>, algorithm, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, algorithm, true, ['verify'])
  const theirs = await new genericBatched.Issuer(new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, 'payer.example', privateKey, publicKey)).issue(genericBatched.BatchedTokenRequest.deserialize(b.buy))
  assert.deepEqual(answered, theirs.serialize())
  const credits = await finish(b.pending, answered)
  assert.equal(credits.length, 3)
  for (const c of credits) assert.match(await checkCredit(c, { origin: ORIGIN, keys: [key.published] }), /^[0-9a-f]{64}$/)
})

test('a request under another key gets an empty slot, and nothing is logged', async () => {
  const other = await keyFrom(pkcs8(2048))
  const theirs = await buy(serviceOf(ORIGIN, seller({ ...config, key: other }).directory()), 1)
  const logged: unknown[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void logged.push(args)
  let answered: Uint8Array
  try {
    answered = await answer(theirs.buy, key)
  } finally {
    console.log = log
  }
  assert.deepEqual(logged, [], 'nothing of what it was sent is logged')
  assert.equal([...genericBatched.GenericBatchTokenResponse.deserialize(answered)][0]!.tokenResponse, null)
  await assert.rejects(finish(theirs.pending, answered), /holds no credit/)
  await assert.rejects(answer(new Uint8Array([0, 2, 9]), key), 'bytes that are not a buy get no answer')
})

/** A stand-in RPC: each transaction by its signature, and every call asked. */
function rpcOf(txs: Record<string, unknown>): Rpc & { asked: string[] } {
  const asked: string[] = []
  const call = async (method: string, params: unknown[]) => {
    asked.push(`${method} ${String(params[0])} ${(params[1] as { commitment?: string })?.commitment}`)
    if (method !== 'getTransaction') throw new Error(`no ${method}`)
    return txs[params[0] as string] ?? null
  }
  return Object.assign(call, { asked })
}
const sig = (n: number) => base58.encode(new Uint8Array(64).fill(n))
/** A finalized transaction naming `names` among its accounts, paying ADDRESS `units` of `mint`. */
const paying = (names: string[], units: string, mint = MINT, err: unknown = null) => ({
  meta: {
    err,
    preTokenBalances: [{ accountIndex: 1, mint, owner: ADDRESS, uiTokenAmount: { amount: '1000', decimals: 6 } }],
    postTokenBalances: [{ accountIndex: 1, mint, owner: ADDRESS, uiTokenAmount: { amount: String(1000n + BigInt(units)), decimals: 6 } }],
  },
  transaction: { message: { accountKeys: ['Payer', ADDRESS, ...names] } },
})

test('a Solana payment: the one transaction, finalized, naming the buy and paying enough, checked in one call', async () => {
  const b = await buy(service, 3)
  const other = await buy(service, 1)
  const rpc = rpcOf({
    [sig(1)]: paying([b.reference], '1500000'),
    [sig(2)]: paying([b.reference], '1499999'),
    [sig(3)]: paying([b.reference], '1500000', ADDRESS),
    [sig(4)]: paying([b.reference], '1500000', MINT, { InstructionError: [0, 'x'] }),
    [sig(5)]: paying([], '1500000'),
    [sig(6)]: paying([b.reference, other.reference], '1500000'),
  })
  const s = seller({ ...config, rpc })
  const status = async (bytes: Uint8Array, header?: string) => (await s.collect(bytes, header)).status
  assert.equal(await status(b.buy, `solana ${sig(1)}`), 200)
  assert.deepEqual(rpc.asked, [`getTransaction ${sig(1)} finalized`], 'one call, at finalized')
  const again = await s.collect(b.buy, `solana ${sig(1)}`)
  assert.deepEqual(again.body, await answer(b.buy, key), 'collected again with the same proof: the same answer')
  assert.equal(again.type, 'application/private-token-generic-batch-response')
  assert.equal(await status(b.buy, `solana ${sig(2)}`), 402, 'short by one unit')
  assert.equal(await status(b.buy, `solana ${sig(3)}`), 402, 'another mint')
  assert.equal(await status(b.buy, `solana ${sig(4)}`), 402, 'a failed transaction')
  assert.equal(await status(b.buy, `solana ${sig(5)}`), 402, 'a payment that does not name this buy')
  assert.equal(await status(b.buy, `solana ${sig(7)}`), 402, 'no such transaction, or not finalized yet')
  // One transaction naming two buys and paying for one: it pays for the first buy collected with it, never the second.
  assert.equal(await status(other.buy, `solana ${sig(6)}`), 200)
  assert.deepEqual((await s.collect(b.buy, `solana ${sig(6)}`)).body, { error: 'proof_used' })

  const sol = seller({ ...config, credit: { ...config.credit, mint: 'SOL', price: '0.001' }, rpc: rpcOf({ [sig(8)]: { meta: { err: null, preBalances: [5, 0, 0], postBalances: [3, 3_000_000, 0] }, transaction: { message: { accountKeys: ['Payer', ADDRESS, b.reference] } } } }) })
  assert.equal((await sol.collect(b.buy, `solana ${sig(8)}`)).status, 200, 'SOL, in lamports')
  const loaded = seller({ ...config, rpc: rpcOf({ [sig(9)]: { ...paying([], '1500000'), meta: { ...paying([], '1500000').meta, loadedAddresses: { writable: [], readonly: [b.reference] } } } }) })
  assert.equal((await loaded.collect(b.buy, `solana ${sig(9)}`)).status, 200, 'the reference loaded from a lookup table')

  assert.equal((await seller(config).collect(b.buy, `solana ${sig(1)}`)).status, 503, 'no RPC: no payment can be checked')
  const down = seller({ ...config, rpc: async () => Promise.reject(new Error('down')) })
  assert.deepEqual((await down.collect(b.buy, `solana ${sig(1)}`)).body, { error: 'payment_check_unavailable' })
})

test('a sponsor’s ticket: for this service, this buy and its count, from a sponsor it takes; billed once', async () => {
  const foundation = sponsor()
  const stranger = sponsor()
  const s = seller({ ...config, sponsors: [foundation.address] })
  const b = await buy(service, 3)
  const status = async (header: string, bytes = b.buy) => (await s.collect(bytes, header)).status
  assert.equal(await status(`ticket ${stranger.signs(ORIGIN, b.reference, 3)}`), 402, 'a sponsor it does not take')
  assert.equal(await status(`ticket ${foundation.signs(ORIGIN, b.reference, 2)}`), 402, 'a ticket for another count')
  assert.equal(await status(`ticket ${foundation.signs('https://host.example', b.reference, 3)}`), 402, 'a ticket for another service')
  const good = foundation.signs(ORIGIN, b.reference, 3)
  const [address, count, signature] = good.split('.') as [string, string, string]
  const flipped = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.at(-1)
  assert.equal(await status(`ticket ${address}.${count}.${flipped}`), 402, 'a signature that does not hold')
  assert.deepEqual(s.bill(), {}, 'nothing billed yet')
  assert.equal(await status(`ticket ${good}`), 200)
  assert.equal(await status(`ticket ${good}`), 200, 'collected again: the same answer')
  assert.deepEqual(s.bill(), { [foundation.address]: 3 }, 'billed once, for the credits it paid')
  const other = await buy(service, 3)
  assert.equal(await status(`ticket ${good}`, other.buy), 402, 'a ticket names its buy')
})

test('what a buy is refused for', async () => {
  const s = seller(config)
  const b = await buy(service, 3)
  const none = await s.collect(b.buy, undefined)
  assert.equal(none.status, 402)
  assert.match((none.body as { detail: string }).detail, new RegExp(`^1.5 to ${ADDRESS} in ${MINT}, the transaction naming the buy's reference ${b.reference}`), 'what to pay, and where')
  for (const header of ['card x', 'solana', 'solana not-a-signature', `solana ${sig(1)} more`, 'ticket a.b.c']) assert.equal((await s.collect(b.buy, header)).status, 400, header)
  assert.equal((await s.collect(new Uint8Array([1, 2, 3]), `solana ${sig(1)}`)).status, 400, 'not a buy')
  assert.deepEqual((await s.collect((await buy(service, 11)).buy, undefined)).body, { error: 'too_many', detail: 'at most 10 credits a buy' })
})

test('the spent list: hold, land and free, of one or several together, kept across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-credits-spent-'))
  try {
    const path = join(dir, 'spent.sqlite')
    let list = new SpentList(path)
    assert.equal(list.hold('a', 'sig-a', 1), 'held')
    assert.equal(list.hold('a'), 'busy', 'held by another request in flight')
    assert.equal(list.hold('b', 'sig-b', 2), 'held')
    list.land('a')
    assert.equal(list.hold('a'), 'spent')
    list.free('a')
    assert.equal(list.hold('a'), 'spent', 'a spent credit stays spent')
    list.free('b')
    assert.equal(list.hold('b', 'sig-b2', 3), 'held', 'a freed credit can be shown again')
    list.close()
    list = new SpentList(path)
    assert.deepEqual(list.holds(), [{ id: 'b', note: 'sig-b2', at: 3 }], 'what is held, after a restart')
    assert.equal(list.hold('a'), 'spent')

    // Several together: all held, or none.
    assert.equal(list.hold(['c', 'd', 'a'], null, 4), 'spent', 'one of them spent')
    assert.equal(list.hold(['c', 'd', 'b'], null, 4), 'busy', 'one of them held by another request')
    assert.deepEqual(list.holds().map((h) => h.id), ['b'], 'and neither took c or d')
    assert.throws(() => list.hold(['c', 'c']), /each once/)
    assert.throws(() => list.hold([]), /one id or more/)
    assert.equal(list.hold(['c', 'd', 'e'], 'n', 5), 'held')
    list.land(['c', 'd'])
    list.free(['e', 'c'])
    assert.deepEqual([list.hold('c'), list.hold('d'), list.hold('e')], ['spent', 'spent', 'held'], 'landed together, freed together; a spent one stays spent')
    list.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the spent list in the seller’s file: held and spent inside the service’s own transaction, or not at all', () => {
  const s = seller(config)
  s.db.exec('CREATE TABLE balances (folder TEXT PRIMARY KEY, credits INTEGER NOT NULL)')
  s.together(() => {
    assert.equal(s.spent.hold(['x', 'y']), 'held')
    s.spent.land(['x', 'y'])
    s.db.prepare('INSERT INTO balances VALUES (?, ?)').run('f', 2)
  })
  assert.equal(s.spent.hold('x'), 'spent')
  assert.throws(() =>
    s.together(() => {
      s.spent.hold('z')
      s.spent.land('z')
      throw new Error('the balance could not take it')
    }),
  )
  assert.equal(s.spent.hold('z'), 'held', 'rolled back with the service’s transaction')
  assert.deepEqual({ ...s.db.prepare('SELECT credits FROM balances').get() }, { credits: 2 })
  s.close()
})
