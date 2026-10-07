// The index end to end, on real pieces: forest's reference host (forest/records), a local validator
// running the registry and the escrow (forest/registry, forest/escrow), notes signed with forest's
// own signNote, by the issuer the index trusts and by a stranger, and a local Postgres. Nothing is
// mocked.
//
// The story:
//   1. Ana tutors, Ben is her student, Cleo is a stranger. Each app writes its hosts record, card,
//      and (Ana) an offer on the host the index reads in full. Nobody holds a row yet: the index
//      keeps the records and shows no one.
//   2. The foundation's issuer signs Ana and Ben a note, a stranger signs Cleo one. Each registers a
//      row with a person proof from its note. The index reads the rows of the issuers it trusts: Ana
//      and Ben appear, from the records it already held; Cleo, whose issuer it does not trust, does
//      not.
//   3. Ana lets an access key write offers: its offer counts. Ben writes a private record: the index
//      leaves it alone.
//   4. A paid deal: Ben pays Ana in one tap through the escrow; they review each other.
//   5. The scores, signed, and the pages.
//
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
//
// Needs: DATABASE_URL (a Postgres the test may create and drop a database in); the two programs
// built (`cargo build-sbf --arch v3` in forest/registry/program and forest/escrow/program); the
// person circuit's files (committed in forest/registry/circuit/devnet); and `solana-test-validator`
// on the PATH. If any is missing the test says which and skips.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import pg from 'pg'

import { issuerSecret, mainKey, type MainKey } from '../../forest/keys/src/index.ts'
import { Host } from '../../forest/records/src/host.ts'
import { hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, accessRecord } from '../../forest/records/src/index.ts'
import { PROGRAM_ID as REGISTRY_ID, type SignedNote, buildRegistration, issuerKeyOf, signNote } from '../../forest/registry/client/src/index.ts'
import { PROGRAM_ID as ESCROW_ID, payInOneTap, termsFor, keysFor } from '../../forest/escrow/client/src/index.ts'

import { issuerHex } from '../src/chain/registry.ts'
import { INDEX_ROOT, loadConfig } from '../src/config.ts'
import { startIndex } from '../src/main.ts'
import { verify } from '../src/scores/sign.ts'
import { serveMarkets } from './markets-repo.ts'

const FOREST = join(INDEX_ROOT, '../forest')
const REGISTRY_SO = join(FOREST, 'registry/program/target/deploy/forest_registry.so')
const ESCROW_SO = join(FOREST, 'escrow/program/target/deploy/forest_escrow.so')
const ARTIFACTS = { wasm: join(FOREST, 'registry/circuit/devnet/person.wasm'), zkey: join(FOREST, 'registry/circuit/devnet/person.zkey') }
const RPC_PORT = 18899
const RPC = `http://127.0.0.1:${RPC_PORT}`
/** A classic mint at USDC's address, which the index's config counts. */
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const SELLER = 'online-tutors/seller'
const BUYER = 'online-tutors/buyer'

function missing(): string | null {
  if (!process.env.DATABASE_URL) return 'DATABASE_URL is not set'
  if (!existsSync(REGISTRY_SO)) return 'the registry is not built; run `cargo build-sbf --arch v3` in forest/registry/program'
  if (!existsSync(ESCROW_SO)) return 'the escrow is not built; run `cargo build-sbf --arch v3` in forest/escrow/program'
  if (!existsSync(ARTIFACTS.zkey)) return "no person circuit's files in forest/registry/circuit/devnet"
  if (spawnSync('solana-test-validator', ['--version']).status !== 0) return 'solana-test-validator is not on the PATH'
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => Promise<boolean> | boolean, ms: number, what: string) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
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
    pubkey: USDC.toBase58(),
    account: { lamports: 1_461_600, data: [data.toString('base64'), 'base64'], owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: MINT_SIZE },
  })
}

