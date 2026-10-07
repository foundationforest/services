// The smoke test's client: the MCP SDK's own, against a copy of forest's MCP door over Streamable
// HTTP. The test (test/smoke.test.ts) runs it against the image's own command on loopback; after a
// deploy, `npm run smoke -- <url> [<profile address>]` runs it against the deployed copy, and reads a
// market and, if given, a profile through it, as a chat would.
//
// What it checks: forest's text on how Forest works comes first, as the server's instructions; there
// is no session; every forest action is a tool, saying which key it needs; a call refused before it
// reads anything (a profile's address that is not one, a write with no key) says why in forest's
// words. Through a deployed copy also: a market as the foundation's index says it, and a profile's
// card, read from its hosts.

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { ACTIONS, HOW, keyNeeded } from '../forest/cli/src/actions.ts'
import { NO_KEY } from '../forest/cli/src/forest.ts'

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const text = (r: unknown) => (r as Result).content[0]?.text ?? ''

/** The checks above against the copy at `url` (ending in /mcp). `read`: what to read through it as well. */
export async function smoke(url: string, read: { market?: string; profile?: string } = {}): Promise<Record<string, unknown>> {
  const client = new Client({ name: 'forest-mcp-smoke', version: '0' })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  try {
    assert.equal(client.getInstructions(), HOW, 'forest’s text on how Forest works comes first')
    assert.equal(transport.sessionId, undefined, 'no session: each request gets a fresh server')
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name), ACTIONS.map((a) => a.name), 'every forest action is a tool')
    for (const a of ACTIONS) assert.ok(tools.find((t) => t.name === a.name)!.description!.endsWith(`Key: ${keyNeeded(a)}.`), `${a.name} says which key it needs`)

    const bad = (await client.callTool({ name: 'profile', arguments: { address: 'not-an-address' } })) as Result
    assert.deepEqual([bad.isError, text(bad)], [true, "not-an-address is not a profile's address"])
    const keyless = (await client.callTool({ name: 'remove-offer', arguments: { id: 'smoke' } })) as Result
    assert.deepEqual([keyless.isError, text(keyless)], [true, NO_KEY], 'a write with no key in the call')
    const seen: Record<string, unknown> = { tools: tools.length, refusals: [text(bad), text(keyless)] }

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
  if (!url) throw new Error('usage: npm run smoke -- <url ending in /mcp> [<profile address>]')
  console.log(JSON.stringify(await smoke(url, { market: 'tutoring', ...(profile && { profile }) }), null, 2))
}
