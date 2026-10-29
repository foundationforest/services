// Reading the hosts this index lists, each in full: every entry on the host, for every folder, page
// by page from a cursor kept per host (GET /v1/entries?after=, the standard's `readPage`, which
// checks each entry's text and signature and refuses the rest). Each entry that checks is kept once,
// by its id. Then each folder it touched is viewed again with the standard's `viewFolder`, which
// decides which entry counts at each path as the standard says (the main key's, or an access key's
// the current profile entry lists with write), so this index sees what any other reader of the same
// entries sees:
//
//   profile      the current profile entry, if it has one: its market, role, hosts, open key, pay
//                addresses, access keys and proofs
//   offer/<id>   a post; a delete keeps its last body here for good, marked deleted, so a review
//                that names it still finds it
//   review/<id>  a review; a delete removes it
//   vouch/<id>   a vouch; a delete removes it
//   report/<id>  a report; a delete removes it
//
// A locked entry is left alone at any path: only the keys it was locked to open it. Other paths are
// not this index's.

import { type Checked, encodeEntry, isLocked, MAX_FUTURE_MS, readPage, type SignedEntry, viewFolder } from '@foundationforest/folders'

import type { Store } from './store.ts'

const POST = /^offer\/[^/]+$/
const REVIEW = /^review\/[^/]+$/
/** Vouches and reports, each kind into its own table, as reviews are. */
const SAID = [
  { path: /^vouch\/[^/]+$/, table: 'vouches' },
  { path: /^report\/[^/]+$/, table: 'reports' },
]

/** Every entry new on each host since its cursor; the profiles whose folders they are in. A host that fails is logged and skipped. */
export async function readHosts(store: Store, hosts: string[], log: (line: string) => void): Promise<Set<string>> {
  const { db } = store
  const touched = new Set<string>()
  const cursorOf = db.prepare('select cursor from hosts where url = ?')
  const setCursor = db.prepare('insert into hosts (url, cursor) values (?, ?) on conflict (url) do update set cursor = excluded.cursor')
  const keep = db.prepare('insert or ignore into entries (id, profile, path, time, text) values (?, ?, ?, ?, ?)')
  for (const host of hosts) {
    let cursor = Number((cursorOf.get(host) as { cursor?: number } | undefined)?.cursor ?? 0)
    try {
      for (;;) {
        const page = await readPage(host, { after: cursor })
        if (page.refused.length) log(`${host}: ${page.refused.length} entries refused (${[...new Set(page.refused.map((r) => r.reason))].join(', ')})`)
        const lines = page.entries.length + page.refused.length
        if (!lines && page.cursor === cursor) break
        if (page.cursor <= cursor) throw new Error(`a cursor that does not move forward: ${page.cursor} after ${cursor}`)
        store.tx(() => {
          for (const { entry, id } of page.entries) {
            keep.run(id, entry.profile, entry.path, entry.time, encodeEntry(entry))
            touched.add(entry.profile)
          }
          setCursor.run(host, page.cursor)
        })
        cursor = page.cursor
      }
    } catch (err) {
      log(`${host}: ${(err as Error).message}`)
    }
  }
  return touched
}

/** The profiles holding an entry that was ahead of the clock at `before` and is due by `now`. */
export function comingDue(store: Store, before: number, now: number): string[] {
  const due = store.db.prepare('select distinct profile from entries where time > ? and time <= ?').all(before + MAX_FUTURE_MS, now + MAX_FUTURE_MS)
  return due.map((r) => r.profile as string)
}

/** Every profile this index holds an entry for. */
export function allProfiles(store: Store): string[] {
  return store.db.prepare('select distinct profile from entries').all().map((r) => r.profile as string)
}

