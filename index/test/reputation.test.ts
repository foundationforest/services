// The reputation tree and the proofs profiles carry (README.md, "The reputation tree" and "Proofs
// a profile shows"):
//   1. a row's market stamp, read from the `register` that wrote it, and from nothing else;
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
import { registerIx, rowAddress } from '../../forest/registry/client/src/program.ts'

import { stampFrom } from '../src/chain/registry.ts'
import { startWeb } from '../src/main.ts'
import { takeIn } from '../src/records/hosts.ts'
import { hex64 } from '../src/scores/reputation.ts'
import * as w from '../src/web/words.ts'
import { HOST, INDEX, INDEX_NAME, ISSUER, MADE_UP_DEAL, MARKET, RECORDS, SELLER, ana, cleo, makeFixture } from './fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const devnet = join(here, '../../forest/circuits/reputation/devnet')
const ARTIFACTS = { wasm: join(devnet, 'reputation.wasm'), zkey: join(devnet, 'reputation.zkey') }
const REGISTRY = '5zTPm1bGY8ANLcJd12fPiKSTd71bvnq38LAUDT4ToeoC'

test('1. a row’s market stamp, from the register that wrote it', () => {
  const program = new PublicKey(REGISTRY)
  const stamp = 0x1234n
  const row = rowAddress(stamp, program as never).toBase58()
  const ix = registerIx({
    profile: program as never,
    label: SELLER,
    marketStamp: stamp,
    issuer: ISSUER.publicKey,
    root: 1n,
    issuerSignature: new Uint8Array(64),
    proof: { a: new Uint8Array(32), b: new Uint8Array(64), c: new Uint8Array(32) },
    payer: program as never,
    programId: program as never,
  })
  const data = new Uint8Array(ix.data)
  assert.equal(stampFrom([{ programId: REGISTRY, data }], REGISTRY, row), hex64(stamp), 'the stamp the row’s address is derived from')
  const other = rowAddress(stamp + 1n, program as never).toBase58()
  assert.equal(stampFrom([{ programId: REGISTRY, data }], REGISTRY, other), null, 'not another row’s')
  assert.equal(stampFrom([{ programId: ISSUER.address, data }], REGISTRY, row), null, 'not from another program')
  assert.equal(stampFrom([{ programId: REGISTRY, data: data.slice(0, 39) }], REGISTRY, row), null, 'not from a cut instruction')
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
    const trusted = { issuers: [ISSUER.address], indexes: [INDEX] }
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
