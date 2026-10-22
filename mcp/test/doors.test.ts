// The two doors on the same tools. The typed door, run as a person or a script runs it; the MCP
// door, over stdio and over HTTP, through the MCP SDK's own client: HOW comes first as its
// instructions, the mark is its icon, every tool is listed with its description starting with the
// key it needs, keys come with the call or from the start, and a hosted copy answers at its root
// and at /mcp, serves the icon, and refuses to start with a key.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { type AddressInfo, connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readProfile } from '@foundationforest/records'
import { ICO, ICON, SVG } from '../src/icon.ts'
import { serveHttp } from '../src/mcp.ts'
import { HOW, TOOLS, keyNeeded } from '../src/tools.ts'
import { KEYS, type World, lesson, student, tutor, world } from './setup.ts'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const exec = promisify(execFile)
const NO_WRITE_KEY = "this needs the write key (writeKey), as the person's app gives it"

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

/** The typed door, with only the environment given: its status, what it printed, and what it said wrong. */
async function forest(args: string[], env: { [name: string]: string } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [MAIN, ...args], { env: { PATH: process.env.PATH ?? '', ...env } })
    return { status: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string }
    return { status: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const live = async () => (await readProfile([w.host], tutor.address, Date.now())).current
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text

test('every tool is a file in src/tools, its description starting with the key its parameters name', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['ask', 'inbox', 'market', 'markets', 'post', 'profile', 'review', 'search', 'send'])
  assert.deepEqual(TOOLS.map(keyNeeded), ['Write key.', 'Read key.', 'No key.', 'No key.', 'Write key.', 'No key.', 'Write key.', 'No key.', 'Write key.'])
  for (const t of TOOLS) assert.ok(t.description.startsWith(`${keyNeeded(t)} `), t.name)
})

describe('the typed door', () => {
  test('help shows how Forest works, then every tool with its description', async () => {
    const { status, stdout } = await forest(['help'])
    assert.equal(status, 0)
    assert.ok(stdout.startsWith(HOW))
    for (const t of TOOLS) assert.ok(stdout.includes(`  forest ${t.name}`) && stdout.includes(`    ${t.description}\n`), t.name)
  })

  test('reads with no key, writes with a key from the environment, and answers JSON', async () => {
    const read = await forest(['profile', student.address, '--host', w.host, '--index', w.index])
    assert.equal(read.status, 0, read.stderr)
    assert.equal(JSON.parse(read.stdout).profile.role, 'student')

    const env = { FOREST_HOSTS: w.host, FOREST_INDEX: w.index, FOREST_PROFILE: tutor.address, FOREST_WRITE_KEY: KEYS.write, FOREST_READ_KEY: KEYS.read }
    const wrote = await forest(['post', 'post', 'typed', '--body', JSON.stringify(lesson('Typed, one hour.'))], env)
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.equal(JSON.parse(wrote.stdout).path, 'offer/typed')
    assert.equal((await live()).get('offer/typed')!.record.body!.description, 'Typed, one hour.')

    const asked = await forest(['ask', 'remove-offer', '--params', '{"id":"owned"}'], env)
    assert.equal(asked.status, 0, asked.stderr)
    assert.equal(JSON.parse(asked.stdout).to, tutor.address)
    const box = JSON.parse((await forest(['inbox'], env)).stdout)
    assert.ok(box.messages.some((m: { request?: string }) => m.request === 'remove-offer'))
  })

  test('a refusal is one line, and exit status 1', async () => {
    const env = { FOREST_HOSTS: w.host, FOREST_PROFILE: tutor.address }
    assert.deepEqual(await forest(['post', 'remove', 'typed'], env), { status: 1, stdout: '', stderr: `${NO_WRITE_KEY}\n` })
    assert.equal((await forest(['post', 'post', '--body', '{not json'], env)).stderr, '--body is not JSON\n')
    assert.equal((await forest(['profile', student.address, 'extra'], env)).stderr, 'profile takes <address> before its flags\n')
    assert.equal((await forest(['pay'], env)).stderr, 'no tool pay; forest help lists them\n')
    assert.match((await forest(['post', 'remove', 'typed', '--writeKey', KEYS.write], env)).stderr, /Unknown option '--writeKey'/, 'a key is never a flag')
    assert.equal((await forest(['markets', '--host', 'host.example'], env)).stderr, 'host.example is not a host: give an origin, https://host[:port]\n')
  })
})

