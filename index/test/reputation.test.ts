// The reputation tree and the proofs profiles carry (README.md, "The reputation tree" and "Proofs
// a profile shows"):
//   1. a row as the index stores it: its stamp, its issuer's key and its time, read from the row;
//   then on the page tests' story (test/fixture.ts) in a fresh database:
//   2. the tree: its leaves rebuild its root with reputation's buildTree, and a proof made from them
//      checks with reputation's verifier against the root, time and signature the index serves;
//   3. a proof passes: Ana shows her rating in her market on her card, and her page and its twin
//      say so;
//   4. a proof with one byte changed shows nothing;
//   5. Ana's proof on Cleo's card shows nothing there: it lands only on the profile whose row sits at
//      its stamp, Ana's own;
//   6. a proof against a root past the window shows nothing: two roots back, it still shows; three,
//      it does not.
//
// The registry is a stand-in RPC that holds the rows at the stamps the proofs show.
//
// Needs Postgres and reputation's proving files (`npm run fetch` in standard/reputation/circuit).
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test --test-force-exit test/reputation.test.ts

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PublicKey } from '@solana/web3.js'

import { type Leaf, buildTree, proofBytes, proveReputation, verifyReputation } from '../../standard/reputation/client/src/index.ts'
import { type Body, b64u, base58, ownerRecord, recordId, unsignedOf } from '../../standard/records/src/index.ts'
import { PROGRAM_ID, ROW_DISCRIMINATOR, ROW_OFFSET, decodeRow, rowAddress, rowSpace } from '../../standard/registry/client/src/program.ts'
import { toBytes32 } from '../../standard/registry/client/src/field.ts'

import { issuerFromHex, issuerHex, rowRecord } from '../src/chain/registry.ts'
import { startWeb } from '../src/main.ts'
import { takeIn } from '../src/records/hosts.ts'
import type { Registry } from '../src/records/store.ts'
import { hex64 } from '../src/scores/reputation.ts'
import * as w from '../src/web/words.ts'
import { HOST, INDEX, INDEX_NAME, ISSUER, ISSUER_NAME, MADE_UP_DEAL, MARKET, RECORDS, SELLER, ana, cleo, makeFixture } from './fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const devnet = join(here, '../../standard/reputation/circuit/devnet')
const ARTIFACTS = { wasm: join(devnet, 'reputation.wasm'), zkey: join(devnet, 'reputation.zkey') }

/** A row's bytes as the program writes them: this profile, at this stamp, under this label, from the test issuer. */
function rowBytes(profile: string, stamp: bigint, labelText: string): Uint8Array {
  const label = new TextEncoder().encode(labelText)
  const data = new Uint8Array(rowSpace(label.length))
  const view = new DataView(data.buffer)
  data.set(ROW_DISCRIMINATOR, 0)
  data.set(new PublicKey(profile).toBytes(), ROW_OFFSET.profile)
  data.set(toBytes32(stamp), ROW_OFFSET.stamp)
  data.set(Buffer.from(ISSUER, 'hex'), ROW_OFFSET.issuer)
  data.set(new PublicKey(INDEX).toBytes(), ROW_OFFSET.payer)
  view.setBigInt64(ROW_OFFSET.made, 1_790_000_000n, true)
  view.setUint32(ROW_OFFSET.label, label.length, true)
  data.set(label, ROW_OFFSET.label + 4)
  return data
}

/** A stand-in RPC holding these rows, each at its stamp's address, as the registry program keeps them. */
function registry(rows: { profile: string; stamp: bigint; label: string }[]): Registry {
  const at = new Map(rows.map((r) => [rowAddress(r.stamp, PROGRAM_ID).toBase58(), rowBytes(r.profile, r.stamp, r.label)]))
  return {
    programId: PROGRAM_ID.toBase58(),
    commitment: 'confirmed',
    connection: {
      getAccountInfo: async (address: PublicKey) => {
        const data = at.get(address.toBase58())
        return data ? { data: Buffer.from(data), owner: new PublicKey(PROGRAM_ID.toBase58()), lamports: 1, executable: false, rentEpoch: 0 } : null
      },
    } as never,
  }
}

