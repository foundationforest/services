// Tiers (README.md, "Proofs a profile shows"): a person proof on a card, checked by forest's
// verifyTier against its row, weighs the row at its issuer's weight for that tier, and the page and
// its twin say "ID-checked" for tier 2. In a fresh database of its own:
//   1. forest's example card's person proof (keys/'s test person, Alice: tier 2 from issuer A under
//      tutoring/seller), on Alice's card, against a stand-in RPC holding her row as the registry
//      program wrote it (forest's fixtures): her row counts at 0.9, and her page and twin say so;
//   2. a bent byte, another tier, an issuer the list does not name, or no RPC: no tier, and her row
//      counts at issuer A's smallest weight, 0.7;
//   3. an RPC that fails: what the index held stays, and the next poll checks the card again.
//
// Needs Postgres; the person circuit's verification key comes with forest.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node --test --test-force-exit test/tiers.test.ts

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PublicKey } from '@solana/web3.js'
import pg from 'pg'

import { mainKey } from '../../forest/keys/src/index.ts'
import { ownerRecord, recordId, unsignedOf } from '../../forest/records/src/index.ts'
import { decodeRow } from '../../forest/registry/client/src/program.ts'

import { rowRecord, storeRow } from '../src/chain/registry.ts'
import { INDEX_ROOT, type IssuerConfig, loadConfig } from '../src/config.ts'
import { createPool } from '../src/db.ts'
import { startReaders, startWeb } from '../src/main.ts'
import { HostReader, takeIn } from '../src/records/hosts.ts'
import type { Registry } from '../src/records/store.ts'
import { serveMarkets } from './markets-repo.ts'

const FOREST = join(INDEX_ROOT, '../forest')
const fixtures = JSON.parse(readFileSync(join(FOREST, 'registry/program/tests-litesvm/fixtures/proofs.json'), 'utf8'))
const example = JSON.parse(readFileSync(join(FOREST, 'records/schemas/examples/profile.json'), 'utf8'))
const seed = Buffer.from(JSON.parse(readFileSync(join(FOREST, 'keys/test/vectors.json'), 'utf8')).seed, 'hex')
const wire = fixtures.wire as { programId: string; rowAddress: string; row: string }
const ISSUER_A = fixtures.issuers.A as string
const ISSUER_B = fixtures.issuers.B as string
const HOST = 'https://host.test.forest.example'

/** The example card's person proof: Alice's, tier 2 from issuer A, under tutoring/seller. */
const PERSON = example.proofs.find((p: { circuit: string }) => p.circuit === 'person')

/** A stand-in RPC holding Alice's row, as forest's own test of the example card stands one in. `down`: it fails. */
function registry(state: { down?: boolean } = {}): Registry & { asked: number } {
  const out = {
    asked: 0,
    programId: wire.programId,
    commitment: 'confirmed' as const,
    connection: {
      getAccountInfo: async (at: PublicKey) => {
        out.asked++
        if (state.down) throw new Error('the RPC did not answer')
        return at.toBase58() === wire.rowAddress ? { data: Buffer.from(wire.row, 'hex'), owner: new PublicKey(wire.programId), lamports: 1, executable: false, rentEpoch: 0 } : null
      },
    } as never,
  }
  return out
}

