// Part one's story, as data, for the page tests: Ana tutors; Ben is her student; Cleo is a
// stranger; Eve holds a line no issuer this index trusts vouches for, so the index keeps nothing of
// hers. The same people, badges, deal and reviews the end-to-end test makes on real pieces,
// written straight into a fresh database, so the pages can be tested with nothing but Postgres.
// Markets v1 adds a one-sided market, where Dara offers a language exchange in a place, with no
// price. Every profile lives in one market, as one side of it.
//
//   - Records are real signed entries (forest/records), one host's feed, taken in through the
//     index's own merge and store, so each body is checked against its schema exactly as an entry
//     read from a host is.
//   - Chain rows go in as the readers store them (lines, the issuer's roots, the receipt).
//   - Scores come from the real recompute, signed with a fixed seed.
//
// The keys are fixed (each profile's from a fixed stand-in for a passkey's secret), so the ids are
// too, and the read skill (index/skill.md) uses them as its examples.

import { randomBytes } from 'node:crypto'

import pg from 'pg'

import { type Body, type Entry, entryId, unsignedOf } from '../../forest/records/src/entry.ts'
import { type ProfileKey, profileKey, seedFromPrf } from '../../forest/records/src/keys.ts'
import { folderEntry, ownerEntry } from '../../forest/records/src/write.ts'

import { storeLine } from '../src/chain/poll.ts'
import { splitScope } from '../src/markets.ts'
import { type Config, loadConfig } from '../src/config.ts'
import { type Db, createPool } from '../src/db.ts'
import { storeRoots } from '../src/issuers.ts'
import { startReaders } from '../src/main.ts'
import { takeIn } from '../src/records/hosts.ts'
import { serveMarkets } from './markets-repo.ts'

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** The issuer config/issuers.json trusts, by its did:key. */
export const FOUNDATION_ISSUER = 'did:key:z6Mkva6a6cR5WU96pSkdNji2PQaW3c41TCvxbghMpK71Armp'
/** The root of the foundation's list every counted line here was proven against. */
export const FOUNDATION_ROOT = 'ab'.repeat(32)
export const MARKET = 'online-tutors'
/** Badges count only as `market/role`: Ana and Cleo sell, Ben buys. */
export const SELLER_SCOPE = `${MARKET}/seller`
export const BUYER_SCOPE = `${MARKET}/buyer`
export const FOLDER = 'freelance-work'
/** A one-sided market: Dara is a peer in it, and her offer there names no price. */
export const EXCHANGE = 'language-exchange'
export const PEER_SCOPE = `${EXCHANGE}/peer`
/** Where Dara's exchange offer is, rounded to 2 km. */
export const LISBON = { lat: '38.72', lon: '-9.14', precisionKm: 2, area: 'Arroios, Lisbon' }
/** The host the story's folders name. Nothing is served there: the entries go straight in. */
export const HOST = 'https://host.example'

const person = (fill: number, name: string, n = 0) => {
  const key = profileKey(seedFromPrf(new Uint8Array(32).fill(fill)), n)
  return { key, did: key.did, wallet: key.address, name }
}
export const ana = person(21, 'Ana Ribeiro')
export const ben = person(22, 'Ben Okafor')
export const cleo = person(23, 'Cleo')
/** A peer in the language exchange: another market, so another profile. */
export const dara = person(24, 'Dara Mensah')
/** Her line was proven against a list no trusted issuer publishes: no badge here, and nothing kept. */
export const eve = person(25, 'Eve')
/** The root of Eve's list, which no issuer this index trusts published. */
export const UNKNOWN_ROOT = 'cd'.repeat(32)
/** Ana invoiced Ben; Ben objected, then paid in one tap and released it to her. */
export const DEAL = 'CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU'
export const MADE_UP_DEAL = 'cd'.repeat(32)
/** The photo Ben's review carries, by the SHA-256 of its bytes. The index never fetches it. */
export const PHOTO = { sha256: '5e3b1f3c2a8a8f2b6c4e9d0a7b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f1a3b5c', mimeType: 'image/jpeg', size: 20 }
export const SIGNING_SEED = '09'.repeat(32)

