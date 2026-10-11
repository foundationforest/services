// The foundation's host: forest's host behind the front, with this service's policy; its storage,
// with the import of the old single file and the move of bytes to a bucket; the registry lookup for
// an inbox that takes messages from one issuer's rows; the sender's records read, and kept a while,
// to take a message a message key signed, never after a redirect (forest's public fetch keeps the
// read to public addresses, and its own tests try every range); and credits: sold, collected,
// finished with the credits/ client and spent into a folder's balance, which every write but a
// hosts or permissions record pays from, bytes by the megabyte.
//
// A request whose URL cannot be read is refused at the front, and the host goes on.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'

import { type Connection, PublicKey } from '@solana/web3.js'

import { inboxKey, mainKey } from '../../standard/keys/src/index.ts'
import { base58, deliver, getBlob, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, pull, pullRequest, putBlob, readAll, readProfile } from '../../standard/records/src/index.ts'
import { Host } from '../../standard/records/src/host.ts'
import { message, openMessage } from '../../standard/records/src/private.ts'
import { recordId, unsignedOf } from '../../standard/records/src/record.ts'
import { blobStore, signS3 } from '../../standard/records/src/storage.ts'
import { ROW_DISCRIMINATOR, ROW_OFFSET, rowSpace } from '../../standard/registry/client/src/program.ts'
import { issuerKeyBytes, issuerKeyOf } from '../../standard/registry/client/src/index.ts'
import { type Credit, PAYMENT_HEADER, buy, creditId, creditList, finish, serviceOf } from '../../credits/src/index.ts'
import type { Rpc } from '../../credits/src/service.ts'

import { BALANCE_PATH, BUY_PATH, DIRECTORY_PATH, SPEND_PATH, UNIT, priceOf } from '../src/credits.ts'
import { DEVNET_REGISTRY, LABEL, POLICY, type RunningHost, moveBlobs, readConfig, rowLookup, startHost } from '../src/host.ts'

const ORIGIN = 'https://host.example'
/** Where credits are paid in these tests, and in what: the classic devnet test dollar. */
const PAY_TO = base58.encode(new Uint8Array(32).fill(5))
const MINT = 'J2QBACfPPb1ys2UyGx3ecXHgCr4hWuHFT3C2Nr6TSVSa'
const CREDIT_KEY = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64')
/** The credit settings every start needs, as a fresh object each time: readConfig takes CREDIT_KEY out of what it reads. */
const credited = (env: Record<string, string> = {}) => ({ PUBLIC_ORIGIN: ORIGIN, CREDIT_KEY, CREDIT_ADDRESS: PAY_TO, CREDIT_MINT: MINT, CREDIT_PRICE: '0.01', ...env })

/** The signature of the stand-in payment for a buy: its reference's 32 bytes, then 32 zeros. */
const paymentFor = (reference: string) => base58.encode(new Uint8Array([...base58.decode(reference), ...new Uint8Array(32)]))
/** An RPC on which every buy is paid: the transaction `paymentFor` names is finalized, names its reference and pays the host plenty. */
const paidRpc: Rpc = async (method, params) => {
  if (method !== 'getTransaction') throw new Error(`no ${method}`)
  const reference = base58.encode(base58.decode(params[0] as string).subarray(0, 32))
  const balance = (amount: string) => [{ accountIndex: 1, mint: MINT, owner: PAY_TO, uiTokenAmount: { amount, decimals: 6 } }]
  return { meta: { err: null, preTokenBalances: balance('0'), postTokenBalances: balance('1000000000') }, transaction: { message: { accountKeys: ['Buyer', PAY_TO, reference] } } }
}
/** The headers a buy is collected with, paid on `paidRpc`. */
const paidFor = (b: { reference: string }) => ({ [PAYMENT_HEADER]: `solana ${paymentFor(b.reference)}` })

/** `n` credits from `h`: bought, collected (on `paidRpc`, every buy is paid) and finished, as an app does. */
async function creditsFrom(h: RunningHost, n: number): Promise<Credit[]> {
  const service = serviceOf(ORIGIN, await (await fetch(`${h.url}${DIRECTORY_PATH}`)).json())
  const b = await buy(service, n)
  const res = await fetch(`${h.url}${BUY_PATH}`, { method: 'POST', body: b.buy as Uint8Array<ArrayBuffer>, headers: paidFor(b) })
  assert.equal(res.status, 200, await res.clone().text())
  return finish(b.pending, new Uint8Array(await res.arrayBuffer()))
}

