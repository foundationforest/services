// The record reader: hosts' feeds (forest/records/SPEC.md §7), read directly, with no directory and
// no relay between. Every line a host serves is checked here, whatever the host (`readPage`: the
// canonical text and the signature); a line that fails is dropped and reported.
//
// The index keeps only what counts: the entries of profiles with a line a trusted issuer vouches
// for (issuers.ts). Everything else is dropped as it arrives, but for one thing: the `proof/<id>`
// records of a profile holding some other line, since a membership among them may earn it that
// trust. A host's own word on who is badged is a hint for what to send; the index checks the lines.
//
// Three filters, as a host serves them:
//   since a cursor   every host is read from where this index left off; the cursor is kept in
//                    Postgres, per host and per kind of feed, so a restart resumes there.
//   badged only      the hosts in HOSTS are read in full. Every other host is followed only while
//                    a trusted profile's folder names it, and read for badged profiles only
//                    (`badged=1`): profiles its host counts as badged.
//   by profile       a badged feed shows a profile only from when its host counted it badged, so
//                    the first time a profile turns up in one, its earlier entries are read from
//                    that host by `profile`, once. And when a profile comes to hold a trusted line,
//                    everything dropped before is read again by `profile` from every host this
//                    index follows, and from each its folder names.
//
// Entries are kept as each host served them, in its order (`host_entries`). After each read, each
// profile that changed is merged with forest's own merge (`viewProfile`), and what it holds now
// replaces what the index held for it (store.ts).

import { readAll, readPage } from '../../../forest/records/src/client.ts'
import { MAX_FUTURE_MS, type Entry, encodeEntry, normalizeOrigin } from '../../../forest/records/src/entry.ts'
import { type Version, viewProfile } from '../../../forest/records/src/view.ts'

import { type Db, type Queryable, getCursor, setCursor } from '../db.ts'
import { VOUCHED, linedProfiles, trustedProfiles } from '../issuers.ts'
import { project } from './store.ts'

/**
 * How long one host may take to serve a read. A host still answering after that is left to finish
 * on its own and skipped until it does, so one slow host never holds up the rest.
 */
export const FOLLOW_MS = 60_000

const within = <T>(read: Promise<T>): Promise<T | null> =>
  Promise.race([read, new Promise<null>((resolve) => setTimeout(resolve, FOLLOW_MS, null).unref())])

/**
 * Which of these entries the index keeps: every entry of a profile with a trusted line; of a
 * profile holding only other lines, its `proof/` records, which may earn it one. Nothing else.
 */
export async function keepable(db: Queryable, issuers: string[], versions: Version[]): Promise<Version[]> {
  const dids = [...new Set(versions.map((v) => v.entry.profile))]
  if (!dids.length) return []
  const trusted = await trustedProfiles(db, issuers, dids)
  const lined = await linedProfiles(db, dids.filter((d) => !trusted.has(d)))
  return versions.filter((v) => trusted.has(v.entry.profile) || (lined.has(v.entry.profile) && v.entry.path.startsWith('proof/')))
}

async function insert(db: Queryable, host: string, versions: Version[]): Promise<number> {
  let n = 0
  for (const v of versions) {
    const res = await db.query(
      'insert into host_entries (host, id, profile, path, text) values ($1, $2, $3, $4, $5) on conflict do nothing',
      [host, v.id, v.entry.profile, v.entry.path, encodeEntry(v.entry)],
    )
    n += res.rowCount ?? 0
  }
  return n
}

export class HostReader {
  private readonly db: Db
  /** The hosts read in full. */
  readonly hosts: string[]
  /** The issuers this index trusts, by did:key. */
  private readonly issuers: string[]
  /** The hosts each trusted profile's folder names, as last merged: only these are followed beyond HOSTS. */
  readonly named = new Map<string, string[]>()
  /** A crawled host on loopback is followed only when this index was pointed at one: a local run. */
  private readonly loopback: boolean
  /** Profiles holding entries dated ahead, which the merge holds back, and when they come due. */
  private readonly due = new Map<string, number>()
  /** Hosts whose last read has not finished, and profiles a late read touched, for the next round. */
  private readonly reading = new Set<string>()
  private readonly late = new Set<string>()
  private readonly onChange: () => void
  private readonly onError: (err: unknown) => void
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private polling: Promise<number> | null = null
  private stopped = false

  constructor(args: { db: Db; hosts: string[]; issuers: string[]; onChange: () => void; onError: (err: unknown) => void; now?: () => number }) {
    this.db = args.db
    this.hosts = args.hosts
    this.issuers = args.issuers
    this.loopback = args.hosts.some((h) => h.startsWith('http://'))
    this.onChange = args.onChange
    this.onError = args.onError
    this.now = args.now ?? Date.now
  }

