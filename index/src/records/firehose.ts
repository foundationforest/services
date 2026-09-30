// The record reader: a firehose (a host's own in tests, the carrier later), read with Bluesky's own
// consumer, `@atproto/sync`, unchanged. For every commit it resolves the DID document, checks the
// commit's signature against the signing key the document names, and checks each record against
// the signed commit by its Merkle proof; a commit that fails is dropped whole, before this code
// sees it, and reported through `onError`. Only the four Forest collections are read.
//
// Events for one DID are handled in order; the cursor stored in Postgres is the last sequence
// number below which everything has been handled, so a restart resumes there.

import { IdResolver } from '@atproto/identity'
import { type Event, Firehose, MemoryRunner } from '@atproto/sync'

import { type Db, getCursor, setCursor } from '../db.ts'
import { FOREST_COLLECTIONS, type Outcome, applyRecordOp } from './store.ts'

export type RecordReader = { stop: () => Promise<void> }

export async function startRecordReader(args: {
  db: Db
  firehoseUrl: string
  plcUrl: string
  onChange: () => void
  onError: (err: Error) => void
  onRecord?: (uri: string, outcome: Outcome) => void
}): Promise<RecordReader> {
  const source = `firehose:${args.firehoseUrl}`
  const stored = await getCursor(args.db, source)
  const runner = new MemoryRunner({
    startCursor: stored === null ? undefined : Number(stored),
    setCursor: (cursor) => setCursor(args.db, source, String(cursor)),
  })
  // The resolver's default fetch refuses private addresses, rightly, for a public index. A local
  // directory (http://, in tests and on a laptop) needs the plain one.
  const idResolver = new IdResolver({
    plcUrl: args.plcUrl,
    ...(args.plcUrl.startsWith('http://') ? { fetch: globalThis.fetch } : {}),
  })
  const firehose = new Firehose({
    idResolver,
    service: args.firehoseUrl,
    runner,
    filterCollections: FOREST_COLLECTIONS,
    // Handles are names, a later feature; identity, account and sync events are not acted on in
    // part one (docs/changes.md).
    unauthenticatedHandles: true,
    excludeIdentity: true,
    excludeAccount: true,
    excludeSync: true,
    onError: args.onError,
    handleEvent: async (evt: Event) => {
      if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') return
      const base = { did: evt.did, collection: evt.collection, rkey: evt.rkey, rev: evt.rev }
      const outcome =
        evt.event === 'delete'
          ? await applyRecordOp(args.db, { ...base, event: 'delete' })
          : await applyRecordOp(args.db, { ...base, event: evt.event, cid: evt.cid.toString(), record: evt.record })
      args.onRecord?.(evt.uri.toString(), outcome)
      if (outcome.result === 'refused') args.onError(new Error(`refused ${evt.uri}: ${outcome.why}`))
      if (outcome.result === 'stored' || outcome.result === 'deleted') args.onChange()
    },
  })
  void firehose.start()
  return {
    stop: async () => {
      await firehose.destroy()
      await runner.destroy()
    },
  }
}
