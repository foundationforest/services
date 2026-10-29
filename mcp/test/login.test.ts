// The login: reading with none; the challenge a call to a tool that acts for the person gets; the
// metadata an AI app discovers, and the open key the connect page locks the connection to; the
// login end to end through the stand-in connect page, by registration and by a client document,
// each login its own connection folder and access keys, listed and noted in each profile ticked; a
// profile added and one removed with no new login; a connection ended, refused at its next call;
// and every way a login is refused: a pointer not locked to this copy, a pointer for another login,
// one that is not one or too long, a login changed on the way, a person who says no, a code with the
// wrong verifier or for another client, a pointer naming the person's connection folder without its
// secret, one naming a folder with no connection, a token this copy did not give, a token from
// before connections, a token whose pointer no longer opens, and a copy with no connect page. Hosts
// that do not answer are a refusal, not a new login. Nothing is kept: a token works on another copy
// with the same two keys, and the data directory holds only them.

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { type Body, b64u, entry, liveContent, readFolder, write } from '@foundationforest/folders'
import { lock, lockCount, openLocked } from '@foundationforest/folders/locked'
import { accessKey, mainKey, newAccessKey, openingHalf } from '@foundationforest/keys'
import { MAX_POINTER } from '../src/connection.ts'
import { serve } from '../src/server.ts'
import { App } from './app.ts'
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

const TUTOR = 'tutoring/tutor'
const STUDENT = 'tutoring/student'
const SELLER = 'clothing/seller'
const SWITCHES = ['read-inbox', 'read', 'write', 'message']
const hash = (request: string) => createHash('sha256').update(request).digest('hex')
const randomSecret = () => b64u.encode(crypto.getRandomValues(new Uint8Array(32)))

/** This copy's open key, which pointers and connections are locked to. */
async function openKey(): Promise<string> {
  return ((await (await fetch(`${w.mcp.origin}/open-key`)).json()) as { openKey: string }).openKey
}

/** A pointer for login request `r`, as anyone can lock one to this copy's open key. */
async function pointer(r: string, body: Body): Promise<string> {
  return (await lock({ request: hash(r), ...body }, [await openKey()])).private
}

