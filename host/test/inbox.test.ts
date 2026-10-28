// The inbox on the plug, as it came from the standard's reference host's tests (at 7b1c937), in the
// order the standard's plug now checks a delivery: its shape, the future, a duplicate, an inbox it
// can read, the signature, `maxBytes` for others, then its own choice; the sizes and batches it
// chooses; and each way to pull what is not yours.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inboxKey } from '@foundationforest/keys'
import { type Body, type Key, RecordError, type Sender, type SignedMessage, canonical, deliver, encodeMessage, ownerRecord, publish, pull, pullRequest, pullSigningInput, signAs, signMessage } from '@foundationforest/records'
import { makePrivate, message } from '@foundationforest/records/private'
import { DEFAULT_MAX_LINE_BYTES, type Host, type HostOptions } from '../src/plug.ts'
import { MINUTE, T0, alice, aliceBuyer, bob, profileBody, stranger } from './fixtures.ts'
import { startPlug } from './helpers.ts'

const aliceInbox = await inboxKey(alice.secret)

const profileWith = (inbox?: Body | string, subject = 'maths') => ({ ...profileBody(subject), inboxKey: aliceInbox.encryptTo, ...(inbox !== undefined && { inbox }) })
/** An inbox anyone may write to, of any size. */
const OPEN = {}

/** A host, at T0, holding Alice's profile record with this inbox. */
async function hostWith(inbox: Body | string | undefined, options: HostOptions = {}): Promise<Host> {
  const h = await startPlug({ now: () => T0, ...options })
  await publish([h.url], [profileRecord(inbox)])
  return h
}
/** Alice's profile record with this inbox. */
const profileRecord = (inbox: Body | string | undefined, time = T0) => ownerRecord(alice, 'profile', profileWith(inbox), time)
const stamp = (from: Sender = bob, text = 'Is Tuesday at six free?', time = T0) => message(from, alice.address, { text, createdAt: '2026-10-02T12:00:00Z' }, time, profileWith(OPEN))
const errors = async (h: Host, messages: SignedMessage[]) => (await deliver([h.url], messages))[0]!.results.map((r) => r.error ?? 'ok')
const pulled = async (h: Host, after = 0, time = T0, owner: Key = alice) => pull(h.url, pullRequest(owner, after, time))
const refusal = async (promise: Promise<unknown>) => promise.then(() => 'ok', (err: unknown) => (err instanceof RecordError ? err.code : String(err)))

