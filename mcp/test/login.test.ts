// The login: reading with none; the challenge a call to a tool that acts for the person gets; the
// metadata an AI app discovers, and the open key the connect page locks the pack to; the login end
// to end through the stand-in connect page, by registration and by a client document, each login
// its own access keys, listed and noted in each profile ticked; and every way a login is refused: a
// pack not locked to this copy, a pack for another login, a pack too long, a login changed on the
// way, a person who says no, a code with the wrong verifier or for another client, a token this copy
// did not give, a token from before packs, a token whose pack no longer opens, and a copy with no
// connect page. Nothing is kept: a token works on another copy with the same two keys, and the data
// directory holds only them.

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { b64u, notePath, readFolder } from '@foundationforest/folders'
import { lock, lockCount, openLocked } from '@foundationforest/folders/locked'
import { mainKey, newAccessKey, openingHalf } from '@foundationforest/keys'
import { MAX_PACK } from '../src/pack.ts'
import { serve } from '../src/server.ts'
import { AiApp, CHOICE, REDIRECT, type World, aiApp, browse, clientFetch, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }
const text = (r: unknown) => (r as Result).content[0]!.text
const OPEN_KEY = /^age1pq1[02-9ac-hj-np-z]{1952}$/

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

/** A login request, as /authorize sends it to the connect page, for a client registered by `name`; and its PKCE verifier. */
async function request(name = 'An AI app'): Promise<{ request: string; clientId: string; verifier: string }> {
  const reg = (await (await fetch(`${w.mcp.origin}/register`, { method: 'POST', body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }
  const verifier = b64u.encode(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64u.encode(createHash('sha256').update(verifier).digest())
  const res = await fetch(`${w.mcp.origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  const to = new URL(res.headers.get('location')!)
  assert.equal(to.origin + to.pathname, new URL(w.appUrl).origin + '/', 'on to the connect page')
  assert.equal(to.searchParams.get('connector'), w.mcp.origin)
  return { request: to.searchParams.get('request')!, clientId: reg.client_id, verifier }
}

/** What /connected answers for this query: its status and its body or where it sends the browser. */
async function connected(query: { [name: string]: string }): Promise<{ status: number; text: string; location: string | null }> {
  const res = await fetch(`${w.mcp.origin}/connected?${new URLSearchParams(query)}`, { redirect: 'manual' })
  return { status: res.status, text: await res.text(), location: res.headers.get('location') }
}

describe('discovery', () => {
  test('reading needs no login', async () => {
    const { client } = await aiApp(w.mcp.origin)
    const markets = (await client.callTool({ name: 'markets', arguments: {} })) as Result
    assert.notEqual(markets.isError, true, text(markets))
    assert.ok(JSON.parse(text(markets)).markets.some((m: { name: string }) => m.name === 'tutoring'))
    await client.close()
  })

  test('a tool that acts for the person, with no token, gets the 401 challenge naming the metadata', async () => {
    for (const name of ['my_profiles', 'read', 'write', 'message']) {
      const res = await fetch(w.mcp.origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
      })
      assert.equal(res.status, 401, name)
      assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${w.mcp.origin}/.well-known/oauth-protected-resource"`)
    }
  })

  test('the metadata: this copy is the resource and its own authorization server, with PKCE, CIMD, DCR and iss', async () => {
    const resource = await (await fetch(`${w.mcp.origin}/.well-known/oauth-protected-resource`)).json()
    assert.deepEqual(resource, { resource: w.mcp.origin, authorization_servers: [w.mcp.origin], bearer_methods_supported: ['header'], resource_name: 'Forest' })
    const server = (await (await fetch(`${w.mcp.origin}/.well-known/oauth-authorization-server`)).json()) as { [key: string]: unknown }
    assert.equal(server.issuer, w.mcp.origin)
    assert.deepEqual(server.code_challenge_methods_supported, ['S256'])
    assert.equal(server.client_id_metadata_document_supported, true)
    assert.equal(server.registration_endpoint, `${w.mcp.origin}/register`)
    assert.equal(server.authorization_response_iss_parameter_supported, true)
  })

  test('its open key, at /open-key, for any page to read; the same after a restart on the same volume', async () => {
    const res = await fetch(`${w.mcp.origin}/open-key`)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const { openKey } = (await res.json()) as { openKey: string }
    assert.match(openKey, OPEN_KEY)
    const again = await serve({ dataDir: w.dataDir, read: { index: w.index } }, '127.0.0.1', 0)
    try {
      assert.deepEqual(await (await fetch(`${again.url}/open-key`)).json(), { openKey })
    } finally {
      await again.close()
    }
  })
})

