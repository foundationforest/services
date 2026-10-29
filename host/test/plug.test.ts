// The plug's own choices over HTTP: what it keeps and for how long, how it answers the socket, what
// it refuses, and the sizes, batches and pages it chooses; and a host's own choice for entries,
// which may make joining cost but never leaving. What every host must do is the standard's host
// check (check.test.ts).

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { describe, test } from 'node:test'
import { serviceKey } from '@foundationforest/keys'
import { type SignedEntry, canonical, encodeEntry, entry, nextTime, readAll, readFolder, readPage, signAs, signingInput, write } from '@foundationforest/folders'
import { DAY, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_PAGE_BYTES, type EntryChoice, type Host } from '../src/plug.ts'
import { MINUTE, T0, alice, aliceWith, bob, helper, offerBody, profileBody, sizedEntry, stranger } from './fixtures.ts'
import { Clock, startPlug } from './helpers.ts'

const errors = async (host: Host, entries: SignedEntry[]) => (await write([host.url], entries))[0]!.results.map((r) => r.error ?? 'ok')
/** Alice's access key, writing for her folder. */
const asHelper = { profile: alice.address, key: helper }

describe('keep days are the host’s', () => {
  test('what an update or a delete replaced goes after keep days, 30 unless told otherwise; a delete stays', async () => {
    const clock = new Clock(T0)
    const h = await startPlug({ now: clock.now })
    try {
      await write([h.url], [entry(alice, 'profile', profileBody('calculus'), T0), entry(alice, 'offer/maths', offerBody('30'), T0)])
      clock.advance(MINUTE)
      const known = await readFolder([h.url], alice.address, clock.t)
      await write([h.url], [entry(alice, 'offer/maths', offerBody('35'), nextTime(clock.t, known, 'offer/maths')), entry(alice, 'profile', null, nextTime(clock.t, known, 'profile'))])
      const was = h.count(alice.address)
      assert.equal(await h.prune(clock.t + 29 * DAY), 0)
      assert.equal(await h.prune(clock.t + 31 * DAY), 2, 'the replaced offer and the replaced profile entry')
      assert.equal(h.count(alice.address), was - 2)
      // A delete is current: it is never pruned, so the profile entry stays deleted.
      assert.ok((await readAll(h.url, { profile: alice.address })).entries.some((c) => c.entry.path === 'profile' && c.entry.body === null))
    } finally {
      await h.close()
    }
  })

  test('a host with keep days 0 forgets a replaced version at its next prune', async () => {
    const h = await startPlug({ now: () => T0, keepDays: 0 })
    try {
      await write([h.url], [entry(alice, 'offer/a', offerBody('1'), T0), entry(alice, 'offer/a', offerBody('2'), T0 + 1)])
      assert.equal(await h.prune(T0), 1)
      assert.deepEqual((await readAll(h.url)).entries.map((c) => c.entry.time), [T0 + 1])
    } finally {
      await h.close()
    }
  })

  test('an access key’s entry stops counting once its key is removed, and goes keep days later; listed again before then, it counts again', async () => {
    const clock = new Clock(T0)
    const h = await startPlug({ now: clock.now })
    try {
      const older = entry(alice, 'offer/a', offerBody('by the main key'), T0)
      const byKey = entry(asHelper, 'offer/a', offerBody('by the access key'), T0 + 1)
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith(['write']), T0), older, byKey]), ['ok', 'ok', 'ok'])
      const at = () => h.view(alice.address).current.get('offer/a')!.entry.body
      assert.deepEqual(at(), offerBody('by the access key'))
      // Removed: the main key's older entry is current again.
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith(['read-inbox']), T0 + 2)]), ['ok'])
      assert.deepEqual(at(), offerBody('by the main key'))
      clock.advance(10 * DAY)
      // Listed again within keep days: it counts again, and is current.
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith(['write']), T0 + 3)]), ['ok'])
      assert.deepEqual(at(), offerBody('by the access key'))
      assert.equal(await h.prune(clock.t + 31 * DAY), 3, 'the two replaced profile entries and the main key’s offer')
      // Removed again: 30 days later, its entry is gone, and the main key’s with it: nothing stands at the path.
      clock.advance(MINUTE)
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith([]), T0 + 4)]), ['ok'])
      assert.equal(await h.prune(clock.t + 31 * DAY), 2, 'the replaced profile entry and the key’s offer')
      assert.equal(h.view(alice.address).current.get('offer/a'), undefined)
    } finally {
      await h.close()
    }
  })
})

