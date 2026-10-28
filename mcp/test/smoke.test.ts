// The hosted copy, as its image runs it: the command in deploy/Dockerfile, read from the file and run
// in this directory, on loopback, with Railway's PORT set to a free port and the settings a deploy
// gives it in the environment, here pointing at the test world.
//   1. the MCP SDK's client finds the door there (../smoke.ts): its instructions and icon, every
//      tool, no session, reading with no login, the challenge and the metadata, the same tools at
//      /mcp, the icon's two files, and a login through the stand-in connect page, answered plainly
//      with no app of the person's open; a request whose URL is no path (`//`) gets 400, and it goes
//      on answering;
//   2. with no APP_URL, reading works and logins wait;
//   3. with no DATA_DIR, it refuses to start.
//
//   ../standard.sh && npm ci && npm test

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { smoke } from '../smoke.ts'
import { AiApp, type World, browse, world } from './setup.ts'

const here = dirname(fileURLToPath(import.meta.url))

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

/** The image's command and working directory, as deploy/Dockerfile says them. */
function image(): { cmd: string[]; cwd: string } {
  const dockerfile = readFileSync(join(here, '../deploy/Dockerfile'), 'utf8')
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)![1]!) as string[]
  const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)![1]!
  assert.equal(workdir, '/services/mcp', 'the image runs in this directory')
  return { cmd, cwd: join(here, '..') }
}

/** A port nothing listens on, so the copy's PUBLIC_URL can name it before it starts. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Runs the image's command; resolves when it listens, or with how it ended. */
function run(env: Record<string, string>): { child: ChildProcess; started: Promise<{ listening: true } | { code: number | null; stderr: string }> } {
  const { cmd, cwd } = image()
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { PATH: process.env.PATH ?? '', ...env } })
  let stderr = ''
  const started = new Promise<{ listening: true } | { code: number | null; stderr: string }>((resolve) => {
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (/forest mcp: .*listening on/.test(stderr)) resolve({ listening: true })
    })
    child.on('exit', (code) => resolve({ code, stderr }))
  })
  return { child, started }
}

/** One request as raw bytes, so a URL no client would send arrives as written; the status line's code, or null if none came. */
function raw(port: number, request: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(request))
    let got = ''
    socket.on('data', (chunk) => (got += chunk.toString('latin1')))
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]) || null))
    socket.on('error', reject)
  })
}

/** The settings a deploy gives, pointing at the test world, on `port`. */
const settings = (port: number) => ({ PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, DATA_DIR: mkdtempSync(join(tmpdir(), 'forest-mcp-smoke-')), INDEX_URL: w.index })

test('1. the MCP SDK’s client finds the door, with every tool, reading with no login, and a login through the connect page', async () => {
  const port = await freePort()
  const { child, started } = run({ ...settings(port), APP_URL: w.appUrl })
  try {
    assert.deepEqual(await started, { listening: true })
    const url = `http://127.0.0.1:${port}`
    const seen = await smoke(url, { provider: new AiApp(), browse })
    assert.deepEqual(seen.tools, ['index', 'market', 'markets', 'pay', 'profile', 'read', 'search', 'write'])
    assert.equal(seen.logins, `to ${new URL(w.appUrl).origin}`)
    assert.equal(seen.login, 'done')
    assert.equal(await raw(port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 400, '`//` is the asker’s mistake')
    assert.deepEqual((await smoke(url)).tools, seen.tools, 'and it goes on answering')
  } finally {
    child.kill()
  }
})

test('2. with no APP_URL, reading works and logins wait', async () => {
  const port = await freePort()
  const { child, started } = run(settings(port))
  try {
    assert.deepEqual(await started, { listening: true })
    assert.equal((await smoke(`http://127.0.0.1:${port}`)).logins, 'waiting for the connect page')
  } finally {
    child.kill()
  }
})

test('3. with no DATA_DIR, it refuses to start', async () => {
  const { DATA_DIR: _, ...rest } = settings(await freePort())
  const got = await run(rest).started
  assert.ok('code' in got, 'it never listened')
  assert.equal(got.code, 1)
  assert.match(got.stderr, /DATA_DIR is where this copy keeps its key/)
})