test('1. a row as the index stores it: its stamp, its issuer’s key and its time, read from the row itself', () => {
  const stamp = 0x1234n
  const row = rowRecord('ExampleRow'.padEnd(44, '1'), decodeRow(rowBytes(ana.address, stamp, SELLER)) as never)
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
  if (!existsSync(ARTIFACTS.wasm) || !existsSync(ARTIFACTS.zkey)) return t.skip('reputation’s proving files are not fetched: npm run fetch in standard/reputation/circuit')
  const fixture = await makeFixture(process.env.DATABASE_URL)
  try {
    const { web } = await startWeb(fixture.db, fixture.config(), { listen: false })
    const get = async (path: string) => {
      const res = await web.handle(new Request(`https://forest.foundation${path}`))
      return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
    }
    const json = async (path: string) => JSON.parse((await get(path)).text)
    const tree = await json('/v1/reputation')
    const served = await json('/v1/reputation/leaves')
    const leaves: Leaf[] = served.leaves.map((l: any) => ({ stamp: BigInt(`0x${l.stamp}`), scope: BigInt(`0x${l.scope}`), score: BigInt(l.score), count: BigInt(l.count) }))
    const proof = await proveReputation({ secret: ana.secret, labels: [SELLER], leaves, profileLabel: SELLER, show: true, artifacts: ARTIFACTS })
    const entry = {
      circuit: 'reputation',
      index: tree.index,
      root: tree.root,
      time: tree.time,
      signature: tree.signature,
      score: Number(proof.score),
      stamp: hex64(proof.stamp),
      label: SELLER,
      proof: b64u.encode(proofBytes(proof.proof)),
    }
    // Ana's row, at the stamp her proof shows.
    const rows = registry([{ profile: ana.address, stamp: proof.stamp, label: SELLER }])
    const trusted = { issuers: { [ISSUER]: { name: ISSUER_NAME, weights: { '1': 1 } } }, indexes: [INDEX], registry: rows }
    /** A person's card again, now, with these proofs; then what its twin and its page say. */
    const showProofs = async (proofs: unknown[], who = ana) => {
      const card = RECORDS.find((r) => r.profile === who.address && r.path === 'profile')!.body as Record<string, unknown>
      const record = ownerRecord(who.key, 'profile', { ...card, proofs } as Body, Date.now())
      await takeIn(fixture.db, HOST, [{ record, id: recordId(unsignedOf(record)) }], trusted)
      return { twin: await json(`/profiles/${who.address}.json`), page: (await get(`/profiles/${who.address}`)).text }
    }
    /** Cleo rates Ana again: a rating that changes Ana's leaf, and so the root. */
    const cleoRates = async (overall: string) => {
      const body = { subject: ana.address, ratings: { overall }, text: 'Rated again.', dealId: MADE_UP_DEAL, createdAt: new Date().toISOString() }
      const record = ownerRecord(cleo.key, 'review/ana', body as Body, Date.now())
      await takeIn(fixture.db, HOST, [{ record, id: recordId(unsignedOf(record)) }], trusted)
      await fixture.rescore()
    }


    await t.test('2. the tree: its leaves make its root, and a proof from them checks', async () => {
      assert.equal((await get('/v1/reputation')).type, 'application/json; charset=utf-8')
      assert.equal(tree.index, INDEX, 'signed with the index’s own key')
      assert.equal(tree.leaves, 2, 'Ana and Ben, the two profiles with a rating')
      assert.equal(served.root, tree.root, 'the leaves of the root it serves')
      assert.equal(hex64(buildTree(leaves).root), tree.root, 'reputation’s buildTree makes the same root')
      const rating = (await json(`/profiles/${ana.address}.json`)).scores.rating
      assert.equal(proof.score, BigInt(Math.round(rating.value * 10)), 'Ana’s leaf: her rating times ten, as her page rounds it')
      const checks = async (over: Partial<Parameters<typeof verifyReputation>[1]>) =>
        (await verifyReputation(
          rows.connection as never,
          {
            proof: proof.proof,
            root: BigInt(`0x${tree.root}`),
            score: proof.score,
            stamp: proof.stamp,
            profile: ana.key.publicKey,
            label: SELLER,
            index: base58.decode(tree.index),
            time: tree.time,
            signature: b64u.decode(tree.signature),
            ...over,
          },
          { programId: PROGRAM_ID },
        )) !== null
      assert.equal(await checks({}), true, 'reputation’s verifier takes the root, time and signature the index serves, and Ana’s row')
      assert.equal(await checks({ time: tree.time + 1 }), false, 'and no other time')
      assert.equal(await checks({ profile: cleo.key.publicKey }), false, 'and no other profile than the one at its stamp')
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

    await t.test('5. Ana’s proof on Cleo’s card shows nothing there', async () => {
      const { twin, page } = await showProofs([entry], cleo)
      assert.deepEqual(twin.proofs, [], 'the row at its stamp names Ana, not Cleo')
      assert.doesNotMatch(page, /Rated [^<]* in Online tutors \(per/)
      assert.equal((await json(`/profiles/${ana.address}.json`)).proofs.length, 1, 'and on Ana’s card it still shows')
    })

    await t.test('6. a proof against a root past the window shows nothing', async () => {
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
