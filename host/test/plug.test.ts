// The plug's own choices over HTTP, as they came from the standard's reference host's tests (at
// 7b1c937): what it keeps and for how long, how it answers the socket, what it refuses, and the
// sizes, batches and pages it chooses; and a host's own choice for records, which may make joining
// cost but never leaving. What every host must do is the standard's host check (check.test.ts).

import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { describe, test } from 'node:test'
import { serviceKey } from '@foundationforest/keys'
import { type SignedRecord, encodeRecord, hostsRecord, nextTime, ownerRecord, publish, readAll, readPage, readProfile, signAs, signingInput } from '@foundationforest/records'
import { DAY, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_PAGE_BYTES, type Host, type RecordChoice } from '../src/plug.ts'
import { MINUTE, T0, alice, bob, offerBody, profileBody, sizedRecord, stranger } from './fixtures.ts'
import { Clock, startPlug } from './helpers.ts'

const errors = async (host: Host, records: SignedRecord[]) => (await publish([host.url], records))[0]!.results.map((r) => r.error ?? 'ok')

describe('keep days are the host’s', () => {
  test('what an update or a delete replaced goes after keep days, 30 unless told otherwise; a delete stays', async () => {
    const clock = new Clock(T0)
    const h = await startPlug({ now: clock.now })
    try {
      await publish([h.url], [hostsRecord(alice, [h.url], T0), ownerRecord(alice, 'profile', profileBody('calculus'), T0), ownerRecord(alice, 'offer/maths', offerBody('30'), T0)])
      clock.advance(MINUTE)
      const known = await readProfile([h.url], alice.address, clock.t)
      await publish([h.url], [ownerRecord(alice, 'offer/maths', offerBody('35'), nextTime(clock.t, known, 'offer/maths')), ownerRecord(alice, 'profile', null, nextTime(clock.t, known, 'profile'))])
      const was = h.count(alice.address)
      assert.equal(await h.prune(clock.t + 29 * DAY), 0)
      assert.equal(await h.prune(clock.t + 31 * DAY), 2, 'the replaced offer and the replaced profile record')
      assert.equal(h.count(alice.address), was - 2)
      // A delete is current: it is never pruned, so the profile record stays deleted.
      assert.ok((await readAll(h.url, { profile: alice.address })).records.some((c) => c.record.path === 'profile' && c.record.body === null))
    } finally {
      await h.close()
    }
  })

  test('a host with keep days 0 forgets a replaced version at its next prune', async () => {
    const h = await startPlug({ now: () => T0, keepDays: 0 })
    try {
      await publish([h.url], [ownerRecord(alice, 'offer/a', offerBody('1'), T0), ownerRecord(alice, 'offer/a', offerBody('2'), T0 + 1)])
      assert.equal(await h.prune(T0), 1)
      assert.deepEqual((await readAll(h.url)).records.map((c) => c.record.time), [T0 + 1])
    } finally {
      await h.close()
    }
  })
})