const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00.000Z`
const at = (d: number) => Date.parse(day(d))

// -----------------------------------------------------------------------------------------------
// The entries: each profile's folder, card, offers and reviews, signed with its own key
// -----------------------------------------------------------------------------------------------

const profile = (scope: string, about: string | null, d: number, extra: Record<string, unknown> = {}) => ({
  market: scope.split('/')[0],
  role: scope.split('/')[1],
  ...(about ? { about } : {}),
  createdAt: day(d),
  ...extra,
})
// An offer names no market or side: they are its author profile's.
const offer = (description: string, amount: string, extra: Record<string, unknown>) => ({
  direction: 'offer',
  description,
  price: { amount, mint: USDC, per: 'hour' },
  remote: true,
  createdAt: day(4),
  ...extra,
})
const review = (subject: string, ratings: Record<string, string>, dealId: string, text: string, d: number, extra: Record<string, unknown> = {}) => ({
  subject,
  ratings,
  text,
  dealId,
  createdAt: day(d),
  ...extra,
})

const { remote: _r, ...spanish } = offer('Spanish grammar, one hour, homework optional.', '12.50', { terms: { timer: { days: 30, to: 'buyer' } }, subjects: ['spanish'] })
const { price: _p, remote: _q, ...exchange } = offer('English for Portuguese, an hour each way, in a café.', '0', { location: LISBON, speaks: ['en'] })

const entries = (p: { key: ProfileKey; name: string }, d: number, card: Record<string, unknown>, rest: [string, Record<string, unknown>, number][]): Entry[] => [
  folderEntry(p.key, { hosts: [HOST] }, at(d)),
  ownerEntry(p.key, 'profile', { ...card, name: p.name } as Body, at(d)),
  ...rest.map(([path, body, when]) => ownerEntry(p.key, path, body as Body, at(when))),
]

export const ENTRIES: Entry[] = [
  ...entries(ana, 1, profile(SELLER_SCOPE, 'Portuguese and Spanish tutor. Ten years teaching adults online.', 1, { contact: 'Message me here first; video calls after a first reply.' }), [
    ['offer/portuguese', offer('Portuguese conversation for adults, A1 to B2.', '25', { availability: 'Weekday evenings, Lisbon time.', subjects: ['portuguese'] }), 4],
    // With a timer that sends the money back to the buyer (which no page speaks of), and saying
    // nothing of where (`remote` is optional).
    ['offer/spanish', spanish, 4],
    ['review/ben', review(ben.did, { overall: '10' }, DEAL, 'Paid on time, came prepared.', 7), 7],
  ]),
  ...entries(ben, 2, profile(BUYER_SCOPE, 'Learning Portuguese for a move to Lisbon.', 2), [
    // Ana lives in online-tutors, whose file adds `sessions` to a review of her.
    ['review/ana', review(ana.did, { overall: '10', patience: '10' }, DEAL, 'Patient and well prepared.', 7, { sessions: 8, media: [PHOTO] }), 7],
  ]),
  ...entries(cleo, 3, profile(SELLER_SCOPE, null, 3), [['review/ana', review(ana.did, { overall: '1' }, MADE_UP_DEAL, 'Never showed up.', 8), 8]]),
  // Dara's offer: in her market, the language exchange; no price, and a place.
  ...entries(dara, 3, profile(PEER_SCOPE, 'English teacher, learning Portuguese.', 3), [['offer/exchange', exchange, 4]]),
  ...entries(eve, 3, profile(SELLER_SCOPE, 'Portuguese lessons, cheap.', 3), [
    ['offer/cheap', offer('Portuguese lessons, cheap.', '5', {}), 4],
    ['review/ana', review(ana.did, { overall: '1' }, MADE_UP_DEAL, 'Terrible.', 8), 8],
  ]),
]

const idAt = (did: string, path: string) => entryId(unsignedOf(ENTRIES.find((e) => e.profile === did && e.path === path)!))
const address = (did: string, path: string) => ({ path, uri: `${did}/${path}`, cid: idAt(did, path) })
export const OFFERS = {
  portuguese: address(ana.did, 'offer/portuguese'),
  spanish: address(ana.did, 'offer/spanish'),
  exchange: address(dara.did, 'offer/exchange'),
}

export type Fixture = { db: Db; config: (env?: Record<string, string>) => Config; drop: () => Promise<void> }

/** A fresh database with the story in it and its scores computed. `drop` removes it. */
export async function makeFixture(adminUrl: string): Promise<Fixture> {
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const name = `forest_index_pages_${randomBytes(4).toString('hex')}`
  await admin.query(`create database ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const markets = await serveMarkets()
  const env = { DATABASE_URL: url.toString(), MARKETS_URL: markets.url, INDEX_SIGNING_SEED: SIGNING_SEED }
  const config = (more: Record<string, string> = {}) => loadConfig({ ...env, ...more })
  const db = createPool(url.toString())

  // Migrations and the public keys; no hosts, no chain and no roots address, so no reader reads.
  const readers = await startReaders(db, config())
  readers.roots.stop()

  // Six lines. Five proven against the foundation's list; Ben's second is under another scope than
  // his profile's, so it does not count for it: a second market is a second profile, as Dara's is.
  // Eve's, against a list no trusted issuer publishes.
  await storeRoots(db, FOUNDATION_ISSUER, [{ root: FOUNDATION_ROOT, size: 5, time: at(5) }])
  const line = async (i: number, p: { key: ProfileKey }, scope: string, root = FOUNDATION_ROOT) => {
    await storeLine(db, {
      address: `ExampleLine${i}`.padEnd(44, '1'),
      code: String(i).repeat(64),
      did: p.key.did,
      wallet: p.key.address,
      label: scope,
      ...splitScope(scope),
      root,
      time: at(5) / 1000,
      payer: 'ExamplePayer'.padEnd(44, '1'),
    })
  }
  await line(1, ana, SELLER_SCOPE)
  await line(2, ben, BUYER_SCOPE)
  await line(3, cleo, SELLER_SCOPE)
  await line(4, ben, PEER_SCOPE)
  await line(5, dara, PEER_SCOPE)
  await line(6, eve, SELLER_SCOPE, UNKNOWN_ROOT)

  // The records: every entry as one host served them, kept, merged and stored as the reader does.
  // Eve's are dropped as they arrive.
  const refused: unknown[] = []
  await takeIn(db, HOST, ENTRIES.map((entry) => ({ entry, id: entryId(unsignedOf(entry)) })), [FOUNDATION_ISSUER], (err) => refused.push(err))
  if (refused.length) throw new Error(`fixture entries refused: ${refused.map(String).join('; ')}`)

  // The receipt: $25 from Ben to Ana, which she asked for. Ben objected, then released it to her.
  await db.query(
    `insert into escrow_receipts (escrow, program_id, buyer, seller, creator, mint, amount, created_at, funded_at, ended_at, outcome,
                                  to_seller, to_buyer, objected_by, objected_at, signature)
     values ($1, 'escrow-v2', $2, $3, 'seller', $4, 25000000, $5, $6, $6, 'releasedToSeller', 25000000, 0, 'buyer', $5, $7)`,
    [DEAL, ben.wallet, ana.wallet, USDC, day(6), day(6), 'ExampleDealRelease'.padEnd(88, '1')],
  )

  await readers.scorer.now()
  readers.scorer.stop()

  return {
    db,
    config,
    drop: async () => {
      // pg's pool resolves `end()` before its sockets have closed; dropping the database under a
      // closing connection makes it report an error nobody is listening for. Wait for them to go.
      await db.end()
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query('select count(*)::int as n from pg_stat_activity where datname = $1', [name])
        if (rows[0].n === 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
      await admin.query(`drop database if exists ${name} with (force)`)
      await admin.end()
      await markets.close()
    },
  }
}
