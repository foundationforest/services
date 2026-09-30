// Part one's story, as data, for the page tests: Ana tutors; Ben is her student; Cleo is a
// stranger. The same people, badges, deal and reviews the end-to-end test makes on real pieces,
// written straight into a fresh database, so the pages can be tested with nothing but Postgres.
// Markets v1 adds a one-sided market, where Dara offers a language exchange in a place, with no
// price. Every profile lives in one market, as one side of it.
//
//   - Records go in through part one's own `applyRecordOp`, so each is checked against its lexicon
//     exactly as a record off the firehose is.
//   - Chain rows go in as the adapters store them (badges, the log archive, the receipt).
//   - Scores come from the real recompute, signed with a fixed seed.
//
// The ids are fixed, so the read skill (index/skill.md) can use them as its examples.

import { randomBytes } from 'node:crypto'

import pg from 'pg'

import { type Config, loadConfig } from '../src/config.ts'
import { type Db, createPool } from '../src/db.ts'
import { startReaders } from '../src/main.ts'
import { serveMarkets } from './markets-repo.ts'
import { applyRecordOp } from '../src/records/store.ts'

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const FOUNDATION_ISSUER = 'H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS'
export const MARKET = 'online-tutors'
/** Badges count only as `market/role`: Ana and Cleo sell, Ben buys. */
export const SELLER_SCOPE = `${MARKET}/seller`
export const BUYER_SCOPE = `${MARKET}/buyer`
export const FOLDER = 'freelance-work'
/** A one-sided market: Dara is a peer in it, and her offer there names no price. */
export const EXCHANGE = 'language-exchange'
export const PEER_SCOPE = `${EXCHANGE}/peer`
/** Where Ben's exchange offer is, rounded to 2 km. */
export const LISBON = { lat: '38.72', lon: '-9.14', precisionKm: 2, area: 'Arroios, Lisbon' }

export const ana = { did: 'did:plc:exampleana22222222222222', wallet: '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9', name: 'Ana Ribeiro' }
export const ben = { did: 'did:plc:exampleben22222222222222', wallet: 'mBKqcnGotbsSb5vNrdyhzZ5EhqZdids9QYiTRckvi7v', name: 'Ben Okafor' }
/** Cleo's badge is registered with one key; her profile declares another, so it must not count. */
export const cleo = {
  did: 'did:plc:examplecleo2222222222222',
  wallet: '4MfyR4G3NWfVRDWo6iNAHDBZqWMgwZX6FNtMqEW3a9JT',
  badgeWallet: 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os',
  name: 'Cleo',
}
/** A peer in the language exchange: another market, so another profile. */
export const dara = { did: 'did:plc:exampledara2222222222222', wallet: 'EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1', name: 'Dara Mensah' }
/** Ana invoiced Ben; Ben paid in one tap and released it to her. */
export const DEAL = 'CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU'
export const MADE_UP_DEAL = 'cd'.repeat(32)
export const OFFERS = {
  portuguese: { rkey: '3kzq2vrffxb2c', cid: 'bafyreiexampleanaportuguese2222', uri: `at://${ana.did}/foundation.forest.post/3kzq2vrffxb2c` },
  spanish: { rkey: '3kzq2vrffxb2d', cid: 'bafyreiexampleanaspanish2222222', uri: `at://${ana.did}/foundation.forest.post/3kzq2vrffxb2d` },
  exchange: { rkey: '3kzq2vrffxb2e', cid: 'bafyreiexampledaraexchange22222', uri: `at://${dara.did}/foundation.forest.post/3kzq2vrffxb2e` },
}
/** The photo Ben's review carries. The index never fetches it. */
export const PHOTO = { $type: 'blob', ref: { $link: 'bafkreicx54kjfbjopw56j2bwh7zphoa5ejyyx7e6wazjsfr3u2q33d65he' }, mimeType: 'image/jpeg', size: 20 }
export const SIGNING_SEED = '09'.repeat(32)

