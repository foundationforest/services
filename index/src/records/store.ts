// A profile as forest's view sees it (forest/records/src/view.ts), into Postgres. Every record
// reached the view checked: its canonical text and its signature, when it was read from a host. Here
// each live body is checked once more, against its shape (forest/records/schemas/), and a body that
// fails is not stored: nothing unchecked ever reaches a score.
//
// Three shapes are read, by path: `profile`, `offer/<id>` and `review/<id>`. A private record (its
// body only `{private}`) is left alone: its readers open it, an index cannot. Every other path is not
// this index's. A record's address is `<profile>/<path>`; its `id` is the id of the record that holds
// the path now. The profile's address is its name and its Solana address.
//
// A profile's proofs (forest/records/README.md, "Proofs") are checked here, once per version of its
// card, and the ones that check are stored with it: its reputation proofs (`checkProofs`), and its
// person proofs, the tiers it shows (`checkTiers`). Whether a page shows a reputation proof is
// decided when the page is made, from the roots (web/data.ts); a tier weighs its row in the scores
// (scores/compute.ts).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Commitment, type Connection, PublicKey } from '@solana/web3.js'
import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'

import { verifyReputation } from '../../../forest/circuits/reputation/src/index.ts'
import { type View, b64u, base58, hex, isPrivate, liveContent } from '../../../forest/records/src/index.ts'
import { verifyTier } from '../../../forest/registry/client/src/index.ts'

import { INDEX_ROOT, type IssuerConfig } from '../config.ts'
import type { Db } from '../db.ts'

export const KINDS = ['profile', 'offer', 'review'] as const
export type Kind = (typeof KINDS)[number]

const ajv = new Ajv2020({ strict: true, allErrors: true })
formats.default(ajv)
const schemaFile = (kind: Kind) => join(INDEX_ROOT, '../forest/records/schemas', `${kind}.json`)
const validators = Object.fromEntries(KINDS.map((k) => [k, ajv.compile(JSON.parse(readFileSync(schemaFile(k), 'utf8')))]))

/** Whether a body fits its shape, and every way it does not. */
export function checkBody(kind: Kind, body: unknown): { ok: true } | { ok: false; why: string } {
  const validate = validators[kind]!
  if (validate(body)) return { ok: true }
  return { ok: false, why: ajv.errorsText(validate.errors, { dataVar: kind }) }
}

/** The shape a path holds: `profile`, or `offer` or `review` at `<kind>/<id>`. Null for anything else. */
export function kindOf(path: string): Kind | null {
  if (path === 'profile') return 'profile'
  const [kind, id, ...rest] = path.split('/')
  if (!id || rest.length || (kind !== 'offer' && kind !== 'review')) return null
  return kind
}

const ts = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export type Projected = { stored: number; refused: { path: string; why: string }[] }

/** A reputation proof on a card that checked: the fields the card gives, but the proof's bytes. */
export type StoredProof = { index: string; root: string; time: number; signature: string; score: number; label: string | null }

/**
 * The reputation proofs on a card that check: each from an index in `indexes`, for this profile's
 * main key and the label it shows, under the root and time that index signed. circuits'
 * `verifyReputation` checks it all, reading the proof's 256 bytes with `proofFromBytes`. A proof
 * that fails, or names an index not listed, is left out; it is not an error. A proof of a circuit
 * this index does not know is left alone.
 */
export async function checkProofs(profile: string, card: Record<string, any>, indexes: string[]): Promise<StoredProof[]> {
  const out: StoredProof[] = []
  for (const p of Array.isArray(card.proofs) ? card.proofs : []) {
    if (p?.circuit !== 'reputation' || !indexes.includes(p.index)) continue
    let ok = false
    try {
      ok = await verifyReputation({
        proof: b64u.decode(p.proof),
        root: BigInt(`0x${p.root}`),
        score: BigInt(p.score),
        profile: base58.decode(profile),
        ...(p.label === undefined ? {} : { label: p.label }),
        index: base58.decode(p.index),
        time: p.time,
        signature: b64u.decode(p.signature),
      })
    } catch {
      // Bytes that do not decode are a proof that does not check.
    }
    if (ok) out.push({ index: p.index, root: p.root, time: p.time, signature: p.signature, score: p.score, label: p.label ?? null })
  }
  return out
}

/** A person proof on a card that checked: the tier the profile shows for its row at `stamp`, from `issuer`, under `label`. */
export type StoredTier = { issuer: string; label: string; stamp: string; tier: string }

