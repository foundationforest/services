// The story, as data, for the page tests: Ana tutors; Ben is her student; Cleo is a stranger; Eve
// holds a row whose issuer signature does not check, so the index stores nothing of hers. Dara offers
// a language exchange in a place, with no price, in a one-sided market. Every profile lives in one
// market, as one side of it: its label.
//
//   - Records are real signed records (forest/records), one host's, taken in through the index's own
//     view and store, so each body is checked against its shape exactly as a record read from a host
//     is. Ana lets an access key write offers until 6 September: its offer from before counts, its
//     offer from after does not. Ana also keeps a private record at an offer's path: the index leaves
//     it alone.
//   - Pictures: Ben's review of Ana carries a photo, Dara's offer a video, Ana's card a photo. The
//     three records are also on a second host, forest's reference host on loopback, which holds the
//     bytes of the first two and never gets the third. The readers ask it, as they ask every host.
//   - Rows go in as the chain reader stores them, signed by the test issuer over a fixed root; the
//     receipt as the escrow reader stores it.
//   - Scores come from the real recompute, signed with a fixed seed.
//
// The keys are fixed (each profile's from a fixed seed and its label), so the addresses are too, and
// the read skill (index/skill.md) uses them as its examples.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import pg from 'pg'

import { type MainKey, mainKey } from '../../forest/keys/src/index.ts'
import { Host } from '../../forest/records/src/host.ts'
import {
  type Body,
  type Checked,
  type SignedRecord,
  b64u,
  hex,
  hostsRecord,
  keyFromPrivate,
  ownerRecord,
  permissionsRecord,
  publish,
  putBlob,
  recordId,
  unsignedOf,
  accessRecord,
} from '../../forest/records/src/index.ts'
import { issuerSigned } from '../../forest/registry/client/src/issuer.ts'

import { storeRow } from '../src/chain/registry.ts'
import { type Config, loadConfig } from '../src/config.ts'
import { type Db, createPool } from '../src/db.ts'
import { startReaders } from '../src/main.ts'
import { splitLabel } from '../src/markets.ts'
import { checkBlobs } from '../src/records/blobs.ts'
import { takeIn } from '../src/records/hosts.ts'
import { serveMarkets } from './markets-repo.ts'

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** The test issuer, the one the index trusts: a fixed key. */
export const ISSUER = keyFromPrivate(new Uint8Array(32).fill(31))
export const ISSUER_NAME = 'Forest Foundation (test key)'
/** The root of the issuer's list every counted row here was proven against, and the issuer's signature on it. */
export const ROOT = new Uint8Array(32).fill(0xab)
const SIGNATURE = ed25519.sign(ROOT, ISSUER.privateKey)
export const MARKET = 'online-tutors'
/** Rows count only as `market/role`: Ana and Cleo sell, Ben buys. */
export const SELLER = `${MARKET}/seller`
export const BUYER = `${MARKET}/buyer`
export const FOLDER = 'freelance-work'
/** A one-sided market: Dara is a peer in it, and her offer there names no price. */
export const EXCHANGE = 'language-exchange'
export const PEER = `${EXCHANGE}/peer`
/** Where Dara's exchange offer is, rounded to 2 km. */
export const LISBON = { lat: '38.72', lon: '-9.14', precisionKm: 2, area: 'Arroios, Lisbon' }
/** The host the story's hosts records name. Nothing is served there: the records go straight in. */
export const HOST = 'https://host.example'

type Person = { key: MainKey; address: string; name: string }
const person = async (fill: number, label: string, name: string): Promise<Person> => {
  const key = await mainKey(new Uint8Array(32).fill(fill), label)
  return { key, address: key.address, name }
}
export const ana = await person(21, SELLER, 'Ana Ribeiro')
export const ben = await person(22, BUYER, 'Ben Okafor')
export const cleo = await person(23, SELLER, 'Cleo')
/** A peer in the language exchange: another market, so another profile. */
export const dara = await person(24, PEER, 'Dara Mensah')
/** Her row's issuer signature does not check: no row counts, and nothing of hers is stored. */
export const eve = await person(25, SELLER, 'Eve')
/** The access key Ana lets write offers until 6 September. */
export const ACCESS = keyFromPrivate(new Uint8Array(32).fill(42))
/** Ana invoiced Ben; Ben objected, then paid in one tap and released it to her. */
export const DEAL = 'CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU'
export const ESCROW_PROGRAM = 'FA6ZodkyhMDj9yjzY27dk8JDCtcHnJx8mr45Mx9TfKg8'
export const MADE_UP_DEAL = 'cd'.repeat(32)
/** A picture as a record names it: by the SHA-256 of its bytes, with its type and size. */
const picture = (bytes: Uint8Array, mimeType: string) => ({ sha256: hex.encode(sha256(bytes)), mimeType, size: bytes.length })
const PHOTO_BYTES = new TextEncoder().encode('A photo of a lesson.')
const CLIP_BYTES = new TextEncoder().encode('A short video of an exchange.')
/** The photo Ben's review carries: the second host holds it. */
export const PHOTO = picture(PHOTO_BYTES, 'image/jpeg')
/** The video Dara's offer carries: the second host holds it. */
export const CLIP = picture(CLIP_BYTES, 'video/mp4')
/** The photo Ana's card names: no host holds it, so no page shows it. */
export const NO_PHOTO = picture(new TextEncoder().encode('A photo no host was given.'), 'image/png')
export const SIGNING_SEED = '09'.repeat(32)

