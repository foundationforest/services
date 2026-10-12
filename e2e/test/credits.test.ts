// The credits client (credits/client.ts), against a stand-in service made of Cloudflare's own
// Privacy Pass issuer and origin: a service read from its directory, a buy, its pay link, the
// service's answer, the credits finished from it and shown; a buy finished later from what the
// vault keeps; and every answer that must finish nothing. The services' own checks of a credit are
// tested where they live: host/ and fee-payer/registry/.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AuthorizationHeader, Token, genericBatched, publicVerif } from '@cloudflare/privacypass-ts'
import { base58, base64urlnopad as b64u } from '@scure/base'
import { CREDIT_TYPE, type Pending, authorization, buy, challengeOf, checkPending, creditList, finish, referenceOf, serviceOf } from '../credits/client.ts'

const { BLIND_RSA, BlindRSAMode, Issuer, Origin, getPublicKeyBytes } = publicVerif
const T = Date.UTC(2026, 9, 9)

/** A stand-in service: an RSA-2048 credit key, Cloudflare's issuer for it, and its directory. */
async function service(origin: string) {
  const keys = await Issuer.generateKey(BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: Uint8Array.from([1, 0, 1]) })
  const issuer = new Issuer(BlindRSAMode.PSS, new URL(origin).host, keys.privateKey, keys.publicKey)
  const key = await getPublicKeyBytes(keys.publicKey)
  const directory = {
    'issuer-request-uri': '/credits/buy',
    'token-keys': [{ 'token-type': 2, 'token-key': b64u.encode(key), 'not-before': T / 1000 - 60 }],
    'forest-credit': { unit: 'one registration', address: base58.encode(new Uint8Array(32).fill(3)), mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', price: '0.25' },
  }
  // What the service does with a paid buy: sign every request in it, blind, and answer.
  const answer = async (bytes: Uint8Array) => (await new genericBatched.Issuer(issuer).issue(genericBatched.BatchedTokenRequest.deserialize(bytes))).serialize()
  return { origin, keys, issuer, key, directory, answer, info: serviceOf(origin, directory, T) }
}
const payer = await service('https://payer.example')
const host = await service('https://host.example')

test('a service is what its Privacy Pass directory says, and its forest-credit entry', async () => {
  const s = payer.info
  assert.deepEqual(s.key, payer.key)
  assert.equal(s.requestUri, 'https://payer.example/credits/buy')
  assert.deepEqual([s.unit, s.mint, s.price], ['one registration', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '0.25'])
  const d = payer.directory
  const later = { 'token-type': 2, 'token-key': b64u.encode(host.key), 'not-before': T / 1000 + 3600 }
  assert.deepEqual(serviceOf(payer.origin, { ...d, 'token-keys': [...d['token-keys'], later] }, T).key, payer.key, 'a key counts from its not-before')
  assert.deepEqual(serviceOf(payer.origin, { ...d, 'token-keys': [...d['token-keys'], later] }, T + 7200_000).key, host.key, 'then the latest counts')
  const bad: [string, unknown][] = [
    ['no forest-credit', { ...d, 'forest-credit': undefined }],
    ['no unit', { ...d, 'forest-credit': { ...d['forest-credit'], unit: '' } }],
    ['a price of 0', { ...d, 'forest-credit': { ...d['forest-credit'], price: '0.00' } }],
    ['a price as a number', { ...d, 'forest-credit': { ...d['forest-credit'], price: 0.25 } }],
    ['an address that is none', { ...d, 'forest-credit': { ...d['forest-credit'], address: 'x' } }],
    ['no type 2 key', { ...d, 'token-keys': [{ ...d['token-keys'][0], 'token-type': 1 }] }],
    ['no request uri', { ...d, 'issuer-request-uri': undefined }],
  ]
  for (const [why, dir] of bad) assert.throws(() => serviceOf(payer.origin, dir, T), Error, why)
  assert.throws(() => serviceOf('http://payer.example', d, T), /origin/, 'https, or loopback')
  assert.equal(challengeOf(payer.origin).issuerName, 'payer.example')
  assert.equal(challengeOf(payer.origin).redemptionContext.length, 0, 'no context: bought ahead and kept')
})

