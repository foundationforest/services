// The key holder end to end on loopback: forest's reference host, a stand-in index, this service,
// an assistant doing OAuth with PKCE and calling every tool on both doors, and the person's app
// making the keys, listing them with the main key, handing them over, and revoking one.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { mainKey, readingKey } from '../../forest/keys/src/index.ts'
import { Host } from '../../forest/records/src/host.ts'
import { b64u, deliver, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, pull, pullRequest, readAll, readProfile } from '../../forest/records/src/index.ts'
import { makePrivate, message, openMessage } from '../../forest/records/src/private.ts'

import { FileKeys } from '../src/keys.ts'
import { readConfig, startKeyholder } from '../src/service.ts'
import { Store } from '../src/store.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'forest-keyholder-'))
  dirs.push(d)
  return d
}

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

/** A stand-in for the index: one market and one profile, as JSON. */
async function standInIndex(profile: string): Promise<{ url: string; close(): Promise<void> }> {
  const pages: Record<string, unknown> = { '/markets/tutoring.json': { market: 'tutoring', offers: [] }, [`/profiles/${profile}.json`]: { address: profile, scores: {} } }
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url!, 'http://x').pathname]
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { error: 'not_found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

const b64 = (b: Buffer) => b.toString('base64url')
const BANNED = /\b(wallets?|usdc|chains?|blockchains?|gas|crypto(currency)?|tokens?|solana|mints?|seed)\b/i
const readable = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' as const })
const SECRET = randomBytes(32).toString('base64url')

/** An assistant registers and sends the person to /authorize; returns what it needs to finish. */
async function authorize(base: string) {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()
  const redirect = 'http://127.0.0.1:9/callback'
  const reg = await fetch(meta.registration_endpoint, json({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', client_name: 'Test assistant', grant_types: ['authorization_code', 'refresh_token'] }))
  assert.equal(reg.status, 201)
  const client = await reg.json()
  const verifier = b64(randomBytes(32))
  const url = new URL(meta.authorization_endpoint)
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const opened = await fetch(url, { redirect: 'manual' })
  assert.equal(opened.status, 303)
  const connect = opened.headers.get('location')!
  return { meta, redirect, client, verifier, connect }
}

test('an app hands its keys to the key holder, and an assistant acts with them on both doors', async () => {
  const dir = tempDir()
  const host = new Host({ readSender: async (url, profile) => (await readAll(url, { profile })).records })
  const hostUrl = await host.listen(0)
  const me = await mainKey(randomBytes(32), 'tutoring/seller')
  const them = await mainKey(randomBytes(32), 'tutoring/buyer')
  const index = await standInIndex(me.address)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const dbPath = join(dir, 'keyholder.sqlite')
  const service = await startKeyholder(readConfig({ PUBLIC_URL: base, HOSTS: hostUrl, INDEX: index.url, KEYHOLDER_SECRET: SECRET, DATABASE_PATH: dbPath, PORT: String(port) }))
  try {
    // Each app: a profile with its inbox key and an inbox. The seller's app makes a read key for the
    // assistant at random, and lists it among its inbox's readers.
    const mine = await readingKey(me.privateKey)
    const theirs = await readingKey(them.privateKey)
    const readKey = await readingKey(randomBytes(32))
    const t0 = Date.now()
    const card = { name: 'Ana', market: 'tutoring', role: 'seller', createdAt: new Date(t0).toISOString(), inboxKey: mine.recipient, inbox: { senders: 'anyone', readers: [readKey.recipient] } }
    const buyerCard = { name: 'Bo', market: 'tutoring', role: 'buyer', createdAt: new Date(t0).toISOString(), inboxKey: theirs.recipient, inbox: { senders: 'anyone' } }
    for (const [who, body] of [[me, card], [them, buyerCard]] as const) {
      assert.ok((await publish([hostUrl], [hostsRecord(who, [hostUrl], t0), ownerRecord(who, 'profile', body, t0)]))[0]!.results.every((r) => r.ok))
    }

    // An assistant with no token is sent to the metadata, on both doors.
    for (const path of ['/mcp', '/v1/tools/list_grants']) {
      const denied = await fetch(base + path, json({}))
      assert.equal(denied.status, 401)
      assert.match(denied.headers.get('www-authenticate') ?? '', new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`))
    }

    // It registers and sends the person to /authorize, which opens a connection: 128 random bits.
    const { meta, redirect, client, verifier, connect } = await authorize(base)
    assert.match(connect, /^\/connect\/[A-Za-z0-9_-]{22}$/)
    const first = await fetch(base + connect, { redirect: 'manual' })
    assert.equal(first.status, 200)
    assert.match(first.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    const firstPage = await first.text()
    assert.match(firstPage, /Test assistant asks to act for one of your profiles/)
    assert.ok(firstPage.includes(`<code>${base}${connect}</code>`), 'the link the app opens')
    assert.match(firstPage, /http-equiv="refresh"/)
    assert.equal(BANNED.exec(readable(firstPage)), null, 'no crypto word on a page a person reads')

    // The app makes three keys, one per scope, and the grants that hand them over.
    const writeKey = keyFromPrivate(new Uint8Array(randomBytes(32)))
    const messageKey = keyFromPrivate(new Uint8Array(randomBytes(32)))
    const since = Date.now()
    const grant = (scope: string, key: string, extra = {}) => ({ key, folder: me.address, scope, from: me.address, since, ...extra })
    const grants = [
      grant('write', b64u.encode(writeKey.privateKey), { paths: ['offer', 'review'], note: 'Test assistant' }),
      grant('message', b64u.encode(messageKey.privateKey)),
      grant('read', readKey.identity),
    ]

    // What the holder refuses: a pay key, two folders, a bad shape. None of them uses the connection up.
    const pay = await fetch(base + connect, json({ grants: [...grants, grant('pay', b64u.encode(randomBytes(32)))] }))
    assert.equal(pay.status, 400)
    assert.deepEqual(await pay.json(), { ok: false, error: 'pay', message: 'This key holder never holds a pay key. A key it holds can sign, so holding a pay key would let it move money; that needs signing inside an enclave with a cap, a later version.' })
    assert.equal((await fetch(base + connect, json({ grants: [grants[0], { ...grants[1], folder: them.address }] }))).status, 400, 'one folder')
    assert.equal((await fetch(base + connect, json({ grants: [{ ...grants[0], extra: 1 }] }))).status, 400, "forest's grant shape")
    assert.equal((await fetch(base + connect, json({ grants: [grants[0], grants[0]] }))).status, 400, 'each key once')
    const main = await fetch(base + connect, json({ grants: [grant('write', b64u.encode(me.privateKey))] }))
    assert.deepEqual([main.status, (await main.json()).message], [400, 'a main key is never handed over: only access keys'])

    // The grants, once; a second POST is refused.
    const handed = await fetch(base + connect, json({ grants }))
    assert.equal(handed.status, 200, await handed.clone().text())
    assert.deepEqual(await handed.json(), { ok: true, folder: me.address, keys: 3 })
    assert.equal((await fetch(base + connect, json({ grants }))).status, 409, 'the link works once')
    const waiting = await (await fetch(base + connect, { redirect: 'manual' })).text()
    assert.match(waiting, /Waiting for your profile/)
    assert.equal(BANNED.exec(readable(waiting)), null)

    // The app lists the three keys with the main key; the grant goes through.
    const listing = (message: 'message' | 'revoked') => [
      { key: writeKey.address, scope: 'write' as const, paths: ['offer', 'review'] },
      { key: messageKey.address, scope: message },
      { key: readKey.recipient, scope: 'read' as const },
    ]
    await publish([hostUrl], [permissionsRecord(me, listing('message'), Date.now())])
    const granted = await fetch(base + connect, { redirect: 'manual' })
    assert.equal(granted.status, 302)
    const back = new URL(granted.headers.get('location')!)
    assert.equal(`${back.origin}${back.pathname}`, redirect)
    assert.equal(back.searchParams.get('state'), 'xyz')
    const code = back.searchParams.get('code')!
    assert.equal((await fetch(base + connect, json({ grants }))).status, 404, 'a granted connection takes no more keys')

    // The code, with the verifier, for tokens; once.
    const exchange = (body: Record<string, string>) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    assert.equal((await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: b64(randomBytes(32)) })).status, 400, 'the wrong verifier')
    const tokens = await (await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).json()
    assert.equal(tokens.token_type, 'bearer')
    assert.equal((await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier })).status, 400, 'a code counts once')

    // The MCP door.
    const assistant = new Client({ name: 'test-assistant', version: '0.0.0' })
    await assistant.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }))
    const mcp = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await assistant.callTool({ name, arguments: args })
      assert.equal(r.isError, undefined, `${name}: ${JSON.stringify(r.content)}`)
      return r.structuredContent as any
    }
    const mcpRefused = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await assistant.callTool({ name, arguments: args })
      assert.equal(r.isError, true, `${name} should be refused`)
      return JSON.stringify(r.content)
    }
    const { tools } = await assistant.listTools()
    const NAMES = ['disconnect', 'list_grants', 'open_private', 'post_offer', 'post_review', 'pull_inbox', 'read_market', 'read_profile', 'remove_offer', 'request_payment', 'send_message']
    assert.deepEqual(tools.map((t) => t.name).sort(), NAMES)
    assert.deepEqual((tools.find((t) => t.name === 'post_offer')!.inputSchema as any).properties.offer.required, ['direction', 'description'], "forest's offer shape, createdAt filled in")

    // What it may do: the three grants, never a private half.
    const held = await mcp('list_grants')
    assert.deepEqual(
      held.grants.map((g: any) => [g.scope, g.address]),
      [['write', writeKey.address], ['message', messageKey.address], ['read', readKey.recipient]],
    )
    assert.equal(held.grants[0].note, 'Test assistant')
    for (const g of grants) assert.ok(!JSON.stringify(held).includes(g.key), 'no private half')

    // Offers: post, update, remove; a review. Each signed by the write key, never the main key.
    const offer = { direction: 'offer', description: 'One hour of maths, online.', price: { amount: '30', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', per: 'hour' }, remote: true }
    assert.equal((await mcp('post_offer', { id: 'maths', offer })).path, 'offer/maths')
    await mcp('post_offer', { id: 'maths', offer: { ...offer, description: 'Ninety minutes of maths, online.' } })
    await mcp('post_offer', { id: 'physics', offer: { ...offer, description: 'Physics.' } })
    await mcp('remove_offer', { id: 'physics' })
    await mcp('post_review', { review: { subject: them.address, ratings: { overall: '9' }, text: 'Paid on time.' } })
    const view = await readProfile([hostUrl], me.address, Date.now())
    assert.equal(view.current.get('offer/maths')!.record.by, writeKey.address)
    assert.equal((view.current.get('offer/maths')!.record.body as any).description, 'Ninety minutes of maths, online.')
    assert.equal(view.current.get('offer/physics')!.record.body, null, 'removed')
    assert.ok([...view.current.keys()].some((p) => p.startsWith('review/')))

    // What it may not do: a body that is not an offer, a path the main key wrote, the card.
    assert.match(await mcpRefused('post_offer', { offer: { direction: 'sell' } }), /not valid/)
    await publish([hostUrl], [ownerRecord(me, 'offer/mine', { direction: 'offer', description: 'Mine.', createdAt: new Date().toISOString() }, Date.now())])
    assert.match(await mcpRefused('post_offer', { id: 'mine', offer }), /main key wrote offer\/mine/)
    assert.match(await mcpRefused('remove_offer', { id: 'mine' }), /main key wrote offer\/mine/)
    assert.match(await mcpRefused('remove_offer', { id: 'nothing' }), /nothing at offer\/nothing/)

    // Reading public things: its own profile from the host, with what the index says; a market.
    const profile = await mcp('read_profile')
    assert.deepEqual([profile.address, profile.card.name, profile.index], [me.address, 'Ana', { address: me.address, scores: {} }])
    assert.deepEqual(profile.offers.map((o: any) => o.path).sort(), ['offer/maths', 'offer/mine'])
    assert.equal((await mcp('read_profile', { address: them.address })).index, null, 'the index does not count it')
    assert.deepEqual(await mcp('read_market', { market: 'tutoring' }), { market: 'tutoring', offers: [] })
    assert.match(await mcpRefused('read_market', { market: 'knitting' }), /no market named knitting/)

    // The inbox: the buyer writes; the assistant pulls with the message key and opens with the read key.
    const asked = 'Is Tuesday at six free?'
    assert.ok((await deliver([hostUrl], [await message(them, me.address, { text: asked }, Date.now(), card)]))[0]!.results[0]!.ok)
    const inbox = await mcp('pull_inbox')
    assert.equal(inbox.messages.length, 1)
    assert.deepEqual([inbox.messages[0].from, inbox.messages[0].opened, inbox.messages[0].body], [them.address, true, { text: asked }])
    assert.equal(typeof inbox.cursors[hostUrl], 'number')
    assert.equal((await mcp('pull_inbox', { after: inbox.cursors })).messages.length, 0, 'nothing since')

    // A reply, signed by the message key for the seller; the buyer's app sees the key sent it.
    await mcp('send_message', { to: them.address, text: 'Tuesday at six, yes.' })
    const buyerPage = await pull(hostUrl, pullRequest(them, 0, Date.now()))
    const reply = await openMessage(buyerPage.messages[0]!.message, theirs.identity)
    assert.deepEqual([reply.from, reply.key, reply.body], [me.address, messageKey.address, { text: 'Tuesday at six, yes.' }])

    // A payment request: a message to the seller's own inbox, which its app opens with its inbox key.
    await mcp('request_payment', { amount: '30', to: them.address, note: 'The lesson.' })
    const own = await pull(hostUrl, pullRequest(me, inbox.cursors[hostUrl], Date.now()))
    assert.equal(own.messages.length, 1)
    const request = await openMessage(own.messages[0]!.message, mine.identity)
    assert.deepEqual([request.from, request.key, request.body], [me.address, messageKey.address, { request: 'pay', amount: '30', to: them.address, note: 'The lesson.' }])

    // A private record the app sealed to the read key opens; one it did not seal to it does not.
    const t1 = Date.now()
    await publish([hostUrl], [
      ownerRecord(me, 'notes/hours', await makePrivate({ text: 'Free on Tuesdays.' }, [mine.recipient, readKey.recipient]), t1),
      ownerRecord(me, 'notes/mine', await makePrivate({ text: 'Mine alone.' }, [mine.recipient]), t1),
    ])
    assert.deepEqual((await mcp('open_private', { path: 'notes/hours' })).body, { text: 'Free on Tuesdays.' })
    assert.match(await mcpRefused('open_private', { path: 'notes/mine' }), /not sealed to a read key/)
    assert.match(await mcpRefused('open_private', { path: 'offer/maths' }), /not private/)

    // The HTTP door: the same token, the same tools.
    const api = (method: string, path: string, body?: unknown, token = tokens.access_token) =>
      fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) })
    assert.deepEqual(((await (await api('GET', '/v1/tools')).json()).tools as any[]).map((t) => t.name).sort(), NAMES)
    const viaHttp = await api('POST', '/v1/tools/post_offer', { id: 'chess', offer: { ...offer, description: 'Chess.' } })
    assert.equal(viaHttp.status, 200)
    assert.equal((await viaHttp.json()).path, 'offer/chess')
    assert.equal((await api('POST', '/v1/tools/post_offer', { offer: { direction: 'sell' } })).status, 400)
    assert.equal((await api('POST', '/v1/tools/nope', {})).status, 404)
    assert.deepEqual((await (await api('POST', '/v1/tools/read_market', { market: 'tutoring' })).json()).market, 'tutoring')

    // The seller revokes the message key: pulls and messages by it are refused by the host.
    await publish([hostUrl], [permissionsRecord(me, listing('revoked'), Date.now())])
    assert.match(await mcpRefused('pull_inbox'), /permission/)
    assert.match(await mcpRefused('send_message', { to: them.address, text: 'And Thursday?' }), /permission/)
    await mcp('post_review', { id: 'still', review: { subject: them.address, ratings: { overall: '8' } } })

    // Refreshing gives a new token and spends the old refresh token.
    const refreshed = await (await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json()
    assert.ok(refreshed.access_token)
    assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status, 400)

    // Disconnect: the holder drops its copies of the keys and every token; the keys themselves still work where listed.
    const connection = service.store.token(refreshed.access_token, 'access', Date.now())!.connection.id
    assert.equal((await service.keys.held(connection)).length, 3)
    const out = await api('POST', '/v1/tools/disconnect', {}, refreshed.access_token)
    assert.equal(out.status, 200)
    assert.deepEqual(await service.keys.held(connection), [])
    assert.equal(service.store.connection(connection), null)
    assert.equal((await api('GET', '/v1/tools', undefined, refreshed.access_token)).status, 401)
    assert.equal((await api('GET', '/v1/tools', undefined, tokens.access_token)).status, 401)
    await assistant.close()

    // The file and its log hold no private half, no token and no code in the clear.
    const file = Buffer.concat([readFileSync(dbPath), existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`) : Buffer.alloc(0)])
    for (const g of grants) assert.equal(file.includes(Buffer.from(g.key)), false, `${g.scope} key's private half, as text`)
    for (const k of [writeKey, messageKey, me]) assert.equal(file.includes(Buffer.from(k.privateKey)), false, 'a private key, as bytes')
    for (const s of [tokens.access_token, tokens.refresh_token, refreshed.access_token, refreshed.refresh_token, code]) assert.equal(file.includes(Buffer.from(s)), false)
  } finally {
    await service.close()
    await index.close()
    await host.close()
  }
})

test('a connection takes keys within the hour, and only once', async () => {
  let clock = Date.now()
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const me = await mainKey(randomBytes(32), 'tutoring/seller')
  const grants = [{ key: b64u.encode(randomBytes(32)), folder: me.address, scope: 'write', from: me.address, since: clock }]
  const service = await startKeyholder(
    readConfig({ PUBLIC_URL: base, HOSTS: 'http://127.0.0.1:9', INDEX: 'http://127.0.0.1:9', KEYHOLDER_SECRET: SECRET, DATABASE_PATH: ':memory:', PORT: String(port) }),
    { now: () => clock },
  )
  try {
    const late = (await authorize(base)).connect
    const once = (await authorize(base)).connect
    assert.equal((await fetch(base + once, json({ grants }))).status, 200)
    assert.equal((await fetch(base + once, json({ grants }))).status, 409, 'a second POST')
    const id = once.split('/').pop()!
    assert.equal((await service.keys.held(id)).length, 1)
    clock += 60 * 60_000
    await service.prune()
    assert.deepEqual(await service.keys.held(id), [], 'a connection not finished within the hour ends, its keys with it')
    assert.equal(service.store.connection(id), null)
    assert.equal((await fetch(base + late, json({ grants }))).status, 404, 'an hour later')
    assert.equal((await fetch(base + late, { redirect: 'manual' })).status, 404)
    assert.equal((await fetch(base + `/connect/${b64(randomBytes(16))}`, json({ grants }))).status, 404, 'an id it never made')
  } finally {
    await service.close()
  }
})

test('the key store opens a row only under its own connection, and only with its secret', async () => {
  const db = new DatabaseSync(':memory:')
  const keys = new FileKeys(db, SECRET)
  const me = await mainKey(randomBytes(32), 'tutoring/seller')
  const write = keyFromPrivate(new Uint8Array(randomBytes(32)))
  await keys.put('a', [{ key: b64u.encode(write.privateKey), folder: me.address, scope: 'write', from: me.address, since: 0 }])
  assert.deepEqual((await keys.held('a')).map((h) => h.address), [write.address])
  db.prepare("INSERT INTO keys (connection, box) SELECT 'b', box FROM keys WHERE connection = 'a'").run()
  await assert.rejects(keys.held('b'), 'a row copied under another connection')
  await assert.rejects(new FileKeys(db, 'another secret, at least thirty-two characters').held('a'), 'another secret')
  await assert.rejects(keys.sign('a', me.address, new Uint8Array(1)), /no key/)
  await keys.drop('a')
  assert.deepEqual(await keys.held('a'), [])
})

test('the configuration names what is missing, and takes origins and a long secret only', () => {
  assert.throws(() => readConfig({}), /PUBLIC_URL, HOSTS, INDEX, KEYHOLDER_SECRET/)
  const ok = { PUBLIC_URL: 'https://c.example', HOSTS: 'https://h.example, https://i.example', INDEX: 'https://x.example/', KEYHOLDER_SECRET: SECRET }
  assert.throws(() => readConfig({ ...ok, PUBLIC_URL: 'https://c.example/x' }), /PUBLIC_URL is an origin/)
  assert.throws(() => readConfig({ ...ok, INDEX: 'https://x.example/v1' }), /INDEX is an origin/)
  assert.throws(() => readConfig({ ...ok, HOSTS: 'https://h.example/path' }), /HOSTS/)
  assert.throws(() => readConfig({ ...ok, KEYHOLDER_SECRET: 'short' }), /at least 32/)
  const c = readConfig(ok)
  assert.deepEqual([c.publicUrl, c.hosts, c.index, c.port, c.databasePath], ['https://c.example', ['https://h.example', 'https://i.example'], 'https://x.example', 8080, './data/keyholder.sqlite'])
})

test('a file from before the key holder loses the keys it kept in the clear', async () => {
  const dbPath = join(tempDir(), 'old.sqlite')
  const key = randomBytes(32)
  const old = new DatabaseSync(dbPath)
  old.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE clients (id TEXT PRIMARY KEY, info TEXT NOT NULL);
    CREATE TABLE connections (id TEXT PRIMARY KEY, client TEXT NOT NULL, profile TEXT, access_key BLOB, granted INTEGER NOT NULL DEFAULT 0, pending TEXT, expires INTEGER NOT NULL);
    CREATE TABLE codes (hash TEXT PRIMARY KEY, connection TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, connection TEXT NOT NULL, expires INTEGER NOT NULL);`)
  old.prepare('INSERT INTO clients (id, info) VALUES (?, ?)').run('a', '{}')
  old.prepare('INSERT INTO connections (id, client, profile, access_key, granted, expires) VALUES (?, ?, ?, ?, 1, ?)').run('c1', 'a', 'p', key, Date.now() + 60_000)
  old.prepare('INSERT INTO tokens (hash, kind, connection, expires) VALUES (?, ?, ?, ?)').run('h', 'access', 'c1', Date.now() + 60_000)
  old.close()
  assert.ok(readFileSync(dbPath).includes(key), 'the old file holds the key in the clear')
  const store = new Store(dbPath)
  try {
    assert.equal(store.connection('c1'), null, 'its connections end')
    assert.ok(store.client('a'), 'registrations stay')
    assert.equal(readFileSync(dbPath).includes(key), false, 'the key is gone from the file')
  } finally {
    store.close()
  }
})