describe('the socket', () => {
  test('numbers come from the clock, in microseconds: the second entry taken at T0 is T0 × 1000 + 1', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      await write([h.url], [entry(alice, 'profile', profileBody('calculus'), T0)])
      await write([h.url], [entry(bob, 'profile', profileBody('chemistry'), T0)])
      await write([h.url], [entry(alice, 'offer/a', offerBody('1'), T0)])
      const first = T0 * 1000
      const since = await readPage(h.url, { after: first })
      assert.deepEqual(since.entries.map((c) => [c.entry.profile, c.entry.path]), [[bob.address, 'profile'], [alice.address, 'offer/a']])
      assert.deepEqual((await readPage(h.url, { after: first, profile: alice.address })).entries.map((c) => c.entry.path), ['offer/a'])
    } finally {
      await h.close()
    }
  })

  test('a folder is read by POST, { profile, after? } and nothing else, in a small body; GET /v1/entries takes after and nothing else', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      for (const path of ['/v1/entries/read', '/v1/inbox/read']) {
        const field = path === '/v1/entries/read' ? 'profile' : 'to'
        const posted = async (body: string) => (await fetch(`${h.url}${path}`, { method: 'POST', body })).status
        const bad = ['', 'nope', '[]', '{}', '{"after":0}', `{"${field}":"x","after":-1}`, `{"${field}":"x","after":1.5}`, `{"${field}":"x","after":"1"}`, `{"${field}":5}`, `{"${field}":"x","more":1}`]
        for (const body of bad) assert.equal(await posted(body), 400, `${path} ${body}`)
        assert.equal(await posted(JSON.stringify({ [field]: alice.address })), 200)
        assert.equal(await posted(JSON.stringify({ [field]: 'x'.repeat(2000) })), 413)
        assert.equal((await fetch(`${h.url}${path}`)).status, 405)
      }
      for (const query of ['profile=x', `profile=${alice.address}`, 'after=1&after=2', 'after=1&profile=x']) assert.equal((await fetch(`${h.url}/v1/entries?${query}`)).status, 400, query)
      assert.equal((await fetch(`${h.url}/v1/entries?after=0`)).status, 200)
    } finally {
      await h.close()
    }
  })

  test('only the seven requests, each by its method, and a cursor is a whole number', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const hash = '0'.repeat(64)
      for (const path of ['/v1/records', '/v1/inbox/pull', '/v1/inbox/delete', `/v1/blobs/${hash}`, `/v1/files/${hash.toUpperCase()}`, '/v2/entries']) assert.equal((await fetch(`${h.url}${path}`)).status, 404, path)
      for (const [method, path] of [['PUT', '/v1/entries'], ['GET', '/v1/inbox'], ['DELETE', `/v1/files/${hash}`], ['POST', `/v1/files/${hash}`]]) {
        assert.equal((await fetch(`${h.url}${path}`, { method })).status, 405, `${method} ${path}`)
      }
      for (const after of ['-1', '1.5', 'x']) assert.equal((await fetch(`${h.url}/v1/entries?after=${after}`)).status, 400, after)
      const many = Array.from({ length: 101 }, (_, i) => encodeEntry(entry(alice, `offer/${i}`, offerBody('1'), T0)))
      assert.deepEqual(await h.accept(many), [{ i: 0, ok: false, error: 'batch', message: 'at most 100 lines a request' }])
    } finally {
      await h.close()
    }
  })

  test('a request target that is no path, such as //, is answered 400, and the host goes on', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const { port } = new URL(h.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write('GET // HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n')
      const answer = await new Promise<string>((resolve) => {
        let got = ''
        socket.on('data', (d) => (got += d))
        socket.on('close', () => resolve(got))
      })
      assert.match(answer, /^HTTP\/1\.1 400/)
      assert.equal((await fetch(`${h.url}/v1/entries`)).status, 200)
    } finally {
      await h.close()
    }
  })

  test('a host is open: it takes a profile entry that names other hosts, and entries for a folder with no profile entry here', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual(await errors(h, [entry(alice, 'profile', { ...profileBody('maths'), hosts: ['https://elsewhere.example'] }, T0), entry(bob, 'offer/a', offerBody('1'), T0)]), ['ok', 'ok'])
    } finally {
      await h.close()
    }
  })

  test('a host refuses what does not check: forged, signed by a key that is not the main key, by a key not listed, a profile entry by an access key, dated ahead, not canonical', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const good = entry(alice, 'offer/a', offerBody('1'), T0)
      const unsigned = { v: 1 as const, profile: alice.address, path: 'offer/c', time: T0, body: offerBody('1') }
      const byHelper = { v: 1 as const, profile: alice.address, path: 'profile', time: T0, body: profileBody('maths'), key: helper.address }
      const results = await h.accept([
        encodeEntry({ ...good, body: offerBody('2') }),
        encodeEntry({ ...unsigned, sig: signAs(stranger, stranger.address, signingInput(unsigned)) }),
        encodeEntry(entry({ profile: alice.address, key: stranger }, 'offer/d', offerBody('1'), T0)),
        canonical({ ...byHelper, sig: signAs(helper, helper.address, signingInput(byHelper)) }),
        encodeEntry(entry(alice, 'offer/b', offerBody('1'), T0 + 11 * MINUTE)),
        JSON.stringify(good, null, 1),
        encodeEntry(good),
      ])
      assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['signature', 'signature', 'unlisted', 'unlisted', 'future', 'canonical', 'ok'])
    } finally {
      await h.close()
    }
  })

  test('an access key writes any path but profile while the profile entry here lists it with write, and nothing once it does not', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith(['read', 'read-inbox', 'message']), T0), entry(asHelper, 'offer/a', offerBody('1'), T0)]), ['ok', 'unlisted'])
      assert.deepEqual(await errors(h, [entry(alice, 'profile', aliceWith(['write']), T0 + 1), entry(asHelper, 'offer/a', offerBody('1'), T0 + 1), entry(asHelper, 'photo/1', offerBody('1'), T0 + 1)]), ['ok', 'ok', 'ok'])
      assert.deepEqual(await errors(h, [entry(asHelper, 'offer/b', offerBody('1'), T0 + 2)]), ['ok'])
      assert.deepEqual(await errors(h, [entry(alice, 'profile', profileBody('maths'), T0 + 3), entry(asHelper, 'offer/c', offerBody('1'), T0 + 3)]), ['ok', 'unlisted'])
      assert.deepEqual(await errors(h, [entry(asHelper, 'offer/a', offerBody('1'), T0 + 4)].map((e) => ({ ...e, profile: bob.address }))), ['signature'], 'a key listed for one folder signs for none other')
    } finally {
      await h.close()
    }
  })

  test('a host drops a request still arriving after its timeout, with 408', async () => {
    const h = await startPlug({ now: () => T0, timeout: 200 })
    try {
      const { port } = new URL(h.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write('POST /v1/entries HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{"v"')
      const answer = await new Promise<string>((resolve) => {
        let got = ''
        socket.on('data', (d) => (got += d))
        socket.on('close', () => resolve(got))
      })
      assert.match(answer, /^HTTP\/1\.1 408/)
    } finally {
      await h.close()
    }
  })
})

