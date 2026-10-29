// The host's storage (storage.ts): a SQLite file per folder, host.sqlite for the log and for which
// files are named and stored, and the bytes on disk or in an S3-compatible bucket. None of it is the
// standard: the seven requests answer the same whatever the storage. Here: where things land, the
// feed across folders, removing a folder, a malformed address, rebuilding host.sqlite, a folder file
// in another layout, refused and left out of the feed and the prune, and the S3 driver.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { type IncomingMessage, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, mock, test } from 'node:test'
import { openingHalf } from '@foundationforest/keys'
import { type Body, entry, fetchFile, fileOf, leave, readAll, readInbox, readPage, upload, write } from '@foundationforest/folders'
import { inboxEntry } from '@foundationforest/folders/locked'
import { DAY, type FileDriver, Host, rebuild } from '../src/plug.ts'
import { LINK_SECONDS, presignS3, s3Url, signS3 } from '../src/storage.ts'
import { MINUTE, T0, alice, aliceBuyer, aliceOpening, bob, offerBody, profileBody } from './fixtures.ts'
import { Clock, startPlug } from './helpers.ts'

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'forest-storage-'))
  dirs.push(dir)
  return dir
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (seed: number, length = 2000) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed * 13) & 255)
const photo = bytesOf(1)
const clip = bytesOf(2, 3000)
/** Alice's photo and Bob's clip, each uploaded once an entry names it. */
const putBoth = async (url: string) => [...(await upload([url], photo, 'image/jpeg')), ...(await upload([url], clip, 'video/mp4'))].map((o) => o.ok)

const bobOpening = await openingHalf(bob.secret)
const aliceProfile: Body = { ...profileBody('calculus'), openKey: aliceOpening.openKey }
const bobProfile: Body = { ...profileBody('chemistry'), role: 'buyer', openKey: bobOpening.openKey }
/** Alice's offer naming her photo. */
const photoOffer = entry(alice, 'post/photo', { ...offerBody('5'), files: [fileOf(photo, 'image/jpeg')] }, T0)
const withClip = (about: string): Body => ({ ...offerBody(about), files: [fileOf(clip, 'video/mp4')] })

/** Every page of the feed, as [cursor, ids]: what a crawler sees, number for number. */
async function pages(url: string, profile?: string) {
  const out: Array<[number, string[]]> = []
  for (let after = 0; ; ) {
    const page = await readPage(url, { after, ...(profile && { profile }) })
    if (page.cursor === after) return out
    out.push([page.cursor, page.entries.map((c) => c.id)])
    after = page.cursor
  }
}