describe('the socket', () => {
  test('numbers come from the clock, in microseconds: the second record taken at T0 is T0 × 1000 + 1', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      await publish([h.url], [hostsRecord(alice, [h.url], T0), ownerRecord(alice, 'profile', profileBody('calculus'), T0)])
      await publish([h.url], [hostsRecord(bob, [h.url], T0), ownerRecord(bob, 'profile', profileBody('chemistry'), T0)])
      await publish([h.url], [ownerRecord(alice, 'offer/a', offerBody('1'), T0)])
      const second = T0 * 1000 + 1
      const since = await readPage(h.url, { after: second })
      assert.deepEqual(since.records.map((c) => c.record.path), ['hosts', 'profile', 'offer/a'])
      assert.deepEqual((await readPage(h.url, { after: second, profile: alice.address })).records.map((c) => c.record.path), ['offer/a'])
    } finally {
      await h.close()
    }
  })

  test('POST /v1/records/read takes { profile?, after? } and nothing else, in a small body; its GET form is /v1/records', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const posted = async (body: string) => (await fetch(`${h.url}/v1/records/read`, { method: 'POST', body })).status
      for (const bad of ['', 'nope', '[]', '{"after":-1}', '{"after":1.5}', '{"after":"1"}', '{"profile":5}', '{"more":1}']) assert.equal(await posted(bad), 400, bad)
      assert.equal(await posted(JSON.stringify({ profile: 'x'.repeat(2000) })), 413)
      assert.equal((await fetch(`${h.url}/v1/records/read`)).status, 405, 'the GET form is /v1/records')
    } finally {
      await h.close()
    }
  })

  test('only /v1/records, only GET and POST, and a cursor is a whole number', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.equal((await fetch(`${h.url}/v1/entries`)).status, 404)
      assert.equal((await fetch(`${h.url}/v1/records`, { method: 'PUT' })).status, 405)
      for (const after of ['-1', '1.5', 'x']) assert.equal((await fetch(`${h.url}/v1/records?after=${after}`)).status, 400, after)
      const many = Array.from({ length: 101 }, (_, i) => encodeRecord(ownerRecord(alice, `offer/${i}`, offerBody('1'), T0)))
      assert.deepEqual(await h.accept(many), [{ i: 0, ok: false, error: 'batch', message: 'at most 100 records a request' }])
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
      assert.equal((await fetch(`${h.url}/v1/records`)).status, 200)
    } finally {
      await h.close()
    }
  })

  test('a host is open: it takes a profile whose hosts record does not name it, or that has none', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual(await errors(h, [hostsRecord(alice, ['https://elsewhere.example'], T0), ownerRecord(alice, 'profile', profileBody('maths'), T0), ownerRecord(bob, 'profile', profileBody('physics'), T0)]), ['ok', 'ok', 'ok'])
    } finally {
      await h.close()
    }
  })

  test('a host refuses what does not check: forged, signed by a key that is not the main key, dated ahead, not canonical', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const good = ownerRecord(alice, 'offer/a', offerBody('1'), T0)
      const unsigned = { v: 1 as const, profile: alice.address, path: 'offer/c', time: T0, body: offerBody('1') }
      const results = await h.accept([
        encodeRecord({ ...good, body: offerBody('2') }),
        encodeRecord({ ...unsigned, sig: signAs(stranger, stranger.address, signingInput(unsigned)) }),
        encodeRecord(ownerRecord(alice, 'offer/b', offerBody('1'), T0 + 11 * MINUTE)),
        JSON.stringify(good, null, 1),
        encodeRecord(good),
      ])
      assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['signature', 'signature', 'future', 'canonical', 'ok'])
    } finally {
      await h.close()
    }
  })

  test('a host drops a request still arriving after its timeout, with 408', async () => {
    const h = await startPlug({ now: () => T0, timeout: 200 })
    try {
      const { port } = new URL(h.url)
      const socket = connect(Number(port), '127.0.0.1')
      socket.write('POST /v1/records HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n{"v"')
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

  test('a page ends before 4 MB; a reader still gets every record, page by page', async () => {
    const h = await startPlug({ now: () => T0 })
    try {
      const full = Array.from({ length: 66 }, (_, i) => sizedRecord(alice, `stamp/${i}`, DEFAULT_MAX_LINE_BYTES))
      const [outcome] = await publish([h.url], full)
      assert.ok(outcome!.results.every((r) => r.ok), JSON.stringify(outcome!.results.filter((r) => !r.ok)))
      const first = h.read()
      assert.ok(bytes(first.lines) <= DEFAULT_MAX_PAGE_BYTES)
      assert.ok(bytes(first.lines) + DEFAULT_MAX_LINE_BYTES + 1 > DEFAULT_MAX_PAGE_BYTES, 'the next record would not have fit')
      assert.ok(first.lines.length < 66)
      assert.equal((await readAll(h.url)).records.length, 66)
    } finally {
      await h.close()
    }
  })

  test('a host chooses its batch: a client sends a request it finds too big again in halves, and every record lands', async () => {
    const h = await startPlug({ now: () => T0, maxBatch: 3 })
    try {
      const records = Array.from({ length: 10 }, (_, i) => ownerRecord(alice, `offer/${i}`, offerBody('1'), T0))
      assert.deepEqual(await h.accept(records.map(encodeRecord)), [{ i: 0, ok: false, error: 'batch', message: 'at most 3 records a request' }])
      const [outcome] = await publish([h.url], [ownerRecord(alice, 'offer/0', offerBody('1'), T0 - 1), ...records])
      assert.equal(outcome!.status, 200)
      assert.deepEqual(outcome!.results.map((r) => r.i), [...Array(11).keys()], 'each result at its place in the request')
      assert.deepEqual(outcome!.results.map((r) => r.error ?? 'ok'), ['ok', ...Array(10).fill('ok')])
      assert.equal(h.view(alice.address).current.size, 10, 'the newer offer/0 replaced the older')
    } finally {
      await h.close()
    }
  })

  test('a host chooses its page, by lines or bytes: a reader follows the cursor whatever the size, and a page always holds one record', async () => {
    for (const options of [{ maxPageRecords: 2 }, { maxPageBytes: 10 }]) {
      const h = await startPlug({ now: () => T0, ...options })
      try {
        await publish([h.url], Array.from({ length: 5 }, (_, i) => ownerRecord(alice, `offer/${i}`, offerBody('1'), T0)))
        assert.ok(h.read().lines.length <= 2 && h.read().lines.length >= 1, JSON.stringify(options))
        assert.equal((await readAll(h.url)).records.length, 5, JSON.stringify(options))
      } finally {
        await h.close()
      }
    }
  })

  test('size is a host’s own choice: records of up to 65,536 bytes in UTF-8, unless its operator says otherwise', async () => {
    const atCap = sizedRecord(alice, 'stamp/a', DEFAULT_MAX_LINE_BYTES)
    // One more byte, from one two-byte character: still 65,536 characters, now 65,537 bytes.
    const over = sizedRecord(alice, 'stamp/b', DEFAULT_MAX_LINE_BYTES + 1, 1)
    assert.deepEqual([encodeRecord(over).length, Buffer.byteLength(encodeRecord(over))], [DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES + 1])
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

/** One host's choice: at most three content records a profile. */
const threeEach: RecordChoice = (_record, stored) => (stored.records < 3 ? null : 'three records a profile here')

describe('host choice', () => {
  test('the plug sets no budget: a host that chooses nothing of its own takes 200 fresh keys', async () => {
    const host = await startPlug({ now: () => T0 })
    try {
      let taken = 0
      for (let i = 0; i < 200; i++) {
        const k = freshKey(i)
        const [outcome] = await publish([host.url], [ownerRecord(k, 'profile', profileBody(`bot ${i}`), T0)])
        if (outcome!.results.every((r) => r.ok)) taken++
      }
      assert.equal(taken, 200)
    } finally {
      await host.close()
    }
  })

  test('a host’s own choice refuses content; a newer hosts record always passes', async () => {
    const host = await startPlug({ now: () => T0, recordChoice: threeEach })
    try {
      const results = async (records: Parameters<typeof publish>[1]) => (await publish([host.url], records))[0]!.results.map((r) => r.error ?? 'ok')
      assert.deepEqual(await results([ownerRecord(alice, 'profile', profileBody('maths'), T0), ownerRecord(alice, 'offer/a', offerBody('1'), T0), ownerRecord(alice, 'offer/b', offerBody('1'), T0)]), ['ok', 'ok', 'ok'])
      assert.deepEqual(await results([ownerRecord(alice, 'offer/c', offerBody('1'), T0), ownerRecord(alice, 'permission/0123456789abcdef0123456789abcdef', offerBody('1'), T0)]), ['refused', 'refused'], 'a permission is content too')
      // The person can always move.
      assert.deepEqual(await results([hostsRecord(alice, ['https://elsewhere.example'], T0), hostsRecord(alice, ['https://other.example'], T0 + 1)]), ['ok', 'ok'])
    } finally {
      await host.close()
    }
  })

  test('joining can cost: a host’s own choice may refuse a folder’s first hosts record, and is never asked about a later one', async () => {
    const asked: string[] = []
    // One host's choice: a folder joins only once paid, which this example keeps as a list.
    const paid = new Set<string>()
    const choice: RecordChoice = (record, stored) => {
      asked.push(`${record.path} ${stored.records}`)
      return stored.records === 0 && !paid.has(record.profile) ? 'pay to join this host' : null
    }
    const host = await startPlug({ now: () => T0, recordChoice: choice })
    try {
      const results = async (records: Parameters<typeof publish>[1]) => (await publish([host.url], records))[0]!.results.map((r) => r.error ?? 'ok')
      assert.deepEqual(await results([hostsRecord(alice, [host.url], T0)]), ['refused'], 'not paid: the first hosts record is refused')
      assert.deepEqual(await results([ownerRecord(alice, 'profile', profileBody('maths'), T0)]), ['refused'], 'and so is content, by the same choice')
      paid.add(alice.address)
      assert.deepEqual(await results([hostsRecord(alice, [host.url], T0), ownerRecord(alice, 'profile', profileBody('maths'), T0)]), ['ok', 'ok'])
      paid.delete(alice.address)
      asked.length = 0
      assert.deepEqual(await results([hostsRecord(alice, ['https://elsewhere.example'], T0 + 1)]), ['ok'], 'a folder it holds can always leave')
      assert.deepEqual(asked, [], 'and the choice was not asked')
    } finally {
      await host.close()
    }
  })
})