describe('limits: each host’s own size, batch and page', () => {
  const bytes = (lines: string[]) => lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)

  test('a page ends before 4 MB; a reader still gets every entry, page by page', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const full = Array.from({ length: 66 }, (_, i) => sizedEntry(alice, `big/${i}`, DEFAULT_MAX_LINE_BYTES))
      const [outcome] = await write([h.url], full)
      assert.ok(outcome!.results.every((r) => r.ok), JSON.stringify(outcome!.results.filter((r) => !r.ok)))
      const first = h.read()
      assert.ok(bytes(first.lines) <= DEFAULT_MAX_PAGE_BYTES)
      assert.ok(bytes(first.lines) + DEFAULT_MAX_LINE_BYTES + 1 > DEFAULT_MAX_PAGE_BYTES, 'the next entry would not have fit')
      assert.ok(first.lines.length < 66)
      assert.equal((await readAll(h.url)).entries.length, 66)
    } finally {
      await h.close()
    }
  })

  test('a host chooses its batch: a client sends a request it finds too big again in halves, and every entry lands', async () => {
    const h = await startPlug({ now: () => T0, maxBatch: 3 })
    try {
      const entries = Array.from({ length: 10 }, (_, i) => entry(alice, `offer/${i}`, offerBody('1'), T0))
      assert.deepEqual(await h.accept(entries.map(encodeEntry)), [{ i: 0, ok: false, error: 'batch', message: 'at most 3 lines a request' }])
      const [outcome] = await write([h.url], [entry(alice, 'offer/0', offerBody('1'), T0 - 1), ...entries])
      assert.equal(outcome!.status, 200)
      assert.deepEqual(outcome!.results.map((r) => r.i), [...Array(11).keys()], 'each result at its place in the request')
      assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok', ...Array(10).fill('ok')])
      assert.equal(h.view(alice.address).current.size, 10, 'the newer offer/0 replaced the older')
    } finally {
      await h.close()
    }
  })

  test('a host chooses its page, by lines or bytes: a reader follows the cursor whatever the size, and a page always holds one entry', async () => {
    for (const options of [{ maxPageLines: 2 }, { maxPageBytes: 10 }]) {
      const h = await startPlug({ now: () => T0, ...options })
      try {
        await write([h.url], Array.from({ length: 5 }, (_, i) => entry(alice, `offer/${i}`, offerBody('1'), T0)))
        assert.ok(h.read().lines.length <= 2 && h.read().lines.length >= 1, JSON.stringify(options))
        assert.equal((await readAll(h.url)).entries.length, 5, JSON.stringify(options))
      } finally {
        await h.close()
      }
    }
  })

  test('size is a host’s own choice: entries of up to 65,536 bytes in UTF-8, unless its operator says otherwise', async () => {
    const atCap = sizedEntry(alice, 'big/a', DEFAULT_MAX_LINE_BYTES)
    // One more byte, from one two-byte character: still 65,536 characters, now 65,537 bytes.
    const over = sizedEntry(alice, 'big/b', DEFAULT_MAX_LINE_BYTES + 1, 1)
    assert.deepEqual([encodeEntry(over).length, Buffer.byteLength(encodeEntry(over))], [DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES + 1])
    const h = await startPlug({ now: () => T0 })
    const roomy = await startPlug({ now: () => T0, maxLineBytes: 200_000 })
    try {
      assert.deepEqual(await errors(h, [atCap, over]), ['ok', 'size'])
      assert.deepEqual(await errors(roomy, [over]), ['ok'])
    } finally {
      await h.close()
      await roomy.close()
    }
  })
})