/** Credits spent into `folder`'s balance, in one request, as the app sends them: the status and what the host answered. */
async function spend(h: RunningHost, folder: unknown, credits: Credit[], body: unknown = { folder, credits: creditList(credits) }) {
  const res = await fetch(`${h.url}${SPEND_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as { error?: string; detail?: string; folder?: string; credits?: number } }
}

/** `n` credits into each folder's balance at `h`, one request a folder. */
async function fund(h: RunningHost, folders: string[], n = 5) {
  for (const folder of folders) assert.equal((await spend(h, folder, await creditsFrom(h, n))).status, 200)
}

/** An issuer's key, as a row holds it, and as an inbox names it: 128 hex. */
const ISSUER_KEY = issuerKeyBytes(issuerKeyOf(new Uint8Array(32).fill(7)))
const ISSUER = Buffer.from(ISSUER_KEY).toString('hex')
/** Forest's single-file host's own file, as it wrote it: two folders, ten records, three messages, three blobs. */
const SINGLE_FILE = new URL('../../standard/records/test/single-file.sqlite', import.meta.url)

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-test-'))
  dirs.push(dir)
  return dir
}

/** A row's bytes as the registry holds them, from the issuer whose key is `issuer`. */
function rowData(profile: Uint8Array, issuer: Uint8Array = ISSUER_KEY, label = 'tutoring/buyer'): Buffer {
  const name = new TextEncoder().encode(label)
  const data = Buffer.alloc(rowSpace(name.length))
  data.set(ROW_DISCRIMINATOR, 0)
  data.set(profile, ROW_OFFSET.profile)
  data.set(randomBytes(32), ROW_OFFSET.stamp)
  data.set(issuer, ROW_OFFSET.issuer)
  data.set(new Uint8Array(32).fill(3), ROW_OFFSET.payer)
  data.writeBigInt64LE(1_790_000_000n, ROW_OFFSET.made)
  data.writeUInt32LE(name.length, ROW_OFFSET.label)
  data.set(name, ROW_OFFSET.label + 4)
  return data
}

/** An RPC holding these accounts, filtering as a real one does: each memcmp on the account's bytes. */
function rpc(accounts: Buffer[]): Pick<Connection, 'getProgramAccounts'> & { asked: string[] } {
  const asked: string[] = []
  const getProgramAccounts = async (program: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) => {
    asked.push(program.toBase58())
    const matches = (data: Buffer) =>
      config.filters.every(({ memcmp }) => {
        const want = base58.decode(memcmp.bytes)
        return Buffer.from(want).equals(data.subarray(memcmp.offset, memcmp.offset + want.length))
      })
    return accounts.filter(matches).map((data) => ({ pubkey: new PublicKey(randomBytes(32)), account: { data, owner: program, lamports: 0, executable: false } }))
  }
  return { asked, getProgramAccounts: getProgramAccounts as never }
}

/** A card with an inbox under `rule`, its inbox key and `readers`. */
async function card(owner: Awaited<ReturnType<typeof mainKey>>, rule: object, readers?: string[]) {
  const key = await inboxKey(owner.privateKey)
  const body = { market: 'tutoring', role: owner.label.split('/')[1]!, name: 'Test', inboxKey: key.recipient, inbox: { ...rule, ...(readers && { readers }) }, createdAt: '2026-10-02T00:00:00Z' }
  return { body, identity: key.identity }
}

const errors = (outcome: { results: { ok: boolean; error?: string }[] } | undefined) => outcome!.results.map((r) => r.error ?? 'ok')

let host: RunningHost
before(async () => {
  host = await startHost(readConfig(credited({ PORT: '0' })), { rpc: paidRpc })
})
after(async () => {
  await host?.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('`/` says what this is; every other path is forest’s host, with this policy', async () => {
  const res = await fetch(`${host.url}/`)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), LABEL)
  assert.match(LABEL, /run by the Forest Foundation/)
  assert.equal((await fetch(`${host.url}/elsewhere`)).status, 404)
  const h = host.host
  assert.deepEqual(
    { keepDays: h.keepDays, maxBatch: h.maxBatch, maxPageRecords: h.maxPageRecords, maxPageBytes: h.maxPageBytes, maxBlobBytes: h.maxBlobBytes },
    POLICY,
  )
  assert.deepEqual(POLICY, { keepDays: 30, maxBatch: 100, maxPageRecords: 1000, maxPageBytes: 4_194_304, maxBlobBytes: 50_000_000 })
})

/** One request as raw bytes, so a URL no client would send arrives as written; the status line's code, or null if none came. */
function raw(url: string, request: string): Promise<number | null> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => socket.end(request))
    let got = ''
    socket.on('data', (chunk) => (got += chunk.toString('latin1')))
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1]) || null))
    socket.on('error', reject)
  })
}

test('a request whose URL cannot be read gets 400, and the host goes on answering', async () => {
  for (const path of ['//', '/\\', '//x:99999']) {
    assert.equal(await raw(host.url, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), 400, path)
    assert.equal((await fetch(`${host.url}/`)).status, 200, `still answering after ${path}`)
  }
})

test('the settings: a data directory, the old file, a bucket by its variables, the time a sender’s records are kept, and credits', () => {
  const env = credited()
  const none = readConfig(env)
  assert.deepEqual({ ...none, creditKey: undefined }, { dir: null, importFrom: null, blobs: { kind: 'disk' }, port: 8080, rpcUrl: null, registryProgramId: DEVNET_REGISTRY, senderCacheMs: 60_000, origin: ORIGIN, creditKey: undefined, credit: { address: PAY_TO, mint: MINT, price: '0.01' }, maxBuy: 1000, sponsors: [] })
  assert.deepEqual(none.creditKey, new Uint8Array(Buffer.from(CREDIT_KEY, 'base64')))
  assert.equal(env.CREDIT_KEY, undefined, 'the credit key leaves the environment once read')
  assert.throws(() => readConfig({}), /missing environment variables: PUBLIC_ORIGIN, CREDIT_KEY, CREDIT_ADDRESS, CREDIT_MINT, CREDIT_PRICE/, 'no credits, no start: never a free host by mistake')
  assert.throws(() => readConfig(credited({ PUBLIC_ORIGIN: 'https://host.example/path' })), /PUBLIC_ORIGIN/)
  assert.throws(() => readConfig(credited({ CREDIT_PRICE: '0' })), /CREDIT_PRICE/)
  assert.throws(() => readConfig(credited({ CREDITS_PER_BUY: '0' })), /CREDITS_PER_BUY/)
  assert.equal(readConfig(credited({ CREDIT_MINT: 'SOL' })).credit.mint, 'SOL')
  const bucket = { S3_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'forest-host', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }
  const full = readConfig(credited({ DATA_DIR: '/data/host', IMPORT_FROM: '/data/host.sqlite', SENDER_CACHE_SECONDS: '5', ...bucket, S3_REGION: 'auto', S3_STYLE: 'virtual' }))
  assert.deepEqual([full.dir, full.importFrom, full.senderCacheMs], ['/data/host', '/data/host.sqlite', 5000])
  assert.deepEqual(full.blobs, { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'forest-host', accessKeyId: 'id', secretAccessKey: 'secret', region: 'auto', style: 'virtual' }, 'the region as given, `auto` too')
  assert.deepEqual(readConfig(credited(bucket)).blobs, { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'forest-host', accessKeyId: 'id', secretAccessKey: 'secret' }, 'forest’s defaults: us-east-1, path style')
  assert.throws(() => readConfig(credited({ S3_BUCKET: 'forest-host', S3_REGION: 'auto' })), /missing: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/, 'half a bucket is no bucket, and no silent disk')
  assert.throws(() => readConfig(credited({ ...bucket, S3_STYLE: 'sideways' })), /S3_STYLE/)
  assert.throws(() => readConfig(credited({ ...bucket, S3_ENDPOINT: 'not a url' })))
  assert.throws(() => readConfig(credited({ SENDER_CACHE_SECONDS: '-1' })), /SENDER_CACHE_SECONDS/)
})

test('a credit key that is not one stops the start, and says nothing of what it was given', async () => {
  const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64')
  await assert.rejects(startHost(readConfig(credited({ PORT: '0', CREDIT_KEY: pkcs1 }))), (err: Error) => /PKCS #8/.test(err.message) && !err.message.includes(pkcs1.slice(0, 16)))
})

test('records go in and come back through the front, for the whole host and by profile', async () => {
  const now = Date.now()
  const people = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
  await fund(host, people.map((p) => p.address), 1)
  for (const who of people) {
    const outcomes = await publish([host.url], [
      hostsRecord(who, [host.url], now),
      ownerRecord(who, 'profile', { market: 'tutoring', role: who.label.split('/')[1]!, name: 'Test', createdAt: '2026-10-02T00:00:00Z' }, now),
    ])
    assert.ok(outcomes[0]!.results.every((r) => r.ok), JSON.stringify(outcomes))
  }
  assert.equal((await readAll(host.url)).records.length, 4, 'what is new on the whole host')
  const view = await readProfile([host.url], people[0]!.address, Date.now())
  assert.deepEqual(view.hosts, [host.url])
  assert.equal(view.current.get('profile')!.record.profile, people[0]!.address)
})

test('the old single file goes into the data directory once, under the same numbers', async () => {
  const dir = join(scratch(), 'host')
  const old = join(scratch(), 'host.sqlite')
  copyFileSync(SINGLE_FILE, old)

  const config = readConfig(credited({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old }))
  let h = await startHost(config)
  try {
    assert.deepEqual(h.moved, { imported: { folders: 2, records: 10, messages: 3, blobs: 3 }, toBucket: null })
    assert.deepEqual(readdirSync(dir).filter((n) => !/-(wal|shm)$/.test(n)).sort(), ['blobs', 'credits', 'folders', 'host.sqlite'], 'forest’s layout and the credits, and nothing half-made beside them')
    assert.equal(existsSync(`${dir}.import`), false)
    const all = await readAll(h.url)
    assert.equal(all.records.length, 10)
    assert.equal(all.cursor, 10, 'the cursors readers hold go on working')
    // A new record takes a number after them: forest's host numbers by the clock, in microseconds.
    const someone = await mainKey(randomBytes(32), 'tutoring/seller')
    await publish([h.url], [hostsRecord(someone, [h.url], Date.now())])
    assert.ok((await readAll(h.url)).cursor > 10)
  } finally {
    await h.close()
  }
  h = await startHost(config)
  try {
    assert.equal(h.moved.imported, null, 'once host.sqlite is there, the old file is left alone')
    assert.equal((await readAll(h.url)).records.length, 11)
  } finally {
    await h.close()
  }
})

test('a data directory with folders but no host.sqlite is not replaced by the import', async () => {
  const dir = join(scratch(), 'host')
  const old = join(scratch(), 'host.sqlite')
  copyFileSync(SINGLE_FILE, old)
  const first = await startHost(readConfig(credited({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old })))
  await first.close()
  rmSync(join(dir, 'host.sqlite'))
  await assert.rejects(startHost(readConfig(credited({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old }))))
  assert.ok(readdirSync(join(dir, 'folders')).length, 'the folders are where they were')
})

test('bytes on disk move to another store under the same names and types, and leave the disk', async () => {
  const from = blobStore(scratch(), { kind: 'disk' })
  const to = blobStore(scratch(), { kind: 'disk' })
  const blobs = [randomBytes(100), randomBytes(200)].map((bytes, i) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), type: i ? 'video/mp4' : 'image/png', bytes: new Uint8Array(bytes) }))
  for (const b of blobs) await from.put(b.sha256, b.type, b.bytes)
  assert.equal(await moveBlobs(from, to), 2)
  for (const b of blobs) {
    assert.deepEqual(await to.get(b.sha256), { type: b.type, bytes: b.bytes })
    assert.equal(await from.get(b.sha256), undefined)
  }
  assert.equal(await moveBlobs(from, to), 0)
})

/**
 * A bucket on loopback, path style, that takes a request only if forest's own SigV4 signature for
 * these credentials, in region `auto`, matches it; objects in memory, with their content-type.
 */
async function bucketStandIn(credentials: { accessKeyId: string; secretAccessKey: string; region: string }) {
  const objects = new Map<string, { type: string; bytes: Uint8Array }>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, `http://${req.headers.host}`)
    const auth = req.headers.authorization ?? ''
    const names = (/SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? '').split(';').filter((n) => !['host', 'x-amz-content-sha256', 'x-amz-date'].includes(n))
    const payloadHash = String(req.headers['x-amz-content-sha256'])
    const expected = signS3({ method: req.method!, url, headers: Object.fromEntries(names.map((n) => [n, String(req.headers[n])])), payloadHash, amzDate: String(req.headers['x-amz-date']) }, credentials).authorization
    if (auth !== expected || payloadHash !== createHash('sha256').update(body).digest('hex')) return void res.writeHead(403).end()
    const [, bucket, key] = url.pathname.split('/')
    if (bucket !== 'forest-host') return void res.writeHead(404).end()
    if (!key && req.method === 'GET') {
      const keys = [...objects.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
      return void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys}</ListBucketResult>`)
    }
    if (req.method === 'PUT') {
      objects.set(key!, { type: String(req.headers['content-type']), bytes: new Uint8Array(body) })
      return void res.writeHead(200).end()
    }
    if (req.method === 'DELETE') return void res.writeHead(objects.delete(key!) ? 204 : 404).end()
    const held = objects.get(key!)
    if (!held) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': held.type, 'content-length': held.bytes.length }).end(req.method === 'HEAD' ? undefined : held.bytes)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { objects, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('with a bucket: the old file’s bytes go straight to it; bytes an earlier start left on disk move to it', async () => {
  const credentials = { accessKeyId: 'id', secretAccessKey: 'secret', region: 'auto' }
  const bucket = await bucketStandIn(credentials)
  const variables = (dir: string, old: string) => credited({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old, S3_ENDPOINT: bucket.url, S3_BUCKET: 'forest-host', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret', S3_REGION: 'auto', S3_STYLE: 'path' })
  const old = join(scratch(), 'host.sqlite')
  copyFileSync(SINGLE_FILE, old)
  const fixtureBlobs = ['1c85c049849c11c261c798dc86337dad071aba06912e5cf0bc4246b6741d2fea', '5f16b986be00b36dad6ceccb463837b06bf09e5266e531ebaad64c140ef1858b', '1eab5c7e38c814d8bfa518fdf37d1652c3877616db7cab2af17812083083d8c4']
  try {
    // The first start, with the bucket already set: what the deploy does.
    const straight = join(scratch(), 'host')
    let h = await startHost(readConfig(variables(straight, old)))
    try {
      assert.deepEqual(h.moved, { imported: { folders: 2, records: 10, messages: 3, blobs: 3 }, toBucket: null })
      assert.deepEqual([...bucket.objects.keys()].sort(), [...fixtureBlobs].sort())
      assert.equal(existsSync(join(straight, 'blobs')), false, 'nothing on disk')
      assert.equal((await getBlob([h.url], fixtureBlobs[0]!))?.type, 'image/jpeg', 'served from the bucket')
    } finally {
      await h.close()
    }

    // A host that started on disk, then got the bucket.
    bucket.objects.clear()
    const later = join(scratch(), 'host')
    h = await startHost(readConfig(credited({ PORT: '0', DATA_DIR: later, IMPORT_FROM: old })))
    await h.close()
    assert.equal(readdirSync(join(later, 'blobs')).filter((n) => !n.endsWith('.type')).length, 3)
    h = await startHost(readConfig(variables(later, old)))
    try {
      assert.deepEqual(h.moved, { imported: null, toBucket: 3 })
      assert.equal(bucket.objects.size, 3)
      assert.deepEqual(readdirSync(join(later, 'blobs')), [], 'and gone from disk')
      for (const name of fixtureBlobs) assert.ok(await getBlob([h.url], name), 'each served from the bucket, as host.sqlite says it is held')
    } finally {
      await h.close()
    }
  } finally {
    await bucket.close()
  }
})

test("the lookup: a row of the sender's from the issuer, by the issuer's key", async () => {
  const [held, other, none] = [keyFromPrivate(randomBytes(32)), keyFromPrivate(randomBytes(32)), keyFromPrivate(randomBytes(32))]
  const otherIssuer = issuerKeyBytes(issuerKeyOf(new Uint8Array(32).fill(8)))
  const chain = rpc([rowData(held.publicKey), rowData(other.publicKey, otherIssuer)])
  const lookup = rowLookup(chain, DEVNET_REGISTRY)
  assert.equal(await lookup(held.address, ISSUER), true, "a row from the issuer's key")
  assert.equal(await lookup(other.address, ISSUER), false, "a row from another issuer's key")
  assert.equal(await lookup(none.address, ISSUER), false, 'no row')
  assert.equal(await lookup(held.address, Buffer.from(otherIssuer).toString('hex')), false, 'asked for another issuer')
  assert.equal(await lookup(held.address, ISSUER.toUpperCase()), false, 'a key not as a row writes it')
  assert.deepEqual(new Set(chain.asked), new Set([DEVNET_REGISTRY]), 'the registry it was told to read')
})

test('an inbox open to one issuer’s rows: taken with the lookup, refused without one', async () => {
  const now = Date.now()
  const owner = await mainKey(randomBytes(32), 'tutoring/seller')
  const sender = keyFromPrivate(randomBytes(32))
  const { body } = await card(owner, { senders: { issuer: ISSUER } })
  const note = () => message(sender, owner.address, { text: 'Is Tuesday free?' }, Date.now(), body)

  const withLookup = await startHost(readConfig(credited({ PORT: '0' })), { connection: rpc([rowData(sender.publicKey)]), rpc: paidRpc })
  try {
    await fund(withLookup, [owner.address, sender.address], 1)
    await publish([withLookup.url], [ownerRecord(owner, 'profile', body, now)])
    const [outcome] = await deliver([withLookup.url], [await note()])
    assert.deepEqual(errors(outcome), ['ok'])
  } finally {
    await withLookup.close()
  }

  await fund(host, [owner.address], 1)
  await publish([host.url], [ownerRecord(owner, 'profile', body, now)])
  const [outcome] = await deliver([host.url], [await note()])
  assert.deepEqual(errors(outcome), ['rule_unsupported'], 'no SOLANA_RPC_URL: no lookup')
})

test('a message key: taken while the sender’s host lists it; once past, refused after the time this host keeps what it read', async () => {
  const keep = 2
  // The plain fetch stands in for the public one, so the sender's host can be on loopback.
  const h = await startHost(readConfig(credited({ PORT: '0', SENDER_CACHE_SECONDS: String(keep) })), { fetch, rpc: paidRpc })
  try {
    const seller = await mainKey(randomBytes(32), 'tutoring/seller')
    const buyer = await mainKey(randomBytes(32), 'tutoring/buyer')
    const messageKey = keyFromPrivate(randomBytes(32))
    const readKey = await inboxKey(randomBytes(32))
    const sellerCard = await card(seller, { senders: 'anyone' }, [readKey.recipient])
    const buyerCard = await card(buyer, { senders: 'anyone' })
    const now = Date.now()
    await fund(h, [seller.address, buyer.address])
    await publish([h.url], [
      hostsRecord(seller, [h.url], now),
      permissionsRecord(seller, [{ key: messageKey.address, scope: 'message' }], now),
      ownerRecord(seller, 'profile', sellerCard.body, now),
      hostsRecord(buyer, [h.url], now),
      ownerRecord(buyer, 'profile', buyerCard.body, now),
    ])
    const delegated = { key: messageKey, from: seller.address, host: h.url }

    // The buyer writes; the message key pulls the seller's inbox and the read key opens it.
    assert.deepEqual(errors((await deliver([h.url], [await message(buyer, seller.address, { text: 'Tuesday?' }, Date.now(), sellerCard.body)]))[0]), ['ok'])
    const inbox = await pull(h.url, pullRequest({ key: messageKey, profile: seller.address }, 0, Date.now()))
    assert.deepEqual((await openMessage(inbox.messages[0]!.message, readKey.identity)).body, { text: 'Tuesday?' })

    // The reply, signed by the message key for the seller: the buyer sees which key sent it.
    assert.deepEqual(errors((await deliver([h.url], [await message(delegated, buyer.address, { text: 'Yes.' }, Date.now(), buyerCard.body)]))[0]), ['ok'])
    const replies = await pull(h.url, pullRequest(buyer, 0, Date.now()))
    const reply = await openMessage(replies.messages[0]!.message, buyerCard.identity)
    assert.deepEqual([reply.from, reply.key, reply.body], [seller.address, messageKey.address, { text: 'Yes.' }])

    // The seller makes it past. Pulls stop at once: the host reads its own copy of the permissions.
    await publish([h.url], [permissionsRecord(seller, [{ key: messageKey.address, was: 'message' }], Date.now() + 1)])
    await assert.rejects(pull(h.url, pullRequest({ key: messageKey, profile: seller.address }, 0, Date.now())), (err: Error & { code?: string }) => err.code === 'permission')
    // Sending stops once what this host read of the seller's host expires.
    assert.deepEqual(errors((await deliver([h.url], [await message(delegated, buyer.address, { text: 'Still me.' }, Date.now(), buyerCard.body)]))[0]), ['ok'], 'kept from before')
    await new Promise((resolve) => setTimeout(resolve, keep * 1000 + 100))
    assert.deepEqual(errors((await deliver([h.url], [await message(delegated, buyer.address, { text: 'Not any more.' }, Date.now(), buyerCard.body)]))[0]), ['permission'])

    // A host the message names that does not answer: `lookup`, for the sender to try again.
    const elsewhere = { ...delegated, host: 'http://127.0.0.1:9' }
    assert.deepEqual(errors((await deliver([h.url], [await message(elsewhere, buyer.address, { text: 'Hello?' }, Date.now(), buyerCard.body)]))[0]), ['lookup'])
  } finally {
    await h.close()
  }
})


test('credits: the directory, a buy collected only once paid, and spent into a folder, once', async () => {
  const directory = await (await fetch(`${host.url}${DIRECTORY_PATH}`)).json()
  assert.deepEqual(directory['forest-credit'], { unit: UNIT, address: PAY_TO, mint: MINT, price: '0.01' })
  assert.equal(directory['issuer-request-uri'], BUY_PATH)
  const service = serviceOf(ORIGIN, directory)
  const collect = async (h: RunningHost, bytes: Uint8Array, headers: Record<string, string> = {}) => {
    const res = await fetch(`${h.url}${BUY_PATH}`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer>, headers })
    return { status: res.status, body: res.headers.get('content-type') === 'application/json' ? await res.json() : null }
  }
  const owed = await buy(service, 3)
  assert.ok(owed.payLink.includes('amount=0.03&'), 'three cents')

  // Unpaid, or with no RPC to ask: no credits.
  const unpaid: Rpc = async () => null
  const strict = await startHost(readConfig(credited({ PORT: '0', CREDITS_PER_BUY: '2' })), { rpc: unpaid })
  const noRpc = await startHost(readConfig(credited({ PORT: '0' })))
  try {
    const two = await buy(service, 2)
    const owes = `0.02 to ${PAY_TO} in ${MINT}, the transaction naming the buy's reference ${two.reference}, finalized; or a ticket from a sponsor this service takes`
    assert.deepEqual(await collect(strict, two.buy), { status: 402, body: { error: 'not_paid', detail: owes } }, 'no payment shown')
    assert.deepEqual(await collect(strict, two.buy, paidFor(two)), { status: 402, body: { error: 'not_paid', detail: owes } }, 'a payment the RPC does not have')
    assert.deepEqual((await collect(strict, owed.buy)).body, { error: 'too_many', detail: 'at most 2 credits a buy' })
    assert.deepEqual((await collect(noRpc, owed.buy, paidFor(owed))).body, { error: 'payment_check_unavailable' })
  } finally {
    await strict.close()
    await noRpc.close()
  }
  assert.deepEqual((await collect(host, new Uint8Array([1, 2, 3]))).body, { error: 'not_a_buy' })

  // Paid: collected twice, the same credits.
  const first = await fetch(`${host.url}${BUY_PATH}`, { method: 'POST', body: owed.buy as Uint8Array<ArrayBuffer>, headers: paidFor(owed) })
  const answered = new Uint8Array(await first.arrayBuffer())
  const again = new Uint8Array(await (await fetch(`${host.url}${BUY_PATH}`, { method: 'POST', body: owed.buy as Uint8Array<ArrayBuffer>, headers: paidFor(owed) })).arrayBuffer())
  assert.deepEqual(again, answered, 'the same buy, the same answer')
  const [a, b, c] = await finish(owed.pending, answered)

  const folder = (await mainKey(randomBytes(32), 'tutoring/seller')).address
  assert.deepEqual(await spend(host, folder, [a!]), { status: 200, body: { folder, credits: 1 } })
  assert.deepEqual(await spend(host, folder, [a!]), { status: 409, body: { error: 'spent' } }, 'a credit is spent once')
  assert.deepEqual(await spend(host, folder, [b!, c!, a!]), { status: 409, body: { error: 'spent' } }, 'one spent among several: none of them taken')
  assert.equal(host.credits.balance(folder), 1)
  assert.deepEqual((await spend(host, 'not a folder', [b!])).body, { error: 'bad_request' })
  assert.deepEqual((await spend(host, folder, [], { folder })).body, { error: 'bad_request' }, 'no list')
  assert.deepEqual((await spend(host, folder, [])).body, { error: 'bad_request', detail: 'from 1 to 100 credits' })
  assert.deepEqual((await spend(host, folder, Array(101).fill(b!))).body, { error: 'bad_request', detail: 'from 1 to 100 credits' })
  assert.deepEqual(await spend(host, folder, [b!, b!]), { status: 402, body: { error: 'credit', detail: 'the same credit twice' } })
  // The same credit with one byte of its signature changed: read as a credit, checked, refused, and the good one beside it with it.
  const bytes = Buffer.from(b!.credit, 'base64url')
  bytes[bytes.length - 1]! ^= 1
  const forged = { ...b!, credit: bytes.toString('base64url') }
  const refused = await spend(host, folder, [c!, forged])
  assert.deepEqual([refused.status, refused.body.error], [402, 'credit'])
  assert.deepEqual(await spend(host, folder, [b!, c!]), { status: 200, body: { folder, credits: 3 } }, 'two together, the refusals having taken none')
  assert.deepEqual(await (await fetch(`${host.url}${BALANCE_PATH}${folder}`)).json(), { folder, credits: 3 })
  assert.equal((await fetch(`${host.url}${BALANCE_PATH}nope`)).status, 400)
  const preflight = await fetch(`${host.url}${SPEND_PATH}`, { method: 'OPTIONS' })
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type, forest-payment', 'a page may post credits, and collect a buy with its payment')
})

