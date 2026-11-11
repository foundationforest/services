// The morning email: an optional email, off until a person turns it on, with once a day, in their
// morning, a count of what's new on the profiles they chose, never what a message says. The host
// sends it, since it already sees what arrives. It stands in front of the host API, as the credits
// do, and reads what the host API holds as any reader in this process would: an inbox's entries,
// the feed of every folder's entries, and a folder's profile entry. It keeps no count.
//
//   POST /email                 { email, timeZone, profiles: [{ profile, sig }] }: each profile
//                               signed by its main key over emailMessage (../client/email.ts); emails
//                               a 6-digit code, answers { id }
//   POST /email/confirm         { id, code }: turns it on
//   POST /email/<id>            { timeZone, profiles }: changes them, with no code
//   GET  /email/stop/<id>       a page with one Stop button
//   POST /email/stop/<id>       turns it off and deletes all of it
//
// One email address per profile: confirming, or a change, takes the profiles it lists away from any
// other email address, and one left with none is deleted. So changing the email address is turning
// it on again with the new one.
//
// Every quarter hour it looks for the email addresses whose time zone is between 8:00 and 9:00 and
// that have not had an email that day there, and counts, since the last email (at first, since it
// was confirmed): the inbox entries that arrived for each profile, and the reviews, vouches and
// reports this host took whose subject is one of the profiles. Something new: one email, sent
// through Resend's API. Nothing new: nothing.
//
// What it keeps, in DATA_DIR/email/email.sqlite, and nothing else: for each email address, a random
// id (the stop link's, and the app's for a change), the email address, its time zone, the
// profiles, when it was confirmed and when it last sent; until it is confirmed, its code, when that
// was sent and the wrong tries. In memory only, for a day: when codes went to each email address,
// so nobody floods one. Its file overwrites what it deletes (secure_delete) and keeps SQLite's
// rollback journal, so turning it off leaves none of it in the file. It logs one line when Resend
// refuses an email, its status only.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { PROFILE_PATH, type SignedEntry, checkSignature, publicKeyFromAddress } from '@foundationforest/folders'
import { base64urlnopad } from '@scure/base'

import { emailMessage } from '../client/email.ts'
import { type Answer, refuse } from '../credits/seller.ts'
import { DAY, type Host } from './plug.ts'
import { logLine } from './storage.ts'

/** This host's choices for the morning email: each number README.md's How we run it says. */
export const emailChoice = {
  /** The hour of the day, in the person's time zone, it sends in. */
  hour: 8,
  /** How often it looks, in minutes: every UTC offset is a multiple of 15, so a local hour starts on one. */
  everyMinutes: 15,
  /** How long a code works, in minutes; an email address not confirmed by then is deleted. */
  codeMinutes: 15,
  /** Wrong codes before the code, and its email address, are deleted. */
  tries: 5,
  /** The least time between two codes to one email address, in seconds. */
  codeGapSeconds: 60,
  /** Codes to one email address in a day. */
  codesADay: 5,
  /** Codes from the whole host in an hour. */
  codesAnHour: 100,
  /** Profiles one email address counts. */
  maxProfiles: 50,
  /** The longest email address, as RFC 5321 bounds one. */
  maxEmail: 254,
  /** Times Resend is asked again when it answers 429, too many at once. */
  retries: 3,
} as const

export type EmailConfig = {
  /** Resend's API key, a sending-only one. */
  key: string
  /** Who the emails are from: `Forest <notify@forest.foundation>`. */
  from: string
  /** Where the email's button goes: the app. */
  app: string
}

export type EmailOptions = EmailConfig & {
  /** Its own directory, DATA_DIR/email. */
  dir: string
  /** The host's public origin: what each profile signs, and where the stop link is. */
  origin: string
  host: Host
  now?: () => number
  /** Resend's API, or a stand-in for tests. */
  resendUrl?: string
}

