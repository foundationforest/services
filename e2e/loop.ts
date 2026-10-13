// The loop's own issuer and index, on this machine, for one run (README.md, "Why does the loop run
// its own issuer and index?").
//
// The deployed issuer is real: it checks a face through Didit, and a script has no face. So the loop
// runs the issuer's own code (../issuer/src/main.ts) with the stand-in Didit its tests run
// (../issuer/test/fake-didit.ts), the stand-in face model, and a key it makes at its first start, in a
// directory of its own. It gives no welcome gift: the deployed host and registry payer take only the
// deployed issuer's tickets. The deployed index trusts only the deployed issuer, so the loop runs the
// index's own code (../index/src/main.ts) too: a fresh database on DATABASE_URL, the deployed host as
// the one host it reads, the loop issuer's key as the one issuer it trusts, and its own signing key as
// the one index whose proofs it shows. It reads the chain through the run's RPC, as the deployed one
// does. Everything else is deployed.
//
// Each child gets this process's environment without its secrets (the devnet phrase, the RPC's key,
// Didit's key) and with its own settings; the index alone gets the RPC's URL, which may hold that key.
// Their output goes to this console, the RPC's key taken out. `stop` ends both and drops the database.

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'

import { base58 } from '../standard/records/src/index.ts'
import { indexKeys } from '../index/src/scores/sign.ts'

const here = dirname(fileURLToPath(import.meta.url))
const NODE = [process.execPath, '--disable-warning=ExperimentalWarning']

/** The loop issuer's name, which each person's secret for it is mixed from: one no deployed issuer has. */
export const ISSUER_NAME = 'issuer.e2e-loop.invalid'
/** What the loop index calls the loop issuer and itself on its pages. */
export const ISSUER_SHOWN = 'e2e loop issuer (loopback)'
export const INDEX_SHOWN = 'e2e loop index (loopback)'
/** The stand-in Didit's two workflows. */
const WORKFLOW = '00000000-0000-4000-8000-00000000f0ce'
const ID_WORKFLOW = '00000000-0000-4000-8000-0000000001d0'

export type Loop = {
  issuer: { url: string; name: string; key: string }
  index: { url: string; address: string; database: string }
  stop(): Promise<void>
}

/** A port nothing on this machine listens on, now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** This process's environment, without what a child must never see, and with the child's own settings. */
function childEnv(settings: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(FOREST_|HELIUS_|DIDIT_|ISSUER_|INDEX_|DATABASE_|SOLANA_|REGISTRY_|HOST_|APP_|PUBLIC_|PORT$)/.test(name)) env[name] = value
  }
  return { ...env, ...settings }
}

function start(name: string, args: string[], cwd: string, settings: Record<string, string>, redact: (text: string) => string): ChildProcess {
  const child = spawn(NODE[0]!, [...NODE.slice(1), ...args], { cwd, env: childEnv(settings), stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on('data', (chunk: Buffer) => {
      for (const line of redact(chunk.toString('utf8')).split('\n').filter(Boolean)) console.log(`  [${name}] ${line}`)
    })
  }
  return child
}

/** Waits until `url` answers 200, or the child stops, or `ms` pass. */
async function answers(url: string, child: ChildProcess, ms = 120_000): Promise<void> {
  const until = Date.now() + ms
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${url}: the process stopped (${child.exitCode})`)
    try {
      if ((await fetch(url)).status === 200) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > until) throw new Error(`${url} did not answer`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

const stopped = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
  })

/** The loop issuer and the loop index, started; `rpc` is the run's RPC, `host` the deployed host. */
export async function startLoop(options: { databaseUrl: string; rpc: string; host: string; registry: string; escrow: string; redact: (text: string) => string }): Promise<Loop> {
  const dir = mkdtempSync(join(tmpdir(), 'forest-e2e-loop-'))
  const children: ChildProcess[] = []
  const admin = new pg.Client({ connectionString: options.databaseUrl })
  await admin.connect()
  const database = `forest_e2e_${Date.now()}_${randomBytes(3).toString('hex')}`
  let made = false
  const stop = async () => {
    for (const child of children.reverse()) await stopped(child)
    if (made) await admin.query(`drop database if exists ${database}`)
    await admin.end()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    // The issuer: the stand-in Didit first, then the issuer, which makes its key in its directory.
    const diditPort = await freePort()
    const didit = start('stand-in Didit', [join(here, '../issuer/test/fake-didit.ts')], join(here, '../issuer'), { FAKE_DIDIT_PORT: String(diditPort), FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW }, options.redact)
    children.push(didit)
    const issuerPort = await freePort()
    const issuerUrl = `http://127.0.0.1:${issuerPort}`
    await new Promise((r) => setTimeout(r, 300))
    const issuer = start('loop issuer', ['src/main.ts'], join(here, '../issuer'), {
      ISSUER_NAME,
      DIDIT_API_KEY: 'stand-in',
      DIDIT_WORKFLOW_ID: WORKFLOW,
      DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
      DIDIT_BASE_URL: `http://127.0.0.1:${diditPort}`,
      FACE_MODEL: 'stand-in',
      DATABASE_PATH: join(dir, 'issuer', 'issuer.sqlite'),
      PORT: String(issuerPort),
    }, options.redact)
    children.push(issuer)
    await answers(`${issuerUrl}/issuer.json`, issuer)
    const about = (await (await fetch(`${issuerUrl}/issuer.json`)).json()) as { name: string; key: string }

    // The index: a fresh database, and lists naming the deployed host, the loop issuer and itself.
    await admin.query(`create database ${database}`)
    made = true
    const url = new URL(options.databaseUrl)
    url.pathname = `/${database}`
    const seed = randomBytes(32)
    const address = base58.encode(indexKeys(new Uint8Array(seed)).ed25519.publicKey)
    const file = (name: string, body: unknown) => {
      const path = join(dir, `${name}.json`)
      writeFileSync(path, JSON.stringify(body))
      return path
    }
    const indexPort = await freePort()
    const indexUrl = `http://127.0.0.1:${indexPort}`
    const index = start('loop index', ['src/main.ts'], join(here, '../index'), {
      DATABASE_URL: url.toString(),
      INDEX_SIGNING_SEED: seed.toString('hex'),
      SOLANA_RPC_URL: options.rpc,
      REGISTRY_PROGRAM_ID: options.registry,
      ESCROW_PROGRAM_ID: options.escrow,
      CHAIN_COMMITMENT: 'confirmed',
      POLL_MS: '5000',
      PUBLIC_URL: indexUrl,
      PORT: String(indexPort),
      HOSTS_FILE: file('hosts', { hosts: [options.host] }),
      ISSUERS_FILE: file('issuers', { issuers: { [about.key]: { name: ISSUER_SHOWN, weights: { '1': 0.7, '2': 0.9 } } } }),
      INDEXES_FILE: file('indexes', { roots: 10, indexes: { [address]: { name: INDEX_SHOWN } } }),
    }, options.redact)
    children.push(index)
    await answers(`${indexUrl}/`, index)
    return { issuer: { url: issuerUrl, name: about.name, key: about.key }, index: { url: indexUrl, address, database }, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
