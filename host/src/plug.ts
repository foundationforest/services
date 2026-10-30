// The plug: the seven requests every host answers (the standard's folders/README.md, Hosts), over
// plain HTTP, a SQLite file per folder, and a file store (storage.ts). It is this host's own code;
// the standard's host check (@foundationforest/folders/check) shows it fits the plug.
//
// It holds no keys, has no sign-up and asks for no login: an entry's signature is its only
// credential. It is open: it takes signed entries for any folder and serves them to anyone; it takes
// inbox entries for any folder whose profile entry here has openKey, and lists them to anyone; it
// takes the bytes a current entry here names, and serves them to anyone. The bodies it reads are
// the profile entry's and each body's `files`. It keeps the current entry at each path; an entry
// that stops being current or stops counting, and an inbox entry, go after `keepDays`; a file goes
// `keepDays` after no current entry names it.
//
//   POST /v1/entries               NDJSON of canonical entries; one NDJSON result each
//   POST /v1/entries/read          { profile, after? }: NDJSON of that folder's stored entries after
//                                  the cursor, in the order taken; header forest-cursor: the last
//                                  sequence number
//   GET  /v1/entries?after=        every folder's stored entries after the cursor, the same way
//   POST /v1/inbox                 NDJSON of canonical inbox entries; one NDJSON result each
//   POST /v1/inbox/read            { to, after? }: NDJSON of the inbox entries left for that folder
//                                  after the cursor, in arrival order; header forest-cursor
//   PUT  /v1/files/<sha256>        raw bytes, content-type their type
//   GET  /v1/files/<sha256>        the bytes, with the type they came in with; or, from a bucket
//                                  that gives one, a redirect to a short-lived link to them there
//
// A write's payment, the standard's forest-payment header, goes to this host's choice for inbox
// entries with each line's place in the request; the plug reads nothing in it.
//
// How large an entry, an inbox entry or a file it takes, and how many lines a request or a page
// holds, is this host's own choice (maxEntryBytes, maxInboxBytes, maxFileBytes, maxBatch,
// maxPageLines, maxPageBytes); a client handles any size. It logs nothing about who asks. Where it keeps things is
// storage.ts's business, and only storage.ts's.

import { createHash } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type Checked,
  type CheckedInbox,
  FolderError,
  type InboxEntry,
  MAX_FUTURE_MS,
  PROFILE_PATH,
  READ_TIMEOUT_MS,
  type ReadOptions,
  type Result,
  type SignedEntry,
  type View,
  canDo,
  decodeEntry,
  decodeInbox,
  encodeEntry,
  isMediaType,
  openKeyOf,
  publicKeyFromAddress,
  viewFolder,
} from '@foundationforest/folders'
import { type FileDriver, type Row, Storage, logLine } from './storage.ts'

export { type FileDriver, type S3Options, rebuild } from './storage.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export const DAY = 86_400_000
/** The largest entry it takes, as canonical text in bytes, unless the operator says otherwise. */
export const DEFAULT_MAX_ENTRY_BYTES = 65_536
/** The largest inbox entry it takes, as canonical text in bytes, unless the operator says otherwise. */
export const DEFAULT_MAX_INBOX_BYTES = 65_536
/** Lines a request carries, unless the operator says otherwise. */
export const DEFAULT_MAX_BATCH = 100
/** Lines a page holds, unless the operator says otherwise. */
export const DEFAULT_MAX_PAGE_LINES = 1000
/** Bytes a page holds, unless the operator says otherwise. A page always holds at least one line. */
export const DEFAULT_MAX_PAGE_BYTES = 4 * 1024 * 1024
/** Days an entry that stopped being current or counting, an inbox entry, and a file no current entry names are kept, unless the operator says otherwise. */
export const DEFAULT_KEEP_DAYS = 30
/** The largest file it reads, unless the operator says otherwise: a short video. */
export const DEFAULT_MAX_FILE_BYTES = 50_000_000
/** The file types it takes, unless the operator says otherwise: photos and short videos. */
export const DEFAULT_FILE_TYPES = ['image/png', 'image/jpeg', 'video/mp4']
/** A read request is under 100 bytes. */
const MAX_ASK_BYTES = 1024
/** A request's headers, at most: room for a payment of a credit, 472 characters, for each of a full batch's lines. */
export const MAX_HEADER_BYTES = 64 * 1024
/** The header a write's payment comes in, as the standard names it. */
const PAYMENT_HEADER = 'forest-payment'
const FILE_PATH = /^\/v1\/files\/([0-9a-f]{64})$/