/** An email address turned on, or waiting for its code, as its file holds it. */
type Line = {
  id: string
  email: string
  time_zone: string
  /** The profiles' addresses, in the order chosen, as JSON. */
  profiles: string
  confirmed: number | null
  sent: number | null
  code: string | null
  code_sent: number | null
  tries: number
}

/** The reviews, vouches and reports taken since a time: for each folder and path, its newest version's number and subject. */
type About = Map<string, { seq: number; kind: Kind; subject: string | null }>
type Letter = { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }
type Kind = 'message' | 'review' | 'vouch' | 'report'
const KINDS: Kind[] = ['message', 'review', 'vouch', 'report']
const PLURAL: Record<Kind, string> = { message: 'messages', review: 'reviews', vouch: 'vouches', report: 'reports' }
/** A review, a vouch or a report, at its kind's path, as the markets write them: `review/<id>`. */
const ABOUT = /^(review|vouch|report)\/[^/]+$/
/** An id: 16 random bytes in base64url. */
export const ID = /^[A-Za-z0-9_-]{22}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A market's name in words, as the markets manual and the index write it: `home-cleaning` is "Home cleaning". */
const inWords = (name: string) => {
  const words = name.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
const isObject = (value: unknown, keys: string): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).sort().join() === keys

const formats = new Map<string, Intl.DateTimeFormat>()
/** The day, `YYYY-MM-DD`, and the hour, 0 to 23, at `time` in `timeZone`. */
function local(timeZone: string, time: number): { day: string; hour: number } {
  let format = formats.get(timeZone)
  if (!format) formats.set(timeZone, (format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })))
  const part = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value]))
  return { day: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) }
}

/** A time zone as Intl names it, `America/Mexico_City`; undefined for one it does not know. */
function zoneOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

