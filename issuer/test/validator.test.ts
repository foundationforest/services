// The issuer end to end against a real validator: the registry program loaded and initialized, the
// service started from its environment variables with the real chain client and a stand-in Didit,
// three people through it, one batch, and the three commitments read back out of the list.
//
//   npm run test:validator
//
// Needs `solana-test-validator` on the PATH and the program built (`cargo build-sbf` in
// registry/program). If either is missing, or something already answers on the validator's port,
// the test says so and skips rather than failing for the wrong reason.
//
// Like the registry client's test, everything polls rather than opening a websocket, which would keep
// Node alive after the test.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, type PublicKey } from '@solana/web3.js'

import { commitmentOf } from '../../registry/client/src/code.ts'
import { fetchListLeaves } from '../../registry/client/src/leaves.ts'
import {
  FOUNDATION_ISSUER,
  FOUNDATION_ISSUER_PLACEHOLDER_SEED,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  initIx,
} from '../../registry/client/src/program.ts'
import { readConfig, startIssuer } from '../src/service.ts'
import { FakeFaceCheck, WORKFLOW, assertFileHolds, assertNoLink, passed } from './fakes.ts'

const here = dirname(fileURLToPath(import.meta.url))
const soPath = join(here, '../../registry/program/target/deploy/forest_registry.so')
const RPC = 'http://127.0.0.1:8899'

const payer = Keypair.generate()
let validator: ChildProcess | undefined
let exited = false
let skip: string | undefined
const temp = mkdtempSync(join(tmpdir(), 'forest-issuer-validator-'))
const connection = new Connection(RPC, 'confirmed')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * `init` reads USDC's mint and checks it counts in six decimals, so the validator starts with a
 * classic SPL Token mint planted at USDC's address (82 bytes, the layout the registry client's own
 * validator test writes with `@solana/spl-token`).
 */
function usdcMintJson(authority: PublicKey): string {
  const data = Buffer.alloc(82)
  data.writeUInt32LE(1, 0) // mint_authority: Some
  authority.toBuffer().copy(data, 4)
  data[44] = 6 // decimals
  data[45] = 1 // is_initialized
  return JSON.stringify({
    pubkey: USDC_MINT.toBase58(),
    account: {
      lamports: 1_461_600,
      data: [data.toString('base64'), 'base64'],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: 82,
    },
  })
}

async function answers(): Promise<boolean> {
  try {
    await connection.getVersion()
    return true
  } catch {
    return false
  }
}

async function confirm(signature: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await sleep(250)
  }
  throw new Error(`${signature} was never confirmed`)
}

before(
  async () => {
    if (!existsSync(soPath)) return void (skip = `no program at ${soPath}; run \`cargo build-sbf\` in registry/program`)
    if (await answers()) return void (skip = `something already answers on ${RPC}; stop it first`)
    // Not inside the ledger directory: `--reset` empties that before `--account` files are read.
    const mint = join(temp, 'usdc.json')
    writeFileSync(mint, usdcMintJson(payer.publicKey))
    validator = spawn(
      'solana-test-validator',
      ['--reset', '--quiet', '--ledger', join(temp, 'ledger'), '--bpf-program', PROGRAM_ID.toBase58(), soPath, '--account', USDC_MINT.toBase58(), mint],
      { stdio: 'ignore' },
    )
    validator.on('error', () => (exited = true))
    validator.on('exit', () => (exited = true))
    for (let i = 0; i < 90 && !exited; i++) {
      if (await answers()) return
      await sleep(1000)
    }
    skip = 'solana-test-validator did not start (is it on the PATH?)'
  },
  { timeout: 150_000 },
)

after(() => {
  validator?.kill('SIGKILL')
  rmSync(temp, { recursive: true, force: true })
})

