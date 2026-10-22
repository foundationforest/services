// What a run runs against (services.json), and the loop's own copy of each service, on loopback,
// from this repo's folders. A service the file names (an origin) is used as it is deployed; one it
// leaves null, the loop starts here. The issuer and the index are always the loop's own: a deployed
// issuer checks real faces, and a script has none, and a deployed index trusts only that issuer. A
// named issuer or index is only checked to answer. The chain is always remote, through the RPC.
//
//   the issuer     issuer/src, with the stand-in Didit its tests run (issuer/test/fake-didit.ts,
//                  a process of its own) and the stand-in face model; its own name and seed in a
//                  directory of its own; no gift, since a deployed host takes no loop's tickets
//   the host       host/src, started as its tests start it, with a plain fetch, so it reads a
//                  sender's records from a host on loopback; selling credits for the test dollar,
//                  paid to `payTo`, and checked through the RPC
//   the fee payer  fee-payer/run.sh, a process of its own: Kora, with the kora.toml its image runs
//                  (fee-payer/deploy/devnet-config.sh), a fresh key made at its first start, which
//                  the loop funds (chain.ts)
//   the index      index/src, with lists of its own: the host it reads, the loop issuer's two keys
//                  (the face check 1 point, the ID check 2, as the foundation's index lists them),
//                  and its own reputation proofs; its numbers and money are index/config's
//   mcp            mcp/src's MCP door over HTTP, starting from the host and reading the index
//
// Each process of its own gets only the settings it needs, never the phrase, and what it prints
// comes here with the RPC's URL taken out.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig as hostConfig, startHost } from '../host/src/host.ts'
import { startIndex } from '../index/src/index.ts'
import { readConfig as issuerConfig, startIssuer } from '../issuer/src/service.ts'
import { hostsFrom } from '../mcp/src/forest.ts'
import { serveHttp } from '../mcp/src/mcp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/** services.json: each service's origin, or null for the loop's own; the RPC, the escrow, the test dollar, the market. */
export type Services = {
  host: string | null
  issuer: string | null
  feePayer: string | null
  index: string | null
  mcp: string | null
  rpc: string
  escrow: string
  testDollar: string
  market: string
}

const SERVICES = ['host', 'issuer', 'feePayer', 'index', 'mcp'] as const

/** services.json at `path`, checked: each service null or an origin, and the rest named. */
export function readServices(path: string): Services {
  const s = JSON.parse(readFileSync(path, 'utf8')) as { [key: string]: unknown }
  for (const name of SERVICES) {
    const v = s[name]
    if (v !== null && !(typeof v === 'string' && URL.canParse(v) && new URL(v).origin === v)) throw new Error(`${path}: ${name} is null or an origin`)
  }
  for (const name of ['rpc', 'escrow', 'testDollar', 'market']) if (typeof s[name] !== 'string' || !s[name]) throw new Error(`${path}: ${name} is needed`)
  return s as Services
}

/** The loop issuer's name, which each person's note number at it is mixed from: one no real issuer has. */
export const ISSUER_NAME = 'issuer.e2e-loop.invalid'
/** The stand-in Didit's two workflows. */
const FACE_WORKFLOW = '00000000-0000-4000-8000-00000000f0ce'
const ID_WORKFLOW = '00000000-0000-4000-8000-0000000001d0'

export type Running = {
  issuer: { url: string; name: string; keys: { face: string; id: string } }
  host: string
  feePayer: string
  index: { url: string; address: string }
  mcp: string
  /** The loop's own fee payer's key, which the loop funds; null when the fee payer is deployed. */
  ownFeePayer: string | null
  stop(): Promise<void>
}

