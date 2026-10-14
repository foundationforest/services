// The smoke test's client: the MCP SDK's own, against a copy of forest's MCP door over Streamable
// HTTP. The test (test/smoke.test.ts) runs it against the image's own command on loopback; after a
// deploy, `npm run smoke -- <url> [<profile address>]` runs it against the deployed copy, and reads a
// market and, if given, a profile through it, as a chat would.
//
// What it checks: forest's text on how Forest works comes first, as the server's instructions, with
// the mark as the server's icon; there is no session; every action a hosted copy serves is a tool,
// its description starting with the key it needs; a call refused before it reads anything (a
// profile's address that is not one, a write with no key) says why in forest's words; the same tools
// answer at /mcp, for connectors added before; and the icon is at /favicon.ico and /icon.svg.
// Through a deployed copy also: a market as the foundation's index says it, and a profile's card,
// read from its hosts.

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { HOSTED, HOW, keyNeeded } from './src/actions.ts'
import { NO_KEY } from './src/forest.ts'
import { ICO, ICON, SVG } from './src/icon.ts'

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const text = (r: unknown) => (r as Result).content[0]?.text ?? ''

/** The tools the copy at `url` lists, and its client, connected. */
async function connected(url: URL) {
  const client = new Client({ name: 'forest-mcp-smoke', version: '0' })
  const transport = new StreamableHTTPClientTransport(url)
  await client.connect(transport)
  return { client, transport, tools: (await client.listTools()).tools }
}

/** The checks above against the copy at `url`, its address. `read`: what to read through it as well. */
export async function smoke(url: string, read: { market?: string; profile?: string } = {}): Promise<Record<string, unknown>> {
  const { client, transport, tools } = await connected(new URL(url))
  try {
    assert.equal(client.getInstructions(), HOW, 'forest’s text on how Forest works comes first')
    assert.deepEqual(client.getServerVersion()?.icons, [ICON], 'the mark on paper is the server’s icon')
    assert.equal(transport.sessionId, undefined, 'no session: each request gets a fresh server')
    assert.deepEqual(tools.map((t) => t.name), HOSTED.map((a) => a.name), 'every action a hosted copy serves is a tool')
    for (const a of HOSTED) assert.ok(tools.find((t) => t.name === a.name)!.description!.startsWith(`${keyNeeded(a)}. `), `${a.name} starts with the key it needs`)

    const bad = (await client.callTool({ name: 'profile', arguments: { address: 'not-an-address' } })) as Result
    assert.deepEqual([bad.isError, text(bad)], [true, "not-an-address is not a profile's address"])
    const keyless = (await client.callTool({ name: 'offer', arguments: { action: 'remove', id: 'smoke' } })) as Result
    assert.deepEqual([keyless.isError, text(keyless)], [true, NO_KEY], 'a write with no key in the call')

    const before = await connected(new URL('/mcp', url))
    await before.client.close()
    assert.deepEqual(before.tools, tools, 'the same tools at /mcp, for connectors added before')
    for (const [path, type, body] of [['/favicon.ico', 'image/x-icon', ICO], ['/icon.svg', 'image/svg+xml', Buffer.from(SVG)]] as const) {
      const res = await fetch(new URL(path, url))
      assert.equal(res.headers.get('content-type'), type, path)
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(body), `${path} is the mark`)
    }
    const seen: Record<string, unknown> = { tools: tools.map((t) => t.name), refusals: [text(bad), text(keyless)], icon: ['/favicon.ico', '/icon.svg'] }

    if (read.market) {
      const got = (await client.callTool({ name: 'market', arguments: { market: read.market } })) as Result
      assert.notEqual(got.isError, true, `the market, through the copy: ${text(got)}`)
      const out = JSON.parse(text(got))
      assert.equal(out.market, read.market)
      seen.market = { index: out.index, market: out.market }
    }
    if (read.profile) {
      const got = (await client.callTool({ name: 'profile', arguments: { address: read.profile } })) as Result
      assert.notEqual(got.isError, true, `the profile, through the copy: ${text(got)}`)
      const out = JSON.parse(text(got))
      assert.ok(out.card, 'its card, read from its hosts')
      seen.profile = { address: out.address, hosts: out.hosts, name: out.card.body.name, offers: out.offers.length }
    }
    return seen
  } finally {
    await client.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, profile] = process.argv.slice(2)
  if (!url) throw new Error('usage: npm run smoke -- <the copy\'s address> [<profile address>]')
  console.log(JSON.stringify(await smoke(url, { market: 'tutoring', ...(profile && { profile }) }), null, 2))
}
