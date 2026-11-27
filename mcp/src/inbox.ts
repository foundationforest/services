// Reading one of the person's profiles' conversations, with its access key: the messages to it, each
// inbox entry opened and its sender checked as the standard says (folders/README.md, The inbox): the
// message's signature (openInbox), then whether the sender's own profile entry, read from its hosts,
// stands behind the key that signed (senderCounts); a message whose sender's entry does not count
// is dropped, as the Forest app drops it. Among them, the profile's own copies of what it sent, at
// sent/<id> in its folder, { to, time, body }, as the Forest app and send_message keep them, so a
// conversation reads whole. At most the newest INBOX_MAX of each are opened. Which senders the index
// shows a check for is read_messages' to ask, with indexWordOn.

import { type Body, type CheckedInbox, isLocked, readInbox, senderCounts } from '@foundationforest/folders'
import { openInbox, openLocked } from '@foundationforest/folders/locked'
import { type Own, folderAt, how, ownFolder, profileEntryOf } from './act.ts'
import { indexSays, isObject } from './forest.ts'
import type { Ctx } from './params.ts'

/** The most inbox entries one read opens, the newest; and the most sent copies, the newest. */
export const INBOX_MAX = 100

/** One message of a conversation: when, who wrote it, and what its body holds. */
export type Message = { time: number; mine: boolean; other: string; body: Body }

/**
 * Every inbox entry for `address` at `hosts`, each once, newest first: an inbox entry carries no time
 * of its own, so it is the order of arrival, as the first of `hosts` that lists it lists it, last
 * arrived first; then what only a later host holds. A host that fails is passed over.
 */
async function inboxAt(ctx: Ctx, address: string, hosts: string[]): Promise<CheckedInbox[]> {
  const listed = await Promise.all(
    hosts.map(async (host) => {
      const entries: CheckedInbox[] = []
      try {
        for (let after = 0; ; ) {
          const page = await readInbox(host, address, { after, ...how(ctx) })
          entries.push(...page.entries)
          if (page.cursor <= after) break
          after = page.cursor
        }
      } catch {
        // The other hosts still count.
      }
      return entries
    }),
  )
  const byId = new Map<string, CheckedInbox>()
  for (const entries of listed) for (const e of entries.reverse()) if (!byId.has(e.id)) byId.set(e.id, e)
  return [...byId.values()]
}

/**
 * Every message of one profile the key opens, to and from it, newest first, and how many entries
 * it could not open (locked before the key was listed with read-inbox, or read for sent copies) and
 * how many older ones it left unread.
 */
export async function messagesOf(ctx: Ctx, me: Own): Promise<{ messages: Message[]; unopened: number; older: number }> {
  const { view } = await ownFolder(ctx, me)
  const all = await inboxAt(ctx, me.address, view.hosts)
  // Each sender's profile entry, read once a call.
  const senders = new Map<string, Promise<Body | null>>()
  const profileOf = (from: string, host: string | undefined) => {
    let got = senders.get(from)
    if (!got) {
      got = folderAt(ctx, from, host ? [host] : []).then((folder) => folder && profileEntryOf(folder))
      senders.set(from, got)
    }
    return got
  }
  const messages: Message[] = []
  let unopened = 0
  for (const e of all.slice(0, INBOX_MAX)) {
    let message
    try {
      message = (await openInbox(e.entry, me.key.identity)).message
    } catch {
      unopened++
      continue
    }
    if (!senderCounts(message, await profileOf(message.from, message.host))) continue
    messages.push({ time: message.time, mine: false, other: message.from, body: message.body })
  }
  // The copies of what it sent, each locked: one that does not open was locked before this key was
  // listed to read; one that is not { to, time } counts for nothing, as in the app.
  const copies = [...view.current].filter(([path, c]) => path.startsWith('sent/') && isLocked(c.entry.body)).sort(([, a], [, b]) => b.entry.time - a.entry.time)
  for (const [, c] of copies.slice(0, INBOX_MAX)) {
    let copy: Body
    try {
      copy = await openLocked(c.entry.body!, me.key.identity)
    } catch {
      unopened++
      continue
    }
    if (typeof copy.to !== 'string' || typeof copy.time !== 'number' || !isObject(copy.body)) continue
    messages.push({ time: copy.time, mine: true, other: copy.to, body: copy.body })
  }
  messages.sort((a, b) => b.time - a.time)
  return { messages, unopened, older: Math.max(0, all.length - INBOX_MAX) + Math.max(0, copies.length - INBOX_MAX) }
}

/** What the index shows of another profile, from its page: its market, role and checks, as the Forest app reads them beside a message. */
export type IndexWord = { market?: unknown; role?: unknown; checks: unknown[] } | { checks: 'unknown'; unread: string }

/**
 * What the index shows of another profile: its market, role and checks, from its page, each check
 * without its key. An index that has no page for it, answering 404, shows no check; one that gives
 * no answer leaves its checks unknown, with why.
 */
export async function indexWordOn(ctx: Ctx, address: string): Promise<IndexWord> {
  const said = await indexSays(ctx, `profiles/${address}.json`)
  if (!('answer' in said)) return said.unread.includes('answered 404') ? { checks: [] } : { checks: 'unknown', unread: said.unread }
  const answer = isObject(said.answer) ? said.answer : {}
  const shown = isObject(answer.profile) ? answer.profile : {}
  const checks = Array.isArray(answer.checks) ? answer.checks.map((c) => (isObject(c) ? { verifier: c.verifier, label: c.label } : c)) : []
  return { market: shown.market, role: shown.role, checks }
}
