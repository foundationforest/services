// The welcome gift's tickets, as a service checks them with standard's seller: one for each service
// in the gift and no other, each for that service, that buy and the count the gift gives there,
// signed by the issuer's sponsor key; the same references give the same tickets; and what the file
// keeps of the buys, a hash.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'

import { buy, finish, serviceOf } from '../../credits/src/index.ts'
import { keyFrom, seller } from '../../credits/src/service.ts'

import { buysOf, ticketsFor } from '../src/gift.ts'
import { parseKeypair } from '../src/key.ts'
import { keypairJson } from './fakes.ts'

const sponsor = await parseKeypair(keypairJson().json, 'test').derive('sponsor')
const gift = { registryPayer: { origin: 'https://registry-payer.example', credits: 2 } }
const s = seller({
  origin: gift.registryPayer.origin,
  key: await keyFrom(new Uint8Array(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' }))),
  unit: 'one registration',
  requestUri: '/credits/buy',
  credit: { address: '7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA', mint: 'SOL', price: '0.01' },
  maxBuy: 10,
  sponsors: [sponsor.address],
  rpc: null,
  path: ':memory:',
})
const service = serviceOf(gift.registryPayer.origin, s.directory())

test('a ticket for each service in the gift, which that service takes from the sponsor it lists', async () => {
  const b = await buy(service, 2)
  const tickets = ticketsFor(gift, { registryPayer: b.reference }, sponsor)
  assert.notEqual(tickets, 'bad_gift')
  const { registryPayer } = tickets as Record<string, string>
  assert.equal(registryPayer!.split('.')[0], sponsor.address, 'it names the sponsor')
  const answered = await s.collect(b.buy, `ticket ${registryPayer}`)
  assert.equal(answered.status, 200, JSON.stringify(answered.body))
  assert.equal((await finish(b.pending, answered.body as Uint8Array)).length, 2)
  assert.deepEqual(ticketsFor(gift, { registryPayer: b.reference }, sponsor), tickets, 'the same reference, the same ticket')
})

test('anything but one reference for each service in the gift is bad_gift', () => {
  const reference = '7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA'
  for (const refs of [{}, { registryPayer: reference, host: reference }, { host: reference }, { registryPayer: 'nope' }, { registryPayer: 7 }]) {
    assert.equal(ticketsFor(gift, refs, sponsor), 'bad_gift', JSON.stringify(refs))
  }
})

test('what the file keeps of the buys: a hash, the same for the same references in any order', () => {
  const [a, b] = ['7DnNQWuv73SsNFLxVwWVCkiVf8kALjb49FdZTbndc7KA', '2JuNCurwpbDj4YDaMEPQprnGod5cAJFZrAdqHVQogyr9']
  assert.deepEqual(buysOf({ registryPayer: a, host: b }), buysOf({ host: b, registryPayer: a }))
  assert.notDeepEqual(buysOf({ registryPayer: a, host: b }), buysOf({ registryPayer: b, host: a }))
  assert.equal(buysOf({ registryPayer: a }).length, 32)
})
