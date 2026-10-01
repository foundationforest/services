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
//
// `listFromNotes` is the other way in: the list rebuilt from the issuer's notes on chain alone
// (chain.ts), each root checked against it.

import { Group } from '@semaphore-protocol/group'

import { b64u, concat, utf8 } from '../../forest/records/src/bytes.ts'
import { canonical } from '../../forest/records/src/canonical.ts'
import { parseNote } from './chain.ts'
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

/**
 * The list rebuilt from notes alone, and the roots they name, oldest first: what anyone can do with
 * the issuer's notes on chain. Each note places its members from its `from`; a note seen twice is
 * kept once. Throws on a text that is not a note, two notes that disagree on a member or on a root,
 * a member missing, or a root that is not the Merkle root of the list's first `size` members, as
 * forest/registry/client's `listRoot` builds it.
 */
export function listFromNotes(texts: string[]): { list: bigint[]; roots: Root[] } {
  const members = new Map<number, bigint>()
  const roots = new Map<number, Root>()
  for (const text of texts) {
    const { root, from, commitments } = parseNote(text)
    const known = roots.get(root.size)
    if (known && (known.root !== root.root || known.time !== root.time)) throw new Error(`two roots for size ${root.size}`)
    roots.set(root.size, root)
    commitments.forEach((c, i) => {
      const had = members.get(from + i)
      if (had !== undefined && had !== c) throw new Error(`two members at position ${from + i}`)
      members.set(from + i, c)
    })
  }
  const list = Array.from({ length: members.size }, (_, i) => {
    const c = members.get(i)
    if (c === undefined) throw new Error(`no member at position ${i}`)
    return c
  })
  const ordered = [...roots.values()].sort((a, b) => a.size - b.size)
  if ((ordered.at(-1)?.size ?? 0) !== list.length) throw new Error('the newest root does not cover every member')
  const group = new Group()
  for (const r of ordered) {
    group.addMembers(list.slice(group.size, r.size))
    if (group.root !== r.root) throw new Error(`the root for size ${r.size} is not its members' root`)
  }
  return { list, roots: ordered }
}
