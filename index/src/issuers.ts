// The issuers this index trusts (config/issuers.json) and the roots each published. An issuer keeps
// its list off chain and publishes every root it has had in one signed file (issuer/README.md, "The
// two files"):
//
//   {"issuer":"did:key:…","roots":[{"root":"<decimal>","size":n,"time":ms},…],"sig":"<base64url>","v":1}
//
// signed with the issuer's key over 0xff ‖ "forest.foundation/issuer/roots/v1\n" ‖ the canonical
// text without `sig`. The index reads the file of each issuer it trusts, checks it is canonical text,
// that it names that issuer, and its signature, and keeps its roots. A line counts for an issuer when
// its root is one of them. The list itself (`list.json`) is not read: an index needs only the roots.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { b64u, concat, hex, utf8 } from '../../forest/records/src/bytes.ts'
import { canonical, parseCanonical } from '../../forest/records/src/canonical.ts'
import { verifySignature } from '../../forest/records/src/entry.ts'
import { publicKeyFromDid } from '../../forest/records/src/keys.ts'
import { type Membership, verifyMembership } from '../../forest/registry/client/src/membership.ts'
import { toBytes32 } from '../../forest/registry/client/src/field.ts'

import { lineOf } from './chain/registry.ts'
import { INDEX_ROOT, type IssuerConfig } from './config.ts'
import type { Db } from './db.ts'

/** What the roots file's signature covers begins with this: 0xff, then its own label. */
export const ROOTS_SIGN_PREFIX = concat(Uint8Array.of(0xff), utf8('forest.foundation/issuer/roots/v1\n'))

export type Root = { root: string; size: number; time: number }

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join()

/** An issuer's roots file, checked: canonical text, its issuer, its shape and its signature. Roots as 64 hex. Throws with why. */
export function checkRootsFile(text: string, issuer: string): Root[] {
  const key = publicKeyFromDid(issuer)
  if (!key) throw new Error(`${issuer} is not a did:key`)
  const file = parseCanonical(text) as Record<string, unknown>
  if (canonical(file) !== text) throw new Error('not canonical text')
  if (!file || typeof file !== 'object' || Array.isArray(file) || !exactKeys(file, ['issuer', 'roots', 'sig', 'v']) || file.v !== 1) throw new Error('not a roots file')
  if (file.issuer !== issuer) throw new Error(`it names ${String(file.issuer)}, not ${issuer}`)
  if (!Array.isArray(file.roots) || typeof file.sig !== 'string') throw new Error('not a roots file')
  const { sig, ...unsigned } = file
  let signature: Uint8Array
  try {
    signature = b64u.decode(sig as string)
  } catch {
    throw new Error('its signature is not base64url')
  }
  if (!verifySignature(signature, concat(ROOTS_SIGN_PREFIX, utf8(canonical(unsigned))), key)) throw new Error('its signature does not verify')
  return (file.roots as unknown[]).map((r) => {
    const entry = r as Record<string, unknown>
    if (!entry || typeof entry !== 'object' || !exactKeys(entry, ['root', 'size', 'time'])) throw new Error('a root is not {root, size, time}')
    if (typeof entry.root !== 'string' || !DECIMAL.test(entry.root)) throw new Error('a root is not decimal text')
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new Error("a root's size is not a whole number")
    if (!Number.isSafeInteger(entry.time) || (entry.time as number) < 0) throw new Error("a root's time is not a whole number")
    const value = BigInt(entry.root)
    if (value >= 1n << 256n) throw new Error('a root is more than 32 bytes')
    return { root: hex.encode(toBytes32(value)), size: entry.size as number, time: entry.time as number }
  })
}

/** Keep an issuer's roots. The file only grows; a root already kept stays as it was. Returns how many are new. */
export async function storeRoots(db: Db, issuer: string, roots: Root[]): Promise<number> {
  let added = 0
  for (const r of roots) {
    const res = await db.query(
      `insert into issuer_roots (issuer, root, size, time) values ($1, $2, $3, to_timestamp($4::double precision / 1000))
       on conflict do nothing`,
      [issuer, r.root, r.size, r.time],
    )
    added += res.rowCount ?? 0
  }
  return added
}

