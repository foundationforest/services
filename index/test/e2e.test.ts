// The index end to end, on real pieces: a local DID directory and a Forest host (host/), a local
// validator running both programs (registry/, escrow/), and a local Postgres. Nothing is mocked but
// the one firehose that carries a forged commit, which no real host would send.
//
// The story:
//   Ana tutors; Ben is her student; Cleo is a stranger. Each makes a profile on the host, declaring
//   a wallet. The foundation's issuer puts all three on list 0; each registers a badge in
//   online-tutors, Ana and Cleo as sellers and Ben as a buyer. Cleo registers hers with a wallet
//   her profile does not declare, so it must not count. Ana posts two offers. Ana invoices Ben through
//   an escrow; Ben pays it and releases it to her in one transaction; both review each other on
//   that deal. Cleo reviews Ana with a made-up deal id. Then a forged commit claiming to be Ana's
//   arrives on a second firehose and must be refused. Last, every page and twin answers.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
//
// The market directory comes from a stand-in for the markets repo served locally (test/markets/).
//
// Needs: DATABASE_URL (a Postgres the test may create and drop a database in), host/ built
// (`./build.sh`), both programs built (`cargo build-sbf`), the proving files fetched
// (`npm run fetch` in registry/artifacts), `npm install` in registry/client, escrow/client, keys
// and shapes, and `solana-test-validator` on the PATH. If any is missing the test says which and
// skips.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ACCOUNT_SIZE,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createMintToInstruction,
  createTransferInstruction,
} from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js'
import pg from 'pg'
import { WebSocketServer } from 'ws'

import {
  FOUNDATION_ISSUER,
  FOUNDATION_ISSUER_PLACEHOLDER_SEED,
  PROGRAM_ID as REGISTRY_ID,
  TREASURY_PLACEHOLDER_SEED,
  USDC_MINT,
  buildRegistration,
  commitmentOf,
  initIx,
  insertIdentityIx,
} from '../../registry/client/src/index.ts'
import {
  PROGRAM_ID as ESCROW_ID,
  decodeEscrow,
  invoice,
  keysOf,
  makeStandardAccountIx,
  releaseToSellerIx,
  termsFor,
  transferIx,
} from '../../escrow/client/src/index.ts'
import { didGenesis, identitySecret, profileKeys, submitGenesis } from '../../keys/src/index.ts'

import { INDEX_ROOT, loadConfig } from '../src/config.ts'
import { startIndex } from '../src/main.ts'
import { startRecordReader } from '../src/records/firehose.ts'
import type { Outcome } from '../src/records/store.ts'
import { verify } from '../src/scores/sign.ts'
import { serveMarkets } from './markets-repo.ts'

const REPO = join(INDEX_ROOT, '..')
const UPSTREAM = join(REPO, 'host/upstream/packages')
const REGISTRY_SO = join(REPO, 'registry/program/target/deploy/forest_registry.so')
const ESCROW_SO = join(REPO, 'escrow/program/target/deploy/forest_escrow.so')
const ARTIFACTS = { wasm: join(REPO, 'registry/artifacts/semaphore-32.wasm'), zkey: join(REPO, 'registry/artifacts/semaphore-32.zkey') }
const RPC_PORT = 18899
const RPC = `http://127.0.0.1:${RPC_PORT}`
const MARKET = 'online-tutors'
/** Badges count only as `market/role`: Ana and Cleo sell, Ben buys. */
const SELLER = `${MARKET}/seller`
const BUYER = `${MARKET}/buyer`
const SIGNING_SEED = '09'.repeat(32)

