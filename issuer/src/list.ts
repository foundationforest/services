// The issuer's list, and the two files it publishes: what indexes, boards and apps read.
//
//   GET /list.json    every commitment on the list, in list order
//   GET /roots.json   every root the list has had, with its size and time, signed with the issuer's key
//
// The registry never sees a list. A device proves against the list (forest/registry/client's
// `proveMembership`, which takes list.json's commitments), and a reader trusts a line's root when
// this issuer's signed roots file holds it (README.md, "The two files").
//
// The members and the Merkle tree are kept in memory: read from the file at start, and grown by
// each batch, so a batch hashes only what it adds. The tree is Semaphore's own Group, which is what
// forest/registry/client's `listRoot` builds for a whole list; the tests check the two agree.

import { Group } from '@semaphore-protocol/group'

import { b64u, concat, utf8 } from '../../forest/records/src/bytes.ts'
import { canonical } from '../../forest/records/src/canonical.ts'
import type { IssuerKey } from './key.ts'
import type { Root, Store } from './store.ts'

/** What the roots file's signature covers begins with this: 0xff, then its own label. */
export const ROOTS_SIGN_PREFIX = concat(Uint8Array.of(0xff), utf8('forest.foundation/issuer/roots/v1\n'))

export class IssuerList {
  readonly #store: Store
  readonly #key: IssuerKey
  readonly #list: bigint[]
  readonly #members: Set<bigint>
  readonly #roots: Root[]
  #group: Group
  #listFile = ''
  #rootsFile = ''

  constructor(store: Store, key: IssuerKey) {
    this.#store = store
    this.#key = key
    this.#list = store.members()
    this.#members = new Set(this.#list)
    this.#group = new Group(this.#list)
    this.#roots = store.roots()
    const newest = this.#roots.at(-1)
    if ((newest?.size ?? 0) !== this.#list.length || (newest && newest.root !== this.#group.root)) {
      throw new Error("the file's list does not match its newest root")
    }
    this.#publish()
  }

  has(commitment: bigint): boolean {
    return this.#members.has(commitment)
  }

  get size(): number {
    return this.#list.length
  }

  /**
   * One batch: `added` onto the end of the list in the order given, and one new root, dated `time`.
   * `done` leaves the queue in the same transaction. If the file refuses, nothing changes.
   */
  append(added: bigint[], done: bigint[], time: number): void {
    if (added.length === 0) return this.#store.append([], undefined, done)
    this.#group.addMembers(added)
    const root: Root = { root: this.#group.root, size: this.#group.size, time }
    try {
      this.#store.append(added, root, done)
    } catch (error) {
      // The tree grew but the file did not: build it again from the list as it still is.
      this.#group = new Group(this.#list)
      throw error
    }
    for (const c of added) {
      this.#list.push(c)
      this.#members.add(c)
    }
    this.#roots.push(root)
    this.#publish()
  }

  /** `{"commitments":["<decimal>",…],"v":1}`, canonical text. */
  listFile(): string {
    return this.#listFile
  }

  /** `{"issuer":"did:key:…","roots":[{"root":"<decimal>","size":n,"time":ms},…],"sig":"…","v":1}`, canonical text. */
  rootsFile(): string {
    return this.#rootsFile
  }

  #publish(): void {
    this.#listFile = canonical({ v: 1, commitments: this.#list.map(String) })
    const unsigned = {
      v: 1,
      issuer: this.#key.did,
      roots: this.#roots.map((r) => ({ root: r.root.toString(), size: r.size, time: r.time })),
    }
    const sig = this.#key.sign(concat(ROOTS_SIGN_PREFIX, utf8(canonical(unsigned))))
    this.#rootsFile = canonical({ ...unsigned, sig: b64u.encode(sig) })
  }
}
