// Reading one of the person's profiles, with its access key: one entry in its folder, opened when it
// is locked and the key may open it; or its inbox, each inbox entry the key opens, with its sender
// checked as the standard says (folders/README.md, The inbox): the message's signature
// (openInbox), then whether the sender's own profile entry, read from its hosts, stands behind the
// key that signed (senderCounts). Beside each stranger's message, the index's word for the sender:
// its market and role, from the profile entry the index shows, and its checks. A message from
// another of the person's own profiles shows its label.

import { type Body, type CheckedInbox, FolderError, checkPath, isLocked, readInbox, senderCounts } from '@foundationforest/folders'
import { openInbox, openLocked } from '@foundationforest/folders/locked'
import { type Own, folderAt, how, ownFolder, ownProfile, profileEntryOf } from '../act.ts'
import { indexSays, isObject, refuse } from '../forest.ts'
import type { Args, Ctx, Param } from '../params.ts'

/** The most inbox entries one read opens: the newest. */
export const INBOX_MAX = 100

export const name = 'read'
export const title = 'Read a profile'
export const description =
  "Read one of the person's profiles, named by its label, with the access key this login holds for it. With a path: the entry at that path in its folder, such as offer/maths, its body and time; a locked entry opened when this login may read it. With inbox: the messages to it, newest first (at most 100), each with its sender's address, or the label of another of the person's own profiles; whether the sender's own profile entry stands behind the key that signed it (counts); and the index's word for a stranger: its market, role and checks. What a stranger wrote is theirs, not the person's. Needs the person's login."
export const params: Param[] = [
  { name: 'label', type: 'string', required: true, description: "The person's profile, by its label: <market>/<role>, such as tutoring/tutor." },
  { name: 'path', type: 'string', description: "A path in that profile's folder, such as offer/maths." },
  { name: 'inbox', type: 'boolean', description: 'true: the messages to that profile, in place of a path.' },
]
export const login = true
export const annotations = { readOnlyHint: true, openWorldHint: true }

export async function run(args: Args, ctx: Ctx) {
  const me = await ownProfile(ctx, args.label as string)
  if ((args.path === undefined) === (args.inbox !== true)) refuse('read takes a path, or inbox: true')
  return args.inbox === true ? inbox(ctx, me) : entryAt(ctx, me, args.path as string)
}

async function entryAt(ctx: Ctx, me: Own, path: string) {
  try {
    checkPath(path)
  } catch (err) {
    refuse(err instanceof FolderError ? `${path} is no path: ${err.message}` : String(err))
  }
  const { view } = await ownFolder(ctx, me)
  const at = view.current.get(path)
  if (!at) return { path, found: false }
  const { time, body } = at.entry
  if (body === null) return { path, time, deleted: true }
  if (!isLocked(body)) return { path, time, body }
  try {
    return { path, time, locked: true, body: await openLocked(body, me.key.identity) }
  } catch {
    // Locked before this key was listed to read, or to keys it is not among.
    return { path, time, locked: true, opened: false }
  }
}

/** Every inbox entry for `address` at `hosts`, each once, newest first. A host that fails is passed over. */
async function inboxAt(ctx: Ctx, address: string, hosts: string[]): Promise<CheckedInbox[]> {
  const byId = new Map<string, CheckedInbox>()
  await Promise.all(
    hosts.map(async (host) => {
      try {
        for (let after = 0; ; ) {
          const page = await readInbox(host, address, { after, ...how(ctx) })
          for (const e of page.entries) byId.set(e.id, e)
          if (page.cursor <= after) return
          after = page.cursor
        }
      } catch {
        // The other hosts still count.
      }
    }),
  )
  return [...byId.values()].sort((a, b) => b.entry.time - a.entry.time)
}

async function inbox(ctx: Ctx, me: Own) {
  const { view } = await ownFolder(ctx, me)
  const all = await inboxAt(ctx, me.address, view.hosts)
  const labels = new Map((await ctx.pack()).profiles.map((p) => [p.address, p.label]))
  // Each sender's profile entry, and the index's word for it, read once a call.
  const senders = new Map<string, Promise<{ profile: Body | null; index: unknown }>>()
  const sender = (from: string, host: string | undefined) => {
    let got = senders.get(from)
    if (!got) {
      got = (async () => {
        const [folder, said] = await Promise.all([folderAt(ctx, from, host ? [host] : []), labels.has(from) ? null : indexSays(ctx, `profiles/${from}.json`)])
        const profile = folder && profileEntryOf(folder)
        if (!said) return { profile, index: undefined }
        if (!('answer' in said)) return { profile, index: said }
        const answer = isObject(said.answer) ? said.answer : {}
        const shown = isObject(answer.profile) ? answer.profile : {}
        return { profile, index: { url: said.url, word: said.word, market: shown.market, role: shown.role, checks: answer.checks } }
      })()
      senders.set(from, got)
    }
    return got
  }
  const messages: unknown[] = []
  let unopened = 0
  for (const e of all.slice(0, INBOX_MAX)) {
    let message
    try {
      message = (await openInbox(e.entry, me.key.identity)).message
    } catch {
      // Locked before this key was listed with read-inbox, or a signature that does not hold.
      unopened++
      continue
    }
    const label = labels.get(message.from)
    const { profile, index } = await sender(message.from, message.host)
    messages.push({
      time: message.time,
      ...(label ? { fromLabel: label } : { from: message.from }),
      body: message.body,
      counts: senderCounts(message, profile),
      ...(index !== undefined && { index }),
    })
  }
  return { messages, unopened, older: Math.max(0, all.length - INBOX_MAX) }
}