test('face check to list: submit, batch, and the commitments are the list’s leaves', { timeout: 300_000 }, async (t) => {
  if (skip) return t.skip(skip)

  // The registry as `init` leaves it: list 0 open, owned by the foundation's issuer key, which the
  // placeholder seed signs for. The issuer key pays its own inserts, so it needs a little SOL.
  const issuerKey = Keypair.fromSeed(FOUNDATION_ISSUER_PLACEHOLDER_SEED)
  assert.equal(issuerKey.publicKey.toBase58(), FOUNDATION_ISSUER.toBase58())
  await confirm(await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL))
  await confirm(await connection.requestAirdrop(issuerKey.publicKey, LAMPORTS_PER_SOL))
  const init = new Transaction().add(initIx({ payer: payer.publicKey }))
  init.feePayer = payer.publicKey
  init.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  init.sign(payer)
  await confirm(await connection.sendRawTransaction(init.serialize()))

  // The key's contents in a variable, as a sealed variable brings them on Railway.
  const env: Record<string, string> = {
    DIDIT_API_KEY: 'not-used-with-the-stand-in',
    DIDIT_WORKFLOW_ID: WORKFLOW,
    SOLANA_RPC_URL: RPC,
    DATABASE_PATH: join(temp, 'data', 'issuer.sqlite'),
    BATCH_MAX: '50',
    BATCH_INTERVAL_SECONDS: '3600',
    PORT: '0',
  }

  // A key that is not one of the list's insert keys is refused at start, not at the first batch. This
  // one comes from a file, as in a local run.
  const strangerPath = join(temp, 'stranger-keypair.json')
  writeFileSync(strangerPath, JSON.stringify([...Keypair.generate().secretKey]))
  await assert.rejects(
    startIssuer(readConfig({ ...env, ISSUER_KEYPAIR_PATH: strangerPath })),
    /is not an insert key of list 0/,
  )

  const faces = new FakeFaceCheck()
  const logs: string[] = []
  const issuer = await startIssuer(readConfig({ ...env, ISSUER_KEYPAIR: JSON.stringify([...issuerKey.secretKey]) }), {
    faceCheck: faces,
    log: (line) => logs.push(line),
  })
  assert.ok(issuer.keyFile, 'the key went through a file of its own')
  assert.equal(existsSync(issuer.keyFile), false, 'which is gone once the key is loaded')
  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(issuer.url + path, { method: 'POST', body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }

  const sessionIds: string[] = []
  const commitments: bigint[] = []
  try {
    // Each person: a session, the face check (Didit's part, here the stand-in's), then the
    // commitment the app computes from the identity secret `keys/` derives.
    for (let i = 0; i < 3; i++) {
      const { body } = await post('/session')
      faces.set(body.sessionId, passed())
      const commitment = commitmentOf(randomBytes(32))
      const submitted = await post('/submit', { sessionId: body.sessionId, commitment: commitment.toString() })
      assert.deepEqual(submitted, { status: 202, body: { status: 'queued' } })
      sessionIds.push(body.sessionId)
      commitments.push(commitment)
    }
    for (const c of commitments) assert.deepEqual((await post('/status', { commitment: c.toString() })).body, { status: 'queued' })
    assertFileHolds(env.DATABASE_PATH, commitments)

    await issuer.batcher.flush()
    assert.deepEqual(logs, ['issuer: batch of 3 inserted'])

    const { leaves } = await fetchListLeaves(connection, 0)
    assert.deepEqual([...leaves].sort(), [...commitments].sort(), 'the list holds exactly the three')
    for (const c of commitments) assert.deepEqual((await post('/status', { commitment: c.toString() })).body, { status: 'listed' })
    assert.deepEqual(await post('/submit', { sessionId: sessionIds[0], commitment: commitmentOf(randomBytes(32)).toString() }), {
      status: 409,
      body: { error: 'session_used' },
    })
  } finally {
    await issuer.close()
  }
  assertNoLink(env.DATABASE_PATH, sessionIds, commitments)
})