/**
 * A host's own choice for entries: every entry but a profile entry, and a folder's first profile
 * entry while it holds no entry of that folder yet. Null takes the entry, a reason refuses it. So
 * joining can cost; a profile entry for a folder it holds is never asked about, so a person can
 * always leave or update.
 */
export type EntryChoice = (entry: SignedEntry, stored: { entries: number; bytes: number }) => string | null | Promise<string | null>
/**
 * A host's own choice for inbox entries, from the inbox entry, what it holds in that inbox, and the
 * request's payment (its forest-payment header, if any) with the line's place in the request: its
 * spam limits, or its price.
 */
export type InboxChoice = (entry: InboxEntry, stored: { entries: number; bytes: number }, paid: { payment: string | undefined; line: number }) => string | null | Promise<string | null>
/**
 * A host's own choice for files, past its size cap: bytes a current entry here names, with the
 * folders whose current entries name them with this type and size, the newest naming entry first,
 * and what each of those holds here already, so a choice may go by folder: a quota, say.
 */
export type FileChoice = (file: { sha256: string; type: string; size: number }, folders: Array<{ folder: string; files: number; bytes: number }>) => string | null | Promise<string | null>

export const defaultFileChoice: FileChoice = (file) => (DEFAULT_FILE_TYPES.includes(file.type) ? null : `this host takes ${DEFAULT_FILE_TYPES.join(', ')}`)

/**
 * The one line a request answered 500 leaves in the log: its path and the error's message, any
 * address in them taken out (logLine). No query, no body, no IP.
 */
export function logFailure(path: string, err: unknown): void {
  logLine(`500 ${path}: ${err instanceof Error ? err.message : String(err)}`)
}

export type HostOptions = {
  /**
   * The data directory: `folders/` (a SQLite file per folder), `host.sqlite` (the log, and which
   * files are named and stored) and, for the disk driver, `files/`. A fresh temporary one, removed
   * on close, when omitted.
   */
  dir?: string
  /** Where file bytes go: on disk in the data directory, or an S3-compatible bucket. Disk when omitted. */
  files?: FileDriver
  now?: () => number
  /** The operator's choice; DEFAULT_KEEP_DAYS when omitted. */
  keepDays?: number
  /** The largest entry it takes, as canonical text in bytes; DEFAULT_MAX_ENTRY_BYTES when omitted. */
  maxEntryBytes?: number
  /** The largest inbox entry it takes, as canonical text in bytes; DEFAULT_MAX_INBOX_BYTES when omitted. */
  maxInboxBytes?: number
  entryChoice?: EntryChoice
  /** Milliseconds a request may take to arrive in full; past that it gets 408. READ_TIMEOUT_MS when omitted. */
  timeout?: number
  /** Lines a request may carry; DEFAULT_MAX_BATCH when omitted. */
  maxBatch?: number
  /** Lines a page holds at most; DEFAULT_MAX_PAGE_LINES when omitted. */
  maxPageLines?: number
  /** Bytes a page holds at most, though always one line; DEFAULT_MAX_PAGE_BYTES when omitted. */
  maxPageBytes?: number
  inboxChoice?: InboxChoice
  /** The largest file it reads; DEFAULT_MAX_FILE_BYTES when omitted. */
  maxFileBytes?: number
  /** defaultFileChoice when omitted. */
  fileChoice?: FileChoice
}

export type { ReadOptions, Result }
type Answer = Omit<Result, 'i'>
type Page = { lines: string[]; cursor: number }

const refusal = (err: unknown): Answer => ({ ok: false, error: err instanceof FolderError ? err.code : 'invalid', message: (err as Error).message })

export class Host {
  /** Where it listens, once it does. */
  url = ''
  readonly keepDays: number
  readonly maxEntryBytes: number
  readonly maxInboxBytes: number
  readonly maxBatch: number
  readonly maxPageLines: number
  readonly maxPageBytes: number
  readonly maxFileBytes: number
  private readonly storage: Storage
  private readonly now: () => number
  private readonly entryChoice?: EntryChoice
  private readonly inboxChoice?: InboxChoice
  private readonly fileChoice: FileChoice
  private readonly timeout: number
  private server?: Server
  private pruning?: NodeJS.Timeout