describe('deliver', () => {
  test('a host checks a delivery in order: shape, future, duplicate, no inbox, signature', async () => {
    const h = await hostWith(OPEN)
    try {
      const m = await stamp()
      const forged = { ...(await stamp(stranger)), from: bob.address } // stranger signed, claims to be Bob
      const results = await h.deliver([
        'not json',
        canonical({ ...m, path: 'x' }),
        encodeMessage({ ...m, body: { private: m.body.private, text: 'x' } } as never),
        encodeMessage(await stamp(bob, 'later', T0 + 10 * MINUTE + 1)),
        encodeMessage(m),
        encodeMessage(m),
        encodeMessage({ ...m, to: bob.address }),
        encodeMessage(forged),
        encodeMessage({ ...m, time: T0 - 1 }),
      ])
      assert.deepEqual(results.map((r) => r.error ?? 'ok'), ['canonical', 'shape', 'body', 'future', 'ok', 'duplicate', 'no_inbox', 'signature', 'signature'])
      assert.deepEqual(await errors(h, [m]), ['duplicate'], 'in a later request too')
      // Cheap checks first: a forged message to a profile with no inbox is refused before its signature is checked.
      assert.deepEqual(await errors(h, [{ ...forged, to: aliceBuyer.address }]), ['no_inbox'])
    } finally {
      await h.close()
    }
  })

  test('size is the host’s own choice, checked first: 65,536 bytes here unless its operator says otherwise', async () => {
    const big = signMessage(bob, alice.address, { private: 'A'.repeat(DEFAULT_MAX_LINE_BYTES) }, T0)
    const h = await hostWith(OPEN)
    const roomy = await hostWith(OPEN, { maxLineBytes: 2 * DEFAULT_MAX_LINE_BYTES })
    try {
      assert.deepEqual(await errors(h, [big]), ['size'])
      assert.deepEqual(await h.deliver(['x'.repeat(DEFAULT_MAX_LINE_BYTES + 1)]).then((r) => r.map((x) => x.error)), ['size'], 'before its shape')
      assert.deepEqual(await errors(roomy, [big]), ['ok'])
    } finally {
      await h.close()
      await roomy.close()
    }
  })

  test('a message from the profile it is to skips maxBytes; an inbox the host cannot read, or none, stops it too', async () => {
    const toSelf = async (text: string) => signMessage(alice, alice.address, await makePrivate({ text }, [aliceInbox.encryptTo]), T0)
    const small = await hostWith({ maxBytes: 100 })
    try {
      assert.deepEqual(await errors(small, [await toSelf('From my phone'), await toSelf('From my laptop')]), ['ok', 'ok'])
      assert.deepEqual(await errors(small, [await stamp(bob)]), ['too_big'], 'anyone else still meets it')
    } finally {
      await small.close()
    }
    for (const inbox of [{ deposit: '5' }, undefined] as Array<Body | undefined>) {
      const h = await hostWith(inbox)
      try {
        assert.deepEqual(await errors(h, [await toSelf('hi')]), ['no_inbox'], JSON.stringify(inbox))
      } finally {
        await h.close()
      }
    }
  })

  test('no inbox field, no inbox: a profile record without one, none, a deleted one, and one on another host', async () => {
    const h = await hostWith(undefined)
    const other = await startPlug({ now: () => T0 })
    try {
      assert.deepEqual(await errors(h, [await stamp()]), ['no_inbox'])
      await publish([other.url], [profileRecord(OPEN, T0 + 1)])
      assert.deepEqual(await errors(h, [await stamp()]), ['no_inbox'], 'only the profile record on this host counts')
      await publish([h.url], [profileRecord(OPEN, T0 + 1)])
      assert.deepEqual(await errors(h, [await stamp()]), ['ok'])
      await publish([h.url], [ownerRecord(alice, 'profile', null, T0 + 2)])
      assert.deepEqual(await errors(h, [await stamp()]), ['no_inbox'], 'a deleted profile record')
      assert.deepEqual(await errors(h, [await message(bob, bob.address, { text: 'x' }, T0, profileWith(OPEN))]), ['no_inbox'], 'a profile this host has never seen')
    } finally {
      await h.close()
      await other.close()
    }
  })

  test('an inbox the host cannot read is refused as no_inbox, never taken as open to anyone', async () => {
    for (const inbox of [{ senders: 'anyone' }, { senders: { verifier: alice.address } }, { deposit: '5' }, { once: true }, { maxBytes: -1 }, 'anyone'] as Array<Body | string>) {
      const h = await hostWith(inbox)
      try {
        assert.deepEqual(await errors(h, [await stamp()]), ['no_inbox'], JSON.stringify(inbox))
      } finally {
        await h.close()
      }
    }
  })

  test('maxBytes counts the message’s canonical text, in bytes: too_big', async () => {
    const m = await stamp()
    const bytes = Buffer.byteLength(encodeMessage(m))
    for (const [maxBytes, result] of [[bytes, 'ok'], [bytes - 1, 'too_big']] as const) {
      const h = await hostWith({ maxBytes })
      try {
        assert.deepEqual(await errors(h, [m]), [result], String(maxBytes))
      } finally {
        await h.close()
      }
    }
  })

  test('a host’s own choice comes last, and sees what it holds for the profile it is to', async () => {
    const seen: number[] = []
    const h = await hostWith(OPEN, {
      messageChoice: (_m, stored) => {
        seen.push(stored.messages)
        return stored.messages < 2 ? null : 'two messages a profile here'
      },
    })
    try {
      const forged = { ...(await stamp(stranger)), from: bob.address }
      assert.deepEqual(await errors(h, [await stamp(bob), forged, await stamp(aliceBuyer), await stamp(stranger)]), ['ok', 'signature', 'ok', 'refused'])
      assert.deepEqual(seen, [0, 1, 2], 'never asked about a forged one')
    } finally {
      await h.close()
    }
  })

  test('a host chooses its batch: 100 here unless told otherwise; a client sends a bigger request in halves', async () => {
    const h = await hostWith(OPEN, { maxBatch: 2 })
    const plain = await hostWith(OPEN)
    try {
      const five = await Promise.all([1, 2, 3, 4, 5].map((i) => stamp(bob, `stamp ${i}`)))
      assert.deepEqual(await h.deliver(five.map(encodeMessage)), [{ i: 0, ok: false, error: 'batch', message: 'at most 2 messages a request' }])
      const [outcome] = await deliver([h.url], five)
      assert.deepEqual(outcome!.results.map((r) => [r.i, r.error ?? 'ok']), five.map((_, i) => [i, 'ok']))
      assert.equal((await plain.deliver(Array(101).fill('x')))[0]!.error, 'batch')
    } finally {
      await h.close()
      await plain.close()
    }
  })
})

