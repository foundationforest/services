// The devnet test board: forest's host behind the front, the label at `/`, and the badged feed from
// a stand-in registry RPC.
//
//   npm test

import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, test } from 'node:test'

import { base58 } from '../../../forest/records/src/bytes.ts'
import { publish, readAll } from '../../../forest/records/src/client.ts'
import { profileKey, seedFromPrf } from '../../../forest/records/src/keys.ts'
import { folderEntry, ownerEntry } from '../../../forest/records/src/write.ts'
import { LINE_DISCRIMINATOR as FOREST_LINE_DISCRIMINATOR } from '../../../forest/registry/client/src/program.ts'

import { LABEL, LINE_DISCRIMINATOR, type Board, readConfig, startBoard } from '../src/board.ts'

const badged = profileKey(seedFromPrf(new Uint8Array(32).fill(1)), 0)
const plain = profileKey(seedFromPrf(new Uint8Array(32).fill(2)), 0)
const PROGRAM = 'Hyh5Lt1ErzYV3pF9ZkFWTdjhE2wwTuXnPMVgzCKEv9hf'

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

let board: Board
let url: string
const asked: unknown[] = []
const rpc = createHttpServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const { method, params } = JSON.parse(raw)
    asked.push({ method, params })
    const profile = params[1].filters[1].memcmp.bytes
    const lines = profile === base58.encode(badged.publicKey) ? [{ pubkey: 'Line1111111111111111111111111111111111111111', account: {} }] : []
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: lines }))
  })
})

before(async () => {
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve))
  const port = await freePort()
  url = `http://127.0.0.1:${port}`
  board = await startBoard(
    readConfig({ PUBLIC_URL: url, PORT: String(port), SOLANA_RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`, REGISTRY_PROGRAM_ID: PROGRAM }),
  )
})
after(async () => {
  await board?.close()
  await new Promise<void>((resolve) => rpc.close(() => resolve()))
})

test('the registry filter is forest’s: the line discriminator, then the profile key at offset 8', () => {
  assert.deepEqual(new Uint8Array(LINE_DISCRIMINATOR), new Uint8Array(FOREST_LINE_DISCRIMINATOR))
})

test('`/` says what this is; every other path is forest’s host', async () => {
  const res = await fetch(`${url}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), LABEL)
  assert.match(LABEL, /devnet testing only/)
  assert.equal((await fetch(`${url}/elsewhere`)).status, 404)
})

test('entries go in and come back through the front; the badged feed holds only keys the registry names', async () => {
  const now = Date.now()
  for (const who of [badged, plain]) {
    const outcomes = await publish([url], [
      folderEntry(who, { hosts: [url] }, now),
      ownerEntry(who, 'profile', { market: 'tutoring', role: 'seller', name: 'Test', createdAt: '2026-09-30T00:00:00Z' }, now),
    ])
    assert.ok(outcomes[0]!.results.every((r) => r.ok), JSON.stringify(outcomes))
  }
  const all = await readAll(url)
  assert.equal(all.versions.length, 4)
  const onlyBadged = await readAll(url, { badged: true })
  assert.deepEqual([...new Set(onlyBadged.versions.map((v) => v.entry.profile))], [badged.did])
  const call = asked[0] as { method: string; params: [string, { filters: Array<{ memcmp: { offset: number; bytes: string } }> }] }
  assert.equal(call.method, 'getProgramAccounts')
  assert.equal(call.params[0], PROGRAM)
  assert.deepEqual(call.params[1].filters.map((f) => f.memcmp.offset), [0, 8])
})

test('PUBLIC_URL must be an origin', () => {
  assert.throws(() => readConfig({}), /PUBLIC_URL/)
  assert.throws(() => readConfig({ PUBLIC_URL: 'https://board.example/path' }), /PUBLIC_URL/)
})
