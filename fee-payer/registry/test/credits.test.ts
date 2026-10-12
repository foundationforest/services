// The registry payer's credits (credits/): its key from PKCS #8, its seller's directory as mcp's
// client reads it, a buy answered with Node's own RSA, byte for byte privacypass-ts's answer, and
// finished by the client and taken by the payer; nothing logged. Then each way a buy is paid: a
// Solana payment checked in one call, and a sponsor's ticket as the issuer signs it
// (issuer/src/ticket.ts); every refusal; a proof that pays one buy only, the same answer again, and
// the bill counted once. The check a registration makes: one credit in the Authorization header,
// and every credit that must not hold. And the spent list's hold, land and free, kept across a
// restart.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad as b64u } from '@scure/base'

import { type Credit, authorization, buy, finish, serviceOf } from '../../../e2e/credits/client.ts'
import { ticket, ticketMessage } from '../../../issuer/src/ticket.ts'
import { challengeOf, checkCredit, creditId, creditOf } from '../credits/credit.ts'
import { type Rpc, type SellerConfig, UNIT, answer, keyFrom, seller } from '../credits/seller.ts'

const ORIGIN = 'https://registry-payer.example'
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ADDRESS = base58.encode(new Uint8Array(32).fill(3))
const pkcs8 = (bits: number) => new Uint8Array(generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs8', format: 'der' }))

const der = pkcs8(2048)
const key = await keyFrom(der)
const config: SellerConfig = { origin: ORIGIN, key, requestUri: '/credits/buy', credit: { address: ADDRESS, mint: MINT, price: '0.5' }, maxBuy: 10, sponsors: [], rpc: null, path: ':memory:' }
const service = serviceOf(ORIGIN, seller(config).directory())

/** privacypass-ts's own issuer, from the payer's private key. */
async function cloudflareIssuer() {
  const algorithm = { name: 'RSA-PSS', hash: 'SHA-384' }
  const privateKey = await crypto.subtle.importKey('pkcs8', der as Uint8Array<ArrayBuffer>, algorithm, true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, algorithm, true, ['verify'])
  return new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, 'registry-payer.example', privateKey, publicKey)
}

/** A sponsor: an Ed25519 key, its address, and the ticket it signs for a buy, as the issuer signs one. */
function sponsor() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const address = base58.encode(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)))
  const signs = (origin: string, reference: string, credits: number) => ticket(address, credits, new Uint8Array(sign(null, ticketMessage(origin, reference, credits), privateKey)))
  return { address, signs }
}

test('its key, from PKCS #8, and its directory, as the client reads it', async () => {
  assert.deepEqual(service.key, key.published)
  assert.deepEqual([service.requestUri, service.unit, service.address, service.mint, service.price], [`${ORIGIN}/credits/buy`, UNIT, ADDRESS, MINT, '0.5'])
  await assert.rejects(keyFrom(pkcs8(1024)), /RSA-2048/)
  await assert.rejects(keyFrom(new Uint8Array(32)))
  assert.throws(() => seller({ ...config, sponsors: ['not-an-address'] }), /sponsor/)
})