describe('the MCP door', () => {
  test('over stdio: HOW first, the mark its icon, every tool, keys from the call or from the start', async () => {
    const client = new Client({ name: 'test', version: '0' })
    const env = { PATH: process.env.PATH ?? '', FOREST_PROFILE: tutor.address, FOREST_READ_KEY: KEYS.read }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', '--host', w.host, '--index', w.index], env }))
    try {
      assert.equal(client.getInstructions(), HOW)
      assert.deepEqual(client.getServerVersion()?.icons, [ICON])
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map((t) => [t.name, t.description]), TOOLS.map((t) => [t.name, t.description]))
      const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema
      assert.deepEqual(Object.keys(schema('post').properties!), ['action', 'id', 'body', 'profile', 'writeKey'])
      assert.deepEqual(schema('post').required, ['action'], 'the profile and key may come from the start')
      assert.deepEqual(Object.keys(schema('inbox').properties!), ['after', 'profile', 'readKey'])
      assert.deepEqual(Object.keys(schema('market').properties!), ['market'])

      // A key in the call; the profile from the start.
      const wrote = await client.callTool({ name: 'post', arguments: { action: 'post', id: 'mcp', body: lesson('By MCP.'), writeKey: KEYS.write } })
      assert.equal(wrote.isError, undefined, text(wrote))
      assert.equal(JSON.parse(text(wrote)).path, 'offer/mcp')
      // A key from the start: the AI never wrote it.
      const box = await client.callTool({ name: 'inbox', arguments: {} })
      assert.equal(box.isError, undefined, text(box))
      // No key at all, and names the tools do not take.
      assert.deepEqual(await client.callTool({ name: 'review', arguments: { action: 'remove', id: 'x' } }), { isError: true, content: [{ type: 'text', text: NO_WRITE_KEY }] })
      assert.equal(text(await client.callTool({ name: 'market', arguments: { market: 'tutoring', writeKey: KEYS.write } })), 'market takes no writeKey')
      for (const old of ['writingKey', 'inboxKey', 'messageKey']) {
        assert.equal(text(await client.callTool({ name: 'post', arguments: { action: 'remove', id: 'mcp', [old]: KEYS.write } })), `post takes no ${old}`)
      }
    } finally {
      await client.close()
    }
  })

  test('over HTTP, for a hosted copy: at its root and at /mcp, keys only in the call', async () => {
    const http = await serveHttp(w.ctx, {}, '127.0.0.1', 0)
    const root = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    const client = new Client({ name: 'test', version: '0' })
    const before = new Client({ name: 'test', version: '0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(root)))
      await before.connect(new StreamableHTTPClientTransport(new URL(`${root}/mcp`)))
      assert.equal(client.getInstructions(), HOW)
      const names = (await client.listTools()).tools.map((t) => t.name)
      assert.deepEqual(names, TOOLS.map((t) => t.name))
      assert.deepEqual((await before.listTools()).tools.map((t) => t.name), names, 'the same at /mcp')

      const read = await client.callTool({ name: 'profile', arguments: { address: student.address } })
      assert.equal(JSON.parse(text(read)).profile.role, 'student')
      assert.equal(text(await client.callTool({ name: 'post', arguments: { action: 'post', body: lesson('x'), profile: tutor.address } })), NO_WRITE_KEY)
      const wrote = await client.callTool({ name: 'post', arguments: { action: 'post', id: 'hosted', body: lesson('Hosted.'), profile: tutor.address, writeKey: KEYS.write } })
      assert.equal(JSON.parse(text(wrote)).path, 'offer/hosted')
      const gone = await before.callTool({ name: 'post', arguments: { action: 'remove', id: 'hosted', profile: tutor.address, writeKey: KEYS.write } })
      assert.equal(JSON.parse(text(gone)).path, 'offer/hosted')
      const box = JSON.parse(text(await client.callTool({ name: 'inbox', arguments: { profile: tutor.address, readKey: KEYS.read } })))
      assert.ok(box.messages.length > 0 && box.messages.every((m: { body?: unknown }) => m.body), 'each message opened')
    } finally {
      await client.close()
      await before.close()
      await new Promise((resolve) => http.close(resolve))
    }
  })

  test('a hosted copy serves the mark at /favicon.ico and /icon.svg', async () => {
    const http = await serveHttp(w.ctx, {}, '127.0.0.1', 0)
    try {
      const root = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
      const ico = await fetch(`${root}/favicon.ico`)
      assert.equal(ico.headers.get('content-type'), 'image/x-icon')
      const bytes = Buffer.from(await ico.arrayBuffer())
      assert.ok(bytes.equals(ICO))
      // An ICO of four PNGs, 16 to 64 pixels square.
      assert.deepEqual([bytes.readUInt16LE(2), bytes.readUInt16LE(4)], [1, 4])
      assert.deepEqual([0, 1, 2, 3].map((i) => bytes[6 + 16 * i]), [16, 32, 48, 64])
      assert.equal(bytes.subarray(bytes.readUInt32LE(6 + 12), bytes.readUInt32LE(6 + 12) + 4).toString('latin1'), '\x89PNG')
      const svg = await fetch(`${root}/icon.svg`)
      assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
      assert.equal(await svg.text(), SVG)
      assert.equal(ICON.src, `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`, 'the server’s info gives the same SVG')
    } finally {
      await new Promise((resolve) => http.close(resolve))
    }
  })

  test('a hosted copy answers a request target that is no path, such as //, with 400, and goes on', async () => {
    const http = await serveHttp(w.ctx, {}, '127.0.0.1', 0)
    try {
      const { port } = http.address() as AddressInfo
      const socket = connect(port, '127.0.0.1')
      socket.write('GET // HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n')
      const answer = await new Promise<string>((resolve) => {
        let got = ''
        socket.on('data', (d) => (got += d))
        socket.on('close', () => resolve(got))
      })
      assert.match(answer, /^HTTP\/1\.1 400/)
      assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404)
    } finally {
      await new Promise((resolve) => http.close(resolve))
    }
  })

  test('a hosted copy refuses to start with a key in its environment', async () => {
    const refusal = 'a hosted copy takes keys only in each call: unset FOREST_WRITE_KEY and FOREST_READ_KEY\n'
    for (const env of [{ FOREST_WRITE_KEY: KEYS.write }, { FOREST_READ_KEY: KEYS.read }] as Array<{ [name: string]: string }>) {
      assert.deepEqual(await forest(['mcp', '--http', '127.0.0.1:0'], env), { status: 1, stdout: '', stderr: refusal }, Object.keys(env)[0])
    }
  })
})
