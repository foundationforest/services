// The smoke test's client: the MCP SDK's own, against a copy of this mcp over Streamable HTTP. The
// test (test/smoke.test.ts) runs it against the image's own command on loopback, with a login through
// the stand-in connect page; after a deploy, `npm run smoke -- <url>` runs it against the deployed
// copy, and checks what needs no person.
//
// What it checks: how Forest works comes first, as the server's instructions, with the mark as the
// server's icon; there is no session; every tool is listed; reading works with no login; a call to
// a tool that acts for the person, with no token, gets the 401 challenge, naming the metadata; the
// metadata names this copy as the resource and its own authorization server; its open key is at
// /open-key; an AI app can register; /authorize sends the person to the app's connect page, or says
// logins wait; the same tools answer at /mcp; the icon is at /favicon.ico and /icon.svg. Given a way
// through the connect page, also: the login, and my_profiles answering, with the profiles ticked or
// with why the connection's hosts were not reached.

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { ICO, ICON, SVG } from './src/icon.ts'
import { HOW, TOOLS } from './src/tools.ts'

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> }
const text = (r: unknown) => (r as Result).content[0]?.text ?? ''

/** The tools the copy at `url` lists, and its client, connected with no login, or with `authProvider`. */
async function connected(url: URL, authProvider?: OAuthClientProvider) {
  const client = new Client({ name: 'forest-mcp-smoke', version: '0' })
  const transport = new StreamableHTTPClientTransport(url, authProvider && { authProvider })
  await client.connect(transport)
  return { client, transport, tools: (await client.listTools()).tools }
}

/**
 * The checks above against the copy at `url`, its address. `login`: an OAuth provider, and how the
 * person's browser goes from its authorization address through the connect page back to it, giving
 * the code; then the login is checked too.
 */
export async function smoke(url: string, login?: { provider: OAuthClientProvider & { authorization?: URL }; browse: (from: URL) => Promise<URLSearchParams> }): Promise<Record<string, unknown>> {
  const origin = new URL(url).origin
  const { client, transport, tools } = await connected(new URL(url), login?.provider)
  try {
    assert.ok(client.getInstructions()?.startsWith(`${HOW}\n\nThe index`), "how Forest works comes first, then what the index says of its guide")
    assert.deepEqual(client.getServerVersion()?.icons, [ICON], 'the mark on paper is the server’s icon')
    assert.equal(transport.sessionId, undefined, 'no session: each request gets a fresh server')
    assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name), 'every tool is listed')

    const markets = (await client.callTool({ name: 'markets', arguments: {} })) as Result
    assert.notEqual(markets.isError, true, `reading needs no login: ${text(markets)}`)
    assert.ok(JSON.parse(text(markets)).markets.some((m: { name: string }) => m.name === 'tutoring'))

    const challenge = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_profiles', arguments: {} } }),
    })
    assert.equal(challenge.status, 401, 'a tool that acts for the person, with no token, gets the challenge')
    assert.equal(challenge.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`)
    const resource = (await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json()) as { resource: string; authorization_servers: string[] }
    assert.deepEqual([resource.resource, resource.authorization_servers], [origin, [origin]])
    const server = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as { issuer: string; code_challenge_methods_supported: string[] }
    assert.deepEqual([server.issuer, server.code_challenge_methods_supported], [origin, ['S256']])
    const { openKey } = (await (await fetch(`${origin}/open-key`)).json()) as { openKey: string }
    assert.match(openKey, /^age1pq1[02-9ac-hj-np-z]{1952}$/, 'its open key, which the connect page locks the connection to')
    const registered = await fetch(`${origin}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://smoke.invalid/callback'], token_endpoint_auth_method: 'none' }) })
    assert.equal(registered.status, 201, 'an AI app can register')
    const { client_id } = (await registered.json()) as { client_id: string }
    const authorize = await fetch(`${origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://smoke.invalid/callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })}`, { redirect: 'manual' })
    const logins = authorize.status === 302 ? `to ${new URL(authorize.headers.get('location')!).origin}` : authorize.status === 503 ? 'waiting for the connect page' : `answered ${authorize.status}`
    assert.ok(authorize.status === 302 || authorize.status === 503, `/authorize sends the person to the connect page, or says logins wait: ${logins}`)

    const before = await connected(new URL('/mcp', url))
    await before.client.close()
    assert.deepEqual(before.tools, tools, 'the same tools at /mcp, for connectors added before')
    for (const [path, type, body] of [['/favicon.ico', 'image/x-icon', ICO], ['/icon.svg', 'image/svg+xml', Buffer.from(SVG)]] as const) {
      const res = await fetch(new URL(path, url))
      assert.equal(res.headers.get('content-type'), type, path)
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(body), `${path} is the mark`)
    }
    const seen: Record<string, unknown> = { tools: tools.map((t) => t.name), logins, icon: ['/favicon.ico', '/icon.svg'] }

    if (login) {
      await assert.rejects(client.callTool({ name: 'my_profiles', arguments: {} }), UnauthorizedError, 'a tool that acts for the person starts the login')
      await transport.finishAuth((await login.browse(login.provider.authorization!)).get('code')!)
      // The login is taken: my_profiles answers, with the profiles' labels, or with why the
      // connection's hosts were not reached from this copy.
      const mine = (await client.callTool({ name: 'my_profiles', arguments: {} })) as Result
      seen.login = mine.isError ? { refused: text(mine) } : (JSON.parse(text(mine)) as { profiles: Array<{ label: string }> }).profiles.map((p) => p.label)
    }
    return seen
  } finally {
    await client.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url] = process.argv.slice(2)
  if (!url) throw new Error("usage: npm run smoke -- <the copy's address>")
  console.log(JSON.stringify(await smoke(url), null, 2))
}