const page = (body: string): Answer => ({
  status: 200,
  type: 'text/html; charset=utf-8',
  body: new TextEncoder().encode(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Forest emails</title></head>` +
      `<body style="margin:0;background:#ffffff"><div style="max-width:480px;margin:48px auto;padding:0 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f2a24">${body}</div></body></html>`,
  ),
})

/** The page the stop link opens: one button, so a mail scanner that opens every link stops nothing. */
export const STOP_PAGE = page(
  `<p style="margin:0 0 24px">Stop the morning emails from Forest?</p>` +
    `<form method="post" style="margin:0"><button type="submit" style="background:#2f6b4f;color:#ffffff;border:0;border-radius:8px;padding:12px 20px;font-family:inherit;font-size:16px;font-weight:600;cursor:pointer">Stop these emails</button></form>`,
)
/** What a stop answers, whatever the id: it says nothing of which ids there are. */
export const STOPPED_PAGE = page(`<p style="margin:0">These emails are stopped. You can turn them on again in Forest.</p>`)

export class Email {
  readonly #db: DatabaseSync
  readonly #host: Host
  readonly #origin: string
  readonly #config: EmailConfig
  readonly #now: () => number
  readonly #resend: string
  /** When codes went to each email address, lower case, in the past day; and to any, in the past hour. */
  readonly #codes = new Map<string, number[]>()
  #lastHour: number[] = []
  #running = false
  #closed = false
  #timer?: NodeJS.Timeout

  constructor(options: EmailOptions) {
    mkdirSync(options.dir, { recursive: true })
    this.#db = new DatabaseSync(join(options.dir, 'email.sqlite'))
    // Deleted bytes are overwritten, and the rollback journal is kept (no WAL), so what is turned
    // off is gone from the file, not only from its lists.
    this.#db.exec(`
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,          -- random: the stop link's, and the app's for a change
        email TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        profiles TEXT NOT NULL,       -- the profiles' addresses, as JSON, in the order chosen
        confirmed INTEGER,            -- when its code confirmed it; null until then
        sent INTEGER,                 -- when it last sent
        code TEXT,                    -- until it is confirmed
        code_sent INTEGER,
        tries INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
    `)
    this.#host = options.host
    this.#origin = options.origin
    this.#config = { key: options.key, from: options.from, app: options.app }
    this.#now = options.now ?? Date.now
    this.#resend = options.resendUrl ?? 'https://api.resend.com'
  }

  // ------------------------------------------------------------------------------------------
  // Turning it on, changing it, turning it off

  /** `POST /email`: checks each profile's signature, then emails a code. */
  async on(body: unknown): Promise<Answer> {
    if (!isObject(body, 'email,profiles,timeZone')) return refuse('bad_request', 400, 'the body is { email, timeZone, profiles }')
    const { email, profiles: list } = body
    if (typeof email !== 'string' || email.length > emailChoice.maxEmail || !EMAIL.test(email)) return refuse('bad_request', 400, 'not an email address')
    const timeZone = zoneOf(body.timeZone)
    if (!timeZone) return refuse('bad_request', 400, 'timeZone is a time zone, such as America/Mexico_City')
    const profiles = this.#signed(email, list)
    if (!Array.isArray(profiles)) return profiles
    const now = this.#now()
    if (!this.#mayCode(email, now)) return refuse('too_soon', 429, `a code to one email address once a minute and ${emailChoice.codesADay} times a day`)
    const id = base64urlnopad.encode(randomBytes(16))
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.#db.prepare('INSERT INTO emails (id, email, time_zone, profiles, code, code_sent) VALUES (?, ?, ?, ?, ?, ?)').run(id, email, timeZone, JSON.stringify(profiles), code, now)
    try {
      await this.#send(codeLetter(email, code))
    } catch (err) {
      this.#db.prepare('DELETE FROM emails WHERE id = ?').run(id)
      logLine(`email: ${(err as Error).message}`)
      return refuse('not_sent', 502, 'Resend did not take the email with the code')
    }
    return { status: 200, body: { id } }
  }

  /** `POST /email/confirm`: the right code turns it on; a wrong one counts against it. */
  confirm(body: unknown): Answer {
    const wrong = refuse('code', 400, 'the code is wrong, or it has expired')
    if (!isObject(body, 'code,id') || typeof body.id !== 'string' || typeof body.code !== 'string') return refuse('bad_request', 400, 'the body is { id, code }')
    const now = this.#now()
    this.#forget(now)
    const line = this.#db.prepare('SELECT * FROM emails WHERE id = ? AND code IS NOT NULL').get(body.id) as Line | undefined
    if (!line) return wrong
    const right = /^[0-9]{6}$/.test(body.code) && timingSafeEqual(Buffer.from(body.code), Buffer.from(line.code!))
    if (!right) {
      if (line.tries + 1 >= emailChoice.tries) this.#db.prepare('DELETE FROM emails WHERE id = ?').run(line.id)
      else this.#db.prepare('UPDATE emails SET tries = tries + 1 WHERE id = ?').run(line.id)
      return wrong
    }
    this.#together(() => {
      this.#claim(line.id, JSON.parse(line.profiles) as string[])
      this.#db.prepare('UPDATE emails SET confirmed = ?, code = NULL, code_sent = NULL, tries = 0 WHERE id = ?').run(now, line.id)
    })
    return { status: 200, body: { id: line.id } }
  }

  /** `POST /email/<id>`: new profiles, each signed for its email address, and a time zone; no code. */
  change(id: string, body: unknown): Answer {
    const line = this.#db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Line | undefined
    if (!line) return refuse('unknown', 404, 'no email is turned on with this id here')
    if (!isObject(body, 'profiles,timeZone')) return refuse('bad_request', 400, 'the body is { timeZone, profiles }')
    const timeZone = zoneOf(body.timeZone)
    if (!timeZone) return refuse('bad_request', 400, 'timeZone is a time zone, such as America/Mexico_City')
    const profiles = this.#signed(line.email, body.profiles)
    if (!Array.isArray(profiles)) return profiles
    this.#together(() => {
      if (line.confirmed !== null) this.#claim(id, profiles)
      this.#db.prepare('UPDATE emails SET time_zone = ?, profiles = ? WHERE id = ?').run(timeZone, JSON.stringify(profiles), id)
    })
    return { status: 200, body: { id } }
  }

  /** `POST /email/stop/<id>`: deletes all it keeps of that email address. */
  stop(id: string): void {
    this.#db.prepare('DELETE FROM emails WHERE id = ?').run(id)
  }

  /**
   * The profiles a list names, each `{ profile, sig }`, signed by its main key for `email` here,
   * each a folder here whose profile entry names a market and a role; else the refusal.
   */
  #signed(email: string, list: unknown): string[] | Answer {
    if (!Array.isArray(list) || list.length < 1 || list.length > emailChoice.maxProfiles) return refuse('bad_request', 400, `from 1 to ${emailChoice.maxProfiles} profiles`)
    const profiles: string[] = []
    for (const item of list) {
      if (!isObject(item, 'profile,sig') || typeof item.profile !== 'string' || typeof item.sig !== 'string' || !publicKeyFromAddress(item.profile) || profiles.includes(item.profile)) {
        return refuse('bad_request', 400, 'each profile is { profile, sig }: an address, once, and its signature')
      }
      let sig: Uint8Array
      try {
        sig = base64urlnopad.decode(item.sig)
      } catch {
        return refuse('not_signed', 400, item.profile)
      }
      if (!checkSignature(sig, emailMessage(this.#origin, item.profile, email), item.profile)) return refuse('not_signed', 400, item.profile)
      profiles.push(item.profile)
    }
    for (const profile of profiles) if (!this.#nameOf(profile)) return refuse('not_here', 400, profile)
    return profiles
  }

  /** A profile in words, from its profile entry here, as the index writes a label: "Tutoring tutor"; null without a market and a role. */
  #nameOf(profile: string): string | null {
    const { market, role } = (this.#host.view(profile).current.get(PROFILE_PATH)?.entry.body ?? {}) as { market?: unknown; role?: unknown }
    return typeof market === 'string' && typeof role === 'string' ? `${inWords(market)} ${role.replaceAll('-', ' ')}` : null
  }

  /** Takes `profiles` away from every email address but `id`'s; one left with none is deleted. */
  #claim(id: string, profiles: string[]): void {
    for (const other of this.#db.prepare('SELECT id, profiles FROM emails WHERE id != ?').all(id) as Array<{ id: string; profiles: string }>) {
      const had = JSON.parse(other.profiles) as string[]
      const left = had.filter((p) => !profiles.includes(p))
      if (left.length === had.length) continue
      if (left.length) this.#db.prepare('UPDATE emails SET profiles = ? WHERE id = ?').run(JSON.stringify(left), other.id)
      else this.#db.prepare('DELETE FROM emails WHERE id = ?').run(other.id)
    }
  }

  #together(work: () => void): void {
    this.#db.exec('BEGIN')
    try {
      work()
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
  }

  /** Whether a code may go to `email` now, by the limits; if so, it is counted. */
  #mayCode(email: string, now: number): boolean {
    this.#forget(now)
    const key = email.toLowerCase()
    const times = this.#codes.get(key) ?? []
    if (times.length >= emailChoice.codesADay || (times.at(-1) ?? -Infinity) > now - emailChoice.codeGapSeconds * 1000) return false
    if (this.#lastHour.length >= emailChoice.codesAnHour) return false
    this.#codes.set(key, [...times, now])
    this.#lastHour.push(now)
    return true
  }

  /** Forgets codes sent more than a day ago, and the email addresses whose code has expired. */
  #forget(now: number): void {
    for (const [key, times] of this.#codes) {
      const kept = times.filter((t) => t > now - DAY)
      if (kept.length) this.#codes.set(key, kept)
      else this.#codes.delete(key)
    }
    this.#lastHour = this.#lastHour.filter((t) => t > now - HOUR)
    this.#db.prepare('DELETE FROM emails WHERE confirmed IS NULL AND code_sent <= ?').run(now - emailChoice.codeMinutes * MINUTE)
  }

  // ------------------------------------------------------------------------------------------
  // The morning

  /**
   * One look: each confirmed email address whose time zone is in its sending hour and that has not
   * sent that day there gets one email if anything is new since its last one. Returns how many
   * went. One look at a time.
   */
  async morning(): Promise<number> {
    if (this.#running) return 0
    this.#running = true
    try {
      const now = this.#now()
      this.#forget(now)
      const due = (this.#db.prepare('SELECT * FROM emails WHERE confirmed IS NOT NULL').all() as Line[]).filter((line) => {
        const today = local(line.time_zone, now)
        return today.hour === emailChoice.hour && (line.sent === null || local(line.time_zone, line.sent).day !== today.day)
      })
      if (!due.length) return 0
      // Counted since the last email, and never further back than the host keeps an inbox entry:
      // anything older about these profiles was counted by an earlier morning, which sent for it.
      const floor = now - this.#host.keepDays * DAY
      const sinceOf = (line: Line) => Math.max(line.sent ?? line.confirmed!, floor)
      const about = this.#aboutSince(due.reduce((least, line) => Math.min(least, sinceOf(line)), now))
      let sent = 0
      for (const line of due) {
        const since = sinceOf(line)
        const counts = (JSON.parse(line.profiles) as string[]).map((profile) => ({ profile, ...this.#count(profile, since, about) }))
        const news = counts.filter((c) => KINDS.some((k) => c[k] > 0))
        if (!news.length) continue
        const total = Object.fromEntries(KINDS.map((k) => [k, news.reduce((n, c) => n + c[k], 0)])) as Record<Kind, number>
        const names = news.map((c) => this.#nameOf(c.profile) ?? 'Forest profile')
        const day = local(line.time_zone, now).day
        try {
          await this.#send(morningLetter(line.email, total, names, this.#config.app, `${this.#origin}/email/stop/${line.id}`), `${line.id}/${day}`)
          this.#db.prepare('UPDATE emails SET sent = ? WHERE id = ?').run(now, line.id)
          sent++
        } catch (err) {
          logLine(`email: ${(err as Error).message}`)
        }
      }
      return sent
    } finally {
      this.#running = false
    }
  }

  /**
   * The reviews, vouches and reports this host took after `since`: for each folder and path, its
   * newest version's number and subject, null for a deletion. Read in full before anything waits.
   */
  #aboutSince(since: number): About {
    const about: About = new Map()
    for (const taken of this.#host.entriesAfter(since * 1000)) {
      const entry = JSON.parse(taken.text) as SignedEntry
      const kind = ABOUT.exec(entry.path)?.[1] as Kind | undefined
      if (!kind) continue
      const subject = entry.body && typeof entry.body.subject === 'string' ? entry.body.subject : null
      about.set(`${entry.profile} ${entry.path}`, { seq: taken.seq, kind, subject })
    }
    return about
  }

  /**
   * What is new on `profile` since `since`: its inbox entries that arrived after, and the reviews,
   * vouches and reports about it whose newest version came after. A number is the clock in
   * microseconds when it was taken, or just past the last one (storage.ts), so one taken after
   * `since` is above `since` in microseconds.
   */
  #count(profile: string, since: number, about: About): Record<Kind, number> {
    const counts: Record<Kind, number> = { message: 0, review: 0, vouch: 0, report: 0 }
    for (let after = since * 1000; ; ) {
      const { lines, cursor } = this.#host.readInbox(profile, after)
      if (!lines.length) break
      counts.message += lines.length
      after = cursor
    }
    for (const { seq, kind, subject } of about.values()) if (subject === profile && seq > since * 1000) counts[kind]++
    return counts
  }

  /** Looks every quarter hour, a few seconds past it by the real clock, until close. */
  everyQuarterHour(): void {
    const step = emailChoice.everyMinutes * MINUTE
    const next = () => {
      if (this.#closed) return
      this.#timer = setTimeout(() => {
        void this.morning()
          .catch((err: unknown) => logLine(`email: ${(err as Error).message}`))
          .finally(next)
      }, step - (Date.now() % step) + 5_000).unref()
    }
    next()
  }

  // ------------------------------------------------------------------------------------------
  // Resend

  /**
   * One email, through Resend's API, from this host's sender; `once`, Resend's idempotency key, so
   * the same morning email is never taken twice. A 429 waits as Resend says, and asks again.
   * Throws naming the status only: Resend's answer may quote the email address.
   */
  async #send(letter: Letter, once?: string): Promise<void> {
    for (let tries = 0; ; tries++) {
      const res = await fetch(`${this.#resend}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#config.key}`, 'content-type': 'application/json', ...(once && { 'idempotency-key': once }) },
        body: JSON.stringify({ from: this.#config.from, to: [letter.to], subject: letter.subject, html: letter.html, text: letter.text, ...(letter.headers && { headers: letter.headers }) }),
        signal: AbortSignal.timeout(30_000),
      })
      await res.arrayBuffer()
      if (res.ok) return
      if (res.status !== 429 || tries >= emailChoice.retries) throw new Error(`Resend answered ${res.status}`)
      const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 10)
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
    }
  }

  close(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    this.#db.close()
  }
}