test('a buy answered with Node’s RSA: byte for byte privacypass-ts’s answer; the client finishes it and the payer takes each credit', async () => {
  const b = await buy(service, 3)
  const answered = await answer(b.buy, key)
  assert.deepEqual(await answer(b.buy, key), answered, 'the same buy gets the same answer')
  // privacypass-ts's own issuer, from the same private key, answers the same bytes: RSA signing is deterministic.
  const theirs = await new genericBatched.Issuer(await cloudflareIssuer()).issue(genericBatched.BatchedTokenRequest.deserialize(b.buy))
  assert.deepEqual(answered, theirs.serialize())
  const credits = await finish(b.pending, answered)
  assert.equal(credits.length, 3)
  for (const [i, c] of credits.entries()) {
    const id = await checkCredit(c.credit, { origin: ORIGIN, keys: [key.published] })
    assert.equal(id, creditId(c.credit))
    assert.equal(id, Buffer.from(b64u.decode(b.pending.blinds[i]!.nonce)).toString('hex'), 'its id is its nonce')
  }
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

test('the spent list: hold, land and free, kept across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-registry-payer-credits-'))
  try {
    const path = join(dir, 'credits.sqlite')
    let s = seller({ ...config, path })
    let list = s.spent
    assert.equal(list.hold('a', 'row-a', 1), 'held')
    assert.equal(list.hold('a'), 'busy', 'held by another request in flight')
    assert.equal(list.hold('b', 'row-b', 2), 'held')
    list.land('a')
    assert.equal(list.hold('a'), 'spent')
    list.free('a')
    assert.equal(list.hold('a'), 'spent', 'a spent credit stays spent')
    list.free('b')
    assert.equal(list.hold('b', 'row-b2', 3), 'held', 'a freed credit can be shown again')
    s.close()
    s = seller({ ...config, path })
    list = s.spent
    assert.deepEqual(list.holds(), [{ id: 'b', note: 'row-b2', at: 3 }], 'what is held, after a restart')
    assert.equal(list.hold('a'), 'spent')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** `n` credits from a seller, bought with mcp's client and answered as a paid buy is. */
async function creditsFrom(origin: string, k: typeof key, n: number): Promise<Credit[]> {
  const b = await buy(serviceOf(origin, seller({ ...config, origin, key: k }).directory()), n)
  return finish(b.pending, await answer(b.buy, k))
}

test('one credit shown with a registration, in the Authorization header, as RFC 9577 writes it', async () => {
  const [credit] = await creditsFrom(ORIGIN, key, 1)
  const header = authorization(credit!)
  assert.deepEqual(creditOf(header), b64u.decode(credit!.credit))
  assert.throws(() => creditOf(`${header}, ${header}`), /one credit/)
  assert.throws(() => creditOf('Bearer x'))
})

test('a token Cloudflare’s own client made for the same challenge is a credit too', async () => {
  const client = new publicVerif.Client(publicVerif.BlindRSAMode.PSS)
  const request = await client.createTokenRequest(challengeOf(ORIGIN), key.published)
  const token = await client.finalize(await (await cloudflareIssuer()).issue(request))
  assert.ok(await checkCredit(token.serialize(), { origin: ORIGIN, keys: [key.published] }))
})

test('refused by the payer: another service’s credit, a key it does not count, a changed byte, not a credit', async () => {
  const [credit] = await creditsFrom(ORIGIN, key, 1)
  const bytes = b64u.decode(credit!.credit)
  const other = await keyFrom(pkcs8(2048))
  await assert.rejects(checkCredit(bytes, { origin: 'https://host.example', keys: [key.published] }), /not this service's credit/)
  await assert.rejects(checkCredit(bytes, { origin: ORIGIN, keys: [other.published] }), /not under a key/)
  for (const at of [2, 40, 100, bytes.length - 1]) {
    const changed = bytes.slice()
    changed[at]! ^= 1
    await assert.rejects(checkCredit(changed, { origin: ORIGIN, keys: [key.published] }), Error, `byte ${at}`)
  }
  await assert.rejects(checkCredit(new Uint8Array(354), { origin: ORIGIN, keys: [key.published] }))
  // A short view into a good credit's buffer: privacypass-ts alone would read the whole buffer.
  await assert.rejects(checkCredit(bytes.subarray(0, 300), { origin: ORIGIN, keys: [key.published] }), /not a credit/)
  await assert.rejects(checkCredit(new Uint8Array([...bytes, 0]), { origin: ORIGIN, keys: [key.published] }), /not a credit/)
  // And a good credit inside a larger buffer, as a Node Buffer from the pool often is, still holds.
  const inside = new Uint8Array(1000)
  inside.set(bytes, 123)
  assert.equal(await checkCredit(inside.subarray(123, 123 + bytes.length), { origin: ORIGIN, keys: [key.published] }), creditId(bytes))
})
