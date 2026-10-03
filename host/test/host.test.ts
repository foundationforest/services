// Soil's host: forest's host behind the front, with this service's policy, and the registry lookup
// for an inbox that takes messages from one issuer's rows.
//
//   npm test

import assert from 'node:assert/strict'
import { createPrivateKey, randomBytes, sign } from 'node:crypto'
import { after, before, test } from 'node:test'

import { type Connection, PublicKey } from '@solana/web3.js'

import { mainKey, readingKey } from '../../forest/keys/src/index.ts'
import { base58, deliver, hostsRecord, keyFromPrivate, ownerRecord, publish, readAll, readProfile } from '../../forest/records/src/index.ts'
import { message } from '../../forest/records/src/private.ts'
import { ROW_DISCRIMINATOR, ROW_OFFSET, rowSpace } from '../../forest/registry/client/src/program.ts'

import { DEVNET_REGISTRY, LABEL, POLICY, type RunningHost, readConfig, rowLookup, startHost } from '../src/host.ts'

const ISSUER = keyFromPrivate(new Uint8Array(32).fill(7))
const ROOT = new Uint8Array(32).fill(9)

/** Ed25519 by Node itself: PKCS #8 for a 32-byte secret is this fixed header, then the bytes. */
const signed = (message: Uint8Array, secret: Uint8Array) =>
  sign(null, message, createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret]), format: 'der', type: 'pkcs8' }))

/** A row's bytes as the registry holds them, signed over ROOT by `signer`. */
function rowData(profile: Uint8Array, signer = ISSUER, label = 'tutoring/buyer'): Buffer {
  const name = new TextEncoder().encode(label)
  const data = Buffer.alloc(rowSpace(name.length))
  data.set(ROW_DISCRIMINATOR, 0)
  data.set(profile, ROW_OFFSET.profile)
  data.set(ISSUER.publicKey, ROW_OFFSET.issuer)
  data.set(ROOT, ROW_OFFSET.root)
  data.set(signed(ROOT, signer.privateKey), ROW_OFFSET.issuerSignature)
  data.set(new Uint8Array(32).fill(3), ROW_OFFSET.payer)
  data.writeUInt32LE(name.length, ROW_OFFSET.label)
  data.set(name, ROW_OFFSET.label + 4)
  return data
}

/** An RPC holding these accounts, filtering as a real one does: each memcmp on the account's bytes. */
function rpc(accounts: Buffer[]): Pick<Connection, 'getProgramAccounts'> & { asked: string[] } {
  const asked: string[] = []
  const getProgramAccounts = async (program: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) => {
    asked.push(program.toBase58())
    const matches = (data: Buffer) =>
      config.filters.every(({ memcmp }) => {
        const want = base58.decode(memcmp.bytes)
        return Buffer.from(want).equals(data.subarray(memcmp.offset, memcmp.offset + want.length))
      })
    return accounts.filter(matches).map((data) => ({ pubkey: new PublicKey(randomBytes(32)), account: { data, owner: program, lamports: 0, executable: false } }))
  }
  return { asked, getProgramAccounts: getProgramAccounts as never }
}

let host: RunningHost
before(async () => {
  host = await startHost(readConfig({ PORT: '0' }))
})
after(async () => {
  await host?.close()
})

test('`/` says what this is; every other path is forest’s host, with this policy', async () => {
  const res = await fetch(`${host.url}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), LABEL)
  assert.equal((await fetch(`${host.url}/elsewhere`)).status, 404)
  const h = host.host
  assert.deepEqual(
    { keepDays: h.keepDays, maxBatch: h.maxBatch, maxPageRecords: h.maxPageRecords, maxPageBytes: h.maxPageBytes, maxBlobBytes: h.maxBlobBytes },
    POLICY,
  )
  assert.deepEqual(POLICY, { keepDays: 30, maxBatch: 100, maxPageRecords: 1000, maxPageBytes: 4_194_304, maxBlobBytes: 50_000_000 })
})

test('records go in and come back through the front, for the whole host and by profile', async () => {
  const now = Date.now()
  const people = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
  for (const who of people) {
    const outcomes = await publish([host.url], [
      hostsRecord(who, [host.url], now),
      ownerRecord(who, 'profile', { market: 'tutoring', role: who.label.split('/')[1]!, name: 'Test', createdAt: '2026-10-02T00:00:00Z' }, now),
    ])
    assert.ok(outcomes[0]!.results.every((r) => r.ok), JSON.stringify(outcomes))
  }
  assert.equal((await readAll(host.url)).records.length, 4, 'what is new on the whole host')
  const view = await readProfile([host.url], people[0]!.address, Date.now())
  assert.deepEqual(view.hosts, [host.url])
  assert.equal(view.current.get('profile')!.record.profile, people[0]!.address)
})

test('the lookup: a row counts only if the issuer it names signed its root', async () => {
  const [held, forged, none] = [keyFromPrivate(randomBytes(32)), keyFromPrivate(randomBytes(32)), keyFromPrivate(randomBytes(32))]
  const chain = rpc([rowData(held.publicKey), rowData(forged.publicKey, keyFromPrivate(randomBytes(32)))])
  const lookup = rowLookup(chain, DEVNET_REGISTRY)
  assert.equal(await lookup(held.address, ISSUER.address), true, 'a row the issuer signed')
  assert.equal(await lookup(forged.address, ISSUER.address), false, 'a row naming the issuer, signed by another key')
  assert.equal(await lookup(none.address, ISSUER.address), false, 'no row')
  assert.equal(await lookup(held.address, none.address), false, 'a row from another issuer')
  assert.deepEqual(new Set(chain.asked), new Set([DEVNET_REGISTRY]), 'the registry it was told to read')
})

test('an inbox open to one issuer’s rows: taken with the lookup, refused without one', async () => {
  const now = Date.now()
  const owner = await mainKey(randomBytes(32), 'tutoring/seller')
  const read = await readingKey(owner.privateKey)
  const sender = keyFromPrivate(randomBytes(32))
  const card = { market: 'tutoring', role: 'seller', name: 'Test', read: read.recipient, inbox: { senders: { issuer: ISSUER.address } }, createdAt: '2026-10-02T00:00:00Z' }
  const note = () => message(sender, owner.address, { text: 'Is Tuesday free?' }, Date.now(), read.recipient)

  const withLookup = await startHost(readConfig({ PORT: '0' }), rpc([rowData(sender.publicKey)]))
  try {
    await publish([withLookup.url], [ownerRecord(owner, 'profile', card, now)])
    const [outcome] = await deliver([withLookup.url], [await note()])
    assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok'])
  } finally {
    await withLookup.close()
  }

  await publish([host.url], [ownerRecord(owner, 'profile', card, now)])
  const [outcome] = await deliver([host.url], [await note()])
  assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['rule_unsupported'], 'no SOLANA_RPC_URL: no lookup')
})