  constructor(options: HostOptions = {}) {
    this.now = options.now ?? Date.now
    this.keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
    this.maxInboxBytes = options.maxInboxBytes ?? DEFAULT_MAX_INBOX_BYTES
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH
    this.maxPageLines = options.maxPageLines ?? DEFAULT_MAX_PAGE_LINES
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.entryChoice = options.entryChoice
    this.inboxChoice = options.inboxChoice
    this.fileChoice = options.fileChoice ?? defaultFileChoice
    this.timeout = options.timeout ?? READ_TIMEOUT_MS
    this.storage = new Storage(options.dir, options.files)
  }

  // ------------------------------------------------------------------------------------------
  // Entries: Taking an entry in, in the plug's order.

  /** Take a request's entries (wire text), check each, store what becomes current at its path. */
  async accept(lines: string[]): Promise<Result[]> {
    if (lines.length > this.maxBatch) return [{ i: 0, ok: false, error: 'batch', message: `at most ${this.maxBatch} lines a request` }]
    const now = this.now()
    const results: Result[] = []
    const decoded: Array<{ i: number; checked: Checked }> = []
    lines.forEach((line, i) => {
      try {
        if (this.tooBig(line, this.maxEntryBytes)) throw new FolderError('size', `this host takes entries of at most ${this.maxEntryBytes} bytes`)
        const checked = decodeEntry(line)
        if (checked.entry.time > now + MAX_FUTURE_MS) results.push({ i, id: checked.id, ok: false, error: 'future', message: 'dated more than ten minutes ahead' })
        else decoded.push({ i, checked })
      } catch (err) {
        results.push({ i, ...refusal(err) })
      }
    })
    for (const { i, checked } of decoded) results.push({ i, id: checked.id, ...(await this.acceptOne(checked, now)) })
    return results.sort((a, b) => a.i - b.i)
  }

  private async acceptOne(c: Checked, now: number): Promise<Omit<Result, 'i' | 'id'>> {
    const { entry } = c
    const stored = this.stored(entry.profile)
    // An access key's entry: its folder's current profile entry here lists the key with write.
    if (entry.key !== undefined && !canDo(viewFolder(entry.profile, stored, now).current.get(PROFILE_PATH)?.entry.body, entry.key, 'write')) {
      return { ok: false, error: 'unlisted', message: 'the profile entry here lists no such key with write' }
    }
    if (this.storage.hasEntry(entry.profile, c.id)) return { ok: true, message: 'already here' }
    // Taken only if it becomes current at its path, by what every reader follows (the standard's viewFolder).
    if (viewFolder(entry.profile, [...stored, c], now).current.get(entry.path)?.id !== c.id) return { ok: false, error: 'older', message: 'a newer version is already here' }
    if (this.entryChoice && (entry.path !== PROFILE_PATH || this.storage.entryTotals(entry.profile).entries === 0)) {
      const refused = await this.entryChoice(entry, this.storage.entryTotals(entry.profile))
      if (refused) return { ok: false, error: 'refused', message: refused }
    }
    // From here on, no wait: its own choice may have let other requests store entries for this
    // folder, so what is current is worked out again. What is current is kept; what stopped being
    // current, or counting, gets a date, and goes `keepDays` later.
    if (this.storage.hasEntry(entry.profile, c.id)) return { ok: true, message: 'already here' }
    const settled = viewFolder(entry.profile, [...this.stored(entry.profile), c], now)
    this.storage.addEntry(entry.profile, c.id, encodeEntry(entry), now, new Set([...settled.current.values()].map((s) => s.id)))
    return { ok: true }
  }

  /**
   * Delete the entries that stopped being current or counting, the inbox entries that arrived, and
   * the files no current entry has named, more than `keepDays` ago. Returns how many it deleted.
   */
  prune(now = this.now()): Promise<number> {
    return this.storage.prune(now - this.keepDays * DAY, now)
  }

