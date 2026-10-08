// The foundation's host: forest's host behind the front, with this service's policy; its storage,
// with the import of the old single file and the move of bytes to a bucket; the registry lookup for
// an inbox that takes messages from one issuer's rows; the sender's records read, and kept a while,
// to take a message a message key signed, from a public address only and with no redirect; and the
// photo rule: photos and videos only for a folder with a counted row, within its bytes.
//
// A request whose URL cannot be read is refused at the front, and the host goes on.
//
//   npm test

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { type Connection, PublicKey } from '@solana/web3.js'

import { mainKey, readingKey } from '../../forest/keys/src/index.ts'
import { base58, deliver, getBlob, hostsRecord, keyFromPrivate, ownerRecord, permissionsRecord, publish, pull, pullRequest, putBlob, readAll, readProfile } from '../../forest/records/src/index.ts'
import { Host } from '../../forest/records/src/host.ts'
import { message, openMessage } from '../../forest/records/src/private.ts'
import { blobStore, signS3 } from '../../forest/records/src/storage.ts'
import { ROW_DISCRIMINATOR, ROW_OFFSET, rowSpace } from '../../forest/registry/client/src/program.ts'
import { issuerKeyBytes, issuerKeyOf } from '../../forest/registry/client/src/index.ts'

import { DEVNET_REGISTRY, LABEL, PHOTOS, POLICY, type RunningHost, isPublic, moveBlobs, photoRule, publicFetch, readConfig, rowLookup, startHost } from '../src/host.ts'

/** An issuer's key, as a row holds it, and as an inbox names it: 128 hex. */
const ISSUER_KEY = issuerKeyBytes(issuerKeyOf(new Uint8Array(32).fill(7)))
const ISSUER = Buffer.from(ISSUER_KEY).toString('hex')
/** Forest's single-file host's own file, as it wrote it: two folders, ten records, three messages, three blobs. */
const SINGLE_FILE = new URL('../../forest/records/test/single-file.sqlite', import.meta.url)

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
  const inboxKey = await readingKey(owner.privateKey)
  const body = { market: 'tutoring', role: owner.label.split('/')[1]!, name: 'Test', inboxKey: inboxKey.recipient, inbox: { ...rule, ...(readers && { readers }) }, createdAt: '2026-10-02T00:00:00Z' }
  return { body, identity: inboxKey.identity }
}

const errors = (outcome: { results: { ok: boolean; error?: string }[] } | undefined) => outcome!.results.map((r) => r.error ?? 'ok')

