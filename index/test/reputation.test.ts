// The reputation tree and the proofs profiles carry (README.md, "The reputation tree" and "Proofs
// a profile shows"):
//   1. a row as the index stores it: its stamp, its issuer's key and its time, read from the row;
//   then on the page tests' story (test/fixture.ts) in a fresh database:
//   2. the tree: its leaves rebuild its root with circuits' buildTree, and a proof made from them
//      checks with circuits' verifier against the root, time and signature the index serves;
//   3. a proof passes: Ana shows her rating in her market on her card, and her page and its twin
//      say so;
//   4. a proof with one byte changed shows nothing;
//   5. a proof against a root past the window shows nothing: two roots back, it still shows; three,
//      it does not.
//
// Needs Postgres and circuits' proving files (`npm run fetch` in forest/circuits/reputation).
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test --test-force-exit test/reputation.test.ts

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PublicKey } from '@solana/web3.js'

import { type Leaf, buildTree, proofBytes, proveReputation, verifyReputation } from '../../forest/circuits/reputation/src/index.ts'
import { type Body, b64u, base58, ownerRecord, recordId, unsignedOf } from '../../forest/records/src/index.ts'
import { ROW_DISCRIMINATOR, ROW_OFFSET, decodeRow, rowSpace } from '../../forest/registry/client/src/program.ts'
import { toBytes32 } from '../../forest/registry/client/src/field.ts'

import { issuerFromHex, issuerHex, rowRecord } from '../src/chain/registry.ts'
import { startWeb } from '../src/main.ts'
import { takeIn } from '../src/records/hosts.ts'
import { hex64 } from '../src/scores/reputation.ts'
import * as w from '../src/web/words.ts'
import { HOST, INDEX, INDEX_NAME, ISSUER, ISSUER_NAME, MADE_UP_DEAL, MARKET, RECORDS, SELLER, ana, cleo, makeFixture } from './fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const devnet = join(here, '../../forest/circuits/reputation/devnet')
const ARTIFACTS = { wasm: join(devnet, 'reputation.wasm'), zkey: join(devnet, 'reputation.zkey') }
test('1. a row as the index stores it: its stamp, its issuer’s key and its time, read from the row itself', () => {
  const profile = new PublicKey(ana.address)
  const payer = new PublicKey(INDEX)
  const stamp = 0x1234n
  const label = new TextEncoder().encode(SELLER)
  const data = new Uint8Array(rowSpace(label.length))
  const view = new DataView(data.buffer)
  data.set(ROW_DISCRIMINATOR, 0)
  data.set(profile.toBytes(), ROW_OFFSET.profile)
  data.set(toBytes32(stamp), ROW_OFFSET.stamp)
  data.set(Buffer.from(ISSUER, 'hex'), ROW_OFFSET.issuer)
  data.set(payer.toBytes(), ROW_OFFSET.payer)
  view.setBigInt64(ROW_OFFSET.made, 1_790_000_000n, true)
  view.setUint32(ROW_OFFSET.label, label.length, true)
  data.set(label, ROW_OFFSET.label + 4)
  const row = rowRecord('ExampleRow'.padEnd(44, '1'), decodeRow(data) as never)
  assert.deepEqual(row, {
    address: 'ExampleRow'.padEnd(44, '1'),
    profile: ana.address,
    stamp: hex64(stamp),
    issuer: ISSUER,
    payer: INDEX,
    made: 1_790_000_000,
    label: SELLER,
    market: MARKET,
    role: 'seller',
  })
  assert.equal(issuerHex(issuerFromHex(ISSUER)), ISSUER, 'an issuer’s key, there and back')
})