  /** Merge every profile once (the clock moved since the last run), then read on a timer. */
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

  /** A host this index may read: an origin, and on loopback only when this index was pointed at one. */
  private allowed(named: string): string | null {
    const host = normalizeOrigin(named)
    return host && (!host.startsWith('http://') || this.loopback) ? host : null
  }

  /** The hosts to read: the configured ones in full, then every other host a folder names, badged only. */
  following(): { host: string; badged: boolean }[] {
    const out = this.hosts.map((host) => ({ host, badged: false }))
    for (const named of new Set([...this.named.values()].flat())) {
      const host = this.allowed(named)
      if (host && !out.some((o) => o.host === host)) out.push({ host, badged: true })
    }
    return out
  }

  /**
   * Read every host once, then any host the new folders name, until none is new; then catch up the
   * profiles that came to hold a trusted line. Returns how many entries were taken in. A host that
   * does not answer is reported and skipped: the others count.
   */
  pollOnce(): Promise<number> {
    if (!this.polling) {
      this.polling = (async () => {
        let taken = 0
        try {
          const done = new Set<string>()
          for (;;) {
            const next = this.following().filter((f) => !done.has(f.host))
            if (!next.length) break
            for (const { host, badged } of next) {
              done.add(host)
              if (this.reading.has(host)) continue
              this.reading.add(host)
              const read = this.follow(host, badged).finally(() => this.reading.delete(host))
              try {
                const out = await within(read)
                if (out === null) {
                  this.onError(new Error(`reading ${host}: still reading after ${FOLLOW_MS / 1000} s; skipped until it finishes`))
                  read.then(({ profiles }) => profiles.forEach((p) => this.late.add(p)), (err) => this.onError(err))
                  continue
                }
                taken += out.entries
                await this.merge(out.profiles)
              } catch (err) {
                this.onError(new Error(`reading ${host}: ${(err as Error).message}`, { cause: err }))
              }
            }
          }
          taken += await this.catchUp()
          const now = this.now()
          const due = [...this.due].filter(([, at]) => at <= now).map(([p]) => p)
          const late = [...this.late]
          this.late.clear()
          if (due.length || late.length) await this.merge(new Set([...due, ...late]))
        } finally {
          this.polling = null
        }
        return taken
      })()
    }
    return this.polling
  }

  /** One host's feed from this index's cursor to its end. Returns the entries taken in and the profiles they touched. */
  private async follow(host: string, badged: boolean): Promise<{ entries: number; profiles: Set<string> }> {
    const source = badged ? `host:${host}#badged` : `host:${host}`
    const profiles = new Set<string>()
    let entries = 0
    for (;;) {
      const after = Number((await getCursor(this.db, source)) ?? 0)
      const page = await readPage(host, { after, badged })
      for (const r of page.refused) this.onError(new Error(`refused from ${host}: ${r.reason}`))
      const firstSeen: string[] = []
      const client = await this.db.connect()
      try {
        await client.query('begin')
        const kept = await keepable(client, this.issuers, page.versions)
        if (badged) {
          const pageProfiles = [...new Set(kept.map((v) => v.entry.profile))]
          const { rows } = await client.query('select distinct profile from host_entries where host = $1 and profile = any($2)', [host, pageProfiles])
          const held = new Set(rows.map((r) => r.profile as string))
          firstSeen.push(...pageProfiles.filter((p) => !held.has(p)))
        }
        entries += await insert(client, host, kept)
        for (const v of kept) profiles.add(v.entry.profile)
        if (page.cursor > after) await setCursor(client, source, String(page.cursor))
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw err
      } finally {
        client.release()
      }
      for (const profile of firstSeen) entries += await this.readProfile(host, profile)
      if (page.cursor <= after) return { entries, profiles }
    }
  }

