// The connections service end to end, in one process: forest's reference host holding one profile,
// the service in front of it, and an assistant's MCP client (SDK v2, protocol 2026-07-28) calling it
// through the service's front, as an assistant on the internet would.
//
//   npm test

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { publish, readAll } from '../../forest/records/src/client.ts'
import { Host } from '../../forest/records/src/host.ts'
import { profileKey, seedFromPrf } from '../../forest/records/src/keys.ts'
import { requestFromLink } from '../../forest/records/src/request.ts'
import { folderEntry, ownerEntry } from '../../forest/records/src/write.ts'
import { PAGE_DIR, PAGE_POLICY, readConfig, startConnections, type Service } from '../src/service.ts'

const PAGE = 'https://forest.example/approve'
const T0 = Date.UTC(2026, 8, 29, 12, 0, 0)
/** A person, from a stand-in for a passkey's secret. */
const alice = profileKey(seedFromPrf(new Uint8Array(32).fill(3)), 0)
const offer = {
  direction: 'offer',
  description: 'One hour of maths tutoring, online.',
  price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' },
  remote: true,
  createdAt: '2026-09-29T12:00:00Z',
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

let host: Host
let service: Service

before(async () => {
  // Forest's approval page, built by its own build, as the image builds it.
  if (!existsSync(`${PAGE_DIR}/approve.html`)) execFileSync(process.execPath, [new URL('../../forest/records/web/build.ts', import.meta.url).pathname])
  const port = await freePort()
  host = new Host({ url: `http://127.0.0.1:${port}` })
  await host.listen(port)
  // The person's app, once: a folder naming the host, and a profile card.
  const outcomes = await publish(
    [host.url],
    [
      folderEntry(alice, { hosts: [host.url] }, T0),
      ownerEntry(alice, 'profile', { market: 'tutoring', role: 'seller', name: 'Alice', createdAt: '2026-09-29T12:00:00Z' }, T0),
    ],
  )
  assert.ok(outcomes.every((o) => o.results.every((r) => r.ok)), 'the host took both entries')
  service = await startConnections(readConfig({ APPROVAL_PAGE: PAGE, HOSTS: host.url, WAIT_SECONDS: '0', PORT: '0' }))
})

after(async () => {
  await service?.close()
  await host?.close()
})

async function assistant(): Promise<Client> {
  const client = new Client(
    { name: 'test-assistant', version: '0.0.0' },
    { capabilities: { elicitation: { url: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } }, inputRequired: { autoFulfill: false, maxRounds: 3 } },
  )
  await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`)))
  return client
}

const textOf = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]?.text ?? ''

test('it answers on every interface, not only loopback', () => {
  const { address } = service.server.address() as AddressInfo
  assert.ok(address === '::' || address === '0.0.0.0', `listening on ${address}`)
})

test('an assistant reads a profile through the front: no key, no grant, no login', async () => {
  const client = await assistant()
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['forest_draft', 'forest_read'])
    assert.match(textOf(await client.callTool({ name: 'forest_read', arguments: { profile: alice.did } })), /"name": "Alice"/)
  } finally {
    await client.close()
  }
})

test('a draft comes back as an approval link carrying exactly the note, and nothing is published', async () => {
  const client = await assistant()
  try {
    const first = (await client.callTool(
      { name: 'forest_draft', arguments: { profile: alice.did, path: 'offer/maths', body: offer } },
      { allowInputRequired: true } as never,
    )) as { resultType?: string; inputRequests?: Record<string, { params: { mode: string; url: string } }> }
    assert.equal(first.resultType, 'input_required')
    const url = first.inputRequests!.approve!.params.url
    assert.ok(url.startsWith(`${PAGE}#`), 'the link opens the approval page')
    assert.deepEqual(requestFromLink(url), { v: 1, profile: alice.did, path: 'offer/maths', body: offer, hosts: [host.url] })
    const { versions } = await readAll(host.url, { profile: alice.did })
    assert.equal(
      versions.some((v) => v.entry.path === 'offer/maths'),
      false,
      'the service signs nothing: only the person, on their device, can publish it',
    )
  } finally {
    await client.close()
  }
})

test('anything but /mcp is not found, through the front', async () => {
  assert.equal((await fetch(`${service.url}/`)).status, 404)
  assert.equal((await fetch(`${service.url}/other`, { method: 'POST', body: '{}' })).status, 404)
})

test('the configuration names what is missing, and takes only URLs', () => {
  assert.throws(() => readConfig({}), /missing environment variables: APPROVAL_PAGE, HOSTS/)
  assert.throws(() => readConfig({ APPROVAL_PAGE: 'not a url', HOSTS: 'https://a.example' }), /APPROVAL_PAGE/)
  assert.throws(() => readConfig({ APPROVAL_PAGE: PAGE, HOSTS: 'https://a.example, ftp://b.example' }), /HOSTS/)
  assert.throws(() => readConfig({ APPROVAL_PAGE: PAGE, HOSTS: 'https://a.example', WAIT_SECONDS: '-1' }), /WAIT_SECONDS/)
  const config = readConfig({ APPROVAL_PAGE: PAGE, HOSTS: ' https://a.example ,https://b.example,' })
  assert.deepEqual(config, { approvalPage: PAGE, hosts: ['https://a.example', 'https://b.example'], waitMs: 30_000, pageDir: PAGE_DIR, port: 8080 })
})

test('it serves forest’s approval page as built, with the policy the spec asks for; nothing else changes', async () => {
  const page = await fetch(`${service.url}/approve`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(page.headers.get('content-security-policy'), PAGE_POLICY)
  assert.match(PAGE_POLICY, /frame-ancestors 'none'/)
  assert.match(PAGE_POLICY, /connect-src https:;/, 'reads and posts over https only')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await page.text(), readFileSync(`${PAGE_DIR}/approve.html`, 'utf8'))

  const js = Buffer.from(await (await fetch(`${service.url}/approve.js`)).arrayBuffer())
  const published = (await (await fetch(`${service.url}/approve.js.sha256`)).text()).split(' ')[0]
  assert.equal(createHash('sha256').update(js).digest('hex'), published, 'the bundle served is the one whose hash is published')
  const libraries = (await (await fetch(`${service.url}/approve.deps.txt`)).text()).trim().split('\n').map((l) => l.split(' ')[0])
  assert.deepEqual(libraries, ['@noble/curves', '@noble/hashes', '@scure/base', 'canonicalize'])
  assert.equal((await fetch(`${service.url}/approve.css`)).status, 200)

  assert.equal((await fetch(`${service.url}/approve`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${service.url}/approve.html`)).status, 404, 'only the paths it names')
  assert.equal((await fetch(`${service.url}/`)).status, 404)
})

test('with APPROVAL_PAGE_DIR=none it serves no page', () => {
  assert.equal(readConfig({ APPROVAL_PAGE: PAGE, HOSTS: 'https://h.example', APPROVAL_PAGE_DIR: 'none' }).pageDir, null)
})