  /**
   * Stored entries in the order taken, as canonical text, after a cursor, for one folder if asked:
   * at most maxPageLines, and a page ends before a line that would take it past maxPageBytes,
   * though it always holds one.
   */
  read(options: ReadOptions = {}): Page {
    const after = options.after ?? 0
    // A profile that is no address has no folder: nothing to read, and no file to look for.
    if (options.profile !== undefined && !publicKeyFromAddress(options.profile)) return { lines: [], cursor: after }
    return this.page(this.storage.entriesAfter(after, options.profile), after)
  }

  private page(rows: Iterable<Row>, after: number): Page {
    const lines: string[] = []
    let cursor = after
    let size = 0
    for (const row of rows) {
      if (lines.length >= this.maxPageLines) break
      size += row.bytes + 1
      if (size > this.maxPageBytes && lines.length) break
      lines.push(row.text)
      cursor = row.seq
    }
    return { lines, cursor }
  }

  /** Whether a line is larger than `max` bytes. Its length in UTF-16 units is never more than its bytes, so huge text is refused unencoded. */
  private tooBig(line: string, max: number): boolean {
    return line.length > max || utf8(line).length > max
  }

  /**
   * The most a request's body holds: for inbox entries, a full batch of the largest; for entries, as
   * much, or one largest entry and its newline when that is more. Never a full batch of the largest
   * entries: a host that takes large ones would read it all into memory before any price is asked.
   * A larger batch gets 413, and the client sends it again in halves.
   */
  private maxBody(inbox: boolean): number {
    const batch = this.maxBatch * (this.maxInboxBytes + 1)
    return inbox ? batch : Math.max(batch, this.maxEntryBytes + 1)
  }

  /** This host's view of a folder, from what it stores. */
  view(profile: string, now = this.now()): View {
    return viewFolder(profile, this.stored(profile), now)
  }

  /** A folder's stored entries. They were checked on the way in. */
  private stored(profile: string): Checked[] {
    return this.storage.entries(profile).map((r) => ({ id: r.id, entry: JSON.parse(r.text) as SignedEntry }))
  }

  /** The body of a folder's current profile entry here, if it has one. */
  private profileBody(profile: string, now: number) {
    return this.view(profile, now).current.get(PROFILE_PATH)?.entry.body
  }

  count(profile?: string): number {
    return this.storage.count(profile)
  }

  /** Every stored entry's and inbox entry's text: what a host operator can see on its own disk. */
  dump(): string[] {
    return this.storage.dump()
  }

  // ------------------------------------------------------------------------------------------
  // The inbox: Taking an inbox entry in, in the plug's order.

  /** Take a request's inbox entries (wire text), check each in the standard's order, store what passes. `payment` is the request's, for this host's choice. */
  async leave(lines: string[], payment?: string): Promise<Result[]> {
    if (lines.length > this.maxBatch) return [{ i: 0, ok: false, error: 'batch', message: `at most ${this.maxBatch} lines a request` }]
    const now = this.now()
    const open = new Map<string, boolean>()
    const results: Result[] = []
    for (const [i, line] of lines.entries()) results.push({ i, ...(await this.leaveOne(line, now, open, { payment, line: i })) })
    return results
  }

  private async leaveOne(line: string, now: number, open: Map<string, boolean>, paid: { payment: string | undefined; line: number }): Promise<Answer> {
    if (this.tooBig(line, this.maxInboxBytes)) return { ok: false, error: 'size', message: `this host takes inbox entries of at most ${this.maxInboxBytes} bytes` }
    let c: CheckedInbox
    try {
      c = decodeInbox(line)
    } catch (err) {
      return refusal(err)
    }
    const { entry: e, id } = c
    const refuse = (error: string, message: string): Answer => ({ id, ok: false, error, message })
    if (this.storage.hasInbox(e.to, id)) return refuse('duplicate', 'this inbox entry is already here')
    let takes = open.get(e.to)
    if (takes === undefined) open.set(e.to, (takes = openKeyOf(this.profileBody(e.to, now)) !== null))
    if (!takes) return refuse('no_inbox', 'the profile entry here has no openKey: the folder takes no inbox entries')
    if (this.inboxChoice) {
      const refused = await this.inboxChoice(e, this.storage.inboxTotals(e.to), paid)
      if (refused) return refuse('refused', refused)
    }
    // Checked again here, with no wait in between: another request may have taken the same id
    // during its own choice.
    if (!this.storage.addInbox(e.to, id, line, now)) return refuse('duplicate', 'this inbox entry is already here')
    return { id, ok: true }
  }