/** Read one SQLite file while the host runs. */
function query<T>(file: string, sql: string): T[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

/** A folder file in the layout this host had before the standard's folders: its tables `records`, `messages` and `blobs`, version 3. */
function toRecordsLayout(file: string) {
  const db = new DatabaseSync(file)
  db.exec(`
    DROP TABLE entries;
    DROP TABLE inbox;
    CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, bytes INTEGER NOT NULL, arrived INTEGER NOT NULL, older_since INTEGER);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, bytes INTEGER NOT NULL, arrived INTEGER NOT NULL);
    CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, arrived INTEGER NOT NULL) WITHOUT ROWID;
    PRAGMA user_version = 3;
  `)
  db.close()
}

/** A folder file's version and its tables. */
const shapeOf = (file: string) => [
  query<{ user_version: number }>(file, 'PRAGMA user_version')[0]!.user_version,
  query<{ name: string }>(file, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name),
]

describe('a file per folder', () => {
  test('two folders land in two files; host.sqlite holds the log, the names and the files, and no entry', async () => {
    const dir = scratch()
    const h = await startPlug({ dir, now: () => T0 })
    try {
      const entries = [entry(alice, 'profile', profileBody('calculus'), T0), entry(bob, 'profile', profileBody('chemistry'), T0), entry(alice, 'post/a', offerBody('1'), T0)]
      await write([h.url], entries)
      assert.deepEqual(readdirSync(join(dir, 'folders')).sort(), [`${alice.address}.sqlite`, `${bob.address}.sqlite`].sort())
      const profiles = (address: string) => query<{ text: string }>(join(dir, 'folders', `${address}.sqlite`), 'SELECT text FROM entries ORDER BY seq').map((r) => (JSON.parse(r.text) as { profile: string }).profile)
      assert.deepEqual(profiles(alice.address), [alice.address, alice.address])
      assert.deepEqual(profiles(bob.address), [bob.address])

      const host = join(dir, 'host.sqlite')
      assert.deepEqual(query<{ name: string }>(host, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name), ['files', 'log', 'names', 'sqlite_sequence'])
      assert.deepEqual(query<{ folder: string }>(host, 'SELECT folder FROM log ORDER BY seq').map((r) => r.folder), [alice.address, bob.address, alice.address])
      const shared = Buffer.concat([host, `${host}-wal`].filter(existsSync).map((f) => readFileSync(f)))
      for (const e of entries) assert.ok(!shared.includes(e.sig), 'no entry text in host.sqlite')
    } finally {
      await h.close()
    }
  })

  test('the feed orders every folder’s entries by arrival, under one set of numbers', async () => {
    const clock = new Clock(T0)
    const h = await startPlug({ now: clock.now, maxPageLines: 2 })
    try {
      const order = [[alice, 'post/1'], [bob, 'post/1'], [alice, 'post/2'], [bob, 'post/2'], [alice, 'post/3']] as const
      for (const [key, path] of order) await write([h.url], [entry(key, path, offerBody('1'), clock.advance(1))])
      assert.deepEqual((await readAll(h.url)).entries.map((c) => [c.entry.profile, c.entry.path]), order.map(([key, path]) => [key.address, path]))
      // Each number is the clock in microseconds, the entry at T0 + i ms numbered (T0 + i) × 1000.
      const n = (i: number) => (T0 + i) * 1000
      assert.deepEqual((await pages(h.url)).map(([cursor, ids]) => [cursor, ids.length]), [[n(2), 2], [n(4), 2], [n(5), 1]])
      // A cursor from the feed works for one folder too.
      assert.deepEqual((await readPage(h.url, { after: n(2), profile: alice.address })).entries.map((c) => c.entry.path), ['post/2', 'post/3'])
      assert.deepEqual((await readPage(h.url, { after: n(2), profile: bob.address })).cursor, n(4))
    } finally {
      await h.close()
    }
  })

  test('deleting one folder’s file removes exactly that folder; the bytes only it named go keep days later', async () => {
    const dir = scratch()
    const options = { dir, now: () => T0 }
    let h = await startPlug(options)
    const reread = async () => ({ feed: await pages(h.url), bob: await pages(h.url, bob.address), bobInbox: await readInbox(h.url, bob.address) })
    let was: Awaited<ReturnType<typeof reread>>
    try {
      await write([h.url], [entry(alice, 'profile', aliceProfile, T0), photoOffer])
      await write([h.url], [entry(bob, 'profile', bobProfile, T0)])
      await write([h.url], [entry(alice, 'post/a', withClip('1'), T0)])
      await write([h.url], [entry(bob, 'post/b', withClip('2'), T0)])
      assert.deepEqual(await putBoth(h.url), [true, true])
      await leave([h.url], [await inboxEntry(bob, alice.address, { text: 'Tuesday?' }, T0, aliceProfile)])
      await leave([h.url], [await inboxEntry(alice, bob.address, { text: 'Tuesday.' }, T0, bobProfile)])
      was = await reread()
    } finally {
      await h.close()
    }

    rmSync(join(dir, 'folders', `${alice.address}.sqlite`))
    h = await startPlug(options)
    try {
      // Alice's folder is gone: her entries, her inbox.
      assert.deepEqual((await readAll(h.url, { profile: alice.address })).entries, [])
      assert.deepEqual((await readInbox(h.url, alice.address)).entries, [])
      // Bob's is whole: the same entries under the same numbers, and the same inbox.
      const now = await reread()
      const bobIds = new Set(was.bob.flatMap(([, ids]) => ids))
      assert.deepEqual(now.feed.flatMap(([, ids]) => ids), was.feed.flatMap(([, ids]) => ids).filter((id) => bobIds.has(id)))
      assert.deepEqual(now.bob, was.bob)
      assert.deepEqual([now.bobInbox.entries.map((e) => e.id), now.bobInbox.cursor], [was.bobInbox.entries.map((e) => e.id), was.bobInbox.cursor])

      // The next prune drops what host.sqlite said of her; the bytes only she named go keep days later.
      await h.prune(T0)
      const host = join(dir, 'host.sqlite')
      assert.deepEqual(query<{ folder: string }>(host, 'SELECT DISTINCT folder FROM log UNION SELECT folder FROM names').map((r) => r.folder), [bob.address])
      assert.ok(await h.getFile(sha256Hex(photo)), 'kept for keep days')
      await h.prune(T0 + 31 * DAY)
      assert.equal(await h.getFile(sha256Hex(photo)), undefined)
      assert.ok(await h.getFile(sha256Hex(clip)), 'Bob names it still')
    } finally {
      await h.close()
    }
  })

  test('a folder that is no address touches no file', async () => {
    const dir = scratch()
    const h = await startPlug({ dir, now: () => T0 })
    try {
      await write([h.url], [entry(alice, 'profile', profileBody('calculus'), T0)])
      const files = () => readdirSync(dir, { recursive: true }).map(String).sort()
      const was = files()
      const zeroKey = '1'.repeat(32) // 32 zero bytes: one spelling, but a key of small order
      for (const folder of ['../x', 'not-an-address', `${alice.address}/../../host`, `1${alice.address}`, zeroKey, bob.address]) {
        for (const [path, field] of [['/v1/entries/read', 'profile'], ['/v1/inbox/read', 'to']]) {
          const res = await fetch(`${h.url}${path}`, { method: 'POST', body: JSON.stringify({ [field]: folder }) })
          assert.deepEqual([res.status, await res.text(), res.headers.get('forest-cursor')], [200, '', '0'], `${path} ${folder}`)
        }
      }
      assert.deepEqual(files(), was, 'no file made, opened by name or moved')
    } finally {
      await h.close()
    }
  })
})

describe('host.sqlite holds nothing that exists only there', () => {
  test('numbers come from the clock: a rebuilt host.sqlite, or a folder’s file made again, never gives one again', async () => {
    const dir = scratch()
    const clock = new Clock(T0)
    const options = { dir, now: clock.now }
    let h = await startPlug(options)
    let given: number
    let inboxCursor: number
    try {
      await write([h.url], [entry(bob, 'profile', bobProfile, T0), entry(alice, 'profile', aliceProfile, T0)])
      await leave([h.url], [await inboxEntry(bob, alice.address, { text: 'Tuesday?' }, T0, aliceProfile)])
      given = (await readPage(h.url)).cursor
      inboxCursor = (await readInbox(h.url, alice.address)).cursor
      assert.deepEqual([given, inboxCursor], [T0 * 1000 + 1, T0 * 1000], 'the clock in microseconds, then one more')
    } finally {
      await h.close()
    }

    // Alice's folder goes, and host.sqlite with it: rebuilt from Bob's folder alone, the highest
    // number the log knows is Bob's. A millisecond later is enough to give no number twice.
    rmSync(join(dir, 'folders', `${alice.address}.sqlite`))
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `host.sqlite${suffix}`), { force: true })
    clock.advance(1)
    await rebuild(dir, { kind: 'disk' })
    h = await startPlug(options)
    try {
      await write([h.url], [entry(alice, 'profile', aliceProfile, clock.t)])
      await leave([h.url], [await inboxEntry(bob, alice.address, { text: 'Still Tuesday?' }, clock.t, aliceProfile)])
      const page = await readPage(h.url, { after: given })
      assert.deepEqual([page.entries.length, page.cursor], [1, clock.t * 1000], 'a reader holding the old cursor still gets the new entry')
      assert.equal((await readInbox(h.url, alice.address, { after: inboxCursor })).entries.length, 1, 'and the inbox’s old cursor, the new inbox entry')
    } finally {
      await h.close()
    }
  })

  test('delete it and rebuild: the same feed, the same numbers, the same files, each named by the same folders', async () => {
    const dir = scratch()
    const clock = new Clock(T0)
    const options = { dir, now: clock.now, maxPageLines: 2 }
    let h = await startPlug(options)
    let was: Array<[number, string[]]>
    try {
      await write([h.url], [entry(alice, 'profile', aliceProfile, T0), photoOffer, entry(alice, 'post/a', withClip('1'), T0)])
      await write([h.url], [entry(bob, 'profile', bobProfile, T0), entry(bob, 'post/b', withClip('2'), T0)])
      assert.deepEqual(await putBoth(h.url), [true, true])
      was = await pages(h.url)
    } finally {
      await h.close()
    }

    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `host.sqlite${suffix}`), { force: true })
    assert.throws(() => new Host(options), /rebuild/, 'a host does not start without it: new entries would take numbers already given')
    clock.advance(MINUTE)
    await rebuild(dir, { kind: 'disk' })
    h = await startPlug(options)
    try {
      assert.deepEqual(await pages(h.url), was)
      assert.deepEqual(await fetchFile([h.url], sha256Hex(photo)).then((g) => [g!.type, g!.bytes]), ['image/jpeg', photo])
      assert.deepEqual((await upload([h.url], photo, 'image/jpeg'))[0]!.message, 'already here')
      // New entries go on past the numbers given before, from the clock.
      const last = was.at(-1)![0]
      await write([h.url], [entry(bob, 'post/c', offerBody('3'), clock.t)])
      assert.equal((await readPage(h.url, { after: last })).cursor, clock.t * 1000)
      assert.ok(clock.t * 1000 > last)
      // Each file is named still: a prune keeps both, and the clip goes keep days after neither names it.
      await h.prune(clock.t + 365 * DAY)
      assert.ok(await h.getFile(sha256Hex(photo)))
      await write([h.url], [entry(alice, 'post/a', null, clock.t), entry(bob, 'post/b', null, clock.t)])
      await h.prune(clock.t + 31 * DAY)
      assert.equal(await h.getFile(sha256Hex(clip)), undefined)
      assert.ok(await h.getFile(sha256Hex(photo)))
    } finally {
      await h.close()
    }
  })

  test('a file no current entry names at the rebuild is dated then, and goes keep days later', async () => {
    const dir = scratch()
    const clock = new Clock(T0)
    const options = { dir, now: clock.now }
    let h = await startPlug(options)
    try {
      await write([h.url], [photoOffer])
      assert.ok((await upload([h.url], photo, 'image/jpeg'))[0]!.ok)
      await write([h.url], [entry(alice, 'post/photo', null, T0 + 1)])
    } finally {
      await h.close()
    }
    rmSync(join(dir, 'host.sqlite'))
    clock.advance(10 * DAY)
    await rebuild(dir, { kind: 'disk' }, clock.t)
    h = await startPlug(options)
    try {
      await h.prune(T0 + 31 * DAY)
      assert.ok(await h.getFile(sha256Hex(photo)), 'its keep days run from the rebuild')
      await h.prune(clock.t + 31 * DAY)
      assert.equal(await h.getFile(sha256Hex(photo)), undefined)
    } finally {
      await h.close()
    }
  })
})

