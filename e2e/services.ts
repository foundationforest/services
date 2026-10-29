// What a run runs against (services.json), and the loop's own copy of each service, on loopback,
// from this repo's folders. With every service null, as committed, the loop runs on its own copies.
// A file that names any service by its origin is the deployed check instead: each one named is
// checked to answer, and no loop runs. A deployed verifier checks real faces, and a script has none;
// a deployed index trusts only that verifier; a deployed host takes only its own sponsors' tickets;
// and the deployed mcp has no connect page for an AI to log in through (its APP_URL is unset).
//
//   the verifier   verifier/src, with the stand-in Didit its tests run (verifier/test/fake-didit.ts,
//                  a process of its own) and the stand-in face model; its own name and seed in a
//                  directory of its own; its gifts, credits at the loop's host
//   the host       host/src, as `npm start` runs it, the plug and the credits, taking the loop
//                  verifier's sponsor's tickets
//   the index      index/src, with lists of its own: the host it reads, the loop verifier's two keys
//                  (the face check at 0.75, the ID check at 0.95, as the foundation's index lists
//                  them), and its own reputation proofs; its numbers are index/config's
//   the mcp        mcp/src, reading the loop's index and the markets, with `appUrl` as its connect
//                  page, the loop's stand-in for the Forest app's, and reaching the host on loopback
//
// Each process of its own gets only the settings it needs.

import { type ChildProcess, spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DIRECTORY_PATH, serviceOf } from '../host/client/client.ts'
import { readConfig as hostConfig, startHost } from '../host/src/host.ts'
import { startIndex } from '../index/src/index.ts'
import { serve } from '../mcp/src/server.ts'
import { aiApp } from '../mcp/test/setup.ts'
import { readConfig as verifierConfig, startVerifier } from '../verifier/src/service.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

/** services.json: each service's origin, or null; the market the two people deal in. */
export type Services = {
  verifier: string | null
  host: string | null
  index: string | null
  mcp: string | null
  market: string
}

const SERVICES = ['verifier', 'host', 'index', 'mcp'] as const

/** services.json at `path`, checked: each service null or an origin, and the market named. */
export function readServices(path: string): Services {
  const s = JSON.parse(readFileSync(path, 'utf8')) as { [key: string]: unknown }
  for (const name of SERVICES) {
    const v = s[name]
    if (v !== null && !(typeof v === 'string' && URL.canParse(v) && new URL(v).origin === v)) throw new Error(`${path}: ${name} is null or an origin`)
  }
  if (typeof s.market !== 'string' || !s.market) throw new Error(`${path}: market is needed`)
  return s as Services
}

/** The services a file names by their origins: what the deployed check checks. */
export const named = (s: Services): string[] => SERVICES.filter((name) => s[name] !== null)

/** The loop verifier's name, which each person's stamp number at it is mixed from: one no real verifier has. */
export const VERIFIER_NAME = 'verifier.e2e-loop.invalid'
/** The confidence the loop index's lists give the loop verifier's face key, as the index's own lists give the foundation's. */
export const FACE_CONFIDENCE = 0.75
/** The stand-in Didit's two workflows. */
const FACE_WORKFLOW = '00000000-0000-4000-8000-00000000f0ce'
const ID_WORKFLOW = '00000000-0000-4000-8000-0000000001d0'

export type Running = {
  verifier: { url: string; name: string; keys: { face: string; id: string }; sponsor: string }
  host: string
  index: { url: string; address: string }
  /** The loop's own mcp: its origin, the connector a person's app locks the connection for. */
  mcp: string
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
 * The deployed check: each service `s` names answers. The verifier says its name and its two keys;
 * the host its credit directory; the index its home page's twin; the mcp, through the MCP SDK's
 * client with no login, lists its tools and reads the markets. Throws at the first that does not.
 */
export async function checkDeployed(s: Services, say: (line: string) => void): Promise<void> {
  if (s.verifier) {
    const res = await fetch(`${s.verifier}/`)
    const about = (await res.json()) as { name?: string; face?: { key?: string }; id?: { key?: string } }
    if (res.status !== 200 || !about.name || !about.face?.key || !about.id?.key) throw new Error(`the deployed verifier ${s.verifier} does not say who it is`)
    say(`the deployed verifier ${about.name} answers, with its face key ${about.face.key} and ID key ${about.id.key}`)
  }
  if (s.host) {
    const res = await fetch(`${s.host}${DIRECTORY_PATH}`)
    if (res.status !== 200) throw new Error(`the deployed host ${s.host} answered ${res.status} for its credit directory`)
    const service = serviceOf(s.host, await res.json())
    say(`the deployed host answers: a credit ${service.price} dollars, ${service.unit}`)
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
      if (markets.isError || !tools.includes('write')) throw new Error(`the deployed mcp ${s.mcp} does not answer as an mcp`)
      say(`the deployed mcp answers: ${tools.length} tools, and the markets`)
    } finally {
      await client.close()
    }
  }
}

