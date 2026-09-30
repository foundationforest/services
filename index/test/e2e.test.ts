// The index end to end, on real pieces: two of forest's reference hosts (forest/records), a local
// validator running the registry and both escrow versions (forest/registry, forest/escrow), the
// issuer's own list and signed roots file (issuer/src/list.ts) for two issuers, and a local
// Postgres. Nothing is mocked but one host that serves a forged entry, which no real host would take.
//
// The story:
//   Ana tutors; Ben is her student; Cleo is a stranger; Dara teaches English on a second host.
//   1. Ana, Ben and Cleo write their folders, cards and offers on host A, which the index follows in
//      full, and Dara on host B. Nobody holds a badge yet, so the index keeps none of it.
//   2. Each gets a line in the registry. Ana's is proven against the foundation's list, Ben's against
//      a second trusted issuer's, Cleo's and Dara's against lists no trusted issuer publishes. The
//      index reads each issuer's signed roots. Ana and Ben now hold a trusted line: what was dropped
//      is read again by profile, from host A and from host B, which Ana's folder names. Cleo and
//      Dara stay out, though host B counts Dara as badged: its word is a hint. A fresh chain reader
//      finds every line again from the registry's accounts alone.
//   3. Memberships: Ben proves he is on the foundation's list too; Dara does, and so comes to hold a
//      trusted line, and everything of hers is read in by profile; Cleo copies Ben's record, and it
//      does not check for her.
//   4. A paid deal on escrow v2: Ana invoices Ben; Ben objects, then pays and releases it to her in
//      one transaction. A deal on escrow v1: Dara pays Ana in one tap.
//   5. Reviews both ways on the v2 deal; Cleo's review, with no badge behind it, is not kept.
//   6. A forged entry, claiming to be Ana's, is refused; a genuine one of Ana's on the same host is
//      kept, and Mallory's, with no badge, is not.
//   7. The scores, and 8. every page and its twin.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
//
// The market directory comes from a stand-in for the markets repo served locally (test/markets/).
//
// Needs: DATABASE_URL (a Postgres the test may create and drop a database in); the three programs
// built (`cargo build-sbf --arch v3` in forest/registry/program, forest/escrow/program and
// forest/escrow/v2/program); the proving files (`npm run fetch` in forest/registry/artifacts);
// `npm ci` in issuer/ and in forest/records, forest/registry/client, forest/escrow/client and
// forest/escrow/v2/client (`../forest.sh`); and `solana-test-validator` on the PATH. If any is
// missing the test says which and skips.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ed25519 } from '@noble/curves/ed25519.js'
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import pg from 'pg'

import { b64u } from '../../forest/records/src/bytes.ts'
import { publish } from '../../forest/records/src/client.ts'
import { type Body, type Entry, encodeEntry, signingInput } from '../../forest/records/src/entry.ts'
import { Host } from '../../forest/records/src/host.ts'
import { type ProfileKey, addressFromDid, profileKey, seedFromPrf } from '../../forest/records/src/keys.ts'
import { folderEntry, ownerEntry } from '../../forest/records/src/write.ts'
import { PROGRAM_ID as REGISTRY_ID, buildRegistration, commitmentOf, fetchLines, makeMembership } from '../../forest/registry/client/src/index.ts'
import { PROGRAM_ID as ESCROW_ID, payInOneTap, termsFor } from '../../forest/escrow/client/src/index.ts'
import * as v2 from '../../forest/escrow/v2/client/src/index.ts'

import { ChainReader } from '../src/chain/poll.ts'
import { INDEX_ROOT, loadConfig } from '../src/config.ts'
import { startIndex } from '../src/main.ts'
import { verify } from '../src/scores/sign.ts'
import { serveMarkets } from './markets-repo.ts'

const FOREST = join(INDEX_ROOT, '../forest')
const ISSUER = join(INDEX_ROOT, '../issuer')
const REGISTRY_SO = join(FOREST, 'registry/program/target/deploy/forest_registry.so')
const ESCROW_SO = join(FOREST, 'escrow/program/target/deploy/forest_escrow.so')
const ESCROW_V2_SO = join(FOREST, 'escrow/v2/program/target/deploy/forest_escrow_v2.so')
const ARTIFACTS = { wasm: join(FOREST, 'registry/artifacts/semaphore-32.wasm'), zkey: join(FOREST, 'registry/artifacts/semaphore-32.zkey') }
const RPC_PORT = 18899
const RPC = `http://127.0.0.1:${RPC_PORT}`
/** A classic mint at USDC's address, which the index's default config counts. */
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const MARKET = 'online-tutors'
/** Badges count only as `market/role`: Ana and Cleo sell, Ben buys, Dara is a peer. */
const SELLER = `${MARKET}/seller`
const BUYER = `${MARKET}/buyer`
const PEER = 'language-exchange/peer'
const SIGNING_SEED = '09'.repeat(32)