describe('a folder file in another layout', () => {
  test('is refused by name and left as it was, on open and by a rebuild: one from before folders, and one with a table more', async () => {
    const dir = scratch()
    const h = await startPlug({ dir, now: () => T0 })
    await write([h.url], [entry(alice, 'profile', aliceProfile, T0), entry(bob, 'profile', bobProfile, T0)])
    await h.close()
    const aliceFile = join(dir, 'folders', `${alice.address}.sqlite`)
    const bobFile = join(dir, 'folders', `${bob.address}.sqlite`)
    toRecordsLayout(aliceFile)
    const db = new DatabaseSync(bobFile)
    db.exec('CREATE TABLE extra (x)')
    db.close()
    const refused = (file: string) => ({ message: `${file} is not a folder file in this host's layout` })
    const again = new Host({ dir, now: () => T0 })
    try {
      assert.throws(() => again.view(alice.address), refused(aliceFile))
      assert.throws(() => again.view(bob.address), refused(bobFile))
      assert.equal(again.view(aliceBuyer.address).current.size, 0, 'another folder is untouched')
    } finally {
      await again.close()
    }
    await assert.rejects(rebuild(dir), /is not a folder file in this host's layout/)
    assert.deepEqual([shapeOf(aliceFile), shapeOf(bobFile)], [[3, ['blobs', 'messages', 'records']], [4, ['entries', 'extra', 'inbox']]])
  })

  test('its own read answers 500 and logs one line: the path and the error, its address taken out', async () => {
    const dir = scratch()
    let h = await startPlug({ dir, now: () => T0 })
    await write([h.url], [entry(alice, 'profile', aliceProfile, T0)])
    await h.close()
    toRecordsLayout(join(dir, 'folders', `${alice.address}.sqlite`))
    h = await startPlug({ dir, now: () => T0 })
    const logged = mock.method(console, 'error', () => {})
    try {
      const one = await fetch(`${h.url}/v1/entries/read`, { method: 'POST', body: JSON.stringify({ profile: alice.address }) })
      assert.deepEqual([one.status, await one.text()], [500, ''])
      const why = `${join(dir, 'folders', '<address>.sqlite')} is not a folder file in this host's layout`
      assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [[`500 /v1/entries/read: ${why}`]])
    } finally {
      logged.mock.restore()
      await h.close()
    }
  })

  test('the feed and the prune skip it among good folders, each logging one line, and go on with the rest', async () => {
    const dir = scratch()
    const clock = new Clock(T0)
    let h = await startPlug({ dir, now: clock.now })
    const keys = [alice, bob, aliceBuyer]
    // Each folder's offer is replaced once, so each good folder has an entry the prune deletes.
    await write([h.url], keys.flatMap((key) => [entry(key, 'profile', profileBody('calculus'), T0), entry(key, 'post/a', offerBody('1'), T0)]))
    await write([h.url], keys.map((key) => entry(key, 'post/a', offerBody('2'), T0 + MINUTE)))
    const ids = async (profile?: string) => (await readPage(h.url, { after: 0, ...(profile && { profile }) })).entries.map((c) => c.id)
    const bobs = new Set(await ids(bob.address))
    const good = (await ids()).filter((id) => !bobs.has(id))
    await h.close()
    const bobFile = join(dir, 'folders', `${bob.address}.sqlite`)
    toRecordsLayout(bobFile)
    h = await startPlug({ dir, now: clock.now })
    const logged = mock.method(console, 'error', () => {})
    const skipped = [`folder skipped: ${join(dir, 'folders', '<address>.sqlite')} is not a folder file in this host's layout`]
    try {
      // One read of the feed: 200, every good folder's entries, and one line for Bob's three.
      const feed = await fetch(`${h.url}/v1/entries?after=0`)
      assert.equal(feed.status, 200)
      assert.equal((await feed.text()).split('\n').filter(Boolean).length, good.length)
      assert.deepEqual(await ids(), good)
      assert.deepEqual(logged.mock.calls.map((c) => c.arguments), [skipped, skipped])
      // The prune: Alice's and her buyer's replaced offers go, whichever side of Bob's file each is on.
      clock.advance(31 * DAY)
      assert.equal(await h.prune(), 2)
      assert.equal(logged.mock.calls.length, 3)
      assert.deepEqual(logged.mock.calls[2]!.arguments, skipped)
      assert.equal((await ids()).length, good.length - 2)
    } finally {
      logged.mock.restore()
      await h.close()
    }
    // Bob's file is left as it was, and so is what host.sqlite says of it.
    assert.deepEqual(shapeOf(bobFile), [3, ['blobs', 'messages', 'records']])
    assert.equal(query<{ n: number }>(join(dir, 'host.sqlite'), `SELECT COUNT(*) AS n FROM log WHERE folder = '${bob.address}'`)[0]!.n, 3)
  })
})

