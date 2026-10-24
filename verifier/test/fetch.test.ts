// `npm run fetch`'s download (scripts/fetch.ts) against sources on loopback: a source that answers 429
// is tried again, one that keeps failing gives way to the next, a file with another SHA-256 is never
// taken, and it fails only when every source has. Nothing here reaches the network.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import { get } from '../scripts/fetch.ts'

const BYTES = new TextEncoder().encode('a model')
const HASH = createHash('sha256').update(BYTES).digest('hex')
const WAITS = [1, 1, 1]

const asked = new Map<string, number>()
const server = createServer((req, res) => {
  const n = (asked.get(req.url!) ?? 0) + 1
  asked.set(req.url!, n)
  if (req.url === '/down' || (req.url === '/flaky' && n <= 2)) return res.writeHead(429).end()
  res.writeHead(200).end(req.url === '/wrong' ? 'another model' : BYTES)
})
let base = ''

before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => server.close())

const file = (...paths: string[]) => ({ path: 'models/a.onnx', urls: paths.map((p) => `${base}${p}`), sha256: HASH })

test('a source that answers 429 is tried again, and its file taken once it answers', async () => {
  asked.clear()
  const got = await get(file('/flaky', '/good'), WAITS)
  assert.deepEqual(got, { bytes: BYTES, url: `${base}/flaky` })
  assert.equal(asked.get('/flaky'), 3)
  assert.equal(asked.get('/good'), undefined)
})

test('a source that fails four times gives way to the next', async () => {
  asked.clear()
  const got = await get(file('/down', '/good'), WAITS)
  assert.equal(got.url, `${base}/good`)
  assert.equal(asked.get('/down'), 4)
})

test('a file with another SHA-256 is never taken, from any source', async () => {
  asked.clear()
  assert.equal((await get(file('/wrong', '/good'), WAITS)).url, `${base}/good`)
  await assert.rejects(get(file('/wrong'), WAITS), /every source failed: .*\/wrong SHA-256 [0-9a-f]{64}, not /)
})

test('it fails only when every source has, and says why for each', async () => {
  asked.clear()
  const closed = createServer()
  await new Promise<void>((ok) => closed.listen(0, '127.0.0.1', ok))
  const nobody = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/`
  await new Promise((ok) => closed.close(ok))
  const unreachable = { ...file('/down'), urls: [`${base}/down`, nobody] }
  await assert.rejects(get(unreachable, WAITS), (e: Error) => {
    assert.match(e.message, /^models\/a\.onnx: every source failed: /)
    assert.ok(e.message.includes(`/down answered 429; ${nobody} fetch failed (connect ECONNREFUSED`), e.message)
    return true
  })
  assert.equal(asked.get('/down'), 4)
})