function missing(): string | null {
  if (!process.env.DATABASE_URL) return 'DATABASE_URL is not set'
  if (!existsSync(join(UPSTREAM, 'dev-env/dist/pds.js'))) return 'host/ is not built; run ./build.sh in host'
  if (!existsSync(REGISTRY_SO)) return 'the registry is not built; run `cargo build-sbf` in registry/program'
  if (!existsSync(ESCROW_SO)) return 'the escrow is not built; run `cargo build-sbf` in escrow/program'
  if (!existsSync(ARTIFACTS.zkey)) return 'no proving files; run `npm run fetch` in registry/artifacts'
  if (spawnSync('solana-test-validator', ['--version']).status !== 0) return 'solana-test-validator is not on the PATH'
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => Promise<boolean> | boolean, ms: number, what: string | (() => string)) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`)
    await sleep(200)
  }
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
    pubkey: USDC_MINT.toBase58(),
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

  // Upstream's packages load only once we know they are built.
  const { TestPlc } = await import(join(UPSTREAM, 'dev-env/dist/plc.js'))
  const { TestPds } = await import(join(UPSTREAM, 'dev-env/dist/pds.js'))
  const { MemoryBlockstore, Repo, WriteOpAction, blocksToCarFile, cidForRecord } = await import(join(UPSTREAM, 'repo/dist/index.js'))
  const { MessageFrame } = await import(join(UPSTREAM, 'xrpc-server/dist/index.js'))
  const { TID } = await import(join(UPSTREAM, 'common/dist/index.js'))
  const { Device } = await import(join(REPO, 'host/test/device.ts'))

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

    // --- The chain: a local validator with both programs and a USDC-shaped mint ---------------
    const payer = Keypair.generate()
    const ledger = mkdtempSync(join(tmpdir(), 'forest-index-ledger-'))
    const accountsDir = mkdtempSync(join(tmpdir(), 'forest-index-accounts-'))
    writeFileSync(join(accountsDir, 'usdc.json'), usdcAccountJson(payer.publicKey))
    const validator: ChildProcess = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(RPC_PORT), '--faucet-port', '19900',
        '--bpf-program', REGISTRY_ID.toBase58(), REGISTRY_SO,
        '--bpf-program', ESCROW_ID.toBase58(), ESCROW_SO,
        '--account', USDC_MINT.toBase58(), join(accountsDir, 'usdc.json'),
      ],
      { stdio: 'ignore' },
    )
    cleanups.push(() => {
      validator.kill('SIGKILL')
      rmSync(ledger, { recursive: true, force: true })
      rmSync(accountsDir, { recursive: true, force: true })
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

    // --- Records: a local DID directory and one host -------------------------------------------
    const plc = await TestPlc.create({})
    cleanups.push(() => plc.close())
    const dataDirectory = mkdtempSync(join(tmpdir(), 'forest-index-host-'))
    const blobstoreDiskLocation = mkdtempSync(join(tmpdir(), 'forest-index-blobs-'))
    const pds = await TestPds.create({ didPlcUrl: plc.url, dataDirectory, blobstoreDiskLocation })
    cleanups.push(async () => {
      await pds.close()
      rmSync(dataDirectory, { recursive: true, force: true })
      rmSync(blobstoreDiskLocation, { recursive: true, force: true })
    })
    const hostDid = pds.ctx.cfg.service.did

    // --- People. Each seed stands in for a passkey's; each profile's keys come from keys/ -------
    async function person(fill: number, handle: string, withFolder = true) {
      const seed = new Uint8Array(32).fill(fill)
      const keys = await profileKeys(seed, 0)
      const genesis = await didGenesis(keys, { handle, pds: pds.url })
      await submitGenesis(genesis, plc.url)
      return {
        seed,
        keys,
        did: genesis.did as string,
        wallet: Keypair.fromSeed(keys.wallet.privateKey),
        secret: await identitySecret(seed),
        device: withFolder ? new Device(genesis.did, keys, pds.url, hostDid) : null,
      }
    }
    const ana = await person(11, 'ana.test')
    const ben = await person(12, 'ben.test')
    const cleo = await person(13, 'cleo.test')
    const mallory = await person(14, 'mallory.test', false)
    // Cleo's profile declares her second profile's wallet, not the one her badge is registered with.
    const cleoDeclared = (await profileKeys(cleo.seed, 1)).wallet.address

    // --- The index, reading both from the start ------------------------------------------------
    const markets = await serveMarkets()
    cleanups.push(() => markets.close())
    const config = loadConfig({
      DATABASE_URL: dbUrl.toString(),
      MARKETS_URL: markets.url,
      FIREHOSE_URL: pds.url.replace(/^http/, 'ws'),
      PLC_URL: plc.url,
      SOLANA_RPC_URL: RPC,
      CHAIN_COMMITMENT: 'confirmed',
      CHAIN_POLL_MS: '500',
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
    const count = async (sql: string) => Number((await index.db.query(sql)).rows[0].n)

    const now = () => new Date().toISOString()
    const create = (collection: string, value: unknown, rkey?: string) => ({
      $type: 'com.atproto.repo.applyWrites#create',
      collection,
      ...(rkey ? { rkey } : {}),
      value,
    })
    // Every profile lives in one market, as one side of it.
    const profileRecord = (name: string, wallet: string, scope = SELLER) => ({
      $type: 'foundation.forest.profile',
      name,
      market: scope.split('/')[0],
      role: scope.split('/')[1],
      wallet,
      createdAt: now(),
    })
    // A post names no market or side: they are its author profile's (Ana's: online-tutors/seller).
    const offer = (description: string, terms?: unknown) => ({
      $type: 'foundation.forest.post',
      direction: 'offer',
      description,
      price: { amount: '25', mint: USDC_MINT.toBase58(), per: 'hour' },
      ...(terms ? { terms } : {}),
      remote: true,
      createdAt: now(),
    })
    const reviewRecord = (subject: string, overall: string, dealId: string, text: string) => ({
      $type: 'foundation.forest.review',
      subject,
      ratings: { overall },
      text,
      dealId,
      createdAt: now(),
    })

    await t.test('1. profiles and two posts, written on the host, read off its firehose', async () => {
      await ana.device!.write([
        create('foundation.forest.profile', profileRecord('Ana', ana.wallet.publicKey.toBase58()), 'self'),
        create('foundation.forest.post', offer('Portuguese conversation for adults, A1 to B2.')),
        create('foundation.forest.post', offer('Spanish grammar, one hour, homework optional.', { timer: { days: 7, to: 'seller' } })),
      ])
      await ben.device!.write([create('foundation.forest.profile', profileRecord('Ben', ben.wallet.publicKey.toBase58(), BUYER), 'self')])
      await cleo.device!.write([create('foundation.forest.profile', profileRecord('Cleo', cleoDeclared), 'self')])
      await waitFor(async () => (await count('select count(*) n from profiles')) === 3 && (await count('select count(*) n from posts')) === 2, 30_000, 'three profiles and two posts')
      const { rows } = await index.db.query('select pr.market, pr.role from posts p join profiles pr on pr.did = p.did')
      assert.deepEqual(rows, [
        { market: MARKET, role: 'seller' },
        { market: MARKET, role: 'seller' },
      ], "both in their author's market, as her side: the posts name neither")
    })

    let escrow: PublicKey
    let tokens: Map<string, { kp: Keypair }>
    await t.test('2. three badges on list 0, one of them for a wallet its profile does not declare', async () => {
      const treasury = Keypair.fromSeed(TREASURY_PLACEHOLDER_SEED)
      const issuer = Keypair.fromSeed(FOUNDATION_ISSUER_PLACEHOLDER_SEED)
      const rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
      const tokenAccount = (owner: PublicKey) => {
        const kp = Keypair.generate()
        return {
          kp,
          ixs: [
            SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: ACCOUNT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
            createInitializeAccount3Instruction(kp.publicKey, USDC_MINT, owner),
          ],
        }
      }
      const treasuryTokens = tokenAccount(treasury.publicKey)
      const accounts = new Map([ana, ben, cleo].map((p) => [p.did, tokenAccount(p.wallet.publicKey)]))
      tokens = accounts
      await send(
        [
          ...treasuryTokens.ixs,
          ...[...accounts.values()].flatMap((a) => a.ixs),
          ...[...accounts.values()].map((a) => createMintToInstruction(USDC_MINT, a.kp.publicKey, payer.publicKey, 100_000_000)),
        ],
        [payer, treasuryTokens.kp, ...[...accounts.values()].map((a) => a.kp)],
      )

      await send([initIx({ payer: payer.publicKey })], [payer])
      const leaves = [ana, ben, cleo].map((p) => commitmentOf(p.secret))
      for (const commitment of leaves) {
        await send([insertIdentityIx({ issuer: issuer.publicKey, listIndex: 0, commitment })], [payer, issuer])
      }
      for (const p of [ana, ben, cleo]) {
        const reg = await buildRegistration({
          secret: p.secret,
          market: p === ben ? BUYER : SELLER,
          did: p.did,
          listIndex: 0,
          leaves,
          artifacts: ARTIFACTS,
          accounts: {
            payer: payer.publicKey,
            profileWallet: p.wallet.publicKey,
            feeAuthority: p.wallet.publicKey,
            feeTokens: tokens.get(p.did)!.kp.publicKey,
            treasuryTokens: treasuryTokens.kp.publicKey,
          },
          recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
        })
        reg.transaction.sign([p.wallet, payer])
        await confirm(await connection.sendRawTransaction(reg.transaction.serialize()))
      }
      await waitFor(async () => (await count('select count(*) n from badges')) === 3, 60_000, 'three badges')
      const { rows } = await index.db.query('select did, wallet, scope, list_owner from badges order by did')
      for (const b of rows) {
        assert.equal(b.scope, b.did === ben.did ? BUYER : SELLER)
        assert.equal(b.list_owner, FOUNDATION_ISSUER.toBase58(), 'who vouched')
      }
      assert.equal(rows.find((b) => b.did === cleo.did).wallet, cleo.wallet.publicKey.toBase58())
      assert.notEqual(cleoDeclared, cleo.wallet.publicKey.toBase58())
    })

    await t.test('3. a paid deal: Ana invoices Ben; Ben pays and releases it to her in one transaction', async () => {
      const terms = termsFor(null, { seller: ana.wallet.publicKey, amount: 25_000_000n })
      const inv = invoice({ seller: ana.wallet.publicKey, buyer: ben.wallet.publicKey, payer: payer.publicKey, mint: USDC_MINT, decimals: 6, terms })
      escrow = inv.escrow
      await send([inv.instruction], [payer, ana.wallet])
      const keys = keysOf(decodeEscrow(new Uint8Array((await connection.getAccountInfo(escrow))!.data)))
      // The escrow pays the seller only at her standard account for the mint; she has none yet.
      await send(
        [
          makeStandardAccountIx({ payer: payer.publicKey, owner: ana.wallet.publicKey, mint: USDC_MINT }),
          transferIx({ from: tokens.get(ben.did)!.kp.publicKey, to: inv.deposit, owner: ben.wallet.publicKey, amount: 25_000_000n }),
          releaseToSellerIx({ keys }),
        ],
        [payer, ben.wallet],
      )
      await waitFor(async () => (await count(`select count(*) n from escrow_receipts where outcome = 'releasedToSeller'`)) === 1, 60_000, 'the receipt')
      const { rows } = await index.db.query('select * from escrow_receipts')
      assert.equal(rows[0].escrow, escrow.toBase58())
      assert.equal(rows[0].buyer, ben.wallet.publicKey.toBase58())
      assert.equal(rows[0].seller, ana.wallet.publicKey.toBase58())
      assert.equal(rows[0].creator, 'seller', 'an invoice: the seller said yes by asking')
      assert.equal(rows[0].amount, '25000000')
      assert.equal(rows[0].to_seller, '25000000')
      assert.equal(rows[0].funded_at, null, 'nobody marked the funding: the ending proves it')
      assert.ok(rows[0].created_at && rows[0].ended_at)
      // The payment itself is a plain token transfer that never names the escrow program; it rides
      // in the release's transaction. The deal is two transactions: the invoice, and pay-and-release.
      assert.equal(await count('select count(*) n from chain_transactions'), 1 + 3 + 3 + 2, 'every transaction archived: init, three inserts, three registrations, two for the deal')
    })

    const madeUpDeal = randomBytes(32).toString('hex')
    await t.test('4. reviews both ways on the deal, and one with no receipt', async () => {
      await ben.device!.write([create('foundation.forest.review', reviewRecord(ana.did, '10', escrow.toBase58(), 'Patient and well prepared.'))])
      await ana.device!.write([create('foundation.forest.review', reviewRecord(ben.did, '10', escrow.toBase58(), 'Paid on time, came prepared.'))])
      await cleo.device!.write([create('foundation.forest.review', reviewRecord(ana.did, '1', madeUpDeal, 'Never showed up.'))])
      await waitFor(async () => (await count('select count(*) n from reviews')) === 3, 30_000, 'three reviews')
    })

    await t.test('5. a forged commit is refused; a genuine one on the same firehose is stored', async () => {
      // A commit claiming to be Ana's folder, holding a glowing review of Mallory, signed with
      // Mallory's key. And Mallory's own profile, signed with her own key.
      async function commitFrame(seq: number, did: string, signer: unknown, collection: string, rkey: string, record: Record<string, unknown>) {
        const commit = await Repo.formatInitCommit(new MemoryBlockstore(), did, signer, [
          { action: WriteOpAction.Create, collection, rkey, record },
        ])
        const body = {
          seq,
          rebase: false,
          tooBig: false,
          repo: did,
          commit: commit.cid,
          rev: commit.rev,
          since: null,
          blocks: await blocksToCarFile(commit.cid, commit.newBlocks),
          ops: [{ action: 'create', path: `${collection}/${rkey}`, cid: await cidForRecord(record) }],
          blobs: [],
          time: now(),
        }
        return new MessageFrame(body, { type: '#commit' }).toBytes()
      }
      const forgedRkey = TID.nextStr()
      const frames = [
        await commitFrame(1, ana.did, mallory.keys.signing, 'foundation.forest.review', forgedRkey, reviewRecord(mallory.did, '10', madeUpDeal, 'The best.')),
        await commitFrame(2, mallory.did, mallory.keys.signing, 'foundation.forest.profile', 'self', profileRecord('Mallory', mallory.wallet.publicKey.toBase58())),
      ]
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      wss.on('connection', (ws) => {
        for (const f of frames) ws.send(f)
      })
      await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
      cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())))
      const errors: Error[] = []
      const seen: [string, Outcome][] = []
      const reader = await startRecordReader({
        db: index.db,
        firehoseUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        plcUrl: plc.url,
        onChange: () => index.scorer.schedule(),
        onError: (err) => errors.push(err),
        onRecord: (uri, outcome) => seen.push([uri, outcome]),
      })
      cleanups.push(() => reader.stop())
      await waitFor(
        () => seen.some(([uri]) => uri.startsWith(`at://${mallory.did}/`)) && errors.length > 0,
        30_000,
        () => `the genuine commit stored and the forged one refused (seen ${JSON.stringify(seen)}, errors ${errors.map((e) => e.message)})`,
      )
      assert.deepEqual(seen, [[`at://${mallory.did}/foundation.forest.profile/self`, { result: 'stored' }]], 'only the genuine record reached the store')
      assert.equal(await count(`select count(*) n from reviews where uri like '%${forgedRkey}'`), 0, 'the forged review is not stored')
      assert.equal(await count(`select count(*) n from reviews where subject = '${mallory.did}'`), 0)
      // Refused for the one right reason: the commit's signature does not verify against the key
      // Ana's DID document names.
      const causes = errors.map((e) => String((e as { cause?: unknown }).cause ?? e.message))
      assert.ok(causes.some((c) => /Invalid signature on commit/.test(c)), `refused for its signature: ${causes.join(' | ')}`)
    })

    // Everything is in; the scores are recomputed once more and read back.
    await index.scorer.now()
    const pub = (await get('/index.json')).body.index.keys

    await t.test('6. scores as expected, each signed twice', async () => {
      const a = (await get(`/profiles/${ana.did}.json`)).body
      const b = (await get(`/profiles/${ben.did}.json`)).body
      const c = (await get(`/profiles/${cleo.did}.json`)).body

      assert.deepEqual(a.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[SELLER, 1]], "Ana's badge, vouched for by the foundation")
      assert.deepEqual(b.scores.uniqueness.map((u: any) => [u.scope, u.value]), [[BUYER, 1]])
      assert.deepEqual(c.scores.uniqueness, [], "Cleo's badge does not count: her profile declares another wallet")
      assert.deepEqual(c.badges.map((x: any) => [x.counted, x.why]), [[false, 'walletNotDeclared']])

      // Ana and Ben vouch for each other on one deal both said yes to (she invoiced it); each
      // converges to the golden ratio. Cleo's review, from a reviewer with no counted badge and no
      // receipt, takes 0.05 × 0.05 × 1 off Ana's. Cleo has no reviews: zero.
      const ta = a.scores.standing.value
      const tb = b.scores.standing.value
      assert.ok(Math.abs(tb - 1.618034) < 1e-3, `Ben ${tb}`)
      const wBen = 1 + tb / (tb + 1)
      assert.ok(Math.abs(ta - (wBen - 0.0025)) < 1e-5, `Ana ${ta}`)
      assert.equal(c.scores.standing.value, 0)
      assert.equal(a.scores.standing.details.reviews.withReceipt, 1)
      // The rating: Ben's 10 at weight wBen and Cleo's 1 at 0.0025, averaged; Ben's is Ana's 10.
      assert.ok(Math.abs(a.scores.rating.value - (10 * wBen + 0.0025) / (wBen + 0.0025)) < 1e-5, `Ana rated ${a.scores.rating.value}`)
      assert.equal(b.scores.rating.value, 10)
      assert.equal(c.scores.rating, null, 'no review, no rating')

      for (const score of [...a.scores.uniqueness, a.scores.standing, a.scores.rating, b.scores.standing, b.scores.rating, c.scores.standing]) {
        assert.deepEqual(verify(score.signed, pub), { ed25519: true, eddsaPoseidon: true })
      }

      const byBen = a.reviews.received.find((r: any) => r.reviewer === ben.did)
      const byCleo = a.reviews.received.find((r: any) => r.reviewer === cleo.did)
      assert.deepEqual(byBen.evidence, { kind: 'both', note: null, weight: 1 }, 'a receipt both said yes to')
      assert.deepEqual(byCleo.evidence, { kind: 'none', note: 'noReceipt', weight: 0.05 }, 'a made-up deal id')
      assert.equal(byCleo.reviewerWeight, 0.05)
      assert.equal(a.reviews.given[0].subject, ben.did)
    })

    await t.test('7. every page and its twin', async () => {
      const home = await get('/index.json')
      assert.equal(home.status, 200)
      hasKeys(home.body, ['kind', 'url', 'json', 'index', 'folders'], '/index.json')
      hasKeys(home.body.index.keys, ['ed25519', 'eddsaPoseidon'], 'the public keys')
      assert.equal(home.headers.get('cache-control'), 'public, max-age=30, stale-while-revalidate=300')
      assert.equal(home.headers.get('access-control-allow-origin'), '*')
      assert.equal(home.headers.get('set-cookie'), null)
      assert.deepEqual(
        home.body.folders.map((f: any) => [f.folder, f.markets.map((m: any) => [m.name, m.offers])]),
        [['freelance-work', [[MARKET, 2]]], ['learning', [['language-exchange', 0]]]],
      )

      const market = await get(`/markets/${MARKET}.json`)
      hasKeys(market.body, ['kind', 'url', 'json', 'market', 'folderUrl', 'counts', 'near', 'limit', 'offset', 'total', 'next', 'offers'], '/markets/{m}.json')
      assert.equal(market.body.market.name, MARKET)
      assert.deepEqual([market.body.market.sides, market.body.market.labels, market.body.market.roles], ['two', { seller: 'tutor', buyer: 'student' }, ['seller', 'buyer']])
      assert.deepEqual(market.body.counts, { offers: 2, requests: 0, badgedProfiles: 2 }, 'Ana and Ben; not Cleo')
      assert.equal(market.body.total, 2)
      const OFFER = ['uri', 'cid', 'did', 'name', 'profileUrl', 'direction', 'market', 'marketUrl', 'role', 'description', 'price', 'terms', 'availability', 'remote', 'location', 'expires', 'createdAt', 'uniqueness', 'rating', 'standing', 'payLink']
      for (const o of market.body.offers) {
        hasKeys(o, OFFER, 'an offer')
        assert.equal(o.did, ana.did)
        assert.equal(o.name, 'Ana')
        assert.equal(o.uniqueness, 1)
        assert.ok(o.standing > 1.6)
        assert.ok(o.rating.value > 9.9 && o.rating.reviews === 2, `Ana rated ${o.rating.value} from ${o.rating.reviews}`)
        assert.ok(o.payLink.includes(encodeURIComponent(o.uri)), 'the pay link names the offer')
      }
      // The options, as plain data; the pages say nothing of them.
      const terms = market.body.offers.map((o: any) => o.terms)
      assert.equal(terms.filter((x: unknown) => x === null).length, 1)
      assert.deepEqual(terms.find((x: unknown) => x !== null), { timer: { days: 7, to: 'seller' } })

      assert.equal((await get('/markets/online-tutor.json')).status, 404, 'no aliases: another spelling is no market')
      assert.equal((await get('/markets/plumbers.json')).status, 404)

      const a = await get(`/profiles/${ana.did}.json`)
      hasKeys(a.body, ['kind', 'url', 'json', 'did', 'profile', 'badges', 'scores', 'offers', 'requests', 'credentials', 'reviews'], '/profiles/{did}.json')
      hasKeys(a.body.profile, ['name', 'market', 'marketUrl', 'role', 'side', 'about', 'contact', 'wallet', 'photo', 'createdAt', 'cid'], 'profile')
      assert.deepEqual([a.body.profile.market, a.body.profile.role, a.body.profile.side], [MARKET, 'seller', 'tutor'])
      hasKeys(a.body.badges[0], ['scope', 'market', 'marketUrl', 'role', 'side', 'listIndex', 'listOwner', 'issuer', 'wallet', 'counted', 'why', 'registeredAt', 'transaction'], 'a badge')
      hasKeys(a.body.scores, ['uniqueness', 'standing', 'rating'], 'scores')
      hasKeys(a.body.scores.standing, ['scope', 'value', 'valueMicro', 'details', 'computedAt', 'signed'], 'a score')
      hasKeys(a.body.scores.standing.signed, ['statement', 'message', 'ed25519', 'eddsaPoseidon'], 'a signature')
      assert.equal(a.body.offers.length, 2)
      assert.deepEqual([a.body.reviews.received.length, a.body.reviews.given.length], [2, 1])
      const REVIEW = ['uri', 'reviewer', 'reviewerName', 'reviewerUrl', 'subject', 'subjectName', 'subjectUrl', 'market', 'overall', 'ratings', 'text', 'media', 'fields', 'dealId', 'dealUrl', 'hasReceipt', 'createdAt', 'counted', 'skipped', 'evidence', 'reviewerWeight', 'contribution']
      hasKeys(a.body.reviews.received[0], REVIEW, 'a review')
      assert.equal((await get('/profiles/did:plc:nobody.json')).status, 404)

      const d = await get(`/deals/${escrow.toBase58()}.json`)
      hasKeys(d.body, ['kind', 'url', 'json', 'dealId', 'receipt', 'reviews'], '/deals/{dealId}.json')
      hasKeys(
        d.body.receipt,
        ['escrow', 'program', 'buyer', 'seller', 'creator', 'buyerProfiles', 'sellerProfiles', 'market', 'sides', 'mint', 'amount', 'arbiter', 'timer', 'createdAt', 'fundedAt', 'endedAt', 'outcome', 'toSeller', 'toBuyer', 'closed', 'transaction'],
        'a receipt',
      )
      assert.deepEqual(
        [d.body.receipt.buyerProfiles.map((p: any) => p.did), d.body.receipt.sellerProfiles.map((p: any) => p.did), d.body.receipt.creator, d.body.receipt.outcome],
        [[ben.did], [ana.did], 'seller', 'releasedToSeller'],
      )
      assert.equal(d.body.reviews.length, 2, 'the two sides')
      const noReceipt = await get(`/deals/${madeUpDeal}.json`)
      assert.equal(noReceipt.body.receipt, null)
      assert.equal(noReceipt.body.reviews.length, 1)
      assert.equal((await get(`/deals/${'00'.repeat(32)}.json`)).status, 404)

      const s = await get('/search.json?q=portuguese')
      hasKeys(s.body, ['kind', 'url', 'json', 'q', 'near', 'markets', 'offers', 'total'], '/search.json')
      assert.equal(s.body.total, 1)
      assert.deepEqual([s.body.offers[0].market, s.body.offers[0].role], [MARKET, 'seller'], "the author profile's market and side")
      assert.deepEqual((await get('/search.json?q=tutor')).body.markets.map((m: any) => [m.name, m.matched]), [[MARKET, 'name']])

      // And the same pages for people.
      for (const path of ['/', `/markets/${MARKET}`, `/profiles/${ana.did}`, `/deals/${escrow.toBase58()}`, '/search?q=portuguese', '/sitemap.xml', '/skill.md', '/llms.txt', '/robots.txt']) {
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
