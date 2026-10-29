// A gift's ticket, as the host's seller checks it: for the host, that buy and the count the check's
// gift gives, signed by the verifier's sponsor key; the same reference gives the same ticket; anything
// but a buy's reference is refused; and what the file keeps of the buy, a hash.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'

import { buy, finish, serviceOf } from '../../host/client/client.ts'
import { keyFrom, seller } from '../../host/credits/seller.ts'

import { buyOf, ticketFor } from '../src/gift.ts'
import { INFO, seedFrom } from '../src/seed.ts'
import { seedJson } from './fakes.ts'

const sponsor = await seedFrom(seedJson().bytes).ed25519(INFO.sponsor)
const gift = { origin: 'https://host.example', credits: { face: 2, id: 3 } }
const s = seller({
  origin: gift.origin,
  key: await keyFrom(new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))),
  requestUri: '/credits/buy',
  price: '0.01',
  maxBuy: 10,
  sponsors: [sponsor.address],
  path: ':memory:',
})
const service = serviceOf(gift.origin, s.directory())

test('a ticket for the buy, of the check’s gift, which the host takes from the sponsor it lists', async () => {
  for (const [check, n] of [['face', 2], ['id', 3]] as const) {
    const b = await buy(service, n)
    const ticket = ticketFor(gift, check, b.reference, sponsor)
    assert.notEqual(ticket, 'bad_gift')
    assert.deepEqual(ticket.split('.').slice(0, 2), [sponsor.address, String(n)], 'it names the sponsor and the check’s credits')
    const answered = await s.collect(b.buy, `ticket ${ticket}`)
    assert.equal(answered.status, 200, JSON.stringify(answered.body))
    assert.equal((await finish(b.pending, answered.body as Uint8Array)).length, n)
    assert.equal(ticketFor(gift, check, b.reference, sponsor), ticket, 'the same reference, the same ticket')
  }
})

test('anything but a buy’s reference is bad_gift', () => {
  for (const reference of ['nope', 7, null, {}, '1'.repeat(31)]) {
    assert.equal(ticketFor(gift, 'face', reference, sponsor), 'bad_gift', JSON.stringify(reference))
  }
})

test('what the file keeps of the buy: a hash of its reference', () => {
  const [a, b] = ['7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA', '2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9']
  assert.deepEqual(buyOf(a), buyOf(a))
  assert.notDeepEqual(buyOf(a), buyOf(b))
  assert.equal(buyOf(a).length, 32)
})