/** A login with a pointer of one's own: a code from /connected for it, then a token. */
async function tokenWith(make: (request: string) => Promise<string>): Promise<string> {
  const r = await request()
  const got = await connected({ request: r.request, pointer: await make(r.request) })
  assert.equal(got.status, 302, got.text)
  const code = new URL(got.location!).searchParams.get('code')!
  const res = await fetch(`${w.mcp.origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: r.clientId, code_verifier: r.verifier }) })
  return ((await res.json()) as { access_token: string }).access_token
}

/** A JSON-RPC request to the copy at `at` with `token`: by default a call to my_profiles. */
function asked(token: string, at = w.mcp.origin, method = 'tools/call', params: Body = { name: 'my_profiles', arguments: {} }): Promise<Response> {
  return fetch(at, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** The connection folder the newest access key in `label`'s profile entry belongs to, by its note: its address, and its key. */
async function connectionOf(label: string) {
  const note = (await w.app.note(label, (await w.app.keys(label)).at(-1)!.key))!
  const key = await accessKey(b64u.decode(note.body.connection as string))
  return { address: key.address, key }
}

/** The live entries of the connection folder `key` names, under `kind/`, each with its locked body. */
async function entriesOf(key: { address: string }, kind: string): Promise<Array<{ path: string; body: { private: string } }>> {
  const view = await readFolder([w.host], key.address, Date.now())
  return [...liveContent(view)].filter(([path]) => path === kind || path.startsWith(`${kind}/`)).map(([path, c]) => ({ path, body: c.entry.body as { private: string } }))
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
  test('by registration (DCR): the challenge, the connect page, the connection, the pointer, the code, the token; then it acts in the profiles ticked', async () => {
    const before = await w.app.keys(TUTOR)
    const c = await aiApp(w.mcp.origin)
    const back = await logIn(c)
    assert.equal(back.get('iss'), w.mcp.origin, 'the response names this copy, as RFC 9207 asks')
    const mine = (await c.client.callTool({ name: 'my_profiles', arguments: {} })) as Result
    assert.deepEqual(JSON.parse(text(mine)), { profiles: [STUDENT, TUTOR].map((label) => ({ label, can: SWITCHES })) }, 'in the order of their labels')
    // One new access key in each profile ticked, with every switch, and none in the third.
    const after = await w.app.keys(TUTOR)
    assert.equal(after.length, before.length + 1)
    assert.deepEqual(after.at(-1)!.can, SWITCHES)
    assert.match(after.at(-1)!.open!, OPEN_KEY, 'with its open key, since it may read')
    assert.deepEqual(await w.app.keys(SELLER), [])
    // Its note, at key/<id>, a random id, locked to the main key alone, naming the key, the AI app
    // and this copy, and holding the connection folder's key: found by opening the folder's notes.
    const main = await mainKey(w.seed, TUTOR)
    const note = (await w.app.note(TUTOR, after.at(-1)!.key))!
    assert.match(note.path, /^key\/[0-9a-f]{32}$/)
    assert.equal(lockCount(note.locked), 1, 'locked to one key')
    const opened = await openLocked(note.locked, (await openingHalf(main.secret)).identity)
    assert.deepEqual([opened.key, opened.name, opened.connector], [after.at(-1)!.key, 'An AI app', w.mcp.origin])
    // The connection folder: its profile entry only its hosts; its connection entry, the AI app's
    // name and a secret; one access entry for each profile ticked, at a random id. Each is locked to
    // two keys, the folder's own and this copy's, and the folder's key opens it.
    const folder = await connectionOf(TUTOR)
    assert.deepEqual((await readFolder([w.host], folder.address, Date.now())).current.get('profile')?.entry.body, { hosts: [w.host] })
    const [head] = await entriesOf(folder, 'connection')
    assert.equal(lockCount(head!.body), 2)
    const { name, secret } = await openLocked(head!.body, folder.key.identity)
    assert.equal(name, 'An AI app')
    assert.equal(b64u.decode(secret as string).length, 32)
    const access = await entriesOf(folder, 'access')
    assert.ok(access.every((a) => /^access\/[0-9a-f]{32}$/.test(a.path) && lockCount(a.body) === 2))
    const held = await Promise.all(access.map((a) => openLocked(a.body, folder.key.identity)))
    assert.deepEqual(held.map((h) => [h.label, h.address, h.hosts]).sort(), [[STUDENT, w.own[STUDENT], [w.host]], [TUTOR, w.own[TUTOR], [w.host]]])
    const tutorHeld = held.find((h) => h.label === TUTOR)!
    assert.equal((await accessKey(b64u.decode(tutorHeld.key as string))).address, after.at(-1)!.key, 'the key its profile entry lists')
    // The token carries the pointer locked: no label, address or key of the person's is in it.
    const token = c.app.tokens()!.access_token
    const plain = Buffer.from(b64u.decode(token.split('.')[0]!)).toString('utf8')
    assert.deepEqual(Object.keys(JSON.parse(plain)), ['pointer', 'client', 'aud'])
    for (const secret of [TUTOR, folder.address, ...Object.values(w.own)]) assert.equal(plain.includes(secret), false, `the token holds ${secret} only locked`)
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

describe('a connection, changed with no new login', () => {
  test('a profile added from another device, from the seed alone, then one removed', async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const folder = await connectionOf(TUTOR)
    const device = new App({ seed: w.seed, hosts: [w.host] })
    assert.ok((await device.connections()).some((x) => x.address === folder.address), 'a new device finds it from the seed')
    await device.addToConnection(folder.address, SELLER)
    assert.equal((await entriesOf(folder, 'access')).length, 3, 'one access entry more')
    const mine = async () => JSON.parse(text(await c.client.callTool({ name: 'my_profiles', arguments: {} }))).profiles
    assert.deepEqual(await mine(), [SELLER, STUDENT, TUTOR].map((label) => ({ label, can: SWITCHES })))
    const wrote = (await c.client.callTool({ name: 'write', arguments: { label: SELLER, path: 'notes/added', body: { text: 'Added with no new login.' }, locked: true } })) as Result
    assert.equal(JSON.parse(text(wrote)).written, 'notes/added')
    const sellerKey = (await w.app.keys(SELLER)).at(-1)!.key
    assert.equal((await readFolder([w.host], w.own[SELLER]!, Date.now())).current.get('notes/added')?.entry.key, sellerKey, 'signed by its new access key')
    const studentKey = (await w.app.keys(STUDENT)).at(-1)!.key
    await device.removeKey(STUDENT, studentKey)
    assert.equal((await entriesOf(folder, 'access')).length, 2, 'its access entry deleted')
    assert.equal(await w.app.note(STUDENT, studentKey), undefined, 'and its note')
    assert.deepEqual((await mine()).map((p: { label: string }) => p.label), [SELLER, TUTOR])
    await c.client.close()
  })

  test('the connection ended: its next call is refused, and the AI app logs in again', async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const folder = await connectionOf(TUTOR)
    const keys = [(await w.app.keys(TUTOR)).at(-1)!.key, (await w.app.keys(STUDENT)).at(-1)!.key]
    const token = c.app.tokens()!.access_token
    await new App({ seed: w.seed, hosts: [w.host] }).endConnection(folder.address)
    assert.deepEqual(await entriesOf(folder, 'connection'), [], 'its connection entry deleted')
    assert.deepEqual(await entriesOf(folder, 'access'), [], 'and every access entry')
    for (const label of [TUTOR, STUDENT]) assert.equal((await w.app.keys(label)).some((k) => keys.includes(k.key)), false, `no key of it in ${label}'s profile entry`)
    const res = await asked(token)
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate')!, /error="invalid_token", error_description="the connection this login points to is gone"/)
    await logIn(c)
    assert.equal(((await c.client.callTool({ name: 'my_profiles', arguments: {} })) as Result).isError, undefined, 'a new login, a new connection')
    await c.client.close()
  })
})