test('a buy: blinded requests, the reference a payment carries, and the pay link anyone pays', async () => {
  const b = await buy(payer.info, 3)
  assert.equal(b.reference, base58.encode(createHash('sha256').update(b.buy).digest()))
  assert.equal(b.reference, await referenceOf(b.buy))
  assert.equal(
    b.payLink,
    `solana:${payer.info.address}?amount=0.75&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${b.reference}&label=payer.example`,
  )
  assert.equal([...genericBatched.BatchedTokenRequest.deserialize(b.buy)].length, 3)
  assert.equal(b.pending.blinds.length, 3)
  for (const blind of b.pending.blinds) {
    const nonce = Buffer.from(b64u.decode(blind.nonce))
    assert.equal(Buffer.from(b.buy).indexOf(nonce), -1, 'the nonce a credit will carry is nowhere in the buy')
  }
  const sol = await buy({ ...payer.info, mint: 'SOL', price: '0.001' }, 12)
  assert.match(sol.payLink, /^solana:[1-9A-HJ-NP-Za-km-z]+\?amount=0\.012&reference=/, 'SOL: no spl-token')
  await assert.rejects(buy(payer.info, 0), /one credit or more/)
  await assert.rejects(buy(payer.info, 1.5), /one credit or more/)
})

test('the credits: finished from the answer, each a Privacy Pass token Cloudflare’s origin checks', async () => {
  const b = await buy(payer.info, 2)
  const credits = await finish(b.pending, await payer.answer(b.buy))
  assert.equal(credits.length, 2)
  for (const [i, c] of credits.entries()) {
    assert.equal(c.service, payer.origin)
    const token = Token.deserialize(BLIND_RSA, b64u.decode(c.credit))
    assert.equal(token.authInput.tokenType, CREDIT_TYPE)
    assert.deepEqual(token.authInput.nonce, b64u.decode(b.pending.blinds[i]!.nonce), 'it carries the nonce the app kept')
    assert.equal(await new Origin(BlindRSAMode.PSS).verify(token, payer.keys.publicKey), true, 'a Privacy Pass token, as Cloudflare checks one')
  }
})

test('shown with a request: one Authorization header, PrivateToken, as RFC 9577 writes it', async () => {
  const b = await buy(payer.info, 1)
  const [credit] = await finish(b.pending, await payer.answer(b.buy))
  const header = authorization(credit!)
  assert.match(header, /^PrivateToken token="[A-Za-z0-9_-]+=*"$/)
  assert.deepEqual(AuthorizationHeader.parse(BLIND_RSA, header)[0]!.token.serialize(), b64u.decode(credit!.credit), 'Cloudflare reads it')
  assert.throws(() => authorization(b64u.decode(credit!.credit).subarray(0, 300)), /not a credit/, 'only a whole credit')
})

test('several shown with one request, as its body lists them: each credit’s bytes, base64url, in order', async () => {
  const b = await buy(payer.info, 4)
  const credits = await finish(b.pending, await payer.answer(b.buy))
  const list = creditList(credits)
  assert.deepEqual(list, credits.map((c) => c.credit), 'each credit as the vault keeps it')
  assert.deepEqual(JSON.parse(JSON.stringify({ credits: list })).credits, list, 'and as JSON carries it')
  assert.deepEqual(creditList(credits.map((c) => b64u.decode(c.credit))), list, 'the same from bytes')
  assert.throws(() => creditList([...list, 'AAAA']), /not a credit/)
})

test('the same buy collected twice gives the same credits; what the vault keeps finishes it later', async () => {
  const b = await buy(payer.info, 2)
  const first = await payer.answer(b.buy)
  const again = await payer.answer(b.buy)
  assert.deepEqual(again, first, 'a lost answer costs nothing: collecting again signs the same')
  const kept = JSON.parse(JSON.stringify(b.pending)) as Pending
  checkPending(kept)
  assert.deepEqual(await finish(kept, again), await finish(b.pending, first))
})

test('refused: an answer for another buy, an empty slot, a slot too few', async () => {
  const mine = await buy(payer.info, 1)
  const other = await buy(payer.info, 1)
  await assert.rejects(finish(mine.pending, await payer.answer(other.buy)), /does not hold for this buy/)
  const empty = new genericBatched.GenericBatchTokenResponse([new genericBatched.OptionalTokenResponse(null)]).serialize()
  await assert.rejects(finish(mine.pending, empty), /holds no credit/)
  const two = await buy(payer.info, 2)
  await assert.rejects(finish(two.pending, await payer.answer(mine.buy)), /1 slots for 2 credits/)
  // A buyer that swaps in a request of its own gets an answer that finishes nothing.
  const swapped = await payer.answer(other.buy)
  await assert.rejects(finish(mine.pending, swapped))
})

test('a pending buy’s shape is checked before it is finished', () => {
  const ok: Pending = { service: 'https://payer.example', key: 'AA', buy: 'AA', blinds: [{ nonce: 'AA', inverse: 'AA' }] }
  checkPending(ok)
  const bad: unknown[] = [null, { ...ok, more: 1 }, { ...ok, service: 'payer.example' }, { ...ok, blinds: [] }, { ...ok, blinds: [{ nonce: 'AA' }] }]
  for (const p of bad) assert.throws(() => checkPending(p))
})