  /**
   * A profile's whole feed on one host, by `profile`, in that host's order, as much of it as the
   * index keeps. It replaces what this index held for the profile from that host: it is the same
   * feed, from its start.
   */
  private async readProfile(host: string, profile: string): Promise<number> {
    const page = await readAll(host, { profile })
    for (const r of page.refused) this.onError(new Error(`refused from ${host}: ${r.reason}`))
    const client = await this.db.connect()
    try {
      await client.query('begin')
      const kept = await keepable(client, this.issuers, page.versions.filter((v) => v.entry.profile === profile))
      await client.query('delete from host_entries where host = $1 and profile = $2', [host, profile])
      const n = await insert(client, host, kept)
      await client.query('commit')
      return n
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }

  /** `readProfile` on each host, each within the time a host is given; a late one is merged when it lands. */
  private async readEverywhere(hosts: string[], profile: string): Promise<number> {
    let n = 0
    for (const host of hosts) {
      const read = this.readProfile(host, profile)
      try {
        const out = await within(read)
        if (out === null) {
          this.onError(new Error(`reading ${profile} from ${host}: still reading after ${FOLLOW_MS / 1000} s`))
          read.then(() => this.late.add(profile), (err) => this.onError(err))
          continue
        }
        n += out
      } catch (err) {
        this.onError(new Error(`reading ${profile} from ${host}: ${(err as Error).message}`, { cause: err }))
      }
    }
    return n
  }

  /**
   * Profiles that came to hold a trusted line: everything dropped before is read again, by profile,
   * from every host followed and every host their folders name. Profiles that no longer hold one
   * keep only their proof records. Returns how many entries were taken in.
   */
  async catchUp(): Promise<number> {
    const newly = await this.db.query(
      `select distinct l.did as profile from lines l where ${VOUCHED} and not exists (select 1 from kept k where k.profile = l.did)`,
      [this.issuers],
    )
    const gone = await this.db.query(
      `select k.profile from kept k where not exists (select 1 from lines l where l.did = k.profile and ${VOUCHED})`,
      [this.issuers],
    )
    let n = 0
    for (const { profile } of newly.rows as { profile: string }[]) {
      const followed = this.following().map((f) => f.host)
      n += await this.readEverywhere(followed, profile)
      const folders = await this.merge([profile])
      const more = (folders.get(profile) ?? []).map((h) => this.allowed(h)).filter((h): h is string => h !== null && !followed.includes(h))
      if (more.length) {
        n += await this.readEverywhere(more, profile)
        await this.merge([profile])
      }
      await this.db.query('insert into kept (profile) values ($1) on conflict do nothing', [profile])
    }
    for (const { profile } of gone.rows as { profile: string }[]) {
      await this.db.query(`delete from host_entries where profile = $1 and path not like 'proof/%'`, [profile])
      await this.db.query('delete from kept where profile = $1', [profile])
      await this.merge([profile])
    }
    return n
  }

  /**
   * Merge each profile from every host's feed of it, and store what it holds now: everything, for a
   * profile with a trusted line; its memberships alone for any other. Returns each kept profile's
   * folder hosts.
   */
  async merge(profiles: Iterable<string>): Promise<Map<string, string[]>> {
    const list = [...new Set(profiles)]
    const folders = new Map<string, string[]>()
    if (!list.length) return folders
    const trusted = await trustedProfiles(this.db, this.issuers, list)
    for (const profile of list) {
      const now = this.now()
      const { rows } = await this.db.query('select host, id, text from host_entries where profile = $1 order by host, seq', [profile])
      const feeds = new Map<string, Version[]>()
      for (const r of rows) {
        const feed = feeds.get(r.host) ?? []
        feed.push({ id: r.id, entry: JSON.parse(r.text) as Entry })
        feeds.set(r.host, feed)
      }
      const view = viewProfile(profile, feeds.values(), now)
      const ahead = rows.map((r) => (JSON.parse(r.text) as Entry).time).filter((t) => t > now + MAX_FUTURE_MS)
      if (ahead.length) this.due.set(profile, Math.min(...ahead) - MAX_FUTURE_MS)
      else this.due.delete(profile)
      const keep = trusted.has(profile)
      if (keep) {
        const hosts = view.folder?.hosts ?? []
        folders.set(profile, hosts)
        this.named.set(profile, hosts)
      } else {
        // A profile that lost its trusted line, or never had one, names no host this index follows.
        this.named.delete(profile)
      }
      const out = await project(this.db, view, keep)
      for (const r of out.refused) this.onError(new Error(`refused ${profile}/${r.path}: ${r.why}`))
    }
    this.onChange()
    return folders
  }

  async mergeAll(): Promise<void> {
    const { rows } = await this.db.query('select distinct profile from host_entries')
    await this.merge(rows.map((r) => r.profile as string))
  }
}

/**
 * Entries straight into the store as one host's feed, in order, as much as the index keeps, then
 * merged: what the reader does with a page, for callers that already hold checked entries (the
 * page tests' fixture).
 */
export async function takeIn(db: Db, host: string, versions: Version[], issuers: string[], onError: (err: unknown) => void = () => {}): Promise<number> {
  const kept = await keepable(db, issuers, versions)
  await insert(db, host, kept)
  const reader = new HostReader({ db, hosts: [], issuers, onChange: () => {}, onError })
  await reader.merge(kept.map((v) => v.entry.profile))
  await db.query('insert into kept (profile) select unnest($1::text[]) on conflict do nothing', [[...(await trustedProfiles(db, issuers))]])
  return kept.length
}
