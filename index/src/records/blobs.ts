// Pictures (standard/records/README.md, "Blobs"): a profile's `photo`, and the `media` of an offer or a
// review, name bytes by their SHA-256, with a type and a size. The bytes stay on the hosts; the pages
// show them from there (GET /v1/blobs/<sha256>).
//
// For each picture a stored record names, the readers ask each listed host that served that record
// for the bytes, with forest's `getBlob`, which hashes them: bytes that are not the hash count as not
// held. What holds is kept as host, hash and the type the host serves them as, never the bytes
// (`blobs`). A picture not held yet is asked for again after the next read, since an app posts the
// record first and the bytes after it.

import { getBlob } from '../../../standard/records/src/client.ts'

import type { Db } from '../db.ts'

/** Every picture a stored record names: the record's id, and the bytes' SHA-256. */
const NAMED = `
  select o.id, m->>'sha256' as sha256 from offers o cross join jsonb_array_elements(coalesce(o.record->'media', '[]')) m
  union select v.id, m->>'sha256' from reviews v cross join jsonb_array_elements(coalesce(v.record->'media', '[]')) m
  union select p.id, p.record->'photo'->>'sha256' from profiles p where p.record ? 'photo'`

/**
 * Ask `hosts` for every picture a stored record they served names and they are not yet known to
 * hold. Returns how many they now hold. A host that does not answer holds nothing, this time.
 */
export async function checkBlobs(db: Db, hosts: string[]): Promise<number> {
  const { rows } = await db.query(
    `select distinct h.host, n.sha256 from (${NAMED}) n join host_records h on h.id = n.id
     where h.host = any($1) and not exists (select 1 from blobs b where b.sha256 = n.sha256 and b.host = h.host)
     order by h.host, n.sha256`,
    [hosts],
  )
  let held = 0
  for (const r of rows) {
    const got = await getBlob([r.host], r.sha256)
    if (!got) continue
    await db.query('insert into blobs (sha256, host, type) values ($1, $2, $3) on conflict do nothing', [r.sha256, r.host, got.type])
    held++
  }
  return held
}
