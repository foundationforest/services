// The two doors on the same actions. The typed door, run as a person or a script runs it; the MCP
// door, over stdio and over HTTP, through the MCP SDK's own client: HOW comes first as its
// instructions, the tools are exactly the actions, keys come with the call or from the start, and a
// hosted copy refuses to start with one.

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
import { ACTIONS, HOW, keyNeeded } from '../src/actions.ts'
import { NO_KEY } from '../src/forest.ts'
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
const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!.text)

describe('the typed door', () => {
  test('help shows how Forest works, then every action with the key it needs', async () => {
    const { status, stdout } = await forest(['help'])
    assert.equal(status, 0)
    assert.ok(stdout.startsWith(HOW))
    for (const a of ACTIONS) assert.ok(stdout.includes(`  forest ${a.name}`) && stdout.includes(`Key: ${keyNeeded(a)}.`), a.name)
  })

  test('reads with no key, writes with a key from the environment, and answers JSON', async () => {
    const read = await forest(['profile', seller.address, '--host', w.host.url, '--index', w.index])
    assert.equal(read.status, 0, read.stderr)
    assert.equal(JSON.parse(read.stdout).card.body.role, 'seller')

    const env = { FOREST_HOSTS: w.host.url, FOREST_PROFILE: buyer.address, FOREST_WRITE_KEY: KEYS.write }
    const wrote = await forest(['post-offer', '--offer', JSON.stringify(offer('Typed, one hour.')), '--id', 'typed'], env)
    assert.equal(wrote.status, 0, wrote.stderr)
    assert.equal(JSON.parse(wrote.stdout).path, 'offer/typed')
    assert.equal((await live()).get('offer/typed')!.record.body!.description, 'Typed, one hour.')

    const asked = await forest(['request', 'remove-offer', '--params', '{"id":"typed"}'], { ...env, FOREST_MESSAGE_KEY: KEYS.message })
    assert.equal(asked.status, 0, asked.stderr)
    assert.equal(JSON.parse(asked.stdout).to, buyer.address)
  })

  test('a refusal is one line, and exit status 1', async () => {
    const env = { FOREST_HOSTS: w.host.url, FOREST_PROFILE: buyer.address }
    assert.deepEqual(await forest(['remove-offer', 'typed'], env), { status: 1, stdout: '', stderr: `${NO_KEY}\n` })
    assert.equal((await forest(['post-offer', '--offer', '{not json'], env)).stderr, '--offer is not JSON\n')
    assert.equal((await forest(['profile', seller.address, 'extra'], env)).stderr, 'profile takes <address> before its flags\n')
    assert.equal((await forest(['pay'], env)).stderr, 'no action pay; forest help lists them\n')
  })
})

describe('the MCP door', () => {
  test('over stdio: HOW first, every action a tool, keys from the call or from the start', async () => {
    const client = new Client({ name: 'test', version: '0' })
    const env = { PATH: process.env.PATH ?? '', FOREST_PROFILE: buyer.address, FOREST_MESSAGE_KEY: KEYS.message }
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, 'mcp', '--host', w.host.url, '--index', w.index], env }))
    try {
      assert.equal(client.getInstructions(), HOW)
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map((t) => t.name), ACTIONS.map((a) => a.name))
      for (const t of tools) assert.ok(t.description!.endsWith(`Key: ${keyNeeded(ACTIONS.find((a) => a.name === t.name)!)}.`))
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'post-offer')!.inputSchema.properties!), ['offer', 'id', 'profile', 'writeKey'])
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'market')!.inputSchema.properties!), ['market'])
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'request')!.inputSchema.properties!), ['action', 'params', 'profile', 'messageKey'])

      // A key in the call.
      const wrote = await client.callTool({ name: 'post-offer', arguments: { offer: offer('By MCP.'), id: 'mcp', writeKey: KEYS.write } })
      assert.equal(wrote.isError, undefined, text(wrote))
      assert.equal(JSON.parse(text(wrote)).path, 'offer/mcp')
      // A key from the start: the AI never wrote it.
      const asked = await client.callTool({ name: 'request', arguments: { action: 'remove-offer', params: { id: 'owned' } } })
      assert.equal(asked.isError, undefined, text(asked))
      // No key at all, and a key the tool does not take.
      assert.deepEqual(await client.callTool({ name: 'post-review', arguments: { review: { subject: seller.address } } }), { isError: true, content: [{ type: 'text', text: NO_KEY }] })
      assert.equal(text(await client.callTool({ name: 'market', arguments: { market: 'tutoring', writeKey: KEYS.write } })), 'market takes no writeKey')
    } finally {
      await client.close()
    }
  })

  test('over HTTP, for a hosted copy: the same tools, keys only in the call', async () => {
    const http = await serveHttp({ hosts: [w.host.url], keys: {} }, '127.0.0.1', 0)
    const client = new Client({ name: 'test', version: '0' })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`)))
      assert.equal(client.getInstructions(), HOW)
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ACTIONS.map((a) => a.name))
      const read = await client.callTool({ name: 'profile', arguments: { address: seller.address } })
      assert.equal(JSON.parse(text(read)).card.body.role, 'seller')
      assert.equal(text(await client.callTool({ name: 'post-offer', arguments: { offer: offer('x'), profile: buyer.address } })), NO_KEY)
      const wrote = await client.callTool({ name: 'post-offer', arguments: { offer: offer('Hosted.'), id: 'hosted', profile: buyer.address, writeKey: KEYS.write } })
      assert.equal(JSON.parse(text(wrote)).path, 'offer/hosted')
    } finally {
      await client.close()
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

  test('a hosted copy refuses to start with a key', async () => {
    const started = await forest(['mcp', '--http', '127.0.0.1:0'], { FOREST_WRITE_KEY: KEYS.write })
    assert.deepEqual(started, { status: 1, stdout: '', stderr: 'a hosted copy takes keys only in each call: unset FOREST_WRITE_KEY, FOREST_MESSAGE_KEY and FOREST_READ_KEY\n' })
  })
})