test('tiers: a person proof on a card weighs its row, and tier 2 says ID-checked', { timeout: 120_000 }, async (t) => {
  if (!process.env.DATABASE_URL) return t.skip('DATABASE_URL is not set')
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await admin.connect()
  const name = `forest_index_tiers_${randomBytes(4).toString('hex')}`
  await admin.query(`create database ${name}`)
  const url = new URL(process.env.DATABASE_URL)
  url.pathname = `/${name}`

  // The market the example card lives in, `tutoring`, as a directory of its own.
  const folder = mkdtempSync(join(tmpdir(), 'forest-index-tiers-'))
  mkdirSync(join(folder, 'education'))
  const tutors = JSON.parse(readFileSync(join(INDEX_ROOT, 'test/markets/freelance-work/online-tutors.json'), 'utf8'))
  writeFileSync(join(folder, 'education/tutoring.json'), JSON.stringify({ ...tutors, name: 'tutoring', folder: 'education' }))
  writeFileSync(join(folder, 'directory.md'), '# Directory\n\n## education\n\n- [`tutoring`](education/tutoring.json): Tutoring.\n')
  const markets = await serveMarkets(folder)
  const issuers: IssuerConfig = { [ISSUER_A]: { name: 'Issuer A', weights: { '1': 0.7, '2': 0.9 } } }
  writeFileSync(join(folder, 'hosts.json'), JSON.stringify({ hosts: [] }))
  writeFileSync(join(folder, 'markets.json'), JSON.stringify({ directory: markets.url, markets: ['tutoring'] }))
  writeFileSync(join(folder, 'issuers.json'), JSON.stringify({ issuers }))
  copyFileSync(join(INDEX_ROOT, 'lists/indexes.json'), join(folder, 'indexes.json'))
  const config = loadConfig({
    DATABASE_URL: url.toString(),
    INDEX_SIGNING_SEED: '07'.repeat(32),
    HOSTS_FILE: join(folder, 'hosts.json'),
    MARKETS_FILE: join(folder, 'markets.json'),
    ISSUERS_FILE: join(folder, 'issuers.json'),
    INDEXES_FILE: join(folder, 'indexes.json'),
  })
  const db = createPool(url.toString())
  try {
    const readers = await startReaders(db, config)
    readers.scorer.stop()
    const { web } = await startWeb(db, config, { listen: false })
    const get = async (path: string) => (await web.handle(new Request(`https://forest.foundation${path}`))).text()

    // Alice: keys/'s test person, her row as the registry program wrote it.
    const alice = await mainKey(seed, 'tutoring/seller')
    await storeRow(db, rowRecord(wire.rowAddress, decodeRow(Buffer.from(wire.row, 'hex')) as never))
    let time = Date.parse('2026-10-07T00:00:00Z')
    /** Her card, carrying `proof`, stored as the reader stores it, then the scores. */
    const card = async (proof: Record<string, unknown> | null, chain: Registry | null = registry(), lists: { issuers: IssuerConfig } = { issuers }) => {
      const { proofs: _, ...rest } = example
      const record = ownerRecord(alice, 'profile', { ...rest, ...(proof && { proofs: [proof] }) }, time++)
      const refused: unknown[] = []
      await takeIn(db, HOST, [{ record, id: recordId(unsignedOf(record)) }], { ...lists, indexes: [], registry: chain }, (err) => refused.push(err))
      assert.deepEqual(refused, [])
      await readers.scorer.now()
    }
    const shown = async () => {
      const twin = JSON.parse(await get(`/profiles/${alice.address}.json`))
      const page = await get(`/profiles/${alice.address}`)
      const [row] = twin.stamps
      const [u] = twin.scores.uniqueness
      return { tier: row.tier, badge: row.badge, weight: row.issuer.weight, counted: row.counted, value: u.value, scored: u.details.issuers[0].tier, page: page.includes('ID-checked') }
    }

    await t.test('1. the example card’s person proof: tier 2, counted at 0.9, ID-checked', async () => {
      assert.equal(alice.address, fixtures.proofs.find((p: { name: string }) => p.name === 'alice-tutoring-A').profile, 'the card is the proof’s main key’s')
      await card(PERSON)
      assert.deepEqual(await shown(), { tier: '2', badge: 'ID-checked', weight: 0.9, counted: true, value: 0.9, scored: '2', page: true })
      const page = await get(`/profiles/${alice.address}`)
      assert.ok(page.includes('Verified real person, one per market · ID-checked'), 'on the Real person card')
    })

    await t.test('2. a proof that does not check, or is not this index’s to check: no tier, counted at 0.7', async () => {
      const bent = Buffer.from(PERSON.proof, 'base64url')
      bent[255] ^= 1
      const none = { tier: null, badge: null, weight: 0.7, counted: true, value: 0.7, scored: null, page: false }
      const cases: [string, Record<string, unknown> | null, ReturnType<typeof registry> | null, IssuerConfig][] = [
        ['a bent byte', { ...PERSON, proof: bent.toString('base64url') }, registry(), issuers],
        ['another tier', { ...PERSON, tier: '1' }, registry(), issuers],
        ['another issuer shown than the row’s', { ...PERSON, issuer: ISSUER_B }, registry(), { ...issuers, [ISSUER_B]: { name: 'Issuer B', weights: { '1': 0.7, '2': 0.9 } } }],
        ['no RPC', PERSON, null, issuers],
        ['no proof', null, registry(), issuers],
      ]
      for (const [what, proof, chain, listed] of cases) {
        await card(proof, chain, { issuers: listed })
        assert.deepEqual(await shown(), none, what)
      }
      // An issuer the list does not name: the card's proof is never checked, and the RPC never asked.
      const chain = registry()
      await card(PERSON, chain, { issuers: { [ISSUER_B]: { name: 'Issuer B', weights: { '1': 1 } } } })
      assert.equal(chain.asked, 0)
    })

    await t.test('3. an RPC that fails: what the index held stays, and the next poll checks the card again', async () => {
      await card(PERSON)
      const state = { down: true }
      const errors: unknown[] = []
      const reader = new HostReader({ db, hosts: [], issuers, indexes: [], registry: registry(state), onChange: () => {}, onError: (err) => errors.push(err) })
      const { proofs: _, ...rest } = example
      const record = ownerRecord(alice, 'profile', { ...rest, about: 'Changed.', proofs: [PERSON] }, time++)
      await db.query('insert into host_records (host, id, profile, path, text) values ($1, $2, $3, $4, $5)', [HOST, recordId(unsignedOf(record)), alice.address, 'profile', JSON.stringify(record)])
      await reader.merge([alice.address])
      assert.match(String(errors[0]), /the RPC did not answer/)
      await readers.scorer.now()
      const held = JSON.parse(await get(`/profiles/${alice.address}.json`))
      assert.equal(held.profile.about, example.about, 'the card it held stays')
      assert.equal(held.stamps[0].tier, '2', 'and its tier')
      state.down = false
      await reader.pollOnce()
      await readers.scorer.now()
      const now = JSON.parse(await get(`/profiles/${alice.address}.json`))
      assert.deepEqual([now.profile.about, now.stamps[0].tier, now.scores.uniqueness[0].value], ['Changed.', '2', 0.9])
    })
  } finally {
    // pg's pool resolves `end()` before its sockets have closed; dropping the database under a
    // closing connection makes it report an error nobody is listening for. Wait for them to go, as the
    // fixture does.
    await db.end()
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query('select count(*)::int as n from pg_stat_activity where datname = $1', [name])
      if (rows[0].n === 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    await markets.close()
    rmSync(folder, { recursive: true, force: true })
    await admin.query(`drop database ${name} with (force)`)
    await admin.end()
  }
})