function missing(): string | null {
  if (!process.env.DATABASE_URL) return 'DATABASE_URL is not set'
  if (!existsSync(REGISTRY_SO)) return 'the registry is not built; run `cargo build-sbf --arch v3` in forest/registry/program'
  if (!existsSync(ESCROW_SO)) return 'escrow v1 is not built; run `cargo build-sbf --arch v3` in forest/escrow/program'
  if (!existsSync(ESCROW_V2_SO)) return 'escrow v2 is not built; run `cargo build-sbf --arch v3` in forest/escrow/v2/program'
  if (!existsSync(ARTIFACTS.zkey)) return 'no proving files; run `npm run fetch` in forest/registry/artifacts'
  if (!existsSync(join(ISSUER, 'node_modules'))) return 'the issuer is not installed; run `npm ci` in issuer/'
  if (spawnSync('solana-test-validator', ['--version']).status !== 0) return 'solana-test-validator is not on the PATH'
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => Promise<boolean> | boolean, ms: number, what: string | (() => string | Promise<string>)) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : await what()}`)
    await sleep(200)
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** A plain HTTP server answering each path with a text a function gives, else 404. */
async function serveTexts(texts: (path: string, query: URLSearchParams) => { text: string; headers?: Record<string, string> } | null): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const out = texts(url.pathname, url.searchParams)
    if (!out) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json', ...out.headers }).end(out.text)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

/** A classic SPL Token mint at USDC's address, six decimals, whose mint authority is `authority`. */
function usdcAccountJson(authority: PublicKey): string {
  const data = Buffer.alloc(MINT_SIZE)
  data.writeUInt32LE(1, 0)
  authority.toBuffer().copy(data, 4)
  data.writeBigUInt64LE(0n, 36)
  data[44] = 6
  data[45] = 1
  return JSON.stringify({
    pubkey: USDC.toBase58(),
    account: { lamports: 1_461_600, data: [data.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: MINT_SIZE },
  })
}

/** The keys of an object, exactly. */
function hasKeys(obj: unknown, keys: string[], what: string) {
  assert.ok(obj && typeof obj === 'object', `${what} is an object`)
  assert.deepEqual(Object.keys(obj as object).sort(), [...keys].sort(), `${what}'s fields`)
}