/** Every trusted issuer's roots file, read once. A file that fails is reported; the roots already kept stay. */
export async function readRoots(db: Db, issuers: IssuerConfig, onError: (err: unknown) => void, get: typeof fetch = fetch): Promise<number> {
  let added = 0
  for (const [issuer, { roots: url }] of Object.entries(issuers)) {
    if (!url) continue
    try {
      const res = await get(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`answered ${res.status}`)
      added += await storeRoots(db, issuer, checkRootsFile(await res.text(), issuer))
    } catch (err) {
      onError(new Error(`the roots of ${issuer} at ${url}: ${(err as Error).message}`, { cause: err }))
    }
  }
  return added
}

/** Reads the trusted issuers' roots files on a timer: at most once a minute, since issuers add roots in batches. */
export class RootsReader {
  private timer: NodeJS.Timeout | null = null
  private readonly db: Db
  private readonly issuers: IssuerConfig
  private readonly onChange: () => void
  private readonly onError: (err: unknown) => void

  constructor(args: { db: Db; issuers: IssuerConfig; onChange: () => void; onError: (err: unknown) => void }) {
    this.db = args.db
    this.issuers = args.issuers
    this.onChange = args.onChange
    this.onError = args.onError
  }

  async readOnce(): Promise<number> {
    const added = await readRoots(this.db, this.issuers, this.onError)
    if (added > 0) this.onChange()
    return added
  }

  start(intervalMs: number): void {
    const tick = async () => {
      await this.readOnce().catch(this.onError)
      this.timer = setTimeout(tick, Math.max(intervalMs, 60_000))
    }
    void tick()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

// ---------------------------------------------------------------------------------------------
// Memberships: one more trusted issuer for a line, as a record in the profile's folder
// ---------------------------------------------------------------------------------------------

/** The verification key the registry program is sealed with. */
let verificationKey: unknown = null
function sealedKey(): unknown {
  verificationKey ??= JSON.parse(readFileSync(join(INDEX_ROOT, '../forest/registry/artifacts/semaphore-32.json'), 'utf8'))
  return verificationKey
}

/**
 * Check every membership not yet settled. It waits (pending) while its issuer is not one this index
 * trusts, while the index holds no line at its code, or while its root is not one its issuer
 * published; then the registry client's `verifyMembership` decides, against the profile's line, the
 * issuer's roots and the sealed verification key, and that verdict stands for this version of the
 * record. Returns how many were settled.
 */
export async function checkMemberships(db: Db, issuers: IssuerConfig): Promise<number> {
  const { rows } = await db.query(
    `select m.uri, m.did, m.record, m.issuer, m.root, m.why, l.wallet, l.code, l.label, l.root as line_root, l.payer, l.time
     from memberships m left join lines l on l.code = m.code where m.status = 'pending'`,
  )
  let settled = 0
  for (const m of rows) {
    const set = (status: string, why: string | null) =>
      db.query('update memberships set status = $2, why = $3, checked_at = now() where uri = $1', [m.uri, status, why])
    if (!issuers[m.issuer]) {
      if (m.why !== 'issuerNotTrusted') await set('pending', 'issuerNotTrusted')
      continue
    }
    if (!m.code) {
      if (m.why !== 'noLine') await set('pending', 'noLine')
      continue
    }
    const roots = await db.query('select root from issuer_roots where issuer = $1', [m.issuer])
    if (!roots.rows.some((r) => r.root === m.root)) {
      if (m.why !== 'rootNotPublished') await set('pending', 'rootNotPublished')
      continue
    }
    const ok = await verifyMembership(m.record as Membership, {
      profile: publicKeyFromDid(m.did)!,
      line: lineOf({ wallet: m.wallet, code: m.code, label: m.label, root: m.line_root, payer: m.payer, time: m.time }),
      issuer: { key: m.issuer, roots: roots.rows.map((r) => hex.decode(r.root)) },
      verificationKey: sealedKey(),
    })
    await set(ok ? 'valid' : 'invalid', ok ? null : 'doesNotVerify')
    settled++
  }
  return settled
}