/** A port nothing on this machine listens on, now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Waits until `url` answers, or `child` stops, or two minutes pass. */
async function answers(url: string, child?: ChildProcess): Promise<void> {
  const until = Date.now() + 120_000
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`${url}: the process stopped (${child.exitCode})`)
    try {
      await fetch(url)
      return
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

/**
 * The deployed issuer and index a services.json names, which the loop does not use: each answers,
 * and the issuer says its name and its two keys.
 */
async function deployedAnswer(s: Services, say: (line: string) => void): Promise<void> {
  if (s.issuer) {
    const res = await fetch(`${s.issuer}/`)
    const about = (await res.json()) as { name?: string; face?: { key?: string }; id?: { key?: string } }
    if (res.status !== 200 || !about.name || !about.face?.key || !about.id?.key) throw new Error(`the deployed issuer ${s.issuer} does not say who it is`)
    say(`the deployed issuer ${about.name} answers, with its face key ${about.face.key} and ID key ${about.id.key}`)
  }
  if (s.index) {
    const res = await fetch(`${s.index}/index.json`)
    if (res.status !== 200) throw new Error(`the deployed index ${s.index} answered ${res.status}`)
    say(`the deployed index ${((await res.json()) as { index: string }).index} answers`)
  }
}

/**
 * The services a run uses: the loop's own issuer and index, and each other service as `s` names it
 * or the loop's own. `rpcUrl` is the run's RPC; `payTo` the address the loop host's credits are paid
 * to. `stop` ends what the loop started and deletes its directory, whatever happened.
 */
export async function startServices(s: Services, o: { rpcUrl: string; payTo: string; say: (line: string) => void; redact: (text: string) => string }): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'forest-e2e-'))
  const children: ChildProcess[] = []
  const closers: (() => Promise<void>)[] = []
  const stop = async () => {
    for (const close of closers.reverse()) await close().catch((err) => o.say(o.redact(`a service did not close: ${(err as Error).message}`)))
    for (const child of children) await stopped(child)
    rmSync(dir, { recursive: true, force: true })
  }
  const log = (name: string) => (line: string) => {
    for (const l of o.redact(line).split('\n').filter(Boolean)) console.log(`  [${name}] ${l}`)
  }
  const child = (name: string, command: string, args: string[], cwd: string, env: Record<string, string>) => {
    const c = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [c.stdout!, c.stderr!]) stream.on('data', (chunk: Buffer) => log(name)(chunk.toString('utf8')))
    children.push(c)
    return c
  }
  try {
    await deployedAnswer(s, o.say)

    // The issuer: the stand-in Didit first, then the issuer, which makes its seed in its directory.
    const diditPort = await freePort()
    const didit = child('stand-in Didit', process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fake-didit.ts'], join(repo, 'issuer'), {
      FAKE_DIDIT_PORT: String(diditPort),
      FAKE_DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
      FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    })
    await answers(`http://127.0.0.1:${diditPort}/`, didit)
    const issuer = await startIssuer(
      issuerConfig({
        ISSUER_NAME,
        DIDIT_API_KEY: 'stand-in',
        DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
        DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
        DIDIT_BASE_URL: `http://127.0.0.1:${diditPort}`,
        FACE_MODEL: 'stand-in',
        DATABASE_PATH: join(dir, 'issuer', 'issuer.sqlite'),
        PORT: '0',
      }),
      { log: log('loop issuer') },
    )
    closers.push(() => issuer.close())

    // The host: started as its tests start it, selling for the test dollar.
    let host = s.host
    if (!host) {
      const port = await freePort()
      host = `http://127.0.0.1:${port}`
      const settings = { DATA_DIR: join(dir, 'host'), PUBLIC_ORIGIN: host, PORT: String(port), CREDIT_MINT: s.testDollar, CREDIT_PAY_TO: o.payTo, RPC_URL: o.rpcUrl }
      const h = await startHost(hostConfig(settings), { fetch })
      closers.push(() => h.close())
    }

    // The fee payer: Kora, through run.sh, with its image's kora.toml and a new key.
    let feePayer = s.feePayer
    let ownFeePayer: string | null = null
    if (!feePayer) {
      const port = await freePort()
      feePayer = `http://127.0.0.1:${port}`
      const config = join(dir, 'kora.toml')
      writeFileSync(config, execFileSync('bash', [join(repo, 'fee-payer/deploy/devnet-config.sh'), join(repo, 'fee-payer/kora.toml')]))
      const kora = child('loop fee payer', 'bash', [join(repo, 'fee-payer/run.sh')], join(repo, 'fee-payer'), {
        RPC_URL: o.rpcUrl,
        KEY_PATH: join(dir, 'fee-payer', 'fee-payer-keypair.json'),
        KORA_CONFIG: config,
        PORT: String(port),
        RUST_LOG: 'warn',
      })
      await answers(`${feePayer}/liveness`, kora)
      const res = await fetch(feePayer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPayerSigner', params: {} }) })
      ownFeePayer = ((await res.json()) as { result: { signer_address: string } }).result.signer_address
    }

    // The index: its own lists, beside index/config.
    const lists = join(dir, 'index-lists')
    mkdirSync(join(lists, 'lists'), { recursive: true })
    cpSync(join(repo, 'index/config'), join(lists, 'config'), { recursive: true })
    const about = 'The e2e loop index’s, for one run.'
    const write = (file: string, body: object) => writeFileSync(join(lists, 'lists', file), JSON.stringify({ about, ...body }))
    write('hosts.json', { hosts: [host] })
    write('issuers.json', {
      keys: [
        { key: issuer.keys.face, issuer: ISSUER_NAME, label: 'face check', points: 1 },
        { key: issuer.keys.id, issuer: ISSUER_NAME, label: 'ID check', points: 2 },
      ],
    })
    write('indexes.json', { roots: 10, indexes: [{ index: 'self', name: 'e2e loop index' }] })
    const indexPort = await freePort()
    const indexUrl = `http://127.0.0.1:${indexPort}`
    const index = await startIndex({ dataDir: join(dir, 'index'), publicUrl: indexUrl, rpcUrl: o.rpcUrl, readSeconds: 5, listsRoot: lists, port: indexPort, hostname: '127.0.0.1', log: log('loop index') })
    closers.push(() => index.close())

    // mcp: the MCP door over HTTP, as the foundation's copy serves it, starting from the host.
    let mcp = s.mcp
    if (!mcp) {
      const server: Server = await serveHttp({ hosts: hostsFrom([host]), index: indexUrl }, {}, '127.0.0.1', 0)
      mcp = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      closers.push(() => new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }))
    }

    return { issuer: { url: issuer.url, name: ISSUER_NAME, keys: issuer.keys }, host, feePayer, index: { url: indexUrl, address: index.address }, mcp, ownFeePayer, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