  /** A folder's inbox entries after the cursor, in the order they arrived, paged as entries are: to anyone. */
  readInbox(to: string, after = 0): Page {
    if (!publicKeyFromAddress(to)) return { lines: [], cursor: after }
    return this.page(this.storage.inboxAfter(to, after), after)
  }

  // ------------------------------------------------------------------------------------------
  // Files: Taking a file in.

  /**
   * Take bytes a current entry here names: `type` is a media type [shape], a current entry names
   * the hash [unnamed] with this type and this size [shape], and the bytes hash to it [hash].
   * Bytes stored already are `already here`. Otherwise this host must take their size and type
   * [size, refused]. Bytes several folders name are stored once.
   */
  async putFile(name: string, type: string, bytes: Uint8Array): Promise<Answer> {
    if (!isMediaType(type)) return { ok: false, error: 'shape', message: 'content-type is a media type, type/subtype in lower case' }
    const named = this.storage.namedBy(name)
    if (!named.length) return { ok: false, error: 'unnamed', message: 'no current entry here names these bytes' }
    const folders = [...new Set(named.filter((n) => n.type === type && n.size === bytes.length).map((n) => n.folder))]
    if (!folders.length) return { ok: false, error: 'shape', message: 'no current entry here names these bytes with this type and size' }
    if (sha256Hex(bytes) !== name) return { ok: false, error: 'hash', message: 'the bytes do not hash to their name' }
    if (this.storage.holdsFile(name)) return { ok: true, message: 'already here' }
    if (bytes.length > this.maxFileBytes) return { ok: false, error: 'size', message: `at most ${this.maxFileBytes} bytes` }
    const refused = await this.fileChoice({ sha256: name, type, size: bytes.length }, folders.map((folder) => ({ folder, ...this.storage.fileTotals(folder) })))
    if (refused) return { ok: false, error: 'refused', message: refused }
    await this.storage.putFile(name, type, bytes, this.now())
    return { ok: true }
  }

  /** Stored bytes and their type, or undefined. */
  getFile(name: string): Promise<{ type: string; bytes: Uint8Array } | undefined> {
    return this.storage.getFile(name)
  }

  /** A short-lived link to stored bytes, from a store that gives one (a bucket); else undefined. */
  fileLink(name: string): string | undefined {
    return this.storage.fileLink(name)
  }

  // ------------------------------------------------------------------------------------------
  // HTTP