describe('pulling', () => {
  test('only the main key pulls: another profile’s key, a key that is no profile’s, or a changed request is refused as signature', async () => {
    const h = await hostWith(OPEN)
    try {
      await deliver([h.url], [await stamp()])
      const mine = pullRequest(alice, 0, T0)
      assert.equal((await pull(h.url, mine)).messages.length, 1)
      assert.equal(await refusal(pull(h.url, { ...pullRequest(bob, 0, T0), profile: alice.address })), 'signature')
      const unsigned = { v: 1 as const, profile: alice.address, after: 0, time: T0 }
      assert.equal(await refusal(pull(h.url, { ...unsigned, sig: signAs(stranger, stranger.address, pullSigningInput(unsigned)) })), 'signature', 'a key that is not the main key')
      assert.equal(await refusal(pull(h.url, { ...mine, key: stranger.address } as never)), 'shape', 'no field names another key')
      assert.equal(await refusal(pull(h.url, { ...pullRequest(aliceBuyer, 0, T0), profile: alice.address })), 'signature', 'the same person’s other profile')
      assert.equal(await refusal(pull(h.url, { ...mine, after: 1 })), 'signature')
      // Bob's own pull is fine, and finds nothing: messages go to the profile they are to only.
      assert.equal((await pull(h.url, pullRequest(bob, 0, T0))).messages.length, 0)
    } finally {
      await h.close()
    }
  })

  test('a pull is signed within ten minutes of the host’s clock, either way: stale', async () => {
    const h = await hostWith(OPEN)
    try {
      for (const [time, result] of [[T0 - 10 * MINUTE, 'ok'], [T0 + 10 * MINUTE, 'ok'], [T0 - 10 * MINUTE - 1, 'stale'], [T0 + 10 * MINUTE + 1, 'stale']] as const) {
        assert.equal(await refusal(pulled(h, 0, time)), result, String(time - T0))
      }
    } finally {
      await h.close()
    }
  })

  test('a pull is a POST, so no URL carries it; GET is 405, and a pull that is not canonical is refused', async () => {
    const h = await hostWith(OPEN)
    try {
      assert.equal((await fetch(`${h.url}/v1/inbox/pull`)).status, 405)
      assert.equal((await fetch(`${h.url}/v1/inbox`)).status, 405)
      const res = await fetch(`${h.url}/v1/inbox/pull`, { method: 'POST', body: JSON.stringify(pullRequest(alice, 0, T0), null, 1) })
      assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [400, 'canonical'])
    } finally {
      await h.close()
    }
  })
})