let host: RunningHost
before(async () => {
  host = await startHost(readConfig({ PORT: '0' }))
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
  assert.deepEqual(PHOTOS, { issuers: ['2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549'], folderBytes: 250_000_000 })
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

test('the settings: a data directory, the old file, a bucket by its variables, and the time a sender’s records are kept', () => {
  const none = readConfig({})
  assert.deepEqual(none, { dir: null, importFrom: null, blobs: { kind: 'disk' }, port: 8080, rpcUrl: null, registryProgramId: DEVNET_REGISTRY, senderCacheMs: 60_000 })
  const bucket = { S3_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'forest-host', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' }
  const full = readConfig({ DATA_DIR: '/data/host', IMPORT_FROM: '/data/host.sqlite', SENDER_CACHE_SECONDS: '5', ...bucket, S3_REGION: 'auto', S3_STYLE: 'virtual' })
  assert.deepEqual([full.dir, full.importFrom, full.senderCacheMs], ['/data/host', '/data/host.sqlite', 5000])
  assert.deepEqual(full.blobs, { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'forest-host', accessKeyId: 'id', secretAccessKey: 'secret', region: 'auto', style: 'virtual' }, 'the region as given, `auto` too')
  assert.deepEqual(readConfig(bucket).blobs, { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'forest-host', accessKeyId: 'id', secretAccessKey: 'secret' }, 'forest’s defaults: us-east-1, path style')
  assert.throws(() => readConfig({ S3_BUCKET: 'forest-host', S3_REGION: 'auto' }), /missing: S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/, 'half a bucket is no bucket, and no silent disk')
  assert.throws(() => readConfig({ ...bucket, S3_STYLE: 'sideways' }), /S3_STYLE/)
  assert.throws(() => readConfig({ ...bucket, S3_ENDPOINT: 'not a url' }))
  assert.throws(() => readConfig({ SENDER_CACHE_SECONDS: '-1' }), /SENDER_CACHE_SECONDS/)
})

test('records go in and come back through the front, for the whole host and by profile', async () => {
  const now = Date.now()
  const people = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
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

  const config = readConfig({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old })
  let h = await startHost(config)
  try {
    assert.deepEqual(h.moved, { imported: { folders: 2, records: 10, messages: 3, blobs: 3 }, toBucket: null })
    assert.deepEqual(readdirSync(dir).filter((n) => !/-(wal|shm)$/.test(n)).sort(), ['blobs', 'folders', 'host.sqlite'], 'forest’s layout, and nothing half-made beside it')
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
  const first = await startHost(readConfig({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old }))
  await first.close()
  rmSync(join(dir, 'host.sqlite'))
  await assert.rejects(startHost(readConfig({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old })))
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
  const variables = (dir: string, old: string) => ({ PORT: '0', DATA_DIR: dir, IMPORT_FROM: old, S3_ENDPOINT: bucket.url, S3_BUCKET: 'forest-host', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret', S3_REGION: 'auto', S3_STYLE: 'path' })
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
    h = await startHost(readConfig({ PORT: '0', DATA_DIR: later, IMPORT_FROM: old }))
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

  const withLookup = await startHost(readConfig({ PORT: '0' }), { connection: rpc([rowData(sender.publicKey)]) })
  try {
    await publish([withLookup.url], [ownerRecord(owner, 'profile', body, now)])
    const [outcome] = await deliver([withLookup.url], [await note()])
    assert.deepEqual(errors(outcome), ['ok'])
  } finally {
    await withLookup.close()
  }

  await publish([host.url], [ownerRecord(owner, 'profile', body, now)])
  const [outcome] = await deliver([host.url], [await note()])
  assert.deepEqual(errors(outcome), ['rule_unsupported'], 'no SOLANA_RPC_URL: no lookup')
})

test('a message key: taken while the sender’s host lists it; once past, refused after the time this host keeps what it read', async () => {
  const keep = 2
  // The plain fetch stands in for the public one, so the sender's host can be on loopback.
  const h = await startHost(readConfig({ PORT: '0', SENDER_CACHE_SECONDS: String(keep) }), { fetch })
  try {
    const seller = await mainKey(randomBytes(32), 'tutoring/seller')
    const buyer = await mainKey(randomBytes(32), 'tutoring/buyer')
    const messageKey = keyFromPrivate(randomBytes(32))
    const readKey = await readingKey(randomBytes(32))
    const sellerCard = await card(seller, { senders: 'anyone' }, [readKey.recipient])
    const buyerCard = await card(buyer, { senders: 'anyone' })
    const now = Date.now()
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
    await publish([h.url], [permissionsRecord(seller, [{ key: messageKey.address, scope: 'past' }], Date.now() + 1)])
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


/** Bytes, and their name as a record gives it; `size` is what the record says of them, true or not. */
function photo(length: number, size = length) {
  const bytes = new Uint8Array(randomBytes(length))
  return { bytes, named: { sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', size } }
}

/** What a host answered a put: ok, or its code. */
const put = async (url: string, p: ReturnType<typeof photo>) => {
  const [answer] = await putBlob([url], p.bytes, p.named.mimeType)
  return answer!.ok ? 'ok' : answer!.error
}

test('the photo rule: photos and videos only for a folder holding a row from the devnet issuer', async () => {
  const devnetIssuer = Buffer.from(PHOTOS.issuers[0], 'hex')
  const [holder, other, none] = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
  const [mine, others, nones] = [photo(100), photo(100), photo(100)]
  const now = Date.now()
  const records = [
    ownerRecord(holder, 'profile', { name: 'Holder', photo: mine.named }, now),
    ownerRecord(other, 'profile', { name: 'Other', photo: others.named }, now),
    ownerRecord(none, 'profile', { name: 'None', photo: nones.named }, now),
  ]
  // The holder's row is the devnet issuer's; the other's is another issuer's; none holds none.
  const h = await startHost(readConfig({ PORT: '0' }), { connection: rpc([rowData(holder.publicKey, devnetIssuer), rowData(other.publicKey)]) })
  try {
    await publish([h.url], records)
    assert.equal(await put(h.url, mine), 'ok')
    assert.equal(await put(h.url, others), 'policy', 'a row from another issuer')
    assert.equal(await put(h.url, nones), 'policy', 'no row')
    const [refused] = await putBlob([h.url], nones.bytes, 'image/png')
    assert.match(refused!.message!, /only for a folder holding a registry row from an issuer it counts/)
    assert.equal((await getBlob([h.url], mine.named.sha256))?.type, 'image/png', 'and serves what it took')
    assert.equal(await put(h.url, photo(10)), 'unnamed', 'forest’s rule first: bytes no record names')
  } finally {
    await h.close()
  }
  // No RPC: no row can be read, so no photo is taken.
  await publish([host.url], records)
  assert.equal(await put(host.url, mine), 'policy', 'no SOLANA_RPC_URL: no photos')
})

test('the photo rule: a folder’s bytes as they are, not as its records say, through any folder that names them, after a restart too', async () => {
  const dir = scratch()
  const [owner, other] = [await mainKey(randomBytes(32), 'tutoring/seller'), await mainKey(randomBytes(32), 'tutoring/buyer')]
  // Every record says each is 1 byte: the rule counts the bytes.
  const [a, b, c, d] = [photo(600, 1), photo(300, 1), photo(200, 1), photo(50, 1)]
  const start = async (counted: (folder: string) => Promise<boolean> = async () => true) => {
    const h: Host = new Host({ dir, blobPolicy: photoRule(() => h, counted, 1000) })
    return { h, url: await h.listen(0) }
  }
  let { h, url } = await start()
  try {
    const now = Date.now()
    await publish([url], [ownerRecord(owner, 'offer/x', { media: [a.named, b.named, c.named] }, now)])
    assert.equal(await put(url, a), 'ok', '600 of 1000')
    assert.equal(await put(url, b), 'ok', '900')
    assert.equal(await put(url, c), 'policy', '1100: over')
    const [over] = await putBlob([url], c.bytes, 'image/png')
    assert.match(over!.message!, /at most 1000 bytes/)
    // Another folder names the same bytes, and has room: they come in through it.
    await publish([url], [ownerRecord(other, 'offer/y', { media: [c.named] }, now)])
    assert.equal(await put(url, c), 'ok', 'through the other folder: 200 of 1000')
    // A folder with no counted row puts nothing, room or not.
    await h.close()
    ;({ h, url } = await start(async (folder) => folder !== other.address))
    await publish([url], [ownerRecord(other, 'offer/z', { media: [d.named] }, now)])
    assert.equal(await put(url, d), 'policy', 'no row')
    await h.close()
    // After a restart, the sizes of the bytes held are read back from them: the owner's 600, 300
    // and 200 are still 1100, so 10 more is over.
    ;({ h, url } = await start())
    const e = photo(10, 1)
    await publish([url], [ownerRecord(owner, 'offer/v', { media: [e.named] }, now)])
    assert.equal(await put(url, e), 'policy', '1110 of 1000, the sizes read back')
  } finally {
    await h.close()
  }
})

test('the sender check: a public address only, checked before anything is sent', async () => {
  for (const a of ['127.0.0.1', '127.8.8.8', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '64:ff9b::808:808', '2002:7f00:1::1', '2002:808:808::1', 'localhost', 'not an address']) {
    assert.equal(isPublic(a), false, a)
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublic(a), true, a)
  // A server on loopback that must hear nothing: every request to it is refused before it is sent.
  let heard = 0
  const server = createServer((_req, res) => {
    heard++
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/']) {
      await assert.rejects(publicFetch(url), url)
    }
    assert.equal(heard, 0)
  } finally {
    server.close()
  }
})

test('a message key: its sender’s host read at a public address only, and never after a redirect', async () => {
  const seller = await mainKey(randomBytes(32), 'tutoring/seller')
  const buyer = await mainKey(randomBytes(32), 'tutoring/buyer')
  const messageKey = keyFromPrivate(randomBytes(32))
  const buyerCard = await card(buyer, { senders: 'anyone' })
  // A host the plain fetch reads (loopback), and in front of it one that only redirects to it.
  const h = await startHost(readConfig({ PORT: '0', SENDER_CACHE_SECONDS: '0' }), { fetch })
  const redirect = createServer((req, res) => res.writeHead(302, { location: `${h.url}${req.url}` }).end())
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
  const via = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`
  try {
    const now = Date.now()
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