const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00.000Z`
const at = (d: number) => Date.parse(day(d))

// -----------------------------------------------------------------------------------------------
// The records: each profile's hosts, card, offers and reviews, signed with its own key
// -----------------------------------------------------------------------------------------------

const profile = (label: string, about: string | null, d: number) => ({
  market: label.split('/')[0],
  role: label.split('/')[1],
  ...(about ? { about } : {}),
  createdAt: day(d),
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
const { price: _p, remote: _q, ...exchange } = offer('English for Portuguese, an hour each way, in a café.', '0', { location: LISBON, speaks: ['en'], media: [CLIP] })

const records = (p: Person, d: number, card: Record<string, unknown>, rest: [string, Record<string, unknown>, number][]): SignedRecord[] => [
  hostsRecord(p.key, [HOST], at(d)),
  ownerRecord(p.key, 'profile', { ...card, name: p.name } as Body, at(d)),
  ...rest.map(([path, body, when]) => ownerRecord(p.key, path, body as Body, at(when))),
]

export const RECORDS: SignedRecord[] = [
  ...records(ana, 1, { ...profile(SELLER, 'Portuguese and Spanish tutor. Ten years teaching adults online.', 1), photo: NO_PHOTO }, [
    ['offer/portuguese', offer('Portuguese conversation for adults, A1 to B2.', '25', { availability: 'Weekday evenings, Lisbon time.', subjects: ['portuguese'] }), 4],
    // With a timer that sends the money back to the buyer (which no page speaks of), and saying
    // nothing of where (`remote` is optional).
    ['offer/spanish', spanish, 4],
    ['review/ben', review(ben.address, { overall: '10' }, DEAL, 'Paid on time, came prepared.', 7), 7],
    // Private: only its readers open it. The index stores nothing of it, at any path.
    ['offer/private', { private: b64u.encode(randomBytes(64)) }, 4],
  ]),
  // The access key, on Ana's list for offers until 6 September.
  permissionsRecord(ana.key, [{ key: ACCESS.address, paths: ['offer'], until: at(6) }], at(2)),
  accessRecord(ACCESS, ana.address, 'offer/french', offer('French for beginners, online.', '20', { subjects: ['french'] }), at(5)),
  accessRecord(ACCESS, ana.address, 'offer/german', offer('German, written after the access key was removed.', '20', { subjects: ['german'] }), at(7)),
  ...records(ben, 2, profile(BUYER, 'Learning Portuguese for a move to Lisbon.', 2), [
    // Ana lives in online-tutors, whose file adds `sessions` to a review of her.
    ['review/ana', review(ana.address, { overall: '10', patience: '10' }, DEAL, 'Patient and well prepared.', 7, { sessions: 8, media: [PHOTO] }), 7],
  ]),
  ...records(cleo, 3, profile(SELLER, null, 3), [['review/ana', review(ana.address, { overall: '1' }, MADE_UP_DEAL, 'Never showed up.', 8), 8]]),
  // Dara's offer: in her market, the language exchange; no price, and a place.
  ...records(dara, 3, profile(PEER, 'English teacher, learning Portuguese.', 3), [['offer/exchange', exchange, 4]]),
  ...records(eve, 3, profile(SELLER, 'Portuguese lessons, cheap.', 3), [
    ['offer/cheap', offer('Portuguese lessons, cheap.', '5', {}), 4],
    ['review/ana', review(ana.address, { overall: '1' }, MADE_UP_DEAL, 'Terrible.', 8), 8],
  ]),
]

const recordAt = (address: string, path: string) => RECORDS.find((r) => r.profile === address && r.path === path)!
const idAt = (address: string, path: string) => recordId(unsignedOf(recordAt(address, path)))
const offerAt = (address: string, path: string) => ({ path, uri: `${address}/${path}`, id: idAt(address, path) })
export const OFFERS = {
  portuguese: offerAt(ana.address, 'offer/portuguese'),
  spanish: offerAt(ana.address, 'offer/spanish'),
  french: offerAt(ana.address, 'offer/french'),
  exchange: offerAt(dara.address, 'offer/exchange'),
}

/** `host`: the second host, which holds two of the pictures. */
export type Fixture = { db: Db; config: (env?: Record<string, string>) => Config; host: string; drop: () => Promise<void> }

/** A fresh database with the story in it and its scores computed. `drop` removes it. */
export async function makeFixture(adminUrl: string): Promise<Fixture> {
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const name = `forest_index_pages_${randomBytes(4).toString('hex')}`
  await admin.query(`create database ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const markets = await serveMarkets()
  // The three lists, as files: no host (the records go straight in), the test markets, the test issuer.
  const lists = mkdtempSync(join(tmpdir(), 'forest-index-lists-'))
  writeFileSync(join(lists, 'hosts.json'), JSON.stringify({ hosts: [] }))
  writeFileSync(join(lists, 'markets.json'), JSON.stringify({ directory: markets.url, markets: [MARKET, EXCHANGE] }))
  writeFileSync(join(lists, 'issuers.json'), JSON.stringify({ issuers: { [ISSUER.address]: { name: ISSUER_NAME, weight: 1 } } }))
  const env = {
    DATABASE_URL: url.toString(),
    INDEX_SIGNING_SEED: SIGNING_SEED,
    HOSTS_FILE: join(lists, 'hosts.json'),
    MARKETS_FILE: join(lists, 'markets.json'),
    ISSUERS_FILE: join(lists, 'issuers.json'),
    ESCROW_PROGRAM_ID: ESCROW_PROGRAM,
  }
  const config = (more: Record<string, string> = {}) => loadConfig({ ...env, ...more })
  const db = createPool(url.toString())

  // Migrations and the public keys; no hosts and no chain, so no reader reads.
  const readers = await startReaders(db, config())

  // Six rows. Five signed by the test issuer; Ben's second is under another label than his
  // profile's, so it does not count for it: a second market is a second profile, as Dara's is.
  // Eve's carries a signature the issuer never made.
  const row = async (i: number, p: Person, label: string, signature = SIGNATURE) => {
    await storeRow(db, {
      address: `ExampleRow${i}`.padEnd(44, '1'),
      profile: p.address,
      issuer: ISSUER.address,
      root: hex.encode(ROOT),
      issuerSignature: hex.encode(signature),
      issuerSigned: issuerSigned({ issuer: ISSUER.publicKey, root: ROOT, issuerSignature: signature }),
      payer: 'ExamplePayer'.padEnd(44, '1'),
      label,
      ...splitLabel(label),
    })
  }
  await row(1, ana, SELLER)
  await row(2, ben, BUYER)
  await row(3, cleo, SELLER)
  await row(4, ben, PEER)
  await row(5, dara, PEER)
  await row(6, eve, SELLER, ed25519.sign(ROOT, new Uint8Array(32).fill(7)))

  // The records: every one as one host served them, kept, viewed and stored as the reader does.
  // Eve's are kept but never stored.
  const refused: unknown[] = []
  const checked: Checked[] = RECORDS.map((record) => ({ record, id: recordId(unsignedOf(record)) }))
  await takeIn(db, HOST, checked, [ISSUER.address], (err) => refused.push(err))
  if (refused.length) throw new Error(`fixture records refused: ${refused.map(String).join('; ')}`)

  // The second host: the three records that name pictures, posted there too, then the bytes of two
  // of them. The readers ask it for the pictures, as they ask every host they read.
  const host = new Host()
  const hostUrl = await host.listen(0)
  const pictured = [recordAt(ana.address, 'profile'), recordAt(ben.address, 'review/ana'), recordAt(dara.address, 'offer/exchange')]
  const [posted] = await publish([hostUrl], pictured)
  if (!posted!.results.every((r) => r.ok)) throw new Error(`the second host refused: ${JSON.stringify(posted)}`)
  for (const [bytes, type] of [[PHOTO_BYTES, PHOTO.mimeType], [CLIP_BYTES, CLIP.mimeType]] as const) {
    const [put] = await putBlob([hostUrl], bytes, type)
    if (!put!.ok) throw new Error(`the second host refused the bytes: ${JSON.stringify(put)}`)
  }
  await takeIn(db, hostUrl, pictured.map((record) => ({ record, id: recordId(unsignedOf(record)) })), [ISSUER.address], (err) => refused.push(err))
  if (refused.length) throw new Error(`fixture records refused: ${refused.map(String).join('; ')}`)
  await checkBlobs(db, [hostUrl])

  // The receipt: $25 from Ben to Ana, which she asked for. Ben objected, then released it to her.
  await db.query(
    `insert into escrow_receipts (escrow, program_id, buyer, seller, creator, mint, amount, created_at, funded_at, ended_at, outcome,
                                  to_seller, to_buyer, objected_by, objected_at, signature)
     values ($1, $2, $3, $4, 'seller', $5, 25000000, $6, $7, $7, 'releasedToSeller', 25000000, 0, 'buyer', $6, $8)`,
    [DEAL, ESCROW_PROGRAM, ben.address, ana.address, USDC, day(6), day(6), 'ExampleDealRelease'.padEnd(88, '1')],
  )

  await readers.scorer.now()
  readers.scorer.stop()

  return {
    db,
    config,
    host: hostUrl,
    drop: async () => {
      await host.close()
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
      rmSync(lists, { recursive: true, force: true })
    },
  }
}
