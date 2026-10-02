// The human list, and the one file the issuer publishes about it: what apps read to register.
//
//   GET /list.json   {"keeper":"<address>","snapshots":[{"root":"<64 hex>","signature":"<128 hex>",
//                     "size":n,"time":ms},…],"stamps":["<decimal>",…],"v":1}
//
// `stamps` is every stamp on the list, in list order. Each snapshot is the root of the list's first
// `size` stamps, as forest/registry/client's `listRoot` builds it, signed by the keeper key: ed25519
// over the root as 32 big-endian bytes, which is what a registry row carries and what
// `keeperSigned` checks (forest/registry/README.md). An app proves against the newest snapshot: its
// stamps are the first `size`, its signature goes into the row. One file holds both, so an app never
// reads a list and a signature from two different moments.
//
// The stamps and the Merkle tree are kept in memory: read from the file at start, and grown by each
// batch, so a batch hashes only what it adds. The tree is Semaphore's own Group, which is what
// `listRoot` builds for a whole list; the tests check the two agree.

import { Group } from '@semaphore-protocol/group'

import { hex } from '../../forest/records/src/bytes.ts'
import { canonical } from '../../forest/records/src/canonical.ts'
import { toBytes32 } from '../../forest/registry/client/src/field.ts'
import type { IssuerKey } from './key.ts'
import type { Snapshot, Store } from './store.ts'

export class IssuerList {
  readonly #store: Store
  readonly #key: IssuerKey
  readonly #stamps: bigint[]
  readonly #members: Set<bigint>
  readonly #snapshots: (Snapshot & { signature: string })[]
  #group: Group
  #file = ''

  constructor(store: Store, key: IssuerKey) {
    this.#store = store
    this.#key = key
    this.#stamps = store.stamps()
    this.#members = new Set(this.#stamps)
    this.#group = new Group(this.#stamps)
    this.#snapshots = store.snapshots().map((s) => this.#signed(s))
    const newest = this.#snapshots.at(-1)
    if ((newest?.size ?? 0) !== this.#stamps.length || (newest && newest.root !== this.#group.root)) {
      throw new Error("the file's list does not match its newest snapshot")
    }
    this.#publish()
  }

  has(stamp: bigint): boolean {
    return this.#members.has(stamp)
  }

  get size(): number {
    return this.#stamps.length
  }

  /**
   * One batch: `added` onto the end of the list in the order given, and one new snapshot, dated
   * `time`. `done` leaves the queue in the same transaction. If the file refuses, nothing changes.
   */
  append(added: bigint[], done: bigint[], time: number): void {
    if (added.length === 0) return this.#store.append([], undefined, done)
    this.#group.addMembers(added)
    const snapshot: Snapshot = { root: this.#group.root, size: this.#group.size, time }
    try {
      this.#store.append(added, snapshot, done)
    } catch (error) {
      // The tree grew but the file did not: build it again from the list as it still is.
      this.#group = new Group(this.#stamps)
      throw error
    }
    for (const s of added) {
      this.#stamps.push(s)
      this.#members.add(s)
    }
    this.#snapshots.push(this.#signed(snapshot))
    this.#publish()
  }

  /** The list file, canonical text. */
  file(): string {
    return this.#file
  }

  /** The keeper key's signature on a snapshot: ed25519 over its root as 32 big-endian bytes. */
  #signed(s: Snapshot): Snapshot & { signature: string } {
    return { ...s, signature: hex.encode(this.#key.sign(toBytes32(s.root))) }
  }

  #publish(): void {
    this.#file = canonical({
      v: 1,
      keeper: this.#key.address,
      stamps: this.#stamps.map(String),
      snapshots: this.#snapshots.map((s) => ({ root: hex.encode(toBytes32(s.root)), signature: s.signature, size: s.size, time: s.time })),
    })
  }
}