  /** Listen on loopback unless told otherwise, and prune every hour. Returns the url. */
  async listen(port = 0, hostname = '127.0.0.1'): Promise<string> {
    // Node looks for requests past the timeout every 30 seconds by default; every second keeps it near.
    this.server = createServer({ requestTimeout: this.timeout, connectionsCheckingInterval: 1000, maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        // A request dropped while it arrived (408, or the asker gone) gets no 500, so it logs none.
        if (res.headersSent || res.destroyed) return
        logFailure(URL.parse(req.url ?? '/', 'http://host.invalid')?.pathname ?? '', err)
        res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(port, hostname, resolve))
    this.pruning = setInterval(() => void this.prune().catch(() => {}), DAY / 24).unref()
    this.url = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async close(): Promise<void> {
    clearInterval(this.pruning)
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.storage.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('access-control-allow-origin', '*')
    // A target that is no path, such as //, is the asker's mistake.
    const url = URL.parse(req.url ?? '/', 'http://host.invalid')
    if (!url) {
      res.writeHead(400).end()
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT', 'access-control-allow-headers': `content-type, ${PAYMENT_HEADER}` }).end()
      return
    }
    const file = FILE_PATH.exec(url.pathname)?.[1]
    const posts = ['/v1/entries/read', '/v1/inbox', '/v1/inbox/read']
    const methods = url.pathname === '/v1/entries' ? ['GET', 'POST'] : posts.includes(url.pathname) ? ['POST'] : file ? ['GET', 'PUT'] : []
    if (!methods.length) {
      res.writeHead(404).end()
      return
    }
    if (!methods.includes(req.method ?? '')) {
      res.writeHead(405, { allow: methods.join(', ') }).end()
      return
    }

    if (file && req.method === 'GET') {
      // From a bucket, a link straight to the bytes there: the bucket serves them, not this host.
      const link = this.fileLink(file)
      if (link) return void res.writeHead(302, { location: link, 'cache-control': 'no-store' }).end()
      const held = await this.getFile(file)
      if (!held) res.writeHead(404).end()
      else res.writeHead(200, { 'content-type': held.type, 'content-length': held.bytes.length }).end(held.bytes)
      return
    }
    if (file) {
      const tooBig = { ok: false, error: 'size', message: `at most ${this.maxFileBytes} bytes` }
      if (Number(req.headers['content-length'] ?? 0) > this.maxFileBytes) return sendJson(res, 413, tooBig)
      const bytes = await readBody(req, this.maxFileBytes)
      if (bytes === null) return sendJson(res, 413, tooBig)
      const answer = await this.putFile(file, (req.headers['content-type'] ?? '').trim(), bytes)
      return sendJson(res, answer.ok ? 200 : 400, answer)
    }

    // Everyone's entries, by GET, after a cursor and nothing else: a folder is read by POST, its
    // address in the body, which front doors do not log.
    if (req.method === 'GET') {
      const keys = [...url.searchParams.keys()]
      const after = url.searchParams.get('after')
      const asked = after === null ? 0 : Number(after)
      if (keys.some((k) => k !== 'after') || keys.length > 1 || !Number.isSafeInteger(asked) || asked < 0) {
        res.writeHead(400).end()
        return
      }
      return sendLines(res, this.read({ after: asked }))
    }
    if (url.pathname === '/v1/entries/read' || url.pathname === '/v1/inbox/read') {
      const body = await readBody(req, MAX_ASK_BYTES)
      if (body === null) {
        res.writeHead(413).end()
        return
      }
      const field = url.pathname === '/v1/entries/read' ? 'profile' : 'to'
      const asked = readAsk(bodyText.decode(body), field)
      if (!asked) {
        res.writeHead(400).end()
        return
      }
      return sendLines(res, field === 'profile' ? this.read({ profile: asked.folder, after: asked.after }) : this.readInbox(asked.folder, asked.after))
    }

    // POST /v1/entries or /v1/inbox: NDJSON in, one NDJSON result a line out.
    const body = await readBody(req, this.maxBody(url.pathname === '/v1/inbox'), true)
    if (body === null) {
      res.writeHead(413).end()
      return
    }
    const lines = bodyText.decode(body).split('\n').filter((l) => l.length > 0)
    const payment = req.headers[PAYMENT_HEADER]
    const results = url.pathname === '/v1/inbox' ? await this.leave(lines, typeof payment === 'string' ? payment : undefined) : await this.accept(lines)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.end(results.map((r) => JSON.stringify(r) + '\n').join(''))
  }
}

/** A read request's body: `{ <field>, after? }` and nothing else, or undefined. */
function readAsk(text: string, field: 'profile' | 'to'): { folder: string; after: number } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { [field]: folder, after = 0, ...rest } = value as { [key: string]: unknown }
  if (Object.keys(rest).length || typeof folder !== 'string' || !Number.isSafeInteger(after) || (after as number) < 0) return undefined
  return { folder, after: after as number }
}

function sendJson(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

function sendLines(res: ServerResponse, out: Page) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'forest-cursor': String(out.cursor), 'access-control-expose-headers': 'forest-cursor' })
  res.end(out.lines.map((l) => l + '\n').join(''))
}

/** A body as text: bytes that are not UTF-8 become U+FFFD and a byte order mark stays, so a line that has one is refused. */
const bodyText = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * A request's body, or null past `max` bytes. With `drain`, the rest past `max` is still read, and
 * none of it kept, so the client reads the 413 that follows and can send its batch again in halves;
 * the request's timeout bounds how long that takes.
 */
async function readBody(req: IncomingMessage, max: number, drain = false): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Uint8Array).length
    if (size > max && !drain) return null
    if (size <= max) chunks.push(chunk as Uint8Array)
  }
  if (size > max) return null
  // Copied here, not concat(...chunks): a slow client can send more pieces than a call takes arguments.
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.length
  }
  return body
}