/** The registry a person proof is checked against, over an RPC. */
export type Registry = { connection: Pick<Connection, 'getAccountInfo'>; programId: string; commitment: Commitment }

/**
 * The person proofs on a card that check: each from an issuer in `issuers`, checked by forest's
 * `verifyTier` against the row at its stamp, for this profile's main key and the issuer and label it
 * shows. A proof that fails, or names an issuer not listed, is left out; it is not an error. With no
 * registry to read, none checks. An RPC that fails throws, so the card is checked again.
 */
export async function checkTiers(profile: string, card: Record<string, any>, issuers: IssuerConfig, registry: Registry | null): Promise<StoredTier[]> {
  const out: StoredTier[] = []
  if (!registry) return out
  for (const p of Array.isArray(card.proofs) ? card.proofs : []) {
    if (p?.circuit !== 'person' || !Object.hasOwn(issuers, p.issuer)) continue
    let input
    try {
      input = { profile: base58.decode(profile), issuer: hex.decode(p.issuer), label: p.label, stamp: hex.decode(p.stamp), tier: BigInt(p.tier), proof: b64u.decode(p.proof) }
    } catch {
      // Bytes that do not decode are a proof that does not check.
      continue
    }
    // The registry client checks a key against its own copy of web3.js; it reads only its bytes.
    const row = await verifyTier(registry.connection as never, input, { programId: new PublicKey(registry.programId) as never, commitment: registry.commitment })
    if (row) out.push({ issuer: p.issuer, label: p.label, stamp: p.stamp, tier: p.tier })
  }
  return out
}

/** What a card's proofs are checked against: the indexes whose reputation proofs count here, the issuers this index trusts, and the registry. */
export type Proofs = { indexes: string[]; issuers: IssuerConfig; registry: Registry | null }

/**
 * Replace everything the index holds for one profile with what its view says now. Only a profile
 * holding a counted row (`keep`) is stored; any other keeps nothing here.
 */
export async function project(db: Db, view: View, keep: boolean, proofs: Proofs): Promise<Projected> {
  const profile = view.profile
  const content = keep ? liveContent(view) : new Map()
  const out: Projected = { stored: 0, refused: [] }

  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query('delete from profiles where address = $1', [profile])
    await client.query('delete from offers where profile = $1', [profile])
    await client.query('delete from reviews where reviewer = $1', [profile])

    for (const [path, c] of content) {
      const kind = kindOf(path)
      const body = c.record.body
      if (!kind || isPrivate(body)) continue
      const checked = checkBody(kind, body)
      if (!checked.ok) {
        out.refused.push({ path, why: checked.why })
        continue
      }
      const r = body as Record<string, any>
      const uri = `${profile}/${path}`
      const rkey = path.split('/')[1] ?? path
      switch (kind) {
        case 'profile':
          await client.query(
            `insert into profiles (address, id, record, name, market, role, created_at, proofs, tiers, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
            [
              profile,
              c.id,
              r,
              r.name,
              r.market,
              r.role,
              ts(r.createdAt),
              JSON.stringify(await checkProofs(profile, r, proofs.indexes)),
              JSON.stringify(await checkTiers(profile, r, proofs.issuers, proofs.registry)),
            ],
          )
          break
        case 'offer':
          await client.query(
            `insert into offers (uri, profile, rkey, id, record, direction, description, price_amount, price_mint, price_per,
                                 remote, lat, lon, precision_km, area, expires, created_at, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
            [
              uri,
              profile,
              rkey,
              c.id,
              r,
              r.direction,
              r.description,
              r.price?.amount ?? null,
              r.price?.mint ?? null,
              r.price?.per ?? null,
              r.remote ?? null,
              r.location ? Number(r.location.lat) : null,
              r.location ? Number(r.location.lon) : null,
              r.location?.precisionKm ?? null,
              r.location?.area ?? null,
              ts(r.expires),
              ts(r.createdAt),
            ],
          )
          break
        case 'review':
          await client.query(
            `insert into reviews (uri, reviewer, rkey, id, record, subject, overall, text, deal_id, created_at, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
            [uri, profile, rkey, c.id, r, r.subject, r.ratings?.overall ?? null, r.text ?? null, r.dealId ?? null, ts(r.createdAt)],
          )
          break
      }
      out.stored++
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return out
}
