// Connections end to end on loopback: forest's reference host, this service, an assistant doing
// OAuth with PKCE and calling the tools over MCP, and the person's app adding and removing the
// writer key with the profile's own key.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { profileKey } from '../../forest/keys/src/index.ts'
import { Host } from '../../forest/records/src/host.ts'
import { hostsRecord, ownerRecord, permissionsRecord, publish, readProfile } from '../../forest/records/src/index.ts'

import { readConfig, startConnections } from '../src/service.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

const b64u = (b: Buffer) => b.toString('base64url')
const BANNED = /\b(wallets?|usdc|chains?|blockchains?|gas|crypto(currency)?|tokens?|solana|mints?|seed)\b/i
const readable = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')

test('an assistant connects with OAuth, the person adds its writer key, and it posts an offer and a review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-connections-'))
  dirs.push(dir)
  const host = new Host()
  const hostUrl = await host.listen(0)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const dbPath = join(dir, 'connections.sqlite')
  const service = await startConnections(readConfig({ PUBLIC_URL: base, HOSTS: hostUrl, DATABASE_PATH: dbPath, PORT: String(port) }))
  try {
    // The person's app: a profile, and its hosts record on the host.
    const me = await profileKey(randomBytes(32), 'tutoring/seller')
    const them = await profileKey(randomBytes(32), 'tutoring/buyer')
    const t0 = Date.now()
    assert.ok((await publish([hostUrl], [hostsRecord(me, [hostUrl], t0), ownerRecord(me, 'profile', { name: 'Ana', market: 'tutoring', role: 'seller', createdAt: new Date(t0).toISOString() }, t0)]))[0]!.results.every((r) => r.ok))

    // An assistant with no token is sent to the metadata.
    const mcpUrl = `${base}/mcp`
    const denied = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(denied.status, 401)
    assert.match(denied.headers.get('www-authenticate') ?? '', new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`))
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()
    assert.deepEqual([resource.resource, resource.authorization_servers], [mcpUrl, [`${base}/`]])
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256'])

    // It registers itself, and sends the person to /authorize with a PKCE challenge.
    const redirect = 'http://127.0.0.1:9/callback'
    const reg = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: 'Test assistant', grant_types: ['authorization_code', 'refresh_token'] }),
    })
    assert.equal(reg.status, 201)
    const client = await reg.json()
    const verifier = b64u(randomBytes(32))
    const challenge = b64u(createHash('sha256').update(verifier).digest())
    const authorize = new URL(meta.authorization_endpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: mcpUrl })) {
      authorize.searchParams.set(k, v)
    }
    const first = await fetch(authorize, { redirect: 'manual' })
    assert.equal(first.status, 200)
    assert.match(first.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    const firstPage = await first.text()
    assert.match(firstPage, /Test assistant asks to post offers and reviews/)
    const connect = /action="(\/connect\/[^"]+)"/.exec(firstPage)![1]!
    assert.ok(!connect.includes(me.address), 'the page carries a random id, never the profile')

    // The person names the profile, in the form's body: a writer key is made, and shown.
    const bad = await fetch(base + connect, { method: 'POST', body: new URLSearchParams({ profile: 'not-an-address' }), redirect: 'manual' })
    assert.equal(bad.status, 400)
    const named = await fetch(base + connect, { method: 'POST', body: new URLSearchParams({ profile: me.address }), redirect: 'manual' })
    assert.equal(named.status, 303)
    assert.equal(named.headers.get('location'), connect)
    const waiting = await (await fetch(base + connect, { redirect: 'manual' })).text()
    const writer = /<code>([1-9A-HJ-NP-Za-km-z]{32,44})<\/code>/.exec(waiting)![1]!
    assert.match(waiting, /http-equiv="refresh"/)
    for (const html of [firstPage, waiting]) assert.equal(BANNED.exec(readable(html)), null, 'no crypto word on a page a person reads')
    assert.equal((await fetch(base + connect, { redirect: 'manual' })).status, 200, 'still waiting: the profile does not list the key yet')

    // The person's app adds the writer key, signed with the profile's own key; the grant goes through.
    const t1 = Date.now()
    await publish([hostUrl], [permissionsRecord(me, [{ key: writer, paths: ['offer', 'review'], until: t1 + 30 * 86_400_000 }], t1)])
    const granted = await fetch(base + connect, { redirect: 'manual' })
    assert.equal(granted.status, 302)
    const back = new URL(granted.headers.get('location')!)
    assert.equal(`${back.origin}${back.pathname}`, redirect)
    assert.equal(back.searchParams.get('state'), 'xyz')
    const code = back.searchParams.get('code')!

    // The code, with the verifier, for tokens; once.
    const exchange = (body: Record<string, string>) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    const wrong = await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: b64u(randomBytes(32)) })
    assert.equal(wrong.status, 400, 'the wrong verifier')
    const tokens = await (await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).json()
    assert.equal(tokens.token_type, 'bearer')
    assert.equal((await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).status, 400, 'a code counts once')

    // The assistant, over MCP, with its token.
    const mcp = async (token: string) => {
      const c = new Client({ name: 'test-assistant', version: '0.0.0' })
      await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return c
    }
    const assistant = await mcp(tokens.access_token)
    const { tools } = await assistant.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ['post_offer', 'post_review'])
    const offerTool = tools.find((t) => t.name === 'post_offer')!
    assert.deepEqual((offerTool.inputSchema as any).properties.offer.required, ['direction', 'description', 'createdAt'], "forest's own offer shape")

    const offer = { direction: 'offer', description: 'One hour of maths, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, remote: true }
    const posted = await assistant.callTool({ name: 'post_offer', arguments: { id: 'maths', offer } })
    assert.equal(posted.isError, undefined, JSON.stringify(posted))
    assert.equal((posted.structuredContent as any).path, 'offer/maths')
    const review = await assistant.callTool({ name: 'post_review', arguments: { review: { subject: them.address, ratings: { overall: '9' }, text: 'Paid on time.' } } })
    assert.equal(review.isError, undefined, JSON.stringify(review))

    // On the host: signed by the writer key, for the profile, counted by forest's view.
    const view = await readProfile([hostUrl], me.address, Date.now())
    const maths = view.current.get('offer/maths')!.record
    assert.equal(maths.by, writer)
    assert.equal(maths.profile, me.address)
    assert.deepEqual((maths.body as any).price, offer.price)
    assert.ok([...view.current.keys()].some((p) => p.startsWith('review/')))

    // What it may not do: a body that is not an offer, and a path the profile's own key wrote.
    assert.equal((await assistant.callTool({ name: 'post_offer', arguments: { offer: { direction: 'sell' } } })).isError, true)
    await publish([hostUrl], [ownerRecord(me, 'offer/mine', { direction: 'offer', description: 'Mine.', createdAt: new Date().toISOString() }, Date.now())])
    const owners = await assistant.callTool({ name: 'post_offer', arguments: { id: 'mine', offer } })
    assert.equal(owners.isError, true)
    assert.match(JSON.stringify(owners), /own key wrote offer\/mine/)

    // The person removes the writer key in their app: from then on the tools refuse; what it wrote stays.
    const t2 = Date.now()
    await publish([hostUrl], [permissionsRecord(me, [{ key: writer, paths: ['offer', 'review'], until: t2 }], t2 + 1)])
    const refused = await assistant.callTool({ name: 'post_offer', arguments: { id: 'later', offer } })
    assert.equal(refused.isError, true)
    assert.match(JSON.stringify(refused), /not on the profile's permissions list/)
    assert.equal((await readProfile([hostUrl], me.address, Date.now())).current.get('offer/maths')!.record.by, writer, 'what it wrote stays')
    await assistant.close()

    // Refreshing gives a new token and spends the old refresh token; a revoked token is refused.
    const refreshed = await (await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json()
    assert.ok(refreshed.access_token)
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status, 400)
    await fetch(meta.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshed.access_token, client_id: client.client_id }) })
    const revoked = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${refreshed.access_token}` }, body: '{}' })
    assert.equal(revoked.status, 401)

    // The file holds no token, code or profile key in the clear.
    const file = readFileSync(dbPath)
    for (const secret of [tokens.access_token, tokens.refresh_token, refreshed.access_token, refreshed.refresh_token, code]) assert.equal(file.includes(Buffer.from(secret)), false)
    assert.equal(file.includes(Buffer.from(me.privateKey)), false)
  } finally {
    await service.close()
    await host.close()
  }
})

test('the configuration names what is missing, and takes origins only', () => {
  assert.throws(() => readConfig({}), /PUBLIC_URL, HOSTS/)
  assert.throws(() => readConfig({ PUBLIC_URL: 'https://c.example/x', HOSTS: 'https://h.example' }), /origin/)
  assert.throws(() => readConfig({ PUBLIC_URL: 'https://c.example', HOSTS: 'https://h.example/path' }), /HOSTS/)
  const c = readConfig({ PUBLIC_URL: 'https://c.example', HOSTS: 'https://h.example, https://i.example' })
  assert.deepEqual([c.publicUrl, c.hosts, c.port], ['https://c.example', ['https://h.example', 'https://i.example'], 8080])
})
