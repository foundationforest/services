// The record reader: hosts' feeds (forest/records/SPEC.md §7), read directly, with no directory and
// no relay between. Every line a host serves is checked here, whatever the host (`readPage`: the
// canonical text and the signature); a line that fails is dropped and reported.
//
// Three filters, as a host serves them:
//   since a cursor   every host is read from where this index left off; the cursor is kept in
//                    Postgres, per host and per kind of feed, so a restart resumes there.
//   badged only      the hosts in HOSTS are read in full. Every other host a folder names is read
//                    for badged profiles only (`badged=1`): profiles its host counts as badged.
//   by profile       a badged feed shows a profile only from when its host counted it badged, so
//                    the first time a profile turns up in one, its earlier entries are read from
//                    that host by `profile`, once.
//
// Entries are kept as each host served them, in its order (`host_entries`). After each read, each
// profile that changed is merged with forest's own merge (`viewProfile`), and what it holds now
// replaces what the index held for it (store.ts).

import { readAll, readPage } from '../../../forest/records/src/client.ts'
import { MAX_FUTURE_MS, type Entry, encodeEntry, normalizeOrigin } from '../../../forest/records/src/entry.ts'
import { type Version, viewProfile } from '../../../forest/records/src/view.ts'

import { type Db, getCursor, setCursor } from '../db.ts'
import { project } from './store.ts'

/**
 * How long one host may take to serve its feed in one round. A host still answering after that is
 * left to finish on its own and skipped until it does, so one slow host never holds up the rest.
 */
export const FOLLOW_MS = 60_000

export class HostReader {
  private readonly db: Db
  /** The hosts read in full. */
  readonly hosts: string[]
  /** Every host the folders merged so far name. */
  readonly named = new Set<string>()
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

  constructor(args: { db: Db; hosts: string[]; onChange: () => void; onError: (err: unknown) => void; now?: () => number }) {
    this.db = args.db
    this.hosts = args.hosts
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

  /** The hosts to read: the configured ones in full, then every other host a folder names, badged only. */
  following(): { host: string; badged: boolean }[] {
    const out = this.hosts.map((host) => ({ host, badged: false }))
    for (const named of this.named) {
      const host = normalizeOrigin(named)
      if (!host || this.hosts.includes(host) || out.some((o) => o.host === host)) continue
      if (host.startsWith('http://') && !this.loopback) continue
      out.push({ host, badged: true })
    }
    return out
  }

  /**
   * Read every host once, then any host the new folders name, until none is new. Returns how many
   * entries were taken in. A host that does not answer is reported and skipped: the others count.
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
              const timer = new Promise<null>((resolve) => setTimeout(resolve, FOLLOW_MS, null).unref())
              try {
                const out = await Promise.race([read, timer])
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
        if (badged) {
          const pageProfiles = [...new Set(page.versions.map((v) => v.entry.profile))]
          const { rows } = await client.query('select distinct profile from host_entries where host = $1 and profile = any($2)', [host, pageProfiles])
          const held = new Set(rows.map((r) => r.profile as string))
          firstSeen.push(...pageProfiles.filter((p) => !held.has(p)))
        }
        for (const v of page.versions) {
          const inserted = await client.query(
            'insert into host_entries (host, id, profile, text) values ($1, $2, $3, $4) on conflict do nothing',
            [host, v.id, v.entry.profile, encodeEntry(v.entry)],
          )
          entries += inserted.rowCount ?? 0
          profiles.add(v.entry.profile)
        }
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
   * A profile's whole feed on one host, by `profile`, in that host's order. It replaces what this
   * index held for the profile from that host: it is the same feed, from its start.
   */
  private async readProfile(host: string, profile: string): Promise<number> {
    const page = await readAll(host, { profile })
    for (const r of page.refused) this.onError(new Error(`refused from ${host}: ${r.reason}`))
    const versions = page.versions.filter((v) => v.entry.profile === profile)
    const client = await this.db.connect()
    try {
      await client.query('begin')
      await client.query('delete from host_entries where host = $1 and profile = $2', [host, profile])
      for (const v of versions) {
        await client.query('insert into host_entries (host, id, profile, text) values ($1, $2, $3, $4) on conflict do nothing', [
          host,
          v.id,
          profile,
          encodeEntry(v.entry),
        ])
      }
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
    return versions.length
  }

  /** Merge each profile from every host's feed of it, and store what it holds now. */
  async merge(profiles: Iterable<string>): Promise<void> {
    let changed = false
    for (const profile of profiles) {
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
      for (const host of view.folder?.hosts ?? []) this.named.add(host)
      const out = await project(this.db, view)
      for (const r of out.refused) this.onError(new Error(`refused ${profile}/${r.path}: ${r.why}`))
      changed = true
    }
    if (changed) this.onChange()
  }

  async mergeAll(): Promise<void> {
    const { rows } = await this.db.query('select distinct profile from host_entries')
    await this.merge(rows.map((r) => r.profile as string))
  }
}

/**
 * Entries straight into the store as one host's feed, in order, then merged: what the reader does
 * with a page, for callers that already hold checked entries (the page tests' fixture).
 */
export async function takeIn(db: Db, host: string, versions: Version[], onError: (err: unknown) => void = () => {}): Promise<void> {
  for (const v of versions) {
    await db.query('insert into host_entries (host, id, profile, text) values ($1, $2, $3, $4) on conflict do nothing', [
      host,
      v.id,
      v.entry.profile,
      encodeEntry(v.entry),
    ])
  }
  const reader = new HostReader({ db, hosts: [], onChange: () => {}, onError })
  await reader.merge(new Set(versions.map((v) => v.entry.profile)))
}