describe('the login, end to end', () => {
  test('by registration (DCR): the challenge, the connect page, the pack, the code, the token; then it acts in the profiles ticked', async () => {
    const before = await w.app.keys('tutoring/tutor')
    const c = await aiApp(w.mcp.origin)
    const back = await logIn(c)
    assert.equal(back.get('iss'), w.mcp.origin, 'the response names this copy, as RFC 9207 asks')
    const mine = (await c.client.callTool({ name: 'my_profiles', arguments: {} })) as Result
    assert.deepEqual(JSON.parse(text(mine)), { profiles: CHOICE !== 'no' ? CHOICE.profiles.map((label) => ({ label, can: ['read-inbox', 'read', 'write', 'message'] })) : [] })
    // The token carries the pack locked: no label, address or key of the person's is in it.
    const token = c.app.tokens()!.access_token
    const plain = Buffer.from(b64u.decode(token.split('.')[0]!)).toString('utf8')
    for (const secret of ['tutoring/tutor', ...Object.values(w.own)]) assert.equal(plain.includes(secret), false, `the token holds ${secret} only locked`)
    // One new access key in each profile ticked, with every switch, and none in the third.
    const after = await w.app.keys('tutoring/tutor')
    assert.equal(after.length, before.length + 1)
    assert.deepEqual(after.at(-1)!.can, ['read-inbox', 'read', 'write', 'message'])
    assert.match(after.at(-1)!.open!, OPEN_KEY, 'with its open key, since it may read')
    assert.deepEqual(await w.app.keys('clothing/seller'), [])
    // Its note, at its keyed path, locked to the main key alone, naming the AI app and this copy.
    const main = await mainKey(w.seed, 'tutoring/tutor')
    const view = await readFolder([w.host], main.address, Date.now())
    const note = view.current.get(notePath(main.secret, after.at(-1)!.key))!.entry.body as { private: string }
    assert.equal(lockCount(note), 1, 'locked to one key')
    const opened = await openLocked(note, (await openingHalf(main.secret)).identity)
    assert.deepEqual([opened.name, opened.connector], ['An AI app', w.mcp.origin])
    await c.client.close()
  })

  test('by a client document (CIMD), each login its own access keys', async () => {
    const before = (await w.app.keys('tutoring/student')).length
    const c = await aiApp(w.mcp.origin, new AiApp('cimd'))
    await logIn(c)
    assert.ok(c.app.authorization!.searchParams.get('client_id')!.startsWith('https://'))
    assert.equal((await w.app.keys('tutoring/student')).length, before + 1)
    assert.equal(((await c.client.callTool({ name: 'my_profiles', arguments: {} })) as Result).isError, undefined)
    await c.client.close()
  })

  test('the person chooses fewer switches, and which profiles', async () => {
    w.choose({ profiles: ['clothing/seller'], can: ['write'] })
    try {
      const c = await aiApp(w.mcp.origin)
      await logIn(c)
      assert.deepEqual(JSON.parse(text(await c.client.callTool({ name: 'my_profiles', arguments: {} }))), { profiles: [{ label: 'clothing/seller', can: ['write'] }] })
      const [listed] = await w.app.keys('clothing/seller')
      assert.deepEqual(listed!.can, ['write'])
      assert.equal(listed!.open, undefined, 'a key that may not read gives no open key')
      await c.client.close()
    } finally {
      w.choose(CHOICE)
    }
  })
})