// ------------------------------------------------------------------------------------------
// The two emails

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const shell = (inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="margin:0;padding:0;background:#ffffff"><div style="max-width:480px;margin:0 auto;padding:32px 24px;font-family:${FONT};font-size:16px;line-height:1.5;color:#1f2a24">${inner}</div></body></html>`

/** The email with the code. */
export function codeLetter(to: string, code: string): Letter {
  const why = 'Type it in Forest to get a morning email of what is new on your profiles.'
  const ignore = 'If you did not ask for it, do nothing: nothing is turned on.'
  return {
    to,
    subject: `${code} is your Forest code`,
    text: `Your code is ${code}. ${why} It works for ${emailChoice.codeMinutes} minutes.\n\n${ignore}\n`,
    html: shell(
      `<p style="margin:0 0 8px">Your code is</p>` +
        `<p style="margin:0 0 24px;font-size:32px;font-weight:600;letter-spacing:4px">${code}</p>` +
        `<p style="margin:0 0 24px">${why} It works for ${emailChoice.codeMinutes} minutes.</p>` +
        `<p style="margin:0;color:#6b746f;font-size:13px">${ignore}</p>`,
    ),
  }
}

/**
 * The morning email: how many of each kind are new, the profiles they are on, a button to the app,
 * and the stop link, also in List-Unsubscribe with its one-click POST (RFC 8058). Never what a
 * message says: the host cannot open one, and counts only.
 */
export function morningLetter(to: string, total: Record<Kind, number>, names: string[], app: string, stop: string): Letter {
  const items = KINDS.filter((k) => total[k] > 0).map((k, i) => `${total[k]} ${i === 0 ? 'new ' : ''}${total[k] === 1 ? k : PLURAL[k]}`)
  const count = KINDS.reduce((n, k) => n + total[k], 0)
  const what = `You have ${listed(items)}.`
  const where = `On your ${listed(names)}.`
  const foot = 'You turned this on in Forest.'
  return {
    to,
    subject: `${count} new on Forest`,
    text: `${what}\n${where}\n\nOpen Forest: ${app}\n\n${foot} Stop these emails: ${stop}\n`,
    html: shell(
      `<p style="margin:0 0 8px">${escape(what)}</p>` +
        `<p style="margin:0 0 24px">${escape(where)}</p>` +
        `<p style="margin:0 0 32px"><a href="${escape(app)}" style="display:inline-block;background:#2f6b4f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Open Forest</a></p>` +
        `<p style="margin:0;color:#6b746f;font-size:13px">${foot} <a href="${escape(stop)}" style="color:#6b746f">Stop these emails</a></p>`,
    ),
    headers: { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  }
}