test('the index, end to end', { timeout: 600_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)

  // The issuer's own list and roots file load only once we know the issuer is installed.
  const { IssuerList } = await import(join(ISSUER, 'src/list.ts'))
  const { Store } = await import(join(ISSUER, 'src/store.ts'))
  const { parseKeypair } = await import(join(ISSUER, 'src/key.ts'))

  const cleanups: (() => Promise<void> | void)[] = []
  try {
    // --- Postgres: a database of its own, dropped at the end ---------------------------------
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await admin.connect()
    const dbName = `forest_index_e2e_${randomBytes(4).toString('hex')}`
    await admin.query(`create database ${dbName}`)
    cleanups.push(async () => {
      // pg's pool resolves `end()` before its sockets have closed: wait for them, then drop.
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query('select count(*)::int as n from pg_stat_activity where datname = $1', [dbName])
        if (rows[0].n === 0) break
        await sleep(50)
      }
      await admin.query(`drop database if exists ${dbName} with (force)`)
      await admin.end()
    })
    const dbUrl = new URL(process.env.DATABASE_URL!)
    dbUrl.pathname = `/${dbName}`

    // --- The chain: a local validator with the three programs and a USDC-shaped mint ----------
    const payer = Keypair.generate()
    const ledger = mkdtempSync(join(tmpdir(), 'forest-index-ledger-'))
    const scratch = mkdtempSync(join(tmpdir(), 'forest-index-scratch-'))
    writeFileSync(join(scratch, 'usdc.json'), usdcAccountJson(payer.publicKey))
    const validator: ChildProcess = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(RPC_PORT), '--faucet-port', '19900',
        '--bpf-program', REGISTRY_ID.toBase58(), REGISTRY_SO,
        '--bpf-program', ESCROW_ID.toBase58(), ESCROW_SO,
        '--bpf-program', v2.PROGRAM_ID.toBase58(), ESCROW_V2_SO,
        '--account', USDC.toBase58(), join(scratch, 'usdc.json'),
      ],
      { stdio: 'ignore' },
    )
    cleanups.push(() => {
      validator.kill('SIGKILL')
      rmSync(ledger, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    })
    const connection = new Connection(RPC, 'confirmed')
    await waitFor(async () => connection.getVersion().then(() => true, () => false), 120_000, 'the validator')

    const confirm = async (signature: string) => {
      for (let i = 0; i < 120; i++) {
        const status = (await connection.getSignatureStatuses([signature])).value[0]
        if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature
        await sleep(250)
      }
      throw new Error(`${signature} never confirmed`)
    }
    const send = async (instructions: TransactionInstruction[], signers: Keypair[]) => {
      const tx = new Transaction().add(...instructions)
      tx.feePayer = signers[0].publicKey
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
      tx.sign(...signers)
      return confirm(await connection.sendRawTransaction(tx.serialize()))
    }
    await confirm(await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL))

    // --- People: each profile's key from a stand-in for a passkey's secret; each person's identity
    // secret, which only their commitment ever leaves ----------------------------------------------
    const person = (fill: number, n = 0) => {
      const key = profileKey(seedFromPrf(new Uint8Array(32).fill(fill)), n)
      return { key, did: key.did, wallet: Keypair.fromSecretKey(Uint8Array.from([...key.secretKey, ...key.publicKey])), secret: new Uint8Array(randomBytes(32)) }
    }
    const ana = person(11)
    const ben = person(12)
    const cleo = person(13)
    const dara = person(14)
    const mallory = person(15)

    // --- Two issuers: each its own list and signed roots file, as the issuer service keeps them ----
    const issuer = (name: string) => {
      const secret = randomBytes(32)
      const publicKey = ed25519.getPublicKey(secret)
      const key = parseKeypair(JSON.stringify([...secret, ...publicKey]), name)
      const list = new IssuerList(new Store(join(scratch, `${name}.sqlite`)), key)
      return { key, list, commitments: [] as bigint[] }
    }
    const foundation = issuer('foundation')
    const second = issuer('second')
    const others = (n: number) => Array.from({ length: n }, () => commitmentOf(randomBytes(32)))
    const add = (i: ReturnType<typeof issuer>, commitments: bigint[]) => {
      i.list.append(commitments, [], Date.now())
      i.commitments.push(...commitments)
    }
    add(foundation, [...others(2), commitmentOf(ana.secret), commitmentOf(ben.secret), commitmentOf(dara.secret)])
    add(second, [commitmentOf(ben.secret), ...others(1)])
    const roots = await serveTexts((path) =>
      path === '/foundation/roots.json' ? { text: foundation.list.rootsFile() } : path === '/second/roots.json' ? { text: second.list.rootsFile() } : null,
    )
    cleanups.push(() => new Promise<void>((resolve) => roots.server.close(() => resolve())))
    const issuersFile = join(scratch, 'issuers.json')
    writeFileSync(
      issuersFile,
      JSON.stringify({
        issuers: {
          [foundation.key.did]: { name: 'Forest Foundation', weight: 1, roots: `${roots.url}/foundation/roots.json` },
          [second.key.did]: { name: 'Second issuer', weight: 0.5, roots: `${roots.url}/second/roots.json` },
        },
      }),
    )

    // --- Hosts: A, which the index follows in full; B, which it finds in Ana's folder ------------
    // Each asks the registry whether a profile holds a line, as a host's `badged` filter does.
    const isBadged = async (did: string) =>
      (await fetchLines(connection as never, { profile: new PublicKey(addressFromDid(did)) as never, commitment: 'confirmed' })).length > 0
    const startHost = async () => {
      const port = await freePort()
      const host = new Host({ url: `http://127.0.0.1:${port}`, isBadged })
      await host.listen(port)
      cleanups.push(() => host.close())
      return host
    }
    const hostA = await startHost()
    const hostB = await startHost()

    // A host that serves one forged entry, claiming to be Ana's and signed with Mallory's key, and
    // Mallory's own folder and card, genuine. No real host takes the forged one.
    const T0 = Date.now()
    const forgedUnsigned = { v: 1, profile: ana.did, path: 'review/forged', time: T0, body: { subject: mallory.did, ratings: { overall: '10' }, createdAt: new Date(T0).toISOString() } }
    const forged = { ...forgedUnsigned, sig: b64u.encode(ed25519.sign(signingInput(forgedUnsigned as never), mallory.key.secretKey)) } as Entry
    const fakePort = await freePort()
    const fakeUrl = `http://127.0.0.1:${fakePort}`
    const fakeLines = [
      encodeEntry(forged),
      encodeEntry(folderEntry(mallory.key, { hosts: [fakeUrl] }, T0)),
      encodeEntry(ownerEntry(mallory.key, 'profile', { name: 'Mallory', market: MARKET, role: 'seller', createdAt: new Date(T0).toISOString() }, T0)),
      // And one of Ana's, genuine: a note, a kind no index reads.
      encodeEntry(ownerEntry(ana.key, 'note/hello', { text: 'hello' }, T0)),
    ]
    const fake = createServer((req, res) => {
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      const after = Number(query.get('after') ?? 0)
      const profile = query.get('profile')
      const lines = fakeLines.slice(after).filter((l) => !profile || (JSON.parse(l) as Entry).profile === profile)
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'forest-cursor': String(Math.max(after, fakeLines.length)) }).end(lines.map((l) => `${l}\n`).join(''))
    })
    await new Promise<void>((resolve) => fake.listen(fakePort, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => fake.close(() => resolve())))

    // --- The index, reading everything from the start ------------------------------------------
    const markets = await serveMarkets()
    cleanups.push(() => markets.close())
    const config = loadConfig({
      DATABASE_URL: dbUrl.toString(),
      MARKETS_URL: markets.url,
      HOSTS: `${hostA.url},${fakeUrl}`,
      SOLANA_RPC_URL: RPC,
      CHAIN_COMMITMENT: 'confirmed',
      POLL_MS: '300',
      ISSUERS_FILE: issuersFile,
      INDEX_SIGNING_SEED: SIGNING_SEED,
      PORT: '0',
    })
    const indexErrors: unknown[] = []
    const index = await startIndex(config, { onError: (err) => indexErrors.push(err) })
    cleanups.push(() => index.stop())
    const base = `http://127.0.0.1:${(index.server!.address() as AddressInfo).port}`
    const get = async (path: string) => {
      const res = await fetch(base + path, { redirect: 'manual' })
      return { status: res.status, headers: res.headers, body: res.status === 301 ? null : await res.json() }
    }
    const count = async (sql: string, params: unknown[] = []) => Number((await index.db.query(sql, params)).rows[0].n)

    // An app writes to every host its profile's folder names, and to nothing else.
    let clock = T0
    const write = async (p: { key: ProfileKey }, hosts: string[], items: [string, Record<string, unknown> | null][], folder = false) => {
      const entries = [...(folder ? [folderEntry(p.key, { hosts }, ++clock)] : []), ...items.map(([path, body]) => ownerEntry(p.key, path, body as Body | null, ++clock))]
      for (const outcome of await publish(hosts, entries)) {
        assert.ok(outcome.results.every((r) => r.ok), `${outcome.host} took ${JSON.stringify(outcome.results)}`)
      }
    }
    const now = () => new Date().toISOString()
    const card = (name: string, scope: string) => ({ name, market: scope.split('/')[0], role: scope.split('/')[1], createdAt: now() })
    // An offer names no market or side: they are its author profile's.
    const offer = (description: string, terms?: unknown) => ({
      direction: 'offer',
      description,
      price: { amount: '25', mint: USDC.toBase58(), per: 'hour' },
      ...(terms ? { terms } : {}),
      remote: true,
      createdAt: now(),
    })
    const review = (subject: string, overall: string, dealId: string, text: string) => ({ subject, ratings: { overall }, text, dealId, createdAt: now() })
    const anaHosts = [hostA.url, hostB.url]

    await t.test('1. folders, cards and offers on hosts A and B, before anyone holds a badge: nothing kept', async () => {
      await write(ana, anaHosts, [
        ['profile', card('Ana', SELLER)],
        ['offer/portuguese', offer('Portuguese conversation for adults, A1 to B2.')],
        ['offer/spanish', offer('Spanish grammar, one hour, homework optional.', { timer: { days: 7, to: 'seller' } })],
      ], true)
      await write(ben, [hostA.url], [['profile', card('Ben', BUYER)]], true)
      await write(cleo, [hostA.url], [['profile', card('Cleo', SELLER)]], true)
      const { price: _, ...exchange } = offer('English for Portuguese, an hour each way.')
      await write(dara, [hostB.url], [['profile', card('Dara', PEER)], ['offer/exchange', exchange]], true)
      // Host A read to its end: its cursor is past every entry, and nothing of it was kept.
      await waitFor(
        async () => Number((await index.db.query('select value from cursors where source = $1', [`host:${hostA.url}`])).rows[0]?.value ?? 0) >= hostA.read({}).cursor,
        30_000,
        'host A read to its end',
      )
      assert.equal(await count('select count(*) n from host_entries'), 0, 'no badge, nothing kept')
      assert.equal(await count('select count(*) n from profiles'), 0)
      assert.equal(index.records!.following().some((f) => f.host === hostB.url), false, 'no kept folder names host B yet')
    })

    let lineOf: Map<string, { line: PublicKey; code: bigint }>
    const register = async (p: typeof ana, label: string, commitments: bigint[]) => {
      const reg = await buildRegistration({
        secret: p.secret,
        label,
        profile: p.key.publicKey,
        commitments,
        artifacts: ARTIFACTS,
        payer: payer.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
      })
      reg.transaction.sign([payer])
      await confirm(await connection.sendRawTransaction(reg.transaction.serialize()))
      lineOf.set(p.did, { line: new PublicKey(reg.line.toBase58()), code: reg.code })
    }

    await t.test('2. lines and the issuers’ roots; the trusted profiles read in by profile; every line again from the accounts alone', async () => {
      lineOf = new Map()
      await register(ana, SELLER, foundation.commitments)
      await register(ben, BUYER, second.commitments)
      await register(cleo, SELLER, [commitmentOf(cleo.secret), ...others(1)])
      await register(dara, PEER, [commitmentOf(dara.secret), ...others(1)])
      await waitFor(async () => (await count('select count(*) n from lines')) === 4, 60_000, 'four lines')
      await index.roots.readOnce()
      assert.equal(await count('select count(*) n from issuer_roots'), 2, "each issuer's one root")
      const { rows } = await index.db.query(`select l.did, l.label, l.wallet, r.issuer from lines l left join issuer_roots r on r.root = l.root`)
      assert.deepEqual(
        rows.map((r) => [r.did, r.label, r.issuer]).sort(),
        [
          [ana.did, SELLER, foundation.key.did],
          [ben.did, BUYER, second.key.did],
          [cleo.did, SELLER, null],
          [dara.did, PEER, null],
        ].sort(),
        'who vouched: the issuer whose roots hold the line’s root; nobody publishes Cleo’s or Dara’s',
      )
      for (const r of rows) assert.equal(r.wallet, addressFromDid(r.did), "a line names the profile's own key")

      // Ana and Ben hold trusted lines: what was dropped is read again, by profile. Ana's folder names
      // host B, which is then followed, badged profiles only, and read for her too.
      await waitFor(
        async () => (await count('select count(*) n from profiles where did = any($1)', [[ana.did, ben.did]])) === 2 && (await count('select count(*) n from posts')) === 2,
        30_000,
        'Ana and Ben, and her two offers',
      )
      assert.deepEqual(index.records!.following().find((f) => f.host === hostB.url), { host: hostB.url, badged: true }, 'host B, named in a kept folder, badged profiles only')
      await waitFor(async () => (await count('select count(*) n from host_entries where host = $1 and profile = $2', [hostB.url, ana.did])) === 4, 30_000, "Ana's entries on host B, read by profile")
      const { rows: posts } = await index.db.query('select pr.market, pr.role from posts p join profiles pr on pr.did = p.did')
      assert.deepEqual(posts, [{ market: MARKET, role: 'seller' }, { market: MARKET, role: 'seller' }], "both in their author's market, as her side: the offers name neither")

      // Host B counts Dara as badged (she holds a line), and Ana writes on there. The index keeps
      // nothing of Dara's: no issuer it trusts vouches for her line.
      await hostB.refreshBadges()
      await write(ana, anaHosts, [['offer/portuguese', offer('Portuguese conversation for adults, A1 to C1.')]])
      await waitFor(async () => (await count('select count(*) n from host_entries where host = $1 and profile = $2', [hostB.url, ana.did])) === 5, 30_000, "Ana's new entry from host B")
      assert.ok(await isBadged(dara.did), "host B's word: Dara is badged")
      assert.equal(await count('select count(*) n from host_entries where profile = any($1)', [[cleo.did, dara.did]]), 0, 'nothing of Cleo’s or Dara’s kept')
      assert.equal(await count('select count(*) n from profiles where did = any($1)', [[cleo.did, dara.did]]), 0)

      // A chain reader that starts now finds every line from the registry's accounts, and follows
      // only transactions after the newest one there is. The index's own reader pauses meanwhile.
      index.chain!.stop()
      await index.chain!.pollOnce()
      await index.db.query('delete from lines')
      await index.db.query(`delete from cursors where source = $1`, [`chain:${REGISTRY_ID.toBase58()}`])
      const fresh = new ChainReader(index.db, RPC, [{ id: REGISTRY_ID.toBase58(), kind: 'registry' }], () => index.scorer.schedule(), 'confirmed')
      assert.equal(await fresh.pollOnce(), 4, 'four lines, read from the accounts; no transaction')
      assert.equal(await count('select count(*) n from lines'), 4)
      const newest = (await connection.getSignaturesForAddress(REGISTRY_ID, { limit: 1 }, 'confirmed'))[0].signature
      assert.equal((await index.db.query('select value from cursors where source = $1', [`chain:${REGISTRY_ID.toBase58()}`])).rows[0].value, newest)
      assert.equal(await fresh.pollOnce(), 0, 'nothing new')
      index.chain!.start(300)
      // A recompute that ran while the lines were gone is run again, now they are back.
      await index.scorer.now()
    })

    await t.test('3. memberships: Ben’s adds the foundation; Dara’s earns her a trusted line; Cleo’s copy does not check', async () => {
      const before = (await get(`/profiles/${ben.did}.json`)).body
      assert.deepEqual(before.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[BUYER, 0.5]], 'the second issuer, at 0.5')
      const membership = (p: typeof ana, label: string) =>
        makeMembership({ secret: p.secret, label, profile: p.key.publicKey, commitments: foundation.commitments, issuer: foundation.key.did, artifacts: ARTIFACTS })
      const bens = await membership(ben, BUYER)
      await write(ben, [hostA.url], [['proof/foundation', bens as unknown as Record<string, unknown>]])
      await write(cleo, [hostA.url], [['proof/foundation', bens as unknown as Record<string, unknown>]])
      await write(dara, [hostB.url], [['proof/foundation', (await membership(dara, PEER)) as unknown as Record<string, unknown>]])
      await waitFor(
        async () => (await count(`select count(*) n from memberships where status <> 'pending'`)) === 3,
        60_000,
        async () => JSON.stringify((await index.db.query('select did, status, why from memberships')).rows),
      )
      const { rows } = await index.db.query('select did, status, why from memberships order by did')
      assert.deepEqual(
        Object.fromEntries(rows.map((r) => [r.did, [r.status, r.why]])),
        { [ben.did]: ['valid', null], [dara.did]: ['valid', null], [cleo.did]: ['invalid', 'doesNotVerify'] },
      )
      // Dara now holds a trusted line: everything of hers is read in, by profile, from host B.
      await waitFor(async () => (await count('select count(*) n from posts where did = $1', [dara.did])) === 1, 30_000, "Dara's offer, read by profile")
      assert.equal(await count('select count(*) n from host_entries where profile = $1 and path not like $2', [cleo.did, 'proof/%']), 0, 'of Cleo’s, only her proof record')
      await index.scorer.now()
      const after = (await get(`/profiles/${ben.did}.json`)).body
      assert.deepEqual(after.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[BUYER, 1]], 'with the foundation: 1 − (1 − 1) × (1 − 0.5)')
      assert.deepEqual(after.badges[0].issuers.map((i: any) => [i.name, i.via]), [['Second issuer', 'line'], ['Forest Foundation', 'membership']])
      const daraTwin = (await get(`/profiles/${dara.did}.json`)).body
      assert.deepEqual(daraTwin.badges.map((b: any) => [b.scope, b.counted, b.issuers.map((i: any) => [i.name, i.via])]), [[PEER, true, [['Forest Foundation', 'membership']]]])
      assert.equal((await get(`/profiles/${cleo.did}.json`)).status, 404, 'no trusted line, no page')
    })

    let escrow: PublicKey
    await t.test('4. deals: an invoice on escrow v2 that Ben objects to, then pays and releases; a one-tap payment on v1', async () => {
      const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(USDC, owner)
      await send(
        [
          ...[ana, ben, dara].map((p) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(p.wallet.publicKey), p.wallet.publicKey, USDC)),
          createMintToInstruction(USDC, ata(ben.wallet.publicKey), payer.publicKey, 100_000_000),
          createMintToInstruction(USDC, ata(dara.wallet.publicKey), payer.publicKey, 100_000_000),
        ],
        [payer],
      )
      const terms = v2.termsFor(null, { seller: ana.wallet.publicKey, amount: 25_000_000n })
      const invoice = v2.invoiceIx({ seller: ana.wallet.publicKey, buyer: ben.wallet.publicKey, payer: payer.publicKey, mint: USDC, terms })
      escrow = new PublicKey(v2.escrowAddress(ana.wallet.publicKey, terms.id).toBase58())
      await send([invoice], [payer, ana.wallet])
      const read = async () => v2.decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data))
      await send([v2.objectIx({ account: await read(), party: ben.wallet.publicKey })], [payer, ben.wallet])
      await send(v2.payInvoiceInOneTap({ escrow: await read(), payer: payer.publicKey }), [payer, ben.wallet])

      const v1Terms = termsFor(null, { seller: ana.wallet.publicKey, amount: 5_000_000n })
      await send(payInOneTap({ buyer: dara.wallet.publicKey, payer: payer.publicKey, mint: USDC, terms: v1Terms }), [payer, dara.wallet])

      await waitFor(async () => (await count(`select count(*) n from escrow_receipts where outcome = 'releasedToSeller'`)) === 2, 60_000, 'two receipts')
      const { rows } = await index.db.query('select * from escrow_receipts order by amount desc')
      const [deal, v1] = rows
      assert.deepEqual(
        [deal.escrow, deal.program_id, deal.buyer, deal.seller, deal.creator, deal.amount, deal.to_seller],
        [escrow.toBase58(), v2.PROGRAM_ID.toBase58(), ben.wallet.publicKey.toBase58(), ana.wallet.publicKey.toBase58(), 'seller', '25000000', '25000000'],
      )
      assert.equal(deal.objected_by, 'buyer', 'Ben objected')
      assert.ok(deal.objected_at)
      assert.equal(deal.funded_at.getTime(), deal.ended_at.getTime(), 'nobody marked it: v2 says the money was there when it ended')
      assert.deepEqual([v1.program_id, v1.buyer, v1.creator, v1.funded_at], [ESCROW_ID.toBase58(), dara.wallet.publicKey.toBase58(), 'buyer', null])
    })

    const madeUpDeal = randomBytes(32).toString('hex')
    await t.test('5. reviews both ways on the v2 deal; Cleo’s, with no badge behind it, not kept', async () => {
      await write(cleo, [hostA.url], [['review/ana', review(ana.did, '1', madeUpDeal, 'Never showed up.')]])
      await write(ben, [hostA.url], [['review/ana', review(ana.did, '10', escrow.toBase58(), 'Patient and well prepared.')]])
      await write(ana, anaHosts, [['review/ben', review(ben.did, '10', escrow.toBase58(), 'Paid on time, came prepared.')]])
      await waitFor(async () => (await count('select count(*) n from reviews')) === 2, 30_000, 'two reviews')
      assert.equal(await count('select count(*) n from reviews where reviewer = $1', [cleo.did]), 0)
    })

    await t.test('6. a forged entry is refused; a genuine one of Ana’s on the same host is kept; Mallory’s, with no badge, is not', async () => {
      await waitFor(async () => (await count('select count(*) n from host_entries where host = $1 and profile = $2', [fakeUrl, ana.did])) === 1, 30_000, "Ana's note from the fake host, read by profile")
      assert.equal(await count('select count(*) n from host_entries where host = $1 and profile = $2', [fakeUrl, mallory.did]), 0, 'Mallory holds no line: nothing kept')
      assert.equal(await count(`select count(*) n from reviews where subject = $1`, [mallory.did]), 0, 'the forged review is not stored')
      assert.equal(await count(`select count(*) n from host_entries where path = 'review/forged'`), 0)
      assert.ok(indexErrors.some((e) => String(e).includes(`refused from ${fakeUrl}: signature`)), 'refused for its signature')
    })

    // Everything is in; the scores are recomputed once more and read back.
    await index.scorer.now()
    const pub = (await get('/index.json')).body.index.keys

    await t.test('7. scores as expected, each signed twice', async () => {
      const a = (await get(`/profiles/${ana.did}.json`)).body
      const b = (await get(`/profiles/${ben.did}.json`)).body
      const d = (await get(`/profiles/${dara.did}.json`)).body

      assert.deepEqual(a.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[SELLER, 1]], "Ana's line, on the foundation's list")
      assert.deepEqual(b.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[BUYER, 1]])
      assert.deepEqual(d.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[PEER, 1]], "Dara's, by her membership")

      // Ana and Ben vouch for each other on one deal both said yes to (she invoiced it); each
      // converges to the golden ratio. Cleo's review was never kept. Dara has no reviews: zero.
      const ta = a.scores.standing.value
      const tb = b.scores.standing.value
      assert.ok(Math.abs(tb - 1.618034) < 1e-3, `Ben ${tb}`)
      assert.ok(Math.abs(ta - 1.618034) < 1e-3, `Ana ${ta}`)
      assert.equal(d.scores.standing.value, 0)
      assert.equal(a.scores.standing.details.reviews.withReceipt, 1)
      assert.equal(a.scores.rating.value, 10, "Ben's 10, the one review she received")
      assert.equal(b.scores.rating.value, 10)
      assert.equal(d.scores.rating, null, 'no review, no rating')

      for (const score of [...a.scores.uniqueness, a.scores.standing, a.scores.rating, b.scores.standing, b.scores.rating, d.scores.standing]) {
        assert.deepEqual(verify(score.signed, pub), { ed25519: true, eddsaPoseidon: true })
      }

      const byBen = a.reviews.received.find((r: any) => r.reviewer === ben.did)
      assert.deepEqual(byBen.evidence, { kind: 'both', note: null, weight: 1 }, 'a receipt both said yes to')
      assert.deepEqual(byBen.objection?.by, 'buyer', 'the objection, on the review that names the deal')
      assert.equal(a.reviews.received.length, 1)
      assert.equal(a.reviews.given[0].subject, ben.did)
    })

    await t.test('8. every page and its twin', async () => {
      const home = await get('/index.json')
      assert.equal(home.status, 200)
      hasKeys(home.body, ['kind', 'url', 'json', 'index', 'folders'], '/index.json')
      hasKeys(home.body.index.keys, ['ed25519', 'eddsaPoseidon'], 'the public keys')
      assert.equal(home.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=300')
      assert.equal(home.headers.get('access-control-allow-origin'), '*')
      assert.equal(home.headers.get('set-cookie'), null)
      assert.deepEqual(
        home.body.folders.map((f: any) => [f.folder, f.markets.map((m: any) => [m.name, m.offers])]),
        [['freelance-work', [[MARKET, 2]]], ['learning', [['language-exchange', 1]]]],
      )

      const market = await get(`/markets/${MARKET}.json`)
      hasKeys(market.body, ['kind', 'url', 'json', 'market', 'folderUrl', 'counts', 'near', 'limit', 'offset', 'total', 'next', 'offers'], '/markets/{m}.json')
      assert.equal(market.body.market.name, MARKET)
      assert.deepEqual([market.body.market.sides, market.body.market.labels, market.body.market.roles], ['two', { seller: 'tutor', buyer: 'student' }, ['seller', 'buyer']])
      assert.deepEqual(market.body.counts, { offers: 2, requests: 0, badgedProfiles: 2 }, 'Ana and Ben; not Cleo, whose line no trusted issuer vouches for')
      assert.equal(market.body.total, 2)
      const OFFER = ['uri', 'cid', 'did', 'name', 'profileUrl', 'direction', 'market', 'marketUrl', 'role', 'description', 'price', 'terms', 'availability', 'remote', 'location', 'expires', 'createdAt', 'uniqueness', 'rating', 'standing', 'payLink']
      for (const o of market.body.offers) {
        hasKeys(o, OFFER, 'an offer')
        assert.equal(o.did, ana.did)
        assert.equal(o.name, 'Ana')
        assert.equal(o.uniqueness, 1)
        assert.ok(o.standing > 1.6)
        assert.deepEqual(o.rating, { value: 10, reviews: 1 })
        assert.ok(o.payLink.includes(encodeURIComponent(o.uri)), 'the pay link names the offer')
        assert.match(o.cid, /^[0-9a-f]{64}$/, "the offer's entry id")
      }
      assert.ok(market.body.offers.some((o: any) => o.description === 'Portuguese conversation for adults, A1 to C1.'), 'the newest version of the offer')
      // The options, as plain data; the pages say nothing of them.
      const terms = market.body.offers.map((o: any) => o.terms)
      assert.equal(terms.filter((x: unknown) => x === null).length, 1)
      assert.deepEqual(terms.find((x: unknown) => x !== null), { timer: { days: 7, to: 'seller' } })

      assert.equal((await get('/markets/online-tutor.json')).status, 404, 'no aliases: another spelling is no market')
      assert.equal((await get('/markets/plumbers.json')).status, 404)

      const a = await get(`/profiles/${ana.did}.json`)
      hasKeys(a.body, ['kind', 'url', 'json', 'did', 'profile', 'badges', 'scores', 'offers', 'requests', 'credentials', 'reviews'], '/profiles/{did}.json')
      hasKeys(a.body.profile, ['name', 'market', 'marketUrl', 'role', 'side', 'about', 'contact', 'wallet', 'photo', 'createdAt', 'cid'], 'profile')
      assert.deepEqual([a.body.profile.market, a.body.profile.role, a.body.profile.side, a.body.profile.wallet], [MARKET, 'seller', 'tutor', addressFromDid(ana.did)])
      hasKeys(a.body.badges[0], ['scope', 'market', 'marketUrl', 'role', 'side', 'issuers', 'wallet', 'counted', 'why', 'registeredAt', 'line', 'code', 'root'], 'a badge')
      assert.equal(a.body.badges[0].line, lineOf.get(ana.did)!.line.toBase58())
      hasKeys(a.body.scores, ['uniqueness', 'standing', 'rating'], 'scores')
      hasKeys(a.body.scores.standing, ['scope', 'value', 'valueMicro', 'details', 'computedAt', 'signed'], 'a score')
      hasKeys(a.body.scores.standing.signed, ['statement', 'message', 'ed25519', 'eddsaPoseidon'], 'a signature')
      assert.equal(a.body.offers.length, 2)
      assert.deepEqual([a.body.reviews.received.length, a.body.reviews.given.length], [1, 1])
      const REVIEW = ['uri', 'reviewer', 'reviewerName', 'reviewerUrl', 'subject', 'subjectName', 'subjectUrl', 'market', 'overall', 'ratings', 'text', 'media', 'fields', 'dealId', 'dealUrl', 'hasReceipt', 'objection', 'createdAt', 'counted', 'skipped', 'evidence', 'reviewerWeight', 'contribution']
      hasKeys(a.body.reviews.received[0], REVIEW, 'a review')
      assert.equal((await get('/profiles/did:key:z6MkNobody.json')).status, 404)

      const d = await get(`/deals/${escrow.toBase58()}.json`)
      hasKeys(d.body, ['kind', 'url', 'json', 'dealId', 'receipt', 'reviews'], '/deals/{dealId}.json')
      hasKeys(
        d.body.receipt,
        ['escrow', 'program', 'buyer', 'seller', 'creator', 'buyerProfiles', 'sellerProfiles', 'market', 'sides', 'mint', 'amount', 'arbiter', 'timer', 'createdAt', 'fundedAt', 'endedAt', 'outcome', 'toSeller', 'toBuyer', 'closed', 'objection', 'transaction'],
        'a receipt',
      )
      assert.deepEqual(
        [d.body.receipt.buyerProfiles.map((p: any) => p.did), d.body.receipt.sellerProfiles.map((p: any) => p.did), d.body.receipt.creator, d.body.receipt.outcome],
        [[ben.did], [ana.did], 'seller', 'releasedToSeller'],
      )
      assert.deepEqual([d.body.receipt.objection.by, d.body.receipt.objection.side], ['buyer', 'student'])
      assert.equal(d.body.reviews.length, 2, 'the two sides')
      const noReceipt = await get(`/deals/${madeUpDeal}.json`)
      assert.equal(noReceipt.status, 404, "Cleo's review, the one naming it, was never kept")
      assert.equal((await get(`/deals/${'00'.repeat(32)}.json`)).status, 404)

      const s = await get('/search.json?q=portuguese')
      hasKeys(s.body, ['kind', 'url', 'json', 'q', 'near', 'markets', 'offers', 'total'], '/search.json')
      assert.deepEqual(s.body.offers.map((o: any) => o.did), [ana.did, dara.did], "Ana's, then Dara's English for Portuguese: both badged, Ana in standing")
      assert.deepEqual([s.body.offers[0].market, s.body.offers[0].role], [MARKET, 'seller'], "the author profile's market and side")
      assert.deepEqual([s.body.offers[1].market, s.body.offers[1].role], ['language-exchange', 'peer'])
      assert.deepEqual((await get('/search.json?q=tutor')).body.markets.map((m: any) => [m.name, m.matched]), [[MARKET, 'name']])

      // And the same pages for people.
      for (const path of ['/', `/markets/${MARKET}`, `/profiles/${ana.did}`, `/profiles/${dara.did}`, `/deals/${escrow.toBase58()}`, '/search?q=portuguese', '/sitemap.xml', '/skill.md', '/llms.txt', '/robots.txt']) {
        const res = await fetch(base + path)
        assert.equal(res.status, 200, path)
      }
    })

    assert.deepEqual(
      indexErrors.filter((e) => !/refused/.test(String(e))),
      [],
      'the index reported no error of its own',
    )
  } finally {
    for (const c of cleanups.reverse()) {
      try {
        await c()
      } catch (err) {
        console.error('cleanup failed', err)
      }
    }
  }
})