describe('the S3 driver', () => {
  const credentials = { accessKeyId: 'FORESTTESTKEY', secretAccessKey: 'forest-test-secret' }

  /**
   * A local S3 stand-in, path-style: it checks each request's SigV4 signature and payload hash, or
   * a link's, signed in its query, keeps objects in memory with their content-type, and lists one
   * key a page.
   */
  async function s3Stub() {
    const objects = new Map<string, { type: string; bytes: Uint8Array }>()
    const server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const url = new URL(req.url!, `http://${req.headers.host}`)
      if (url.searchParams.has('X-Amz-Signature')) {
        // A link: the same link signed again, from its own date and seconds, gives its signature.
        const bare = new URL(url)
        for (const name of [...url.searchParams.keys()]) if (name.startsWith('X-Amz-')) bare.searchParams.delete(name)
        const again = presignS3({ url: bare, amzDate: url.searchParams.get('X-Amz-Date')!, seconds: Number(url.searchParams.get('X-Amz-Expires')) }, credentials)
        const held = objects.get(url.pathname.split('/')[2]!)
        if (req.method !== 'GET' || again.href !== url.href) return void res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
        if (!held) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
        return void res.writeHead(200, { 'content-type': held.type, 'content-length': held.bytes.length }).end(held.bytes)
      }
      const auth = req.headers.authorization ?? ''
      const signed = (/SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? '').split(';').filter((n) => !['host', 'x-amz-content-sha256', 'x-amz-date'].includes(n))
      const payloadHash = String(req.headers['x-amz-content-sha256'])
      const expected = signS3({ method: req.method!, url, headers: Object.fromEntries(signed.map((n) => [n, String(req.headers[n])])), payloadHash, amzDate: String(req.headers['x-amz-date']) }, credentials).authorization
      if (auth !== expected || payloadHash !== sha256Hex(body)) return void res.writeHead(403).end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
      const [, bucket, key] = url.pathname.split('/')
      if (bucket !== 'forest') return void res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>')
      if (!key && req.method === 'GET') {
        const keys = [...objects.keys()].sort()
        const at = Number(url.searchParams.get('continuation-token') ?? 0)
        const more = at + 1 < keys.length
        const page = keys.slice(at, at + 1).map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')
        return void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page}${more ? `<NextContinuationToken>${at + 1}</NextContinuationToken>` : ''}</ListBucketResult>`)
      }
      const held = objects.get(key!)
      if (req.method === 'PUT') {
        objects.set(key!, { type: String(req.headers['content-type']), bytes: new Uint8Array(body) })
        return void res.writeHead(200).end()
      }
      if (req.method === 'DELETE') {
        objects.delete(key!)
        return void res.writeHead(204).end()
      }
      if (!held) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
      res.writeHead(200, { 'content-type': held.type, 'content-length': held.bytes.length }).end(req.method === 'HEAD' ? undefined : held.bytes)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { objects, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => server.close(resolve)) }
  }

  test('files go to a bucket: put, get, 404; out of it keep days after no entry names them; a rebuild lists them back', async () => {
    const stub = await s3Stub()
    const dir = scratch()
    const clock = new Clock(T0)
    const driver: FileDriver = { kind: 's3', endpoint: stub.url, bucket: 'forest', ...credentials }
    const options = { dir, now: clock.now, files: driver }
    let h = await startPlug(options)
    try {
      await write([h.url], [entry(alice, 'profile', aliceProfile, T0), photoOffer, entry(alice, 'post/a', withClip('1'), T0)])
      assert.deepEqual(await putBoth(h.url), [true, true])
      assert.deepEqual([...stub.objects].map(([k, o]) => [k, o.type]).sort(), [[sha256Hex(photo), 'image/jpeg'], [sha256Hex(clip), 'video/mp4']].sort())
      assert.ok(!existsSync(join(dir, 'files')), 'nothing on disk')
      // A read is a redirect to a short-lived link straight from the bucket, which serves the bytes.
      const read = await fetch(`${h.url}/v1/files/${sha256Hex(clip)}`, { redirect: 'manual' })
      const link = new URL(read.headers.get('location') ?? '')
      assert.deepEqual([read.status, read.headers.get('cache-control'), link.origin, link.searchParams.get('X-Amz-Expires')], [302, 'no-store', stub.url, String(LINK_SECONDS)])
      assert.deepEqual(await fetchFile([h.url], sha256Hex(clip)).then((g) => [g!.type, g!.bytes]), ['video/mp4', clip])
      assert.equal((await fetch(`${h.url}/v1/files/${sha256Hex(bytesOf(9))}`)).status, 404)

      // Alice takes the clip down: keep days later, it leaves the bucket. Named again, it comes back.
      await write([h.url], [entry(alice, 'post/a', null, T0 + 1)])
      await h.prune(clock.t + 31 * DAY)
      assert.deepEqual([...stub.objects.keys()], [sha256Hex(photo)])
      await write([h.url], [entry(bob, 'post/b', withClip('2'), T0)])
      assert.ok((await upload([h.url], clip, 'video/mp4'))[0]!.ok)
    } finally {
      await h.close()
    }

    rmSync(join(dir, 'host.sqlite'))
    await rebuild(dir, driver)
    h = await startPlug(options)
    try {
      assert.deepEqual(await fetchFile([h.url], sha256Hex(clip)).then((g) => [g!.type, g!.bytes]), ['video/mp4', clip], 'listed back, page by page')
      assert.deepEqual((await upload([h.url], photo, 'image/jpeg'))[0]!.message, 'already here')
      assert.deepEqual((await upload([h.url], clip, 'video/mp4'))[0]!.message, 'already here')
    } finally {
      await h.close()
    }

    // The stub checks signatures: a wrong secret is refused, and the host answers 500.
    const wrong = await startPlug({ now: () => T0, files: { ...driver, secretAccessKey: 'wrong' } })
    const logged = mock.method(console, 'error', () => {})
    try {
      await write([wrong.url], [photoOffer])
      assert.equal((await upload([wrong.url], photo, 'image/jpeg'))[0]!.status, 500)
    } finally {
      logged.mock.restore()
      await wrong.close()
      await stub.close()
    }
  })

  test('path-style by default, virtual-hosted on request; signed, and a link presigned, as AWS’s own examples are', () => {
    const endpoint = 'https://s3.amazonaws.com'
    assert.equal(s3Url({ endpoint, bucket: 'examplebucket' }, 'test.txt').href, 'https://s3.amazonaws.com/examplebucket/test.txt')
    const url = (key: string) => s3Url({ endpoint, bucket: 'examplebucket', style: 'virtual' }, key)
    assert.equal(url('test.txt').href, 'https://examplebucket.s3.amazonaws.com/test.txt')

    // AWS's Signature Version 4 examples for S3: GET an object, PUT one, list a bucket.
    const aws = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }
    const empty = sha256Hex('')
    const signature = (method: string, u: URL, headers: Record<string, string>, payloadHash: string) => /Signature=([0-9a-f]+)/.exec(signS3({ method, url: u, headers, payloadHash, amzDate: '20130524T000000Z' }, aws).authorization!)![1]
    assert.equal(signature('GET', url('test.txt'), { range: 'bytes=0-9' }, empty), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    assert.equal(signature('PUT', url('test$file.text'), { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, sha256Hex('Welcome to Amazon S3.')), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
    const list = url('')
    list.searchParams.set('max-keys', '2')
    list.searchParams.set('prefix', 'J')
    assert.equal(signature('GET', list, {}, empty), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
    // And its presigned URL example: an object for 86,400 seconds, the payload unsigned.
    const link = presignS3({ url: url('test.txt'), amzDate: '20130524T000000Z', seconds: 86_400 }, aws)
    assert.equal(link.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
    assert.equal(link.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request')
  })
})