/**
 * The loop's own verifier, host, index and mcp, on loopback. The host's port is picked first, so
 * the verifier's gift names its origin, and the host takes the tickets of the verifier's sponsor
 * key. `appUrl` is the connect page the mcp sends a person's browser to. `stop` ends what the loop
 * started and deletes its directory, whatever happened.
 */
export async function startServices(o: { appUrl: string; say: (line: string) => void }): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'forest-e2e-'))
  const children: ChildProcess[] = []
  const closers: (() => Promise<void>)[] = []
  const stop = async () => {
    for (const close of closers.reverse()) await close().catch((err) => o.say(`a service did not close: ${(err as Error).message}`))
    for (const child of children) await stopped(child)
    rmSync(dir, { recursive: true, force: true })
  }
  const log = (name: string) => (line: string) => {
    for (const l of line.split('\n').filter(Boolean)) console.log(`  [${name}] ${l}`)
  }
  const child = (name: string, command: string, args: string[], cwd: string, env: Record<string, string>) => {
    const c = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [c.stdout!, c.stderr!]) stream.on('data', (chunk: Buffer) => log(name)(chunk.toString('utf8')))
    children.push(c)
    return c
  }
  try {
    const hostPort = await freePort()
    const host = `http://127.0.0.1:${hostPort}`

    // The verifier: the stand-in Didit first, then the verifier, which makes its seed in its
    // directory, with its gifts at the loop's host.
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
        HOST_URL: host,
        DATABASE_PATH: join(dir, 'verifier', 'verifier.sqlite'),
        PORT: '0',
      }),
      { log: log('loop verifier') },
    )
    closers.push(() => verifier.close())
    if (!verifier.sponsor) throw new Error('the loop verifier gives no gift')

    // The host, taking the loop verifier's sponsor's tickets.
    const h = await startHost(hostConfig({ DATA_DIR: join(dir, 'host'), PUBLIC_ORIGIN: host, PORT: String(hostPort), SPONSORS: verifier.sponsor }))
    closers.push(() => h.close())

    // The index: its own lists, beside index/config.
    const lists = join(dir, 'index-lists')
    mkdirSync(join(lists, 'lists'), { recursive: true })
    cpSync(join(repo, 'index/config'), join(lists, 'config'), { recursive: true })
    const about = 'The e2e loop index’s, for one run.'
    const write = (file: string, body: object) => writeFileSync(join(lists, 'lists', file), JSON.stringify({ about, ...body }))
    write('hosts.json', { hosts: [host] })
    write('verifiers.json', {
      keys: [
        { key: verifier.keys.face, verifier: VERIFIER_NAME, label: 'face check', confidence: FACE_CONFIDENCE },
        { key: verifier.keys.id, verifier: VERIFIER_NAME, label: 'ID check', confidence: 0.95 },
      ],
    })
    write('indexes.json', { maxAgeDays: 30, indexes: [{ index: 'self', name: 'e2e loop index' }] })
    const indexPort = await freePort()
    const indexUrl = `http://127.0.0.1:${indexPort}`
    const index = await startIndex({ dataDir: join(dir, 'index'), publicUrl: indexUrl, readSeconds: 5, listsRoot: lists, port: indexPort, hostname: '127.0.0.1', log: log('loop index') })
    closers.push(() => index.close())

    // The mcp: reading the loop's index, its logins through the loop's connect page, and reaching
    // hosts with a plain fetch, since the loop's own host is on loopback, which the mcp's publicFetch
    // refuses.
    const mcp = await serve({ appUrl: o.appUrl, dataDir: join(dir, 'mcp'), read: { index: indexUrl }, hostFetch: fetch }, '127.0.0.1', 0)
    closers.push(() => mcp.close())

    return { verifier: { url: verifier.url, name: VERIFIER_NAME, keys: verifier.keys, sponsor: verifier.sponsor }, host, index: { url: indexUrl, address: index.address }, mcp: mcp.origin, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
