// The two doors on the same actions. The typed door, run as a person or a script runs it; the MCP
// door, over stdio and over HTTP, through the MCP SDK's own client: HOW comes first as its
// instructions, the mark is its icon, the tools are the actions (a hosted copy's without private),
// keys come with the call, by the app's names or the older ones, or from the start, and a hosted
// copy answers at its root and at /mcp, serves the icon, and refuses to start with a key.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { type AddressInfo, connect } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readProfile } from '../../standard/records/src/index.ts'
import { ACTIONS, HOSTED, HOW, described } from '../src/actions.ts'
import { NO_KEY } from '../src/forest.ts'
import { ICO, ICON, SVG } from '../src/icon.ts'
import { serveHttp } from '../src/mcp.ts'
import { KEYS, type World, buyer, offer, seller, world } from './setup.ts'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const exec = promisify(execFile)

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

const live = async () => (await readProfile([w.host.url], buyer.address, Date.now())).current
/** The buyer's inbox key, as the app gives it: its message key and its read key, joined by a dot. */
const INBOX = `${KEYS.message}.${KEYS.read}`
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!.text)

describe('the typed door', () => {
  test('help shows how Forest works, then every action with the key it needs', async () => {
    const { status, stdout } = await forest(['help'])
    assert.equal(status, 0)
    assert.ok(stdout.startsWith(HOW))
    for (const a of ACTIONS) assert.ok(stdout.includes(`  forest ${a.name}`) && stdout.includes(`    ${described(a)}\n`), a.name)
  })

  test('reads with no key, writes with a key from the environment, and answers JSON', async () => {
    const read = await forest(['profile', seller.address, '--host', w.host.url, '--index', w.index])
    assert.equal(read.status, 0, read.stderr)
    assert.equal(JSON.parse(read.stdout).card.body.role, 'seller')

    const env = { FOREST_HOSTS: w.host.url, FOREST_PROFILE: buyer.address, FOREST_WRITING_KEY: KEYS.write }
    const wrote = await forest(['offer', 'post', 'typed', '--offer', JSON.stringify(offer('Typed, one hour.'))], env)
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.equal(JSON.parse(wrote.stdout).path, 'offer/typed')
    assert.equal((await live()).get('offer/typed')!.record.body!.description, 'Typed, one hour.')

    const asked = await forest(['ask', 'remove-offer', '--params', '{"id":"typed"}'], { ...env, FOREST_INBOX_KEY: INBOX })
    assert.equal(asked.status, 0, asked.stderr)
    assert.equal(JSON.parse(asked.stdout).to, buyer.address)

    // The older names, still taken.
    const old = { FOREST_HOSTS: w.host.url, FOREST_PROFILE: buyer.address, FOREST_WRITE_KEY: KEYS.write, FOREST_MESSAGE_KEY: KEYS.message, FOREST_READ_KEY: KEYS.read }
    assert.equal(JSON.parse((await forest(['offer', 'update', 'typed', '--offer', JSON.stringify(offer('Typed, two hours.'))], old)).stdout).path, 'offer/typed')
    assert.ok(JSON.parse((await forest(['inbox'], old)).stdout).messages.every((m: { body?: unknown }) => m.body), 'each message opened by the read key')
  })

  test('a refusal is one line, and exit status 1', async () => {
    const env = { FOREST_HOSTS: w.host.url, FOREST_PROFILE: buyer.address }
    assert.deepEqual(await forest(['offer', 'remove', 'typed'], env), { status: 1, stdout: '', stderr: `${NO_KEY}\n` })
    assert.equal((await forest(['offer', 'remove', 'typed'], { ...env, FOREST_INBOX_KEY: KEYS.message })).stderr, 'the inbox key is a message key and a read key joined by a dot, <message key>.<read key>, as the app gives it\n')
    assert.equal((await forest(['offer', 'post', '--offer', '{not json'], env)).stderr, '--offer is not JSON\n')
    assert.equal((await forest(['profile', seller.address, 'extra'], env)).stderr, 'profile takes <address> before its flags\n')
    assert.equal((await forest(['pay'], env)).stderr, 'no action pay; forest help lists them\n')
  })
})

