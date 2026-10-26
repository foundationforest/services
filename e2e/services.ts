// What a run runs against (services.json), and the loop's own copy of each service, on loopback,
// from this repo's folders. A host or a fee payer the file names (an origin) is used as it is
// deployed; one it leaves null, the loop starts here. The verifier, the index and the mcp are always
// the loop's own: a deployed verifier checks real faces, and a script has none; a deployed index
// trusts only that verifier; and the deployed mcp has no connect page for an AI to log in through
// (its APP_URL is unset), so no AI can act there. A named verifier, index or mcp is only checked to
// answer. The chain is always remote, through the RPC.
//
//   the verifier   verifier/src, with the stand-in Didit its tests run (verifier/test/fake-didit.ts,
//                  a process of its own) and the stand-in face model; its own name and seed in a
//                  directory of its own; no gift, since a deployed host takes no loop's tickets
//   the host       host/src, as `npm start` runs it, selling credits for the loop's dollar, paid to
//                  `payTo`, and checked through the RPC
//   the fee payer  fee-payer/run.sh, a process of its own: Kora, with the kora.toml its image runs
//                  (fee-payer/deploy/devnet-config.sh), a fresh key made at its first start, which
//                  the loop funds, and sweeps back when the run ends (chain.ts)
//   the index      index/src, with lists of its own: the host it reads, the loop verifier's two keys
//                  (the face check 1 point, the ID check 2, as the foundation's index lists them),
//                  and its own reputation proofs; its numbers, money and chains are index/config's
//   the mcp        mcp/src, reading the host and the loop's index, with `appUrl` as its connect page:
//                  the loop's stand-in for the Forest app's
//
// Each process of its own gets only the settings it needs, never the phrase, and what it prints
// comes here with the RPC's URL taken out.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readConfig as hostConfig, startHost } from '../host/src/host.ts'
import { startIndex } from '../index/src/index.ts'
import { hostsFrom } from '../mcp/src/forest.ts'
import { serve } from '../mcp/src/server.ts'
import { aiApp } from '../mcp/test/setup.ts'
import { readConfig as verifierConfig, startVerifier } from '../verifier/src/service.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/** services.json: each service's origin, or null for the loop's own; the RPC, the escrow, the dollar the loop pays in, the market. */
export type Services = {
  verifier: string | null
  host: string | null
  feePayer: string | null
  index: string | null
  mcp: string | null
  rpc: string
  escrow: string
  testDollar: string
  market: string
}

const SERVICES = ['verifier', 'host', 'feePayer', 'index', 'mcp'] as const

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

/** The loop verifier's name, which each person's stamp number and tags at it are mixed from: one no real verifier has. */
export const VERIFIER_NAME = 'verifier.e2e-loop.invalid'
/** The stand-in Didit's two workflows. */
const FACE_WORKFLOW = '00000000-0000-4000-8000-00000000f0ce'
const ID_WORKFLOW = '00000000-0000-4000-8000-0000000001d0'