describe('refused', () => {
  test('a pointer locked to a key that is not this copy’s', async () => {
    const { request: r } = await request()
    const other = await newAccessKey()
    const locked = (await lock({ request: hash(r), folder: other.address, hosts: [w.host], secret: randomSecret() }, [other.openKey])).private
    const got = await connected({ request: r, pointer: locked })
    assert.equal(got.status, 400)
    assert.match(got.text, /not locked to this server's open key/)
  })

  test('a pointer for another login: seen on its way back, it opens no other', async () => {
    const first = await request()
    const back = new URL(await w.app.connect(w.mcp.origin, first.request, CHOICE))
    const second = await request()
    const got = await connected({ request: second.request, pointer: back.searchParams.get('pointer')! })
    assert.equal(got.status, 400)
    assert.match(got.text, /for another login/)
    // And with its own request, it goes through.
    const ok = await connected({ request: first.request, pointer: back.searchParams.get('pointer')! })
    assert.equal(ok.status, 302)
    assert.ok(new URL(ok.location!).searchParams.get('code'))
  })

  test('a pointer that is not one, or longer than this copy takes', async () => {
    const { request: r } = await request()
    const folder = (await newAccessKey()).address
    assert.match((await connected({ request: r, pointer: await pointer(r, { folder }) })).text, /not a pointer: a pointer is \{ request, folder, hosts, secret \} and nothing else/)
    assert.match((await connected({ request: r, pointer: await pointer(r, { folder, hosts: [w.host], secret: 'short' }) })).text, /its secret is 32 bytes/)
    assert.match((await connected({ request: r, pointer: await pointer(r, { folder: 'nobody', hosts: [w.host], secret: randomSecret() }) })).text, /its folder is a folder's address/)
    assert.match((await connected({ request: r, pointer: 'A'.repeat(MAX_POINTER + 1) })).text, new RegExp(`at most ${MAX_POINTER} characters`))
  })

  test('a login changed on the way, a person who says no', async () => {
    const { request: r } = await request()
    const changed = connected({ request: r.replace(/^./, (c) => (c === 'e' ? 'f' : 'e')), pointer: 'x' })
    assert.match((await changed).text, /not made here, or was changed/)
    const no = await connected({ request: r, error: 'access_denied' })
    assert.equal(no.status, 302)
    const q = new URL(no.location!).searchParams
    assert.deepEqual([q.get('error'), q.get('state'), q.get('iss')], ['access_denied', 's', w.mcp.origin])
  })

  test('a code with the wrong verifier, or for another client', async () => {
    const first = await request()
    const ok = await connected({ request: first.request, pointer: new URL(await w.app.connect(w.mcp.origin, first.request, CHOICE)).searchParams.get('pointer')! })
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

  test("a connection folder's address is not enough: a pointer naming the person's folder, with a secret of its own, acts for no one", async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    await c.client.close()
    const { address } = await connectionOf(TUTOR)
    // Anyone can start a login of their own, and lock a pointer naming the folder to this copy's
    // open key: /connected cannot tell, and gives a code. The secret is only in the entry.
    const token = await tokenWith((r) => pointer(r, { folder: address, hosts: [w.host], secret: randomSecret() }))
    const res = await asked(token)
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate')!, /error="invalid_token"/)
    assert.doesNotMatch(await res.text(), /tutoring/)
  })

  test('a pointer naming a folder that holds no connection: refused the same', async () => {
    const folder = await newAccessKey()
    await write([w.host], [entry(folder, 'profile', { hosts: [w.host] }, Date.now())])
    for (const named of [folder.address, (await newAccessKey()).address]) {
      const token = await tokenWith((r) => pointer(r, { folder: named, hosts: [w.host], secret: randomSecret() }))
      assert.equal((await asked(token)).status, 401)
    }
  })

  test('hosts that do not answer: a refusal saying so, and not a new login', async () => {
    const token = await tokenWith(async (r) => pointer(r, { folder: (await newAccessKey()).address, hosts: ['http://127.0.0.1:9'], secret: randomSecret() }))
    const res = await asked(token)
    assert.equal(res.status, 200)
    const { result } = (await res.json()) as { result: Result }
    assert.equal(result.isError, true)
    assert.match(text(result), /the connection's hosts did not answer: http:\/\/127\.0\.0\.1:9 \(/)
  })

  test('an access entry this copy cannot open, or that does not fit, counts for nothing, and the rest act', async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const folder = await connectionOf(TUTOR)
    const key = await newAccessKey()
    const stray = { label: 'clothing/seller', address: w.own[SELLER]!, hosts: [w.host], key: b64u.encode(key.secret) }
    await write([w.host], [
      entry(folder.key, 'access/0000000000000000000000000000000a', await lock(stray, [folder.key.openKey]), Date.now()),
      entry(folder.key, 'access/0000000000000000000000000000000b', await lock({ ...stray, can: SWITCHES }, [folder.key.openKey, await openKey()]), Date.now()),
    ])
    const mine = JSON.parse(text(await c.client.callTool({ name: 'my_profiles', arguments: {} })))
    assert.deepEqual(mine.profiles.map((p: { label: string }) => p.label), [STUDENT, TUTOR])
    await c.client.close()
  })

  test('a token this copy did not give, and one from before connections, on any request', async () => {
    const foreign = await asked('e30.bm90LW1pbmU', w.mcp.origin, 'tools/list', {})
    assert.equal(foreign.status, 401)
    assert.match(foreign.headers.get('www-authenticate')!, /error="invalid_token"/)
    // One this copy signed before connections, carrying a pack: signed with its own key, it still gives nothing.
    const key = b64u.decode((JSON.parse(readFileSync(`${w.dataDir}/mcp-key.json`, 'utf8')) as { key: string }).key)
    const body = b64u.encode(Buffer.from(JSON.stringify({ pack: 'A'.repeat(43), client: 'x', aud: w.mcp.origin })))
    const old = `${body}.${b64u.encode(createHmac('sha256', key).update(`forest-mcp/v1/access\n${body}`).digest())}`
    const before = await asked(old, w.mcp.origin, 'tools/list', {})
    assert.equal(before.status, 401)
    assert.match(before.headers.get('www-authenticate')!, /error="invalid_token"/)
  })

  test("a token whose pointer no longer opens, once this copy's opening half changed: a login to make again", async () => {
    const c = await aiApp(w.mcp.origin)
    await logIn(c)
    const token = c.app.tokens()!.access_token
    await c.client.close()
    // The same key that signs logins, a new opening half.
    const dir = mkdtempSync(join(tmpdir(), 'forest-mcp-'))
    copyFileSync(join(w.dataDir, 'mcp-key.json'), join(dir, 'mcp-key.json'))
    const other = await serve({ origin: w.mcp.origin, dataDir: dir, read: { index: w.index }, hostFetch: fetch }, '127.0.0.1', 0)
    try {
      const res = await asked(token, other.url)
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
    const res = await asked(token, other.url)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /tutoring\/tutor/)
  } finally {
    await other.close()
  }
  assert.deepEqual(readdirSync(w.dataDir).sort(), ['mcp-key.json', 'mcp-opening.json'])
})