/** Bytes, and their name as a record gives it. */
function photo(length: number) {
  const bytes = new Uint8Array(randomBytes(length))
  return { bytes, named: { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', size: length } }
}

/** What a host answered a put: ok, or its code and why. */
const put = async (url: string, p: ReturnType<typeof photo>, type = p.named.mimeType) => {
  const [answer] = await putBlob([url], p.bytes, type)
  return answer!.ok ? 'ok' : `${answer!.error}: ${answer!.message}`
}

test('every write pays from its folder: a record or a message one credit, bytes one a started megabyte; hosts and permissions free', async () => {
  const MIB = 1024 * 1024
  assert.deepEqual([priceOf(0), priceOf(1), priceOf(MIB), priceOf(MIB + 1), priceOf(5 * MIB)], [1, 1, 1, 2, 5])
  const [owner, other] = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
  const balance = (who: { address: string }) => host.credits.balance(who.address)
  const now = Date.now()
  const big = photo(MIB + 1)
  const profile = { name: 'Owner', photo: big.named }

  // With nothing in its balance, a folder still moves and still removes an access key.
  const control = await publish([host.url], [hostsRecord(owner, [host.url], now), permissionsRecord(owner, [], now)])
  assert.deepEqual(errors(control[0]), ['ok', 'ok'])
  const [broke] = await publish([host.url], [ownerRecord(owner, 'profile', profile, now)])
  assert.deepEqual(errors(broke), ['refused'])
  assert.match(broke!.results[0]!.message!, /costs 1 credit, and the folder holds 0 here; credits are sold at \/\.well-known\/private-token-issuer-directory/)

  await fund(host, [owner.address], 2)
  assert.deepEqual(errors((await publish([host.url], [ownerRecord(owner, 'profile', profile, now)]))[0]), ['ok'])
  assert.equal(balance(owner), 1, 'a record: one credit')
  assert.deepEqual(errors((await publish([host.url], [ownerRecord(owner, 'profile', profile, now)]))[0]), ['ok'], 'already here')
  assert.equal(balance(owner), 1, 'a record already here costs nothing')

  // Bytes of a megabyte and one: two credits, from a folder whose records name them.
  assert.match(await put(host.url, big), /^refused: this write costs 2 credits, and the folder holds 1 here/)
  assert.match(await put(host.url, big, 'image/gif'), /^unnamed/, 'forest’s rule first')
  await fund(host, [owner.address], 1)
  assert.equal(await put(host.url, big), 'ok')
  assert.equal(balance(owner), 0)
  assert.equal(await put(host.url, big), 'ok', 'bytes already here')
  assert.equal(balance(owner), 0, 'bytes already here cost nothing')

  // Bytes two folders name come in through one that can pay.
  const shared = photo(10)
  await publish([host.url], [ownerRecord(owner, 'offer/a', { media: [shared.named] }, now)])
  await fund(host, [other.address], 2)
  await publish([host.url], [ownerRecord(other, 'offer/b', { media: [shared.named] }, now)])
  assert.equal(balance(other), 1)
  assert.equal(await put(host.url, shared), 'ok', 'through the folder that holds credits')
  assert.equal(balance(other), 0)

  // A message: one credit, from its sender.
  const inbox = await card(other, { senders: 'anyone' })
  await fund(host, [other.address], 1)
  await publish([host.url], [ownerRecord(other, 'profile', inbox.body, now)])
  const letter = async () => message(owner, other.address, { text: 'Tuesday?' }, Date.now(), inbox.body)
  const [unpaid] = await deliver([host.url], [await letter()])
  assert.deepEqual(errors(unpaid), ['refused'], 'the sender holds nothing here')
  await fund(host, [owner.address], 1)
  assert.deepEqual(errors((await deliver([host.url], [await letter()]))[0]), ['ok'])
  assert.deepEqual([balance(owner), balance(other)], [0, 0], 'the sender paid; the recipient did not')
})

test('a write costs exactly its price or nothing: two copies of one message pay once; a record paid before costs nothing again', async () => {
  const now = Date.now()
  const owner = await mainKey(randomBytes(32), 'tutoring/seller')
  const sender = keyFromPrivate(randomBytes(32))
  const { body } = await card(owner, { senders: { issuer: ISSUER } })
  // A lookup that takes a while, so both copies are in flight at once when they reach the price.
  const chain = rpc([rowData(sender.publicKey)])
  const slow = { getProgramAccounts: (async (...args: Parameters<typeof chain.getProgramAccounts>) => (await new Promise((r) => setTimeout(r, 50)), chain.getProgramAccounts(...args))) as never }
  const h = await startHost(readConfig(credited({ PORT: '0' })), { connection: slow, rpc: paidRpc })
  try {
    await fund(h, [owner.address], 1)
    await fund(h, [sender.address], 3)
    await publish([h.url], [ownerRecord(owner, 'profile', body, now)])
    const line = await message(sender, owner.address, { text: 'Is Tuesday free?' }, Date.now(), body)
    const both = await Promise.all([deliver([h.url], [line]), deliver([h.url], [line])])
    assert.deepEqual(both.map(([o]) => errors(o)[0]).sort(), ['duplicate', 'ok'], 'forest keeps one')
    assert.equal(h.credits.balance(sender.address), 2, 'and it was paid once')

    // A record whose price was taken before (a stop between the price and the store) is kept, free, when sent again.
    const record = ownerRecord(owner, 'offer/a', { title: 'Maths' }, now)
    await fund(h, [owner.address], 1)
    assert.equal(h.credits.charge(owner.address, 1, recordId(unsignedOf(record))), null)
    assert.equal(h.credits.balance(owner.address), 0)
    assert.deepEqual(errors((await publish([h.url], [record]))[0]), ['ok'], 'paid already: kept')
    assert.equal(h.credits.balance(owner.address), 0, 'nothing taken twice')
  } finally {
    await h.close()
  }
})

test('bytes: stored first, charged after; a put that fails costs nothing; two copies pay once; a reservation is never spent twice', async () => {
  const now = Date.now()
  const owner = await mainKey(randomBytes(32), 'tutoring/seller')
  const balance = () => host.credits.balance(owner.address)
  const [one, two] = [photo(10), photo(10)]
  await fund(host, [owner.address], 2)
  await publish([host.url], [ownerRecord(owner, 'offer/a', { media: [one.named, two.named] }, now)])
  assert.equal(balance(), 1)

  // Two copies of one blob at once: both answered ok, one paid.
  await fund(host, [owner.address], 1)
  assert.deepEqual(await Promise.all([put(host.url, one), put(host.url, one)]), ['ok', 'ok'])
  assert.equal(balance(), 1, 'paid once')

  // Two blobs at once, and a balance for one: one kept and paid, the other refused; never below zero.
  const three = photo(10)
  await publish([host.url], [ownerRecord(owner, 'offer/b', { media: [three.named] }, now)])
  assert.equal(balance(), 0)
  await fund(host, [owner.address], 1)
  const answers = await Promise.all([put(host.url, two), put(host.url, three)])
  assert.deepEqual(answers.map((a) => a.split(':')[0]).sort(), ['ok', 'refused'])
  assert.equal(balance(), 0)

  // A reservation holds its credits: a record can't spend them while the bytes are being stored.
  await fund(host, [owner.address], 1)
  assert.equal(host.credits.reserve('a'.repeat(64), [owner.address], 1), null)
  const [refused] = await publish([host.url], [ownerRecord(owner, 'offer/c', { title: 'x' }, now)])
  assert.deepEqual(errors(refused), ['refused'], 'reserved for the bytes')
  host.credits.stored('a'.repeat(64), false)
  assert.deepEqual(errors((await publish([host.url], [ownerRecord(owner, 'offer/c', { title: 'x' }, now)]))[0]), ['ok'], 'released: the record takes it')

  // A bucket that refuses every put: the bytes are not kept, and nothing is paid.
  const broken = createServer((req, res) => {
    req.resume()
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve))
  const bucket = { S3_ENDPOINT: `http://127.0.0.1:${(broken.address() as { port: number }).port}`, S3_BUCKET: 'forest-host', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }
  const h = await startHost(readConfig(credited({ PORT: '0', ...bucket })), { rpc: paidRpc })
  try {
    const lost = photo(10)
    await fund(h, [owner.address], 2)
    await publish([h.url], [ownerRecord(owner, 'offer/a', { media: [lost.named] }, now)])
    assert.equal(h.credits.balance(owner.address), 1)
    assert.notEqual(await put(h.url, lost), 'ok')
    assert.equal(h.credits.balance(owner.address), 1, 'a put that failed cost nothing')
    assert.equal(await getBlob([h.url], lost.named.sha256), null, 'and not kept')
  } finally {
    await h.close()
    broken.close()
  }
})

test('one file: an older host’s balances, and a spend it cut short between its two files, moved in once', async () => {
  const dir = scratch()
  const start = () => startHost(readConfig(credited({ PORT: '0', DATA_DIR: dir })), { rpc: paidRpc })
  let h = await start()
  const folder = (await mainKey(randomBytes(32), 'tutoring/seller')).address
  const [kept, lost] = await creditsFrom(h, 2)
  const ids = [creditId(kept!), creditId(lost!)]
  // Two spends an older host cut short: the first got as far as its balances file, the second only as far as the hold.
  h.credits.spent.hold(ids[0]!)
  h.credits.spent.hold(ids[1]!)
  await h.close()
  const old = new DatabaseSync(join(dir, 'credits', 'balances.sqlite'))
  old.exec('CREATE TABLE balances (folder TEXT PRIMARY KEY, credits INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE landing (id TEXT PRIMARY KEY) WITHOUT ROWID')
  old.prepare('INSERT INTO landing (id) VALUES (?)').run(ids[0]!)
  old.prepare('INSERT INTO balances (folder, credits) VALUES (?, 1)').run(folder)
  old.close()
  h = await start()
  try {
    assert.deepEqual(readdirSync(join(dir, 'credits')).sort(), ['credits.sqlite'], 'one file')
    assert.deepEqual(h.credits.spent.holds(), [], 'nothing held after the start')
    assert.equal(h.credits.balance(folder), 1, 'the balance moved in')
    assert.deepEqual((await spend(h, folder, [kept!])).body, { error: 'spent' }, 'the one its folder took is spent')
    assert.deepEqual((await spend(h, folder, [lost!])).body, { folder, credits: 2 }, 'the other is free to show again')
  } finally {
    await h.close()
  }
  h = await start()
  try {
    assert.equal(h.credits.balance(folder), 2, 'moved once')
  } finally {
    await h.close()
  }
})

test('a message key: its sender’s host read at a public address only, and never after a redirect', async () => {
  const seller = await mainKey(randomBytes(32), 'tutoring/seller')
  const buyer = await mainKey(randomBytes(32), 'tutoring/buyer')
  const messageKey = keyFromPrivate(randomBytes(32))
  const buyerCard = await card(buyer, { senders: 'anyone' })
  // A host the plain fetch reads (loopback), and in front of it one that only redirects to it.
  const h = await startHost(readConfig(credited({ PORT: '0', SENDER_CACHE_SECONDS: '0' })), { fetch, rpc: paidRpc })
  const redirect = createServer((req, res) => res.writeHead(302, { location: `${h.url}${req.url}` }).end())
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
  const via = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`
  try {
    const now = Date.now()
    await fund(h, [seller.address, buyer.address])
    await fund(host, [buyer.address], 1)
    await publish([h.url], [
      hostsRecord(seller, [h.url, via], now),
      permissionsRecord(seller, [{ key: messageKey.address, scope: 'message' }], now),
      ownerRecord(seller, 'profile', (await card(seller, { senders: 'anyone' })).body, now),
      ownerRecord(buyer, 'profile', buyerCard.body, now),
    ])
    const send = async (at: RunningHost, from: string) => errors((await deliver([at.url], [await message({ key: messageKey, from: seller.address, host: from }, buyer.address, { text: 'Hi.' }, Date.now(), buyerCard.body)]))[0])
    assert.deepEqual(await send(h, h.url), ['ok'], 'read from the host itself')
    assert.deepEqual(await send(h, via), ['lookup'], 'a host that redirects, refused')
    // This host itself, with the public fetch: the sender's host on loopback is never read.
    await publish([host.url], [ownerRecord(buyer, 'profile', buyerCard.body, now)])
    assert.deepEqual(await send(host, h.url), ['lookup'], 'a sender’s host on loopback')
  } finally {
    redirect.close()
    await h.close()
  }
})
