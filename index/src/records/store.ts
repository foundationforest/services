// A profile as the merge sees it (forest/records/src/view.ts), into Postgres. Every entry reached
// the merge checked: its canonical text and its signature, when it was read from a host
// (forest/records/src/client.ts). Here each current body is checked once more, against its record
// schema (forest/records/schemas/), and a body that fails is not stored: nothing unchecked ever
// reaches a score.
//
// Four kinds are read, by path: `profile`, `offer/<id>`, `review/<id>` and `proof/<id>`. A proof is
// a credential or a membership. Sealed bodies and every other path are private or not this index's,
// and are left alone. A record's address is `<did>/<path>`; its `cid` is the id of the entry that
// holds it now.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import formats from 'ajv-formats'

import { type Body, isSealed } from '../../../forest/records/src/entry.ts'
import { addressFromDid } from '../../../forest/records/src/keys.ts'
import { type ProfileView, liveContent } from '../../../forest/records/src/view.ts'

import { INDEX_ROOT } from '../config.ts'
import type { Db } from '../db.ts'

export const KINDS = ['profile', 'offer', 'review', 'proof'] as const
export type Kind = (typeof KINDS)[number]

const ajv = new Ajv2020({ strict: true, allErrors: true })
formats.default(ajv)
const schemaFile = (kind: Kind) => join(INDEX_ROOT, '../forest/records/schemas', `${kind}.json`)
const validators = Object.fromEntries(KINDS.map((k) => [k, ajv.compile(JSON.parse(readFileSync(schemaFile(k), 'utf8')))]))

/** Whether a body fits its kind's schema, and every way it does not. */
export function checkBody(kind: Kind, body: unknown): { ok: true } | { ok: false; why: string } {
  const validate = validators[kind]!
  if (validate(body)) return { ok: true }
  return { ok: false, why: ajv.errorsText(validate.errors, { dataVar: kind }) }
}

/** The kind a path holds: `profile`, or one of the three at `<kind>/<id>`. Null for anything else. */
export function kindOf(path: string): Kind | null {
  if (path === 'profile') return 'profile'
  const [kind, id, ...rest] = path.split('/')
  if (!id || rest.length || !['offer', 'review', 'proof'].includes(kind!)) return null
  return kind as Kind
}

const ts = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export type Projected = { stored: number; refused: { path: string; why: string }[] }

/**
 * Replace everything the index holds for one profile with what its view says now. Only a profile
 * with a trusted line (`keep`) is stored whole; any other keeps its memberships alone, which may
 * earn it one. A profile whose owner closed its folder keeps nothing here.
 */
export async function project(db: Db, view: ProfileView, keep: boolean): Promise<Projected> {
  const did = view.profile
  const wallet = addressFromDid(did)
  const content = view.folder === null ? new Map() : liveContent(view)
  const out: Projected = { stored: 0, refused: [] }
  const memberships: string[] = []

  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query('delete from profiles where did = $1', [did])
    await client.query('delete from posts where did = $1', [did])
    await client.query('delete from reviews where reviewer = $1', [did])
    await client.query('delete from credentials where did = $1', [did])

    for (const [path, v] of content) {
      const kind = kindOf(path)
      const body = v.entry.body as Body
      if (!kind || isSealed(body)) continue
      if (!keep && !(kind === 'proof' && 'membership' in body)) continue
      const checked = checkBody(kind, body)
      if (!checked.ok) {
        out.refused.push({ path, why: checked.why })
        continue
      }
      const r = body as Record<string, any>
      const uri = `${did}/${path}`
      const rkey = path.split('/')[1] ?? path
      switch (kind) {
        case 'profile':
          await client.query(
            `insert into profiles (did, cid, record, name, wallet, market, role, created_at, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
            [did, v.id, r, r.name, wallet, r.market, r.role, ts(r.createdAt)],
          )
          break
        case 'offer':
          await client.query(
            `insert into posts (uri, did, rkey, cid, record, direction, description, price_amount, price_mint, price_per,
                                remote, lat, lon, precision_km, area, expires, created_at, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
            [
              uri,
              did,
              rkey,
              v.id,
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
            `insert into reviews (uri, reviewer, rkey, cid, record, subject, overall, text, deal_id, created_at, indexed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
            [uri, did, rkey, v.id, r, r.subject, r.ratings?.overall ?? null, r.text ?? null, r.dealId ?? null, ts(r.createdAt)],
          )
          break
        case 'proof':
          if ('credential' in r) {
            await client.query(
              `insert into credentials (uri, did, rkey, cid, record, issuer, created_at, indexed_at)
               values ($1, $2, $3, $4, $5, $6, $7, now())`,
              [uri, did, rkey, v.id, r, r.issuer, ts(r.createdAt)],
            )
          } else {
            // A new version of the record is checked afresh; the same version keeps its verdict.
            await client.query(
              `insert into memberships (uri, did, cid, record, issuer, label, code, root, created_at, indexed_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
               on conflict (uri) do update set cid = excluded.cid, record = excluded.record, issuer = excluded.issuer,
                 label = excluded.label, code = excluded.code, root = excluded.root, created_at = excluded.created_at,
                 indexed_at = now(),
                 status = case when memberships.cid = excluded.cid then memberships.status else 'pending' end,
                 why = case when memberships.cid = excluded.cid then memberships.why else null end,
                 checked_at = case when memberships.cid = excluded.cid then memberships.checked_at else null end`,
              [uri, did, v.id, r, r.issuer, r.membership.label, r.membership.code, r.membership.root, ts(r.createdAt)],
            )
            memberships.push(uri)
          }
          break
      }
      out.stored++
    }
    await client.query('delete from memberships where did = $1 and not (uri = any($2))', [did, memberships])
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return out
}