const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00.000Z`

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

  // Migrations and the public keys; no firehose and no chain, so no reader starts.
  const readers = await startReaders(db, config())
  const put = async (did: string, collection: string, rkey: string, cid: string, record: Record<string, unknown>) => {
    const out = await applyRecordOp(db, { event: 'create', did, collection, rkey, cid, rev: '3kzq2vrffxb2a', record })
    if (out.result !== 'stored') throw new Error(`fixture record ${did}/${collection}/${rkey} not stored: ${JSON.stringify(out)}`)
  }

  const profile = (p: { name: string; wallet: string }, scope: string, about: string | null, d: number) => ({
    $type: 'foundation.forest.profile',
    name: p.name,
    market: scope.split('/')[0],
    role: scope.split('/')[1],
    wallet: p.wallet,
    ...(about ? { about } : {}),
    createdAt: day(d),
  })
  await put(ana.did, 'foundation.forest.profile', 'self', 'bafyreiexampleanaprofile2222222', {
    ...profile(ana, SELLER_SCOPE, 'Portuguese and Spanish tutor. Ten years teaching adults online.', 1),
    contact: 'Message me here first; video calls after a first reply.',
  })
  await put(ben.did, 'foundation.forest.profile', 'self', 'bafyreiexamplebenprofile2222222', profile(ben, BUYER_SCOPE, 'Learning Portuguese for a move to Lisbon.', 2))
  await put(cleo.did, 'foundation.forest.profile', 'self', 'bafyreiexamplecleoprofile222222', profile(cleo, SELLER_SCOPE, null, 3))
  await put(dara.did, 'foundation.forest.profile', 'self', 'bafyreiexampledaraprofile222222', profile(dara, PEER_SCOPE, 'English teacher, learning Portuguese.', 3))

  // A post names no market or side: they are its author profile's.
  const offer = (description: string, amount: string, extra: Record<string, unknown>) => ({
    $type: 'foundation.forest.post',
    direction: 'offer',
    description,
    price: { amount, mint: USDC, per: 'hour' },
    remote: true,
    createdAt: day(4),
    ...extra,
  })
  await put(ana.did, 'foundation.forest.post', OFFERS.portuguese.rkey, OFFERS.portuguese.cid,
    offer('Portuguese conversation for adults, A1 to B2.', '25', { availability: 'Weekday evenings, Lisbon time.', subjects: ['portuguese'] }))
  // With a timer that sends the money back to the buyer (which no page speaks of), and saying
  // nothing of where (`remote` is optional).
  const { remote: _, ...spanish } = offer('Spanish grammar, one hour, homework optional.', '12.50', { terms: { timer: { days: 30, to: 'buyer' } }, subjects: ['spanish'] })
  await put(ana.did, 'foundation.forest.post', OFFERS.spanish.rkey, OFFERS.spanish.cid, spanish)
  // Dara's offer: in her market, the language exchange; no price, and a place.
  const { price: __, remote: ___, ...exchange } = offer('English for Portuguese, an hour each way, in a café.', '0', { location: LISBON, speaks: ['en'] })
  await put(dara.did, 'foundation.forest.post', OFFERS.exchange.rkey, OFFERS.exchange.cid, exchange)

  // Five badges on list 0, vouched for by the foundation's issuer. Cleo's is for a key her profile
  // does not declare. Ben's second is under another scope than his profile's, so it does not count
  // for it: a second market is a second profile, as Dara's is.
  const badge = async (i: number, did: string, wallet: string, scope: string) => {
    const [market, role] = scope.split('/')
    const signature = `ExampleRegistration${i}`.padEnd(88, '1')
    await db.query(
      `insert into chain_transactions (signature, program_id, slot, block_time, logs) values ($1, 'registry', $2, $3, '[]')`,
      [signature, 100 + i, day(5)],
    )
    await db.query(
      `insert into badges (signature, ix, scope, market, role, did, wallet, code, list_index, list_owner, slot, block_time)
       values ($1, 0, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)`,
      [signature, scope, market, role, did, wallet, String(i).repeat(64), FOUNDATION_ISSUER, 100 + i, day(5)],
    )
  }
  await badge(1, ana.did, ana.wallet, SELLER_SCOPE)
  await badge(2, ben.did, ben.wallet, BUYER_SCOPE)
  await badge(3, cleo.did, cleo.badgeWallet, SELLER_SCOPE)
  await badge(4, ben.did, ben.wallet, PEER_SCOPE)
  await badge(5, dara.did, dara.wallet, PEER_SCOPE)

  // The receipt: $25 from Ben to Ana, which she asked for, released to her.
  await db.query(
    `insert into escrow_receipts (escrow, program_id, buyer, seller, creator, mint, amount, created_at, ended_at, outcome,
                                  to_seller, to_buyer, signature)
     values ($1, 'escrow', $2, $3, 'seller', $4, 25000000, $5, $6, 'releasedToSeller', 25000000, 0, $7)`,
    [DEAL, ben.wallet, ana.wallet, USDC, day(6), day(6), 'ExampleDealRelease'.padEnd(88, '1')],
  )

  const review = (subject: string, ratings: Record<string, string>, dealId: string, text: string, d: number, extra: Record<string, unknown> = {}) => ({
    $type: 'foundation.forest.review',
    subject,
    ratings,
    text,
    dealId,
    createdAt: day(d),
    ...extra,
  })
  // Ana lives in online-tutors, whose file adds `sessions` to a review of her.
  await put(ben.did, 'foundation.forest.review', '3kzq2vrffxb3a', 'bafyreiexamplebenreview22222222',
    review(ana.did, { overall: '10', patience: '10' }, DEAL, 'Patient and well prepared.', 7, { sessions: 8, media: [PHOTO] }))
  await put(ana.did, 'foundation.forest.review', '3kzq2vrffxb3b', 'bafyreiexampleanareview22222222', review(ben.did, { overall: '10' }, DEAL, 'Paid on time, came prepared.', 7))
  await put(cleo.did, 'foundation.forest.review', '3kzq2vrffxb3c', 'bafyreiexamplecleoreview2222222', review(ana.did, { overall: '1' }, MADE_UP_DEAL, 'Never showed up.', 8))

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