describe('the MCP door', () => {
  test('over stdio: HOW first, the mark its icon, every action a tool starting with its key, keys from the call or from the start', async () => {
    const client = new Client({ name: 'test', version: '0' })
    const env = { PATH: process.env.PATH ?? '', FOREST_PROFILE: buyer.address, FOREST_INBOX_KEY: INBOX }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', '--host', w.host.url, '--index', w.index], env }))
    try {
      assert.equal(client.getInstructions(), HOW)
      assert.deepEqual(client.getServerVersion()?.icons, [ICON])
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map((t) => t.name), ACTIONS.map((a) => a.name))
      assert.deepEqual(tools.map((t) => t.description!.split('.')[0]), ['No key', 'No key', 'No key', 'Writing key', 'Writing key', 'Inbox key', 'Inbox key', 'Inbox key', 'Inbox key'])
      for (const t of tools) assert.equal(t.description, described(ACTIONS.find((a) => a.name === t.name)!))
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'offer')!.inputSchema.properties!), ['action', 'id', 'offer', 'profile', 'writingKey'])
      assert.deepEqual((tools.find((t) => t.name === 'offer')!.inputSchema.properties!.action as { enum: string[] }).enum, ['post', 'update', 'remove'])
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'market')!.inputSchema.properties!), ['market'])
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'ask')!.inputSchema.properties!), ['action', 'params', 'profile', 'inboxKey'])
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'inbox')!.inputSchema.properties!), ['after', 'profile', 'inboxKey'])

      // A key in the call.
      const wrote = await client.callTool({ name: 'offer', arguments: { action: 'post', offer: offer('By MCP.'), id: 'mcp', writingKey: KEYS.write } })
      assert.equal(wrote.isError, undefined, text(wrote))
      assert.equal(JSON.parse(text(wrote)).path, 'offer/mcp')
      // A key from the start: the AI never wrote it.
      const asked = await client.callTool({ name: 'ask', arguments: { action: 'remove-offer', params: { id: 'owned' } } })
      assert.equal(asked.isError, undefined, text(asked))
      // No key at all, and a key the tool does not take, by either name.
      assert.deepEqual(await client.callTool({ name: 'review', arguments: { review: { subject: seller.address } } }), { isError: true, content: [{ type: 'text', text: NO_KEY }] })
      assert.equal(text(await client.callTool({ name: 'market', arguments: { market: 'tutoring', writingKey: KEYS.write } })), 'market takes no writingKey')
      assert.equal(text(await client.callTool({ name: 'market', arguments: { market: 'tutoring', writeKey: KEYS.write } })), 'market takes no writeKey')
      assert.equal(text(await client.callTool({ name: 'send', arguments: { to: seller.address, text: 'x', writingKey: KEYS.write } })), 'send takes no writingKey')
    } finally {
      await client.close()
    }
  })

  test('over HTTP, for a hosted copy: at its root and at /mcp, the tools but private, keys only in the call, by either name', async () => {
    const http = await serveHttp({ hosts: [w.host.url], keys: {} }, '127.0.0.1', 0)
    const root = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    const client = new Client({ name: 'test', version: '0' })
    const before = new Client({ name: 'test', version: '0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(root)))
      await before.connect(new StreamableHTTPClientTransport(new URL(`${root}/mcp`)))
      assert.equal(client.getInstructions(), HOW)
      assert.deepEqual(client.getServerVersion()?.icons, [ICON])
      const names = (await client.listTools()).tools.map((t) => t.name)
      assert.deepEqual(names, ['markets', 'market', 'profile', 'offer', 'review', 'inbox', 'send', 'ask'])
      assert.deepEqual(names, HOSTED.map((a) => a.name))
      assert.deepEqual((await before.listTools()).tools.map((t) => t.name), names, 'the same at /mcp')
      assert.equal(text(await client.callTool({ name: 'private', arguments: {} })), 'no tool private')

      const read = await client.callTool({ name: 'profile', arguments: { address: seller.address } })
      assert.equal(JSON.parse(text(read)).card.body.role, 'seller')
      assert.equal(text(await client.callTool({ name: 'offer', arguments: { action: 'post', offer: offer('x'), profile: buyer.address } })), NO_KEY)
      const wrote = await client.callTool({ name: 'offer', arguments: { action: 'post', offer: offer('Hosted.'), id: 'hosted', profile: buyer.address, writingKey: KEYS.write } })
      assert.equal(JSON.parse(text(wrote)).path, 'offer/hosted')
      const old = await before.callTool({ name: 'offer', arguments: { action: 'remove', id: 'hosted', profile: buyer.address, writeKey: KEYS.write } })
      assert.equal(JSON.parse(text(old)).path, 'offer/hosted', 'the older name, writeKey')

      // The inbox key, split on its dot: the message key pulls, the read key opens.
      const box = JSON.parse(text(await client.callTool({ name: 'inbox', arguments: { profile: buyer.address, inboxKey: INBOX } })))
      assert.ok(box.messages.length > 0 && box.messages.every((m: { body?: unknown }) => m.body), 'each message opened')
      const older = JSON.parse(text(await before.callTool({ name: 'inbox', arguments: { profile: buyer.address, messageKey: KEYS.message, readKey: KEYS.read } })))
      assert.deepEqual(older.messages, box.messages, 'the same by the older names')
      assert.match(text(await client.callTool({ name: 'inbox', arguments: { profile: buyer.address, inboxKey: KEYS.message } })), /^the inbox key is a message key and a read key joined by a dot/)
    } finally {
      await client.close()
      await before.close()
      await new Promise((resolve) => http.close(resolve))
    }
  })

  test('a hosted copy serves the mark at /favicon.ico and /icon.svg', async () => {
    const http = await serveHttp({ hosts: [w.host.url], keys: {} }, '127.0.0.1', 0)
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
    const http = await serveHttp({ hosts: [w.host.url], keys: {} }, '127.0.0.1', 0)
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

  test('a hosted copy refuses to start with a key, by either name', async () => {
    const refusal = 'a hosted copy takes keys only in each call: unset FOREST_WRITING_KEY, FOREST_INBOX_KEY and the older FOREST_WRITE_KEY, FOREST_MESSAGE_KEY and FOREST_READ_KEY\n'
    for (const env of [{ FOREST_WRITING_KEY: KEYS.write }, { FOREST_INBOX_KEY: INBOX }, { FOREST_WRITE_KEY: KEYS.write }, { FOREST_READ_KEY: KEYS.read }] as Array<{ [name: string]: string }>) {
      assert.deepEqual(await forest(['mcp', '--http', '127.0.0.1:0'], env), { status: 1, stdout: '', stderr: refusal }, Object.keys(env)[0])
    }
  })
})
