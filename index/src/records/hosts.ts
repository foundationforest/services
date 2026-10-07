// The record reader: what's new on each host in lists/hosts.json, for the whole host, so a profile
// this index has never seen is found the first time it writes there (forest/records/README.md,
// "Hosts": `GET /v1/records?after=`). No other host is read: a profile's hosts record is not
// followed, and nothing is looked up by profile.
//
// Every record a host serves is checked by forest's reader (`readPage`: its canonical text and its
// signature); one that fails is dropped and reported. Every record that checks is kept, as its
// canonical text, per host, in the order taken (`host_records`), and a cursor per host, kept in
// Postgres, says where to resume.
//
// After each read, each profile that changed is viewed with forest's own `viewProfile`, which
// applies the access rule (an access key's record counts while the permissions record lists the key
// with scope write or revoked, its paths covering the record's; no date is checked; the owner wins),
// and what the view holds now replaces what the index held for it (store.ts). Only a profile holding a counted row is stored; any other's records wait in
// `host_records`, so the day its row is read it is stored with nothing to read again.
//
// Then the pictures stored records name are asked for on the hosts that served them (blobs.ts).

import { readPage } from '../../../forest/records/src/client.ts'
import { type Checked, MAX_FUTURE_MS, type SignedRecord, encodeRecord } from '../../../forest/records/src/record.ts'
import { viewProfile } from '../../../forest/records/src/view.ts'

import { countedProfiles } from '../chain/registry.ts'
import type { IssuerConfig } from '../config.ts'
import { type Db, type Queryable, getCursor, setCursor } from '../db.ts'
import { checkBlobs } from './blobs.ts'
import { project } from './store.ts'

/** How long one host may take to serve a page. Past that the read fails, and the next poll tries again. */
export const READ_MS = 60_000

async function insert(db: Queryable, host: string, records: Checked[]): Promise<number> {
  let n = 0
  for (const c of records) {
    const res = await db.query(
      'insert into host_records (host, id, profile, path, text) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [host, c.id, c.record.profile, c.record.path, encodeRecord(c.record)],
    )
    n += res.rowCount ?? 0
  }
  return n
}

export class HostReader {
  private readonly db: Db
  /** The hosts read, each in full. */
  readonly hosts: string[]
  /** The issuers this index trusts, as lists/issuers.json gives them. */
  private readonly issuers: IssuerConfig
  /** The indexes whose reputation proofs count here, by address. */
  private readonly indexes: string[]
  /** Profiles holding records dated ahead, which the view holds back, and when they come due. */
  private readonly due = new Map<string, number>()
  private readonly onChange: () => void
  private readonly onError: (err: unknown) => void
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<number> | null = null
  /** Views run one at a time, whoever asks: the poll, or the chain reader for a profile with a new row. */
  private merging: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(args: {
    db: Db
    hosts: string[]
    issuers: IssuerConfig
    indexes: string[]
    onChange: () => void
    onError: (err: unknown) => void
    now?: () => number
  }) {
    this.db = args.db
    this.hosts = args.hosts
    this.issuers = args.issuers
    this.indexes = args.indexes
    this.onChange = args.onChange
    this.onError = args.onError
    this.now = args.now ?? Date.now
  }

  /** View every profile once (the clock moved since the last run), then read on a timer. */
  async start(intervalMs: number): Promise<void> {
    await this.mergeAll()
    const tick = async () => {
      if (this.stopped) return
      try {
        await this.pollOnce()
      } catch (err) {
        this.onError(err)
      }
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs)
    }
    void tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Read every host once, from its cursor to its end, then view what changed, and every profile
   * whose records dated ahead came due, then ask for the pictures not yet held. Returns how many
   * records were taken in. A host that fails is reported and skipped: the others count.
   */
  pollOnce(): Promise<number> {
    if (!this.polling) {
      this.polling = (async () => {
        let taken = 0
        const touched = new Set<string>()
        try {
          for (const host of this.hosts) {
            try {
              taken += await this.follow(host, touched)
            } catch (err) {
              this.onError(new Error(`reading ${host}: ${(err as Error).message}`, { cause: err }))
            }
          }
          const now = this.now()
          for (const [p, at] of this.due) if (at <= now) touched.add(p)
          if (touched.size) await this.merge(touched)
          await checkBlobs(this.db, this.hosts)
        } finally {
          this.polling = null
        }
        return taken
      })()
    }
    return this.polling
  }

  /** One host's records from this index's cursor to its end. Adds the profiles they name to `touched`. */
  private async follow(host: string, touched: Set<string>): Promise<number> {
    const source = `host:${host}`
    let taken = 0
    for (;;) {
      const after = Number((await getCursor(this.db, source)) ?? 0)
      const page = await readPage(host, { after, timeout: READ_MS })
      for (const r of page.refused) this.onError(new Error(`refused from ${host}: ${r.reason}`))
      const client = await this.db.connect()
      try {
        await client.query('begin')
        taken += await insert(client, host, page.records)
        if (page.cursor > after) await setCursor(client, source, String(page.cursor))
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
      for (const c of page.records) touched.add(c.record.profile)
      if (page.cursor <= after) return taken
    }
  }

  /**
   * View each profile from every record held for it, from every host, and store what the view holds
   * now: everything, for a profile holding a counted row; nothing for any other.
   */
  merge(profiles: Iterable<string>): Promise<void> {
    const list = [...new Set(profiles)]
    const run = this.merging.then(() => this.mergeNow(list))
    this.merging = run.catch(() => {})
    return run
  }

  private async mergeNow(list: string[]): Promise<void> {
    if (!list.length) return
    const counted = await countedProfiles(this.db, this.issuers, list)
    for (const profile of list) {
      const now = this.now()
      // Each was checked when it was taken in; its signature is not checked again.
      const { rows } = await this.db.query('select id, text from host_records where profile = $1', [profile])
      const records: Checked[] = rows.map((r) => ({ id: r.id as string, record: JSON.parse(r.text as string) as SignedRecord }))
      const view = viewProfile(profile, records, now)
      const ahead = records.map((c) => c.record.time).filter((t) => t > now + MAX_FUTURE_MS)
      if (ahead.length) this.due.set(profile, Math.min(...ahead) - MAX_FUTURE_MS)
      else this.due.delete(profile)
      const out = await project(this.db, view, counted.has(profile), this.indexes)
      for (const r of out.refused) this.onError(new Error(`refused ${profile}/${r.path}: ${r.why}`))
    }
    this.onChange()
  }

  async mergeAll(): Promise<void> {
    const { rows } = await this.db.query('select distinct profile from host_records')
    await this.merge(rows.map((r) => r.profile as string))
  }
}

/**
 * Records straight into the store as one host's, then viewed: what the reader does with a page,
 * for callers that already hold checked records (the page tests' fixture).
 */
export async function takeIn(
  db: Db,
  host: string,
  records: Checked[],
  lists: { issuers: IssuerConfig; indexes: string[] },
  onError: (err: unknown) => void = () => {},
): Promise<number> {
  const n = await insert(db, host, records)
  const reader = new HostReader({ db, hosts: [], ...lists, onChange: () => {}, onError })
  await reader.merge(records.map((c) => c.record.profile))
  return n
}