test('the reputation tree and the proofs profiles carry', { timeout: 300_000 }, async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not set')
  if (!existsSync(ARTIFACTS.wasm) || !existsSync(ARTIFACTS.zkey)) return t.skip('circuits’ proving files are not fetched: npm run fetch in forest/circuits/reputation')
  const fixture = await makeFixture(process.env.DATABASE_URL)
  try {
    const { web } = await startWeb(fixture.db, fixture.config(), { listen: false })
    const get = async (path: string) => {
      const res = await web.handle(new Request(`https://forest.foundation${path}`))
      return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
    }
    const json = async (path: string) => JSON.parse((await get(path)).text)
    const trusted = { issuers: { [ISSUER]: { name: ISSUER_NAME, weight: 1 } }, indexes: [INDEX] }
    /** Ana's card again, now, with these proofs; then what her twin and her page say. */
    const anaCard = RECORDS.find((r) => r.profile === ana.address && r.path === 'profile')!.body as Record<string, unknown>
    const showProofs = async (proofs: unknown[]) => {
      const record = ownerRecord(ana.key, 'profile', { ...anaCard, proofs } as Body, Date.now())
      await takeIn(fixture.db, HOST, [{ record, id: recordId(unsignedOf(record)) }], trusted)
      return { twin: await json(`/profiles/${ana.address}.json`), page: (await get(`/profiles/${ana.address}`)).text }
    }
    /** Cleo rates Ana again: a rating that changes Ana's leaf, and so the root. */
    const cleoRates = async (overall: string) => {
      const body = { subject: ana.address, ratings: { overall }, text: 'Rated again.', dealId: MADE_UP_DEAL, createdAt: new Date().toISOString() }
      const record = ownerRecord(cleo.key, 'review/ana', body as Body, Date.now())
      await takeIn(fixture.db, HOST, [{ record, id: recordId(unsignedOf(record)) }], trusted)
      await fixture.rescore()
    }

    const tree = await json('/v1/reputation')
    const served = await json('/v1/reputation/leaves')
    const leaves: Leaf[] = served.leaves.map((l: any) => ({ stamp: BigInt(`0x${l.stamp}`), scope: BigInt(`0x${l.scope}`), score: BigInt(l.score), count: BigInt(l.count) }))
    const proof = await proveReputation({ secret: ana.secret, labels: [SELLER], leaves, profile: ana.key.publicKey, show: true, artifacts: ARTIFACTS })
    const entry = {
      circuit: 'reputation',
      index: tree.index,
      root: tree.root,
      time: tree.time,
      signature: tree.signature,
      score: Number(proof.score),
      label: SELLER,
      proof: b64u.encode(proofBytes(proof.proof)),
    }

    await t.test('2. the tree: its leaves make its root, and a proof from them checks', async () => {
      assert.equal((await get('/v1/reputation')).type, 'application/json; charset=utf-8')
      assert.equal(tree.index, INDEX, 'signed with the index’s own key')
      assert.equal(tree.leaves, 2, 'Ana and Ben, the two profiles with a rating')
      assert.equal(served.root, tree.root, 'the leaves of the root it serves')
      assert.equal(hex64(buildTree(leaves).root), tree.root, 'circuits’ buildTree makes the same root')
      const rating = (await json(`/profiles/${ana.address}.json`)).scores.rating
      assert.equal(proof.score, BigInt(Math.round(rating.value * 10)), 'Ana’s leaf: her rating times ten, as her page rounds it')
      const checks = (over: Partial<Parameters<typeof verifyReputation>[0]>) =>
        verifyReputation({
          proof: proof.proof,
          root: BigInt(`0x${tree.root}`),
          score: proof.score,
          profile: ana.key.publicKey,
          label: SELLER,
          index: base58.decode(tree.index),
          time: tree.time,
          signature: b64u.decode(tree.signature),
          ...over,
        })
      assert.equal(await checks({}), true, 'circuits’ verifier takes the root, time and signature the index serves')
      assert.equal(await checks({ time: tree.time + 1 }), false, 'and no other time')
      const missing = await get('/v1/reputation/nothing')
      assert.equal(missing.status, 404, 'no URL per stamp')
    })

    await t.test('3. a proof passes: her page and its twin show it', async () => {
      const { twin, page } = await showProofs([entry])
      assert.deepEqual(twin.proofs, [
        {
          circuit: 'reputation',
          score: Number(proof.score) / 10,
          label: SELLER,
          market: MARKET,
          index: { address: INDEX, name: INDEX_NAME },
          root: tree.root,
          time: new Date(tree.time).toISOString(),
        },
      ])
      const line = w.proven(twin.proofs[0])
      assert.match(line, /^Rated \d+\.\d of 10 in Online tutors \(per Forest index \(test key\), \d+ \w+ \d{4}\)$/)
      assert.ok(page.includes(`<p>${line}</p>`), `the page says ${line}`)
    })

    await t.test('4. a proof with one byte changed shows nothing', async () => {
      const bytes = b64u.decode(entry.proof)
      bytes[100]! ^= 1
      const { twin, page } = await showProofs([{ ...entry, proof: b64u.encode(bytes) }])
      assert.deepEqual(twin.proofs, [])
      assert.doesNotMatch(page, /Rated [^<]* in Online tutors \(per/)
      assert.equal((await showProofs([entry])).twin.proofs.length, 1, 'the proof as made shows again')
    })

    await t.test('5. a proof against a root past the window shows nothing', async () => {
      await cleoRates('5')
      const second = await json('/v1/reputation')
      assert.notEqual(second.root, tree.root, 'Ana’s rating moved, and with it the root')
      assert.equal((await json(`/profiles/${ana.address}.json`)).proofs.length, 1, 'one root back: still shown')
      await cleoRates('3')
      assert.notEqual((await json('/v1/reputation')).root, second.root)
      const twin = await json(`/profiles/${ana.address}.json`)
      assert.deepEqual(twin.proofs, [], 'two roots back, past the window of two: nothing')
      assert.doesNotMatch((await get(`/profiles/${ana.address}`)).text, /Rated [^<]* in Online tutors \(per/)
    })
  } finally {
    await fixture.drop()
  }
})
