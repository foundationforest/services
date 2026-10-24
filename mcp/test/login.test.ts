// The login: reading with none; the challenge a relayed tool's call gets; the metadata an AI app
// discovers; the login end to end through the stand-in connect page, by registration and by a client
// document, and its end when the person removes the connection; and every way a login is refused: a
// connection whose key did not sign, a login changed on the way, a person who says no, a code with
// the wrong verifier or for another client, a token this copy did not give, and a copy with no
// connect page.

import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { b64u } from '@foundationforest/records'
import { LOGIN } from '../src/connection.ts'
import { AiApp, CHOICE, REDIRECT, type World, aiApp, browse, logIn, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }
const text = (r: unknown) => (r as Result).content[0]!.text

let w: World
before(async () => {
  w = await world()
  await w.person.open(w.mcp.origin)
})
after(() => w.close())

describe('discovery', () => {
  test('reading needs no login', async () => {
    const { client } = await aiApp(w.mcp.origin)
    const markets = (await client.callTool({ name: 'markets', arguments: {} })) as Result
    assert.notEqual(markets.isError, true, text(markets))
    assert.ok(JSON.parse(text(markets)).markets.some((m: { name: string }) => m.name === 'tutoring'))
    await client.close()
  })

  test('a relayed tool with no token gets the 401 challenge naming the metadata', async () => {
    const res = await fetch(w.mcp.origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post', arguments: {} } }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('www-authenticate'), `Bearer resource_metadata="${w.mcp.origin}/.well-known/oauth-protected-resource"`)
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
})

describe('the login, end to end', () => {
  test('by registration (DCR): the challenge, the connect page, the signer, the code, the token; then the signer answers', async () => {
    const c = await aiApp(w.mcp.origin)
    const back = await logIn(c)
    assert.equal(back.get('iss'), w.mcp.origin, 'the response names this copy, as RFC 9207 asks')
    assert.ok(!(c.app.clientInformation()!.client_id).startsWith('https://'), 'registered')
    const profiles = (await c.client.callTool({ name: 'profiles', arguments: {} })) as Result
    assert.notEqual(profiles.isError, true, text(profiles))
    assert.deepEqual(JSON.parse(text(profiles)), { status: 'done', profiles: [{ market: 'tutoring', role: 'tutor' }, { market: 'tutoring', role: 'student' }] })
    await c.client.close()
  })

  test('by a client document (CIMD): the AI app’s https address is its client id', async () => {
    const c = await aiApp(w.mcp.origin, new AiApp('cimd'))
    await logIn(c)
    assert.equal(c.app.clientInformation()!.client_id, 'https://ai-app.example/client.json')
    const profiles = (await c.client.callTool({ name: 'profiles', arguments: {} })) as Result
    assert.equal(JSON.parse(text(profiles)).status, 'done')
    await c.client.close()
  })

  test('each login is its own connection, saved in the person’s permissions with the AI app’s name', async () => {
    const entries = w.person.permissions() as Array<{ who: { connector: string; connection: string; name: string } }>
    assert.ok(entries.length >= 2)
    for (const e of entries) {
      assert.equal(e.who.connector, w.mcp.origin)
      assert.equal(e.who.name, 'An AI app')
      assert.match(e.who.connection, /^[A-Za-z0-9_-]{43}$/)
    }
    assert.equal(new Set(entries.map((e) => e.who.connection)).size, entries.length)
  })

  test('a login ends when the person removes its connection from their permissions, at their signer', async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const connection = (w.person.permissions().at(-1)!.who as { connection: string }).connection
    await w.person.disconnect(connection)
    assert.ok(!w.person.permissions().some((e) => (e.who as { connection: string }).connection === connection), 'gone from the vault')
    const profiles = (await c.client.callTool({ name: 'profiles', arguments: {} })) as Result
    assert.equal(profiles.isError, true)
    assert.match(text(profiles), /this connection was removed/)
    await c.client.close()
  })
})

/** A login request, as /authorize writes it for the connect page, for a fresh registered AI app. */
async function request(): Promise<string> {
  const reg = (await (await fetch(`${w.mcp.origin}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'An AI app' }) })).json()) as { client_id: string }
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 's1' })
  const res = await fetch(`${w.mcp.origin}/authorize?${q}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  const to = new URL(res.headers.get('location')!)
  assert.equal(to.searchParams.get('connector'), w.mcp.origin)
  return to.searchParams.get('request')!
}

describe('refused', () => {
  test('a login signed by a key that is not the connection’s gives no code', async () => {
    const req = await request()
    const theirs = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!
    const other = generateKeyPairSync('ed25519').privateKey
    const q = new URLSearchParams({ request: req, connection: theirs, sig: b64u.encode(sign(null, Buffer.from(LOGIN + req), other)) })
    const res = await fetch(`${w.mcp.origin}/connected?${q}`, { redirect: 'manual' })
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('location'), null, 'no code goes anywhere')
    assert.match(await res.text(), /The connection's key did not sign this login/)
  })

  test('a login request changed on the way is refused', async () => {
    const req = await request()
    const changed = `${b64u.encode(Buffer.from(JSON.stringify({ client: 'x', redirect: 'https://evil.example/', exp: Date.now() + 60_000 })))}.${req.split('.')[1]}`
    const res = await fetch(`${w.mcp.origin}/connected?${new URLSearchParams({ request: changed, error: 'x' })}`, { redirect: 'manual' })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /not made here, or was changed/)
  })

  test('an AI app this copy does not know gets a page, never a redirect', async () => {
    const res = await fetch(`${w.mcp.origin}/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'made-up', redirect_uri: REDIRECT })}`, { redirect: 'manual' })
    assert.equal(res.status, 400)
    assert.equal(res.headers.get('location'), null)
  })

  test('a person who says no sends the AI app access_denied, with its state, and no code', async () => {
    const sent = await browse(await w.person.connect(w.mcp.origin, await request(), 'no'))
    assert.equal(sent.get('error'), 'access_denied')
    assert.equal(sent.get('state'), 's1')
    assert.equal(sent.get('code'), null)
  })

  test('a code with the wrong verifier, or for another client, gives no token', async () => {
    const req = await request()
    const back = await browse(await w.person.connect(w.mcp.origin, req, CHOICE))
    const code = back.get('code')!
    const client = JSON.parse(Buffer.from(b64u.decode(req.split('.')[0]!)).toString()).client as string
    const token = (form: { [key: string]: string }) => fetch(`${w.mcp.origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
    const wrong = await token({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: REDIRECT, code_verifier: 'not-the-verifier-not-the-verifier-not-the-verifier' })
    assert.equal(wrong.status, 400)
    assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_grant')
    const other = await token({ grant_type: 'authorization_code', code, client_id: 'someone-else', redirect_uri: REDIRECT, code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' })
    assert.equal(other.status, 400)
    // The verifier RFC 7636 pairs with the challenge above: the right one gives a token.
    const right = await token({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: REDIRECT, code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' })
    assert.equal(right.status, 200, await right.clone().text())
    const got = (await right.json()) as { access_token: string; token_type: string; expires_in?: number }
    assert.equal(got.token_type, 'Bearer')
    assert.equal(got.expires_in, undefined, 'a login does not expire')
    assert.deepEqual(Object.keys(JSON.parse(Buffer.from(b64u.decode(got.access_token.split('.')[0]!)).toString())).sort(), ['aud', 'client', 'connection'], 'the token names the connection, the client and this copy, and no expiry')
  })

  test('a token this copy did not give gets the challenge again, on any request', async () => {
    const res = await fetch(w.mcp.origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer made.up' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate')!, /error="invalid_token"/)
  })
})

test('with no connect page, reading works and logins wait', async () => {
  const waiting = await world({ noApp: true })
  try {
    const { client } = await aiApp(waiting.mcp.origin)
    const read = (await client.callTool({ name: 'market', arguments: { market: 'tutoring' } })) as Result
    assert.notEqual(read.isError, true, text(read))
    await client.close()
    const res = await fetch(`${waiting.mcp.origin}/authorize?client_id=x`)
    assert.equal(res.status, 503)
    assert.match(await res.text(), /Logins here wait for the Forest app's connect page/)
  } finally {
    await waiting.close()
  }
})