/** Every string inside a body, for search. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join(' ')
  return ''
}

const live = (c: Checked | undefined) => (c && c.entry.body !== null && !isLocked(c.entry.body) ? c : undefined)

/** Each folder viewed again from every entry held for it, at `now`, into profiles, posts, reviews, vouches and reports. */
export function viewAgain(store: Store, profiles: Iterable<string>, now: number): void {
  const { db } = store
  const entriesOf = db.prepare('select id, text from entries where profile = ?')
  const upsertProfile = db.prepare(`insert into profiles (address, body, market, role, time) values (?, ?, ?, ?, ?)
    on conflict (address) do update set body = excluded.body, market = excluded.market, role = excluded.role, time = excluded.time`)
  const dropProfile = db.prepare('delete from profiles where address = ?')
  const postsOf = db.prepare('select address from posts where profile = ? and deleted = 0')
  const upsertPost = db.prepare(`insert into posts (address, profile, body, time, deleted) values (?, ?, ?, ?, 0)
    on conflict (address) do update set body = excluded.body, time = excluded.time, deleted = 0`)
  const deletePost = db.prepare('update posts set deleted = 1 where address = ?')
  const hasPost = db.prepare('select 1 from posts where address = ?')
  const keepDeleted = db.prepare('insert into posts (address, profile, body, time, deleted) values (?, ?, ?, ?, 1)')
  const dropText = db.prepare('delete from posts_text where address = ?')
  const addText = db.prepare('insert into posts_text (address, text) values (?, ?)')
  const reviewsOf = db.prepare('select address from reviews where reviewer = ?')
  const upsertReview = db.prepare(`insert into reviews (address, reviewer, subject, body, time) values (?, ?, ?, ?, ?)
    on conflict (address) do update set subject = excluded.subject, body = excluded.body, time = excluded.time`)
  const dropReview = db.prepare('delete from reviews where address = ?')
  const said = SAID.map((k) => ({
    ...k,
    of: db.prepare(`select address from ${k.table} where writer = ?`),
    upsert: db.prepare(`insert into ${k.table} (address, writer, subject, body, time) values (?, ?, ?, ?, ?)
      on conflict (address) do update set subject = excluded.subject, body = excluded.body, time = excluded.time`),
    drop: db.prepare(`delete from ${k.table} where address = ?`),
  }))

  store.tx(() => {
    for (const profile of profiles) {
      const held = entriesOf.all(profile).map((r): Checked => ({ id: r.id as string, entry: JSON.parse(r.text as string) as SignedEntry }))
      const view = viewFolder(profile, held, now)

      const top = live(view.current.get('profile'))
      const body = top?.entry.body as { [key: string]: unknown } | undefined
      if (top && body) {
        const text = (v: unknown) => (typeof v === 'string' ? v : null)
        upsertProfile.run(profile, JSON.stringify(body), text(body.market), text(body.role), top.entry.time)
      } else {
        dropProfile.run(profile)
      }

      const posts = new Set<string>()
      const reviews = new Set<string>()
      const saidHere = new Set<string>()
      for (const [path, c] of view.current) {
        const it = live(c)
        if (!it) continue
        const address = `${profile}/${path}`
        if (POST.test(path)) {
          posts.add(address)
          upsertPost.run(address, profile, JSON.stringify(it.entry.body), it.entry.time)
          dropText.run(address)
          addText.run(address, textOf(it.entry.body))
        } else if (REVIEW.test(path)) {
          reviews.add(address)
          const subject = (it.entry.body as { subject?: unknown }).subject
          upsertReview.run(address, profile, typeof subject === 'string' ? subject : null, JSON.stringify(it.entry.body), it.entry.time)
        } else {
          const kind = said.find((k) => k.path.test(path))
          if (!kind) continue
          saidHere.add(address)
          const subject = (it.entry.body as { subject?: unknown }).subject
          kind.upsert.run(address, profile, typeof subject === 'string' ? subject : null, JSON.stringify(it.entry.body), it.entry.time)
        }
      }
      for (const r of postsOf.all(profile)) if (!posts.has(r.address as string)) deletePost.run(r.address as string)
      // A post deleted before this index first read it: its last body is the newest version that
      // counted until the delete replaced it, when a host still serves it.
      for (const [path, c] of view.current) {
        const address = `${profile}/${path}`
        if (!POST.test(path) || live(c) || hasPost.get(address)) continue
        const last = held.filter((h) => h.entry.path === path && view.ignored.get(h.id) === 'older' && live(h)).sort((a, b) => b.entry.time - a.entry.time || (a.id < b.id ? 1 : -1))[0]
        if (last) keepDeleted.run(address, profile, JSON.stringify(last.entry.body), last.entry.time)
      }
      for (const r of reviewsOf.all(profile)) if (!reviews.has(r.address as string)) dropReview.run(r.address as string)
      for (const k of said) for (const r of k.of.all(profile)) if (!saidHere.has(r.address as string)) k.drop.run(r.address as string)
    }
  })
}
