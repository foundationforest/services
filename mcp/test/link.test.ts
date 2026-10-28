// The live link with an app made by hand, so a test can send what the reference signer never would:
// a registration by the wrong key, a frame that is not JSON, a frame of a type the app does not send,
// an answer with more than the standard passes on, a waiting link that is not https, a socket that
// closes while an ask waits. Each ask is the standard's, as its frame says it. And what this copy
// keeps: nothing between calls but live sockets. A token one copy gave works on another started
// with the same key, with no store behind either; once the app closes, no socket is left; and its
// data directory holds only its key.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { b64u } from '@foundationforest/records'
import { type Connection, linkUrl, newConnection, signLogin, signRegister } from '@foundationforest/signers'
import { serve } from '../src/server.ts'
import { REDIRECT, type World, browse, world } from './setup.ts'

type Result = { isError?: boolean; content: Array<{ text: string }> }
type Frame = { [key: string]: unknown }

let w: World
before(async () => {
  w = await world()
})
after(() => w.close())

/** A login for `c` made by hand, as the person's app makes one: the request from /authorize signed with its key; then the code turned into a token. */
async function tokenFor(c: Connection, origin = w.mcp.origin): Promise<string> {
  const verifier = b64u.encode(Buffer.alloc(32, 7))
  const challenge = b64u.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const reg = (await (await fetch(`${origin}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })
  const request = new URL((await fetch(`${origin}/authorize?${q}`, { redirect: 'manual' })).headers.get('location')!).searchParams.get('request')!
  const back = await browse(`${origin}/connected?${new URLSearchParams({ request, connection: c.connection, sig: signLogin(c.key, request) })}`)
  const res = await fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: back.get('code')!, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })
  return ((await res.json()) as { access_token: string }).access_token
}

/** A socket opened by hand: the frames it got, and a way to wait for the next of a type. */
async function socket(origin = w.mcp.origin) {
  const ws = new WebSocket(linkUrl(origin))
  const frames: Frame[] = []
  const waiting: Array<(f: Frame) => boolean> = []
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(String(e.data)) as Frame
    frames.push(f)
    for (const [i, take] of waiting.entries()) if (take(f)) waiting.splice(i, 1)
  })
  const next = (type: string) =>
    new Promise<Frame>((resolve) => {
      const seen = frames.find((f) => f.type === type && !(f as { taken?: true }).taken)
      if (seen) return resolve(Object.assign(seen, { taken: true }))
      waiting.push((f) => f.type === type && (resolve(Object.assign(f, { taken: true })), true))
    })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })))
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  return { ws, next, closed, challenge: (await next('challenge')).challenge as string }
}

/** An AI app's client holding `token`. */
async function withToken(token: string, origin = w.mcp.origin): Promise<Client> {
  const client = new Client({ name: 'an-ai-app', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(origin), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  return client
}

const registered = (c: Connection, challenge: string, origin = w.mcp.origin) => JSON.stringify({ type: 'register', connection: c.connection, sig: signRegister(c.key, origin, challenge) })

test('a registration signed by another key is refused; a frame that is not JSON, or one the app does not send, closes the socket', async () => {
  const c = newConnection()
  const s = await socket()
  assert.equal(b64u.decode(s.challenge).length, 32, 'the challenge is 32 random bytes')
  s.ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: signRegister(newConnection().key, w.mcp.origin, s.challenge) }))
  assert.deepEqual(await s.next('refused'), { type: 'refused', connection: c.connection, why: "the connection's key did not sign this socket's challenge", taken: true })
  s.ws.send(JSON.stringify({ type: 'register', connection: c.connection, sig: signRegister(c.key, 'https://another.example', s.challenge) }))
  assert.equal((await s.next('refused')).why, "the connection's key did not sign this socket's challenge", 'signed for another connector')
  assert.equal(w.mcp.link.size, 0)
  s.ws.send('not json')
  assert.equal((await s.closed).code, 1008)
  const t = await socket()
  t.ws.send(JSON.stringify({ type: 'challenge', challenge: t.challenge }))
  assert.equal((await t.closed).code, 1008, 'a challenge is the connector’s to send')
})

test('each ask is the standard’s; only an answer’s known fields are passed on, a waiting link must be https, and a socket that closes mid-ask is said plainly', async () => {
  const c = newConnection()
  const client = await withToken(await tokenFor(c))
  const s = await socket()
  s.ws.send(registered(c, s.challenge))
  await s.next('registered')

  const asked = client.callTool({ name: 'write', arguments: { label: 'tutoring/tutor', path: 'offer/x', body: { description: 'x' } } })
  const { id, taken: _taken, ...ask } = await s.next('ask')
  assert.deepEqual(ask, { type: 'ask', connection: c.connection, ask: 'write', label: 'tutoring/tutor', path: 'offer/x', body: { description: 'x' } })
  s.ws.send(JSON.stringify({ type: 'answer', id, status: 'done', profile: 'an address the standard never passes on' }))
  assert.deepEqual(JSON.parse(((await asked) as Result).content[0]!.text), { status: 'done' })

  const read = client.callTool({ name: 'read', arguments: { label: 'tutoring/tutor', path: 'offer/x' } })
  s.ws.send(JSON.stringify({ type: 'answer', id: (await s.next('ask')).id, status: 'done', body: { description: 'x' }, time: 5, more: 'dropped' }))
  assert.deepEqual(JSON.parse(((await read) as Result).content[0]!.text), { status: 'done', body: { description: 'x' }, time: 5 })

  const insecure = client.callTool({ name: 'read', arguments: {} })
  s.ws.send(JSON.stringify({ type: 'answer', id: (await s.next('ask')).id, status: 'waiting', link: 'http://app.example/approve/1' }))
  assert.equal(((await insecure) as Result).content[0]!.text, 'the app answered in a way this server cannot pass on')

  const notAsk = client.callTool({ name: 'pay', arguments: { label: 'tutoring/student', to: `${c.connection}`, amount: '1', currency: 'USD' } })
  assert.match(((await notAsk) as Result).content[0]!.text, /^not an ask the person's app takes: a pay is to an address/, 'a pay to no address never reaches the app')

  const cut = client.callTool({ name: 'read', arguments: {} })
  await s.next('ask')
  s.ws.close()
  const r = (await cut) as Result
  assert.equal(r.isError, true)
  assert.match(r.content[0]!.text, /^Forest closed on the person's device before it answered/)
  await client.close()
})

test('nothing is kept between calls but live sockets', async () => {
  const c = newConnection()
  const token = await tokenFor(c)
  // A second copy of the same service: the same origin and data directory, so the same key, and no
  // store; on a port of its own.
  const second = await serve({ origin: w.mcp.origin, dataDir: w.dataDir, read: { index: 'http://127.0.0.1:9' } }, '127.0.0.1', 0)
  try {
    const client = await withToken(token, second.url)
    const s = await socket(second.url)
    s.ws.send(registered(c, s.challenge))
    await s.next('registered')
    assert.equal(second.link.size, 1, 'a live socket for one connection')
    const asked = client.callTool({ name: 'read', arguments: {} })
    s.ws.send(JSON.stringify({ type: 'answer', id: (await s.next('ask')).id, status: 'done', profiles: [] }))
    assert.deepEqual(JSON.parse(((await asked) as Result).content[0]!.text), { status: 'done', profiles: [] }, 'the first copy’s token works on the second')
    s.ws.close()
    await s.closed
    for (let i = 0; i < 50 && second.link.size; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(second.link.size, 0, 'once the app closes, nothing is left')
    await client.close()
  } finally {
    await second.close()
  }
  assert.deepEqual(readdirSync(w.dataDir), ['mcp-key.json'], 'its data directory holds its key and nothing else')
})