test('the index, end to end', { timeout: 600_000 }, async (t) => {
  const why = missing()
  if (why) return t.skip(why)

  const cleanups: (() => Promise<void> | void)[] = []
  try {
    // --- Postgres: a database of its own, dropped at the end ---------------------------------
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await admin.connect()
    const dbName = `forest_index_e2e_${randomBytes(4).toString('hex')}`
    await admin.query(`create database ${dbName}`)
    cleanups.push(async () => {
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

    // --- The chain: a local validator with the two programs and a USDC-shaped mint ------------
    const payer = Keypair.generate()
    const scratch = mkdtempSync(join(tmpdir(), 'forest-index-e2e-'))
    writeFileSync(join(scratch, 'usdc.json'), usdcAccountJson(payer.publicKey))
    const validator: ChildProcess = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', join(scratch, 'ledger'), '--rpc-port', String(RPC_PORT), '--faucet-port', '19900',
        '--bpf-program', REGISTRY_ID.toBase58(), REGISTRY_SO,
        '--bpf-program', ESCROW_ID.toBase58(), ESCROW_SO,
        '--account', USDC.toBase58(), join(scratch, 'usdc.json'),
      ],
      { stdio: 'ignore' },
    )
    cleanups.push(() => {
      validator.kill('SIGKILL')
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
      tx.feePayer = signers[0]!.publicKey
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
      tx.sign(...signers)
      return confirm(await connection.sendRawTransaction(tx.serialize()))
    }
    await confirm(await connection.requestAirdrop(payer.publicKey, 100 * LAMPORTS_PER_SOL))

    // --- Two issuers, each with its note key and its name -------------------------------------
    const issuer = (name: string) => {
      const privateKey = new Uint8Array(randomBytes(32))
      return { name, privateKey, key: issuerHex(issuerKeyOf(privateKey)) }
    }
    const foundation = issuer('issuer.foundation.example')
    const stranger = issuer('issuer.stranger.example')

    // --- People: a seed each, a profile per label, a note from one issuer ----------------------
    type Person = { profile: MainKey; signer: Keypair; secret: Uint8Array; note: SignedNote; name: string }
    const person = async (label: string, name: string, by: ReturnType<typeof issuer>): Promise<Person> => {
      const seed = new Uint8Array(randomBytes(32))
      const profile = await mainKey(seed, label)
      const { secret, noteNumber } = await issuerSecret(seed, by.name)
      const note = signNote(by.privateKey, { noteNumber, embedding: new Uint8Array(512), model: 'stand-in', tier: 1n })
      return { profile, signer: Keypair.fromSeed(profile.privateKey), secret, note, name }
    }
    const ana = await person(SELLER, 'Ana', foundation)
    const ben = await person(BUYER, 'Ben', foundation)
    const cleo = await person(SELLER, 'Cleo', stranger)

    // --- The host the index reads in full, and the index on its three lists ---------------------
    const host = new Host()
    const hostUrl = await host.listen(0)
    cleanups.push(() => host.close())
    const markets = await serveMarkets()
    cleanups.push(() => markets.close())
    writeFileSync(join(scratch, 'hosts.json'), JSON.stringify({ hosts: [hostUrl] }))
    writeFileSync(join(scratch, 'markets.json'), JSON.stringify({ directory: markets.url, markets: ['online-tutors', 'language-exchange'] }))
    writeFileSync(join(scratch, 'issuers.json'), JSON.stringify({ issuers: { [foundation.key]: { name: 'Forest Foundation', weight: 1 } } }))
    const config = loadConfig({
      DATABASE_URL: dbUrl.toString(),
      INDEX_SIGNING_SEED: '09'.repeat(32),
      HOSTS_FILE: join(scratch, 'hosts.json'),
      MARKETS_FILE: join(scratch, 'markets.json'),
      ISSUERS_FILE: join(scratch, 'issuers.json'),
      SOLANA_RPC_URL: RPC,
      REGISTRY_PROGRAM_ID: REGISTRY_ID.toBase58(),
      ESCROW_PROGRAM_ID: ESCROW_ID.toBase58(),
      CHAIN_COMMITMENT: 'confirmed',
      POLL_MS: '3600000',
    })
    const errors: unknown[] = []
    const index = await startIndex(config, { listen: false, onError: (err) => errors.push(err) })
    cleanups.push(() => index.stop())
    const page = async (path: string) => {
      const res = await index.web.handle(new Request(`${config.publicUrl}${path}`))
      return { status: res.status, body: res.headers.get('content-type')?.startsWith('application/json') ? await res.json() : await res.text() }
    }
    const read = async () => {
      await index.records!.pollOnce()
      await index.chain!.pollOnce()
      await index.scorer.now()
    }

    // --- 1. Records before any row: kept, shown nowhere ------------------------------------------
    const card = (p: Person, label: string) => ({ name: p.name, market: label.split('/')[0]!, role: label.split('/')[1]!, createdAt: new Date().toISOString() })
    const t0 = Date.now()
    const offer = { direction: 'offer', description: 'Portuguese conversation, online.', price: { amount: '25', mint: USDC.toBase58(), per: 'hour' }, remote: true, createdAt: new Date(t0).toISOString(), subjects: ['portuguese'] }
    for (const [p, label, more] of [[ana, SELLER, [ownerRecord(ana.profile, 'offer/portuguese', offer, t0)]], [ben, BUYER, []], [cleo, SELLER, []]] as const) {
      const out = await publish([hostUrl], [hostsRecord(p.profile, [hostUrl], t0), ownerRecord(p.profile, 'profile', card(p, label), t0), ...more])
      assert.ok(out[0]!.results.every((r) => r.ok), JSON.stringify(out))
    }
    await read()
    for (const p of [ana, ben, cleo]) assert.equal((await page(`/profiles/${p.profile.address}.json`)).status, 404, 'no row yet: no profile shown')
    assert.equal((await index.db.query('select count(*)::int as n from host_records')).rows[0].n, 7, 'every record kept')

    // --- 2. Rows, each from a person proof of its note ------------------------------------------
    const register = async (p: Person, label: string) => {
      const r = await buildRegistration({
        secret: p.secret,
        note: p.note,
        label,
        profile: p.signer.publicKey as never,
        artifacts: ARTIFACTS,
        payer: payer.publicKey as never,
        recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash,
      })
      await send([r.instruction as never], [payer, p.signer])
      return r.row.toBase58()
    }
    const anaRow = await register(ana, SELLER)
    await register(ben, BUYER)
    await register(cleo, SELLER)
    await read()
    const anaPage = (await page(`/profiles/${ana.profile.address}.json`)).body
    assert.deepEqual(anaPage.stamps.map((s: any) => [s.label, s.counted, s.issuer.key, s.row]), [[SELLER, true, foundation.key, anaRow]])
    assert.deepEqual(anaPage.offers.map((o: any) => o.uri), [`${ana.profile.address}/offer/portuguese`], 'from the records it already held')
    assert.equal((await page(`/profiles/${ben.profile.address}.json`)).status, 200)
    assert.equal((await page(`/profiles/${cleo.profile.address}.json`)).status, 404, 'an issuer the index does not trust: no row counts')
    assert.equal((await index.db.query('select count(*)::int as n from rows')).rows[0].n, 2, 'only the trusted issuer’s rows are read')

    // --- 3. An access key's offer, and a private record ------------------------------------
    const access = keyFromPrivate(new Uint8Array(randomBytes(32)))
    const t1 = Date.now()
    await publish([hostUrl], [permissionsRecord(ana.profile, [{ key: access.address, scope: 'write', paths: ['offer'] }], t1)])
    await publish([hostUrl], [accessRecord(access, ana.profile.address, 'offer/physics', { ...offer, description: 'Physics, online.', subjects: ['physics'] }, t1 + 1)])
    await publish([hostUrl], [ownerRecord(ben.profile, 'message/ana', { private: Buffer.from(randomBytes(64)).toString('base64url') }, t1)])
    await read()
    const offers = (await page(`/profiles/${ana.profile.address}.json`)).body.offers.map((o: any) => o.uri).sort()
    assert.deepEqual(offers, [`${ana.profile.address}/offer/physics`, `${ana.profile.address}/offer/portuguese`], 'the access key’s offer counts')
    assert.equal(JSON.stringify((await page(`/profiles/${ben.profile.address}.json`)).body).includes('message/ana'), false, 'the private record is not shown')

    // --- 4. A paid deal, and reviews both ways --------------------------------------------------
    // Ben's dollars, and Ana's standard account, which the escrow pays her at.
    const benUsdc = getAssociatedTokenAddressSync(USDC, ben.signer.publicKey)
    const anaUsdc = getAssociatedTokenAddressSync(USDC, ana.signer.publicKey)
    await send(
      [
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, benUsdc, ben.signer.publicKey, USDC),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, anaUsdc, ana.signer.publicKey, USDC),
        createMintToInstruction(USDC, benUsdc, payer.publicKey, 50_000_000n),
      ],
      [payer],
    )
    const token = { mint: USDC, program: TOKEN_PROGRAM_ID, decimals: 6 }
    const terms = termsFor(undefined, { seller: ana.signer.publicKey as never, amount: 25_000_000n })
    await send(payInOneTap({ buyer: ben.signer.publicKey as never, payer: payer.publicKey as never, token: token as never, terms }) as never, [payer, ben.signer])
    const deal = keysFor({ buyer: ben.signer.publicKey as never, payer: payer.publicKey as never, mint: USDC as never, terms }).escrow.toBase58()
    const t2 = Date.now()
    const review = (subject: string) => ({ subject, ratings: { overall: '10' }, text: 'Good.', dealId: deal, createdAt: new Date(t2).toISOString() })
    await publish([hostUrl], [ownerRecord(ben.profile, 'review/1', review(ana.profile.address), t2), ownerRecord(ana.profile, 'review/1', review(ben.profile.address), t2)])
    await read()

    // --- 5. The scores, signed, and the pages ----------------------------------------------------
    const dealPage = (await page(`/deals/${deal}.json`)).body
    assert.deepEqual([dealPage.receipt.outcome, dealPage.receipt.amount, dealPage.reviews.length], ['releasedToSeller', '25000000', 2])
    const ana2 = (await page(`/profiles/${ana.profile.address}.json`)).body
    assert.deepEqual(ana2.reviews.received.map((r: any) => [r.counted, r.evidence.kind, r.evidence.weight]), [[true, 'oneSidedConfirmed', 1]])
    const keys = (await page('/index.json')).body.index.keys
    for (const s of [ana2.scores.standing, ana2.scores.rating, ...ana2.scores.uniqueness]) assert.equal(verify(s.signed, keys), true)
    assert.equal(ana2.scores.rating.value, 10)
    for (const path of ['/', `/profiles/${ana.profile.address}`, `/profiles/${ben.profile.address}`, `/deals/${deal}`, '/markets/online-tutors']) {
      assert.equal((await page(path)).status, 200, path)
    }
    assert.deepEqual(errors, [], 'nothing went wrong along the way')
  } finally {
    for (const c of cleanups.reverse()) await c()
  }
})