/** A fresh key from 32 bytes: a profile's, for all a host knows. */
const freshKey = (i: number) => serviceKey(new Uint8Array(32).map((_, j) => (i * 31 + j * 7 + 1) & 255))

/** One host's choice: at most three entries a folder. */
const threeEach: EntryChoice = (_entry, stored) => (stored.entries < 3 ? null : 'three entries a folder here')

describe('host choice', () => {
  test('the plug sets no budget: a host that chooses nothing of its own takes 200 fresh keys', async () => {
    const host = await startPlug({ now: () => T0 })
    try {
      let taken = 0
      for (let i = 0; i < 200; i++) {
        const k = freshKey(i)
        const [outcome] = await write([host.url], [entry(k, 'profile', profileBody(`bot ${i}`), T0)])
        if (outcome!.results.every((r) => r.ok)) taken++
      }
      assert.equal(taken, 200)
    } finally {
      await host.close()
    }
  })

  test('a host’s own choice refuses entries; a newer profile entry for a folder it holds always passes', async () => {
    const host = await startPlug({ now: () => T0, entryChoice: threeEach })
    try {
      assert.deepEqual(await errors(host, [entry(alice, 'profile', profileBody('maths'), T0), entry(alice, 'offer/a', offerBody('1'), T0), entry(alice, 'offer/b', offerBody('1'), T0)]), ['ok', 'ok', 'ok'])
      assert.deepEqual(await errors(host, [entry(alice, 'offer/c', offerBody('1'), T0), entry(alice, 'key/0123456789abcdef0123456789abcdef', offerBody('1'), T0)]), ['refused', 'refused'], 'any path but profile')
      // The person can always move.
      assert.deepEqual(await errors(host, [entry(alice, 'profile', { ...profileBody('maths'), hosts: ['https://elsewhere.example'] }, T0 + 1), entry(alice, 'profile', { ...profileBody('maths'), hosts: ['https://other.example'] }, T0 + 2)]), ['ok', 'ok'])
    } finally {
      await host.close()
    }
  })

  test('joining can cost: a host’s own choice may refuse a folder’s first profile entry, and is never asked about a later one', async () => {
    const asked: string[] = []
    // One host's choice: a folder joins only once paid, which this example keeps as a list.
    const paid = new Set<string>()
    const choice: EntryChoice = (e, stored) => {
      asked.push(`${e.path} ${stored.entries}`)
      return stored.entries === 0 && !paid.has(e.profile) ? 'pay to join this host' : null
    }
    const host = await startPlug({ now: () => T0, entryChoice: choice })
    try {
      assert.deepEqual(await errors(host, [entry(alice, 'profile', profileBody('maths'), T0)]), ['refused'], 'not paid: the first profile entry is refused')
      assert.deepEqual(await errors(host, [entry(alice, 'offer/a', offerBody('1'), T0)]), ['refused'], 'and so is any other, by the same choice')
      paid.add(alice.address)
      assert.deepEqual(await errors(host, [entry(alice, 'profile', profileBody('maths'), T0), entry(alice, 'offer/a', offerBody('1'), T0)]), ['ok', 'ok'])
      paid.delete(alice.address)
      asked.length = 0
      assert.deepEqual(await errors(host, [entry(alice, 'profile', { ...profileBody('maths'), hosts: ['https://elsewhere.example'] }, T0 + 1), entry(alice, 'profile', null, T0 + 2)]), ['ok', 'ok'], 'a folder it holds can always leave')
      assert.deepEqual(asked, [], 'and the choice was not asked')
    } finally {
      await host.close()
    }
  })
})
