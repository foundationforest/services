// The hosted copy, as its image runs it: the command in deploy/Dockerfile, read from the file and run
// in forest's CLI at the commit in FOREST, on loopback, with Railway's PORT set to 0 (any free port).
//   1. the MCP SDK's client finds forest's MCP door there (../smoke.ts): its instructions, every
//      action as a tool, no session, and refusals in forest's words;
//   2. with a key in its environment, the same command refuses to start.
//
//   ../forest.sh records cli && npm ci && npm test

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { smoke } from '../smoke.ts'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '../../forest/cli')

/** The image's command and working directory, as deploy/Dockerfile says them. */
function image(): { cmd: string[]; cwd: string } {
  const dockerfile = readFileSync(join(here, '../deploy/Dockerfile'), 'utf8')
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(dockerfile)![1]!) as string[]
  const workdir = [...dockerfile.matchAll(/^WORKDIR (\S+)$/gm)].at(-1)![1]!
  assert.equal(workdir, '/services/forest/cli', 'the image runs in forest’s CLI')
  return { cmd, cwd: CLI }
}

/** Runs the image's command; resolves with the port it listens on, or with how it ended. */
function run(env: Record<string, string>): { child: ChildProcess; started: Promise<{ port: number } | { code: number | null; stderr: string }> } {
  const { cmd, cwd } = image()
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { PATH: process.env.PATH ?? '', ...env } })
  let stderr = ''
  const started = new Promise<{ port: number } | { code: number | null; stderr: string }>((resolve) => {
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      const at = /forest mcp: http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr)
      if (at) resolve({ port: Number(at[1]) })
    })
    child.on('exit', (code) => resolve({ code, stderr }))
  })
  return { child, started }
}

test('the hosted copy, as its image runs it', async (t) => {
  if (!existsSync(join(CLI, 'node_modules'))) return t.skip('forest’s CLI is not installed: ../forest.sh records cli')

  await t.test('1. the MCP SDK’s client finds forest’s door, with every action and no session', async () => {
    const { child, started } = run({ PORT: '0' })
    try {
      const got = await started
      assert.ok('port' in got, `it started: ${JSON.stringify(got)}`)
      const seen = await smoke(`http://127.0.0.1:${got.port}/mcp`)
      assert.ok((seen.tools as number) > 0)
    } finally {
      child.kill()
    }
  })

  await t.test('2. with a key in its environment, it refuses to start', async () => {
    const { started } = run({ PORT: '0', FOREST_WRITE_KEY: 'any' })
    const got = await started
    assert.ok('code' in got, 'it never listened')
    assert.equal(got.code, 1)
    assert.match(got.stderr, /a hosted copy takes keys only in each call/)
  })
})