describe('refused', () => {
  test('a pack locked to a key that is not this copy’s', async () => {
    const { request: r } = await request()
    const other = await newAccessKey()
    const pack = (await lock({ request: createHash('sha256').update(r).digest('hex'), profiles: [] }, [other.openKey])).private
    const got = await connected({ request: r, pack })
    assert.equal(got.status, 400)
    assert.match(got.text, /not locked to this server's open key/)
  })

  test('a pack for another login: seen on its way back, it opens no other', async () => {
    const first = await request()
    const back = new URL(await w.app.connect(w.mcp.origin, first.request, CHOICE))
    const second = await request()
    const got = await connected({ request: second.request, pack: back.searchParams.get('pack')! })
    assert.equal(got.status, 400)
    assert.match(got.text, /for another login/)
    // And with its own request, it goes through.
    const ok = await connected({ request: first.request, pack: back.searchParams.get('pack')! })
    assert.equal(ok.status, 302)
    assert.ok(new URL(ok.location!).searchParams.get('code'))
  })

  test('a pack that is not one, or longer than this copy takes', async () => {
    const { request: r } = await request()
    const { openKey } = (await (await fetch(`${w.mcp.origin}/open-key`)).json()) as { openKey: string }
    const hash = createHash('sha256').update(r).digest('hex')
    const odd = (await lock({ request: hash, profiles: [{ label: 'tutoring/tutor' }] }, [openKey])).private
    assert.match((await connected({ request: r, pack: odd })).text, /not a pack: each profile is \{ label, address, hosts, key, can \}/)
    const none = (await lock({ request: hash, profiles: [] }, [openKey])).private
    assert.match((await connected({ request: r, pack: none })).text, /one profile or more/)
    assert.match((await connected({ request: r, pack: 'A'.repeat(MAX_PACK + 1) })).text, new RegExp(`at most ${MAX_PACK} characters`))
  })

  test('a login changed on the way, a person who says no', async () => {
    const { request: r } = await request()
    const changed = connected({ request: r.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')), pack: 'x' })
    assert.match((await changed).text, /not made here, or was changed/)
    const no = await connected({ request: r, error: 'access_denied' })
    assert.equal(no.status, 302)
    const q = new URL(no.location!).searchParams
    assert.deepEqual([q.get('error'), q.get('state'), q.get('iss')], ['access_denied', 's', w.mcp.origin])
  })

  test('a code with the wrong verifier, or for another client', async () => {
    const first = await request()
    const ok = await connected({ request: first.request, pack: new URL(await w.app.connect(w.mcp.origin, first.request, CHOICE)).searchParams.get('pack')! })
    const code = new URL(ok.location!).searchParams.get('code')!
    const token = (form: { [name: string]: string }) => fetch(`${w.mcp.origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, ...form }) })
    const wrong = await token({ client_id: first.clientId, code_verifier: 'x'.repeat(43) })
    assert.equal(wrong.status, 400)
    assert.match(JSON.stringify(await wrong.json()), /code_verifier does not match/)
    const other = await request('Another AI app')
    const theirs = await token({ client_id: other.clientId, code_verifier: first.verifier })
    assert.match(JSON.stringify(await theirs.json()), /given to another client/)
    const right = await token({ client_id: first.clientId, code_verifier: first.verifier })
    assert.equal(right.status, 200)
  })

  test('a token this copy did not give, and one from before packs, on any request', async () => {
    const call = (token: string) =>
      fetch(w.mcp.origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
    const foreign = await call('e30.bm90LW1pbmU')
    assert.equal(foreign.status, 401)
    assert.match(foreign.headers.get('www-authenticate')!, /error="invalid_token"/)
    // One this copy signed before packs, naming a connection: signed with its own key, it still gives nothing.
    const key = b64u.decode((JSON.parse(readFileSync(`${w.dataDir}/mcp-key.json`, 'utf8')) as { key: string }).key)
    const body = b64u.encode(Buffer.from(JSON.stringify({ connection: 'c'.repeat(43), client: 'x', aud: w.mcp.origin })))
    const old = `${body}.${b64u.encode(createHmac('sha256', key).update(`forest-mcp/v1/access\n${body}`).digest())}`
    const before = await call(old)
    assert.equal(before.status, 401)
    assert.match(before.headers.get('www-authenticate')!, /error="invalid_token"/)
  })

  test("a token whose pack no longer opens, once this copy's opening half changed: a login to make again", async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const token = c.app.tokens()!.access_token
    await c.client.close()
    // The same key that signs logins, a new opening half.
    const dir = mkdtempSync(join(tmpdir(), 'forest-mcp-'))
    copyFileSync(join(w.dataDir, 'mcp-key.json'), join(dir, 'mcp-key.json'))
    const other = await serve({ origin: w.mcp.origin, dataDir: dir, read: { index: w.index }, hostFetch: fetch }, '127.0.0.1', 0)
    try {
      const res = await fetch(other.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_profiles', arguments: {} } }),
      })
      assert.equal(res.status, 401)
      assert.match(res.headers.get('www-authenticate')!, /error="invalid_token"/)
    } finally {
      await other.close()
    }
  })

  test('with no connect page, logins wait and reading works', async () => {
    const waiting = await world({ noApp: true })
    try {
      const reg = (await (await fetch(`${waiting.mcp.origin}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }
      const res = await fetch(`${waiting.mcp.origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' })}`, { redirect: 'manual' })
      assert.equal(res.status, 503)
      assert.match(await res.text(), /wait for the Forest app's connect page/)
      const { client } = await aiApp(waiting.mcp.origin)
      assert.notEqual(((await client.callTool({ name: 'markets', arguments: {} })) as Result).isError, true)
      await client.close()
    } finally {
      await waiting.close()
    }
  })
})

test('nothing kept: a token one copy gave works on another with the same two keys, and the data directory holds only them', async () => {
  const c = await aiApp(w.mcp.origin)
  await logIn(c)
  const token = c.app.tokens()!.access_token
  await c.client.close()
  const other = await serve({ origin: w.mcp.origin, dataDir: w.dataDir, read: { index: w.index }, clientFetch, hostFetch: fetch }, '127.0.0.1', 0)
  try {
    const res = await fetch(other.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_profiles', arguments: {} } }),
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /tutoring\/tutor/)
  } finally {
    await other.close()
  }
  assert.deepEqual(readdirSync(w.dataDir).sort(), ['mcp-key.json', 'mcp-opening.json'])
})