export type Running = {
  verifier: { url: string; name: string; keys: { face: string; id: string } }
  host: string
  feePayer: string
  index: { url: string; address: string }
  /** The loop's own mcp: its origin, which a person's rules name as the connector. */
  mcp: string
  /** The loop's own fee payer's key, which the loop funds; null when the fee payer is deployed. */
  ownFeePayer: string | null
  /**
   * That key's secret, its keypair file's 64 bytes, read once Kora made it and before `stop` deletes
   * it: what sweeps back what the fee payer holds when the run ends. Null when the fee payer is
   * deployed.
   */
  ownFeePayerKey: Uint8Array | null
  /** The deployed services the run only checked to answer. */
  checked: string[]
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
 * The deployed verifier, index and mcp a services.json names, which the loop does not use: each
 * answers. The verifier says its name and its two keys; the mcp, through the MCP SDK's client with
 * no login, lists its tools and reads the markets.
 */
async function deployedAnswer(s: Services, say: (line: string) => void): Promise<string[]> {
  if (s.verifier) {
    const res = await fetch(`${s.verifier}/`)
    const about = (await res.json()) as { name?: string; face?: { key?: string }; id?: { key?: string } }
    if (res.status !== 200 || !about.name || !about.face?.key || !about.id?.key) throw new Error(`the deployed verifier ${s.verifier} does not say who it is`)
    say(`the deployed verifier ${about.name} answers, with its face key ${about.face.key} and ID key ${about.id.key}`)
  }
  if (s.index) {
    const res = await fetch(`${s.index}/index.json`)
    if (res.status !== 200) throw new Error(`the deployed index ${s.index} answered ${res.status}`)
    say(`the deployed index ${((await res.json()) as { index: string }).index} answers`)
  }
  if (s.mcp) {
    const { client } = await aiApp(s.mcp)
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name)
      const markets = (await client.callTool({ name: 'markets', arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> }
      if (markets.isError || !tools.includes('post')) throw new Error(`the deployed mcp ${s.mcp} does not answer as an mcp`)
      say(`the deployed mcp answers: ${tools.length} tools, and the markets`)
    } finally {
      await client.close()
    }
  }
  return [s.verifier, s.index, s.mcp].filter((o): o is string => o !== null)
}

/**
 * The services a run uses: the loop's own verifier, index and mcp, and the host and the fee payer as
 * `s` names them or the loop's own. `rpcUrl` is the run's RPC; `payTo` the address the loop host's
 * credits are paid to; `appUrl` the connect page the mcp sends a person's browser to. `stop` ends
 * what the loop started and deletes its directory, whatever happened.
 */
export async function startServices(s: Services, o: { rpcUrl: string; payTo: string; appUrl: string; say: (line: string) => void; redact: (text: string) => string }): Promise<Running> {
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
    const checked = await deployedAnswer(s, o.say)

    // The verifier: the stand-in Didit first, then the verifier, which makes its seed in its directory.
    const diditPort = await freePort()
    const didit = child('stand-in Didit', process.execPath, ['--disable-warning=ExperimentalWarning', 'test/fake-didit.ts'], join(repo, 'verifier'), {
      FAKE_DIDIT_PORT: String(diditPort),
      FAKE_DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
      FAKE_DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
    })
    await answers(`http://127.0.0.1:${diditPort}/`, didit)
    const verifier = await startVerifier(
      verifierConfig({
        VERIFIER_NAME,
        DIDIT_API_KEY: 'stand-in',
        DIDIT_FACE_WORKFLOW_ID: FACE_WORKFLOW,
        DIDIT_ID_WORKFLOW_ID: ID_WORKFLOW,
        DIDIT_BASE_URL: `http://127.0.0.1:${diditPort}`,
        FACE_MODEL: 'stand-in',
        DATABASE_PATH: join(dir, 'verifier', 'verifier.sqlite'),
        PORT: '0',
      }),
      { log: log('loop verifier') },
    )
    closers.push(() => verifier.close())

    // The host, selling for the loop's dollar.
    let host = s.host
    if (!host) {
      const port = await freePort()
      host = `http://127.0.0.1:${port}`
      const settings = { DATA_DIR: join(dir, 'host'), PUBLIC_ORIGIN: host, PORT: String(port), CREDIT_MINT: s.testDollar, CREDIT_PAY_TO: o.payTo, RPC_URL: o.rpcUrl }
      const h = await startHost(hostConfig(settings))
      closers.push(() => h.close())
    }

    // The fee payer: Kora, through run.sh, with its image's kora.toml and a new key.
    let feePayer = s.feePayer
    let ownFeePayer: string | null = null
    let ownFeePayerKey: Uint8Array | null = null
    if (!feePayer) {
      const port = await freePort()
      feePayer = `http://127.0.0.1:${port}`
      const config = join(dir, 'kora.toml')
      const keyPath = join(dir, 'fee-payer', 'fee-payer-keypair.json')
      writeFileSync(config, execFileSync('bash', [join(repo, 'fee-payer/deploy/devnet-config.sh'), join(repo, 'fee-payer/kora.toml')]))
      const kora = child('loop fee payer', 'bash', [join(repo, 'fee-payer/run.sh')], join(repo, 'fee-payer'), {
        RPC_URL: o.rpcUrl,
        KEY_PATH: keyPath,
        KORA_CONFIG: config,
        PORT: String(port),
        RUST_LOG: 'warn',
      })
      await answers(`${feePayer}/liveness`, kora)
      const res = await fetch(feePayer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getPayerSigner', params: {} }) })
      ownFeePayer = ((await res.json()) as { result: { signer_address: string } }).result.signer_address
      ownFeePayerKey = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[])
    }

    // The index: its own lists, beside index/config.
    const lists = join(dir, 'index-lists')
    mkdirSync(join(lists, 'lists'), { recursive: true })
    cpSync(join(repo, 'index/config'), join(lists, 'config'), { recursive: true })
    const about = 'The e2e loop index’s, for one run.'
    const write = (file: string, body: object) => writeFileSync(join(lists, 'lists', file), JSON.stringify({ about, ...body }))
    write('hosts.json', { hosts: [host] })
    write('verifiers.json', {
      keys: [
        { key: verifier.keys.face, verifier: VERIFIER_NAME, label: 'face check', points: 1 },
        { key: verifier.keys.id, verifier: VERIFIER_NAME, label: 'ID check', points: 2 },
      ],
    })
    write('indexes.json', { maxAgeDays: 30, indexes: [{ index: 'self', name: 'e2e loop index' }] })
    const indexPort = await freePort()
    const indexUrl = `http://127.0.0.1:${indexPort}`
    const index = await startIndex({ dataDir: join(dir, 'index'), publicUrl: indexUrl, settings: { RPC_URL: o.rpcUrl }, readSeconds: 5, listsRoot: lists, port: indexPort, hostname: '127.0.0.1', log: log('loop index') })
    closers.push(() => index.close())

    // The mcp: reading the host and the loop's index, its logins through the loop's connect page.
    const mcp = await serve({ appUrl: o.appUrl, dataDir: join(dir, 'mcp'), read: { hosts: hostsFrom([host]), index: indexUrl } }, '127.0.0.1', 0)
    closers.push(() => mcp.close())

    return { verifier: { url: verifier.url, name: VERIFIER_NAME, keys: verifier.keys }, host, feePayer, index: { url: indexUrl, address: index.address }, mcp: mcp.origin, ownFeePayer, ownFeePayerKey, checked, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
