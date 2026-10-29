// The inbox on the plug, in the order the standard's plug checks an inbox entry: its text and shape,
// a duplicate, an inbox here, then its own choice; the sizes and batches it chooses; and listing to
// anyone.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Body, type InboxEntry, type Writer, canonical, encodeInbox, entry, inboxId, leave, readInbox, write } from '@foundationforest/folders'
import { inboxEntry, openInbox } from '@foundationforest/folders/locked'
import { DEFAULT_MAX_LINE_BYTES, type Host, type HostOptions } from '../src/plug.ts'
import { T0, alice, aliceBuyer, aliceOpening, aliceWith, bob, profileBody, stranger } from './fixtures.ts'
import { startPlug } from './helpers.ts'

/** Alice's profile entry: her open key, and `helper` listed with read-inbox. */
const ALICE = aliceWith(['read-inbox'])

/** A host, at T0, holding Alice's profile entry. */
async function hostWith(body: Body | null = ALICE, options: HostOptions = {}): Promise<Host> {
  const h = await startPlug({ now: () => T0, ...options })
  await write([h.url], [entry(alice, 'profile', body, T0)])
  return h
}
/** An inbox entry from `from` to Alice, locked to the keys her profile entry gives. */
const letter = (from: Writer = bob, text = 'Is Tuesday at six free?', time = T0) => inboxEntry(from, alice.address, { text }, time, ALICE)
const errors = async (h: Host, entries: InboxEntry[]) => (await leave([h.url], entries))[0]!.results.map((r) => r.error ?? 'ok')

describe('leaving', () => {
  test('a host checks an inbox entry in order: text, shape, version, address, duplicate, an inbox here', async () => {
    const h = await hostWith()
    try {
      const e = await letter()
      const results = await h.leave([
        'not json',
        canonical({ ...e, from: bob.address }),
        canonical({ ...e, v: 2 }),
        canonical({ ...e, to: 'x' }),
        canonical({ ...e, private: e.private + '!' }),
        encodeInbox(e),
        encodeInbox(e),
        encodeInbox({ ...e, to: bob.address }),
        encodeInbox({ ...e, to: aliceBuyer.address }),
      ])
      assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['canonical', 'shape', 'version', 'key', 'shape', 'ok', 'duplicate', 'no_inbox', 'no_inbox'])
      assert.deepEqual(await errors(h, [e]), ['duplicate'], 'in a later request too')
      // The host checks no signature: the sender is locked inside, for the keys it was locked to.
      const { message } = await openInbox(e, aliceOpening.identity)
      assert.deepEqual([message.from, message.body], [bob.address, { text: 'Is Tuesday at six free?' }])
    } finally {
      await h.close()
    }
  })

  test('size is the host’s own choice, checked first: 65,536 bytes here unless its operator says otherwise', async () => {
    const big = await letter(bob, 'x'.repeat(DEFAULT_MAX_LINE_BYTES))
    assert.ok(encodeInbox(big).length > DEFAULT_MAX_LINE_BYTES)
    for (const [options, want] of [[{}, 'size'], [{ maxLineBytes: 200_000 }, 'ok']] as const) {
      const h = await hostWith(ALICE, options)
      try {
        assert.deepEqual(await errors(h, [big]), [want])
      } finally {
        await h.close()
      }
    }
  })

  test('no openKey, no inbox: a profile entry without one, none, a deleted one, and one on another host', async () => {
    const e = await letter()
    for (const body of [profileBody('maths'), null]) {
      const h = await hostWith(body)
      try {
        assert.deepEqual(await errors(h, [e]), ['no_inbox'], JSON.stringify(body))
      } finally {
        await h.close()
      }
    }
    const here = await hostWith(ALICE)
    const elsewhere = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual(await errors(elsewhere, [e]), ['no_inbox'], 'a host that holds no profile entry of the folder')
      assert.deepEqual(await errors(here, [e]), ['ok'])
    } finally {
      await here.close()
      await elsewhere.close()
    }
  })

  test('a host’s own choice comes last, and sees what it holds in the inbox the entry is for', async () => {
    const seen: number[] = []
    const h = await hostWith(ALICE, {
      inboxChoice: (_e, stored) => {
        seen.push(stored.entries)
        return stored.entries < 2 ? null : 'two inbox entries a folder here'
      },
    })
    try {
      const e = await letter(bob)
      assert.deepEqual(await errors(h, [e, e, await letter(aliceBuyer), await letter(stranger)]), ['ok', 'duplicate', 'ok', 'refused'])
      assert.deepEqual(seen, [0, 1, 2], 'never asked about a duplicate')
    } finally {
      await h.close()
    }
  })

  test('a host chooses its batch: 100 here unless told otherwise; a client sends a bigger request in halves', async () => {
    const h = await hostWith(ALICE, { maxBatch: 2 })
    const plain = await hostWith(ALICE)
    try {
      const five = await Promise.all([1, 2, 3, 4, 5].map((i) => letter(bob, `letter ${i}`)))
      assert.deepEqual(await h.leave(five.map(encodeInbox)), [{ i: 0, ok: false, error: 'batch', message: 'at most 2 lines a request' }])
      const [outcome] = await leave([h.url], five)
      assert.deepEqual(outcome!.results.map((r) => [r.i, r.error ?? 'ok']), five.map((_, i) => [i, 'ok']))
      assert.equal((await plain.leave(Array(101).fill('x')))[0]!.error, 'batch')
    } finally {
      await h.close()
      await plain.close()
    }
  })
})

describe('listing', () => {
  test('anyone lists a folder’s inbox after a cursor, in arrival order; another folder’s lists none of it', async () => {
    const h = await hostWith()
    try {
      const [one, two, three] = await Promise.all(['one', 'two', 'three'].map((text) => letter(bob, text)))
      await leave([h.url], [one!, two!])
      const page = await readInbox(h.url, alice.address)
      assert.deepEqual(page.entries.map((e) => e.id), [inboxId(one!), inboxId(two!)])
      await leave([h.url], [three!])
      assert.deepEqual((await readInbox(h.url, alice.address, { after: page.cursor })).entries.map((e) => e.id), [inboxId(three!)])
      assert.equal((await readInbox(h.url, bob.address)).entries.length, 0)
      assert.equal((await readInbox(h.url, 'x')).entries.length, 0, 'a folder that is no address has none')
    } finally {
      await h.close()
    }
  })
})
