// Shared test fixtures for the plug's tests: keys/'s test seed, a few keys, and ready-made bodies.
// The keys come from keys/, as an app gets them.

import { readFileSync } from 'node:fs'
import { accessKey, mainKey, openingHalf, serviceKey } from '@foundationforest/keys'
import { type Body, type Key, type SignedEntry, type UnsignedEntry, canonical, hex, signAs, signingInput } from '@foundationforest/folders'

/** keys/'s pinned vectors: its test seed (bytes 00 01 … 1f), its profiles and their opening halves. */
export const KEYS = JSON.parse(readFileSync(new URL('../../standard/keys/test/vectors.json', import.meta.url), 'utf8'))
export const SEED = hex.decode(KEYS.seed)
/** A second person. */
export const OTHER_SEED = new Uint8Array(32).fill(7)

export const alice = await mainKey(SEED, 'tutoring/seller')
export const aliceBuyer = await mainKey(SEED, 'tutoring/buyer') // the same person, another label
export const bob = await mainKey(OTHER_SEED, 'tutoring/buyer') // someone else
/** A key that is no one's main key here: what tries to sign for a profile it is not. */
export const stranger = serviceKey(new Uint8Array(32).fill(99))
/** An access key Alice's profile entry may list: keys/'s, from 32 bytes of 0x2b. */
export const helper = await accessKey(new Uint8Array(32).fill(0x2b))
export const [aliceOpening, bobOpening] = await Promise.all([openingHalf(alice.secret), openingHalf(bob.secret)])

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0)
export const MINUTE = 60_000
export const DAY = 86_400_000
/** The host a profile entry names: the plug takes a folder whose profile entry names another host, so any origin does. */
export const HOSTS = ['https://host.example']

/** A profile entry's body. `subjects`, a field a market adds, tells one version from another. */
export const profileBody = (subject: string, more: Body = {}): Body => ({
  market: 'tutoring',
  role: 'seller',
  hosts: HOSTS,
  subjects: [subject],
  ...more,
})

/** Alice's profile entry, listing `helper` with what it can do; with her open key, so her folder takes inbox entries. */
export const aliceWith = (can: string[], subject = 'calculus'): Body =>
  profileBody(subject, { openKey: aliceOpening.openKey, keys: [{ key: helper.address, open: helper.openKey, can }] })

// An offer's and a review's fields are the market's, not the standard's: these tests need only
// bodies that differ, so `about` stands in for them.
export const offerBody = (about: string): Body => ({ about })
export const reviewBody = (about: string): Body => ({ about })

/** A signed entry by the main key whose canonical text is exactly `bytes` long, `wide` of its characters two-byte (é). */
export function sizedEntry(key: Key, path: string, bytes: number, wide = 0): SignedEntry {
  const unsigned = (about: string): UnsignedEntry => ({ v: 1, profile: key.address, path, time: T0, body: { about } })
  const rest = bytes - canonical({ ...unsigned(''), sig: 'x'.repeat(86) }).length - 2 * wide
  const u = unsigned('é'.repeat(wide) + 'x'.repeat(rest))
  return { ...u, sig: signAs(key, key.address, signingInput(u)) }
}
