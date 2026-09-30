// The issuer's side of the chain: its list's members, and inserting one more.
//
// Everything here goes through `registry/client`: the list's address, the insert instruction, and
// `fetchListLeaves`, which rebuilds the list from the registry's own log entries and checks the
// result against the root on the chain. The members are kept in memory only: they are public, and
// they answer "is this commitment on the list yet".

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Connection, Keypair, Transaction, type PublicKey } from '@solana/web3.js'

import { fetchListLeaves } from '../../registry/client/src/leaves.ts'
import { decodeIdentityList, insertIdentityIx, listAddress } from '../../registry/client/src/program.ts'

export interface IssuerList {
  /** Read every member again from the chain. */
  refresh(): Promise<void>
  /** Whether the last read, plus every insert confirmed since, holds this commitment. */
  has(commitment: bigint): boolean
  /** Insert one commitment. Resolves once the chain has it; throws once it is sure it never will. */
  insert(commitment: bigint): Promise<void>
}

/** An insert that failed on the chain, or whose transaction can no longer land. */
export class InsertFailed extends Error {}

/**
 * A Solana keypair in the form `solana-keygen` writes: a JSON list of 64 numbers. On anything else it
 * throws a message that quotes none of the input, since the input is a secret key and an error
 * message ends up in a log (JSON's own parse errors quote the text they fail on).
 */
export function parseKeypair(text: string, source: string): Keypair {
  let numbers: unknown
  try {
    numbers = JSON.parse(text)
  } catch {
    numbers = undefined
  }
  const valid =
    Array.isArray(numbers) &&
    numbers.length === 64 &&
    numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  if (!valid) throw new Error(`${source} is not a Solana keypair: a JSON list of 64 numbers`)
  try {
    return Keypair.fromSecretKey(Uint8Array.from(numbers as number[]))
  } catch {
    throw new Error(`${source} is not a Solana keypair: its two halves do not match`)
  }
}

/** The issuer's key, from a keypair file. */
export function loadKeypair(path: string): Keypair {
  return parseKeypair(readFileSync(path, 'utf8'), `the key file ${path}`)
}

/**
 * The issuer's key from the contents of a sealed variable (`ISSUER_KEYPAIR`), written to a file of
 * its own: a new directory under the system's temporary directory, readable by this process's user
 * only (0700), holding one file readable by it only (0600). Never under the repo or the build, and
 * `remove` deletes it. The service loads the key and removes the file at once.
 */
export function writeKeyFile(contents: string): { path: string; remove(): void } {
  const keypair = parseKeypair(contents, 'ISSUER_KEYPAIR')
  const dir = mkdtempSync(join(tmpdir(), 'forest-issuer-key-'))
  const path = join(dir, 'issuer-keypair.json')
  writeFileSync(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600, flag: 'wx' })
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ChainList implements IssuerList {
  readonly #connection: Connection
  readonly #issuer: Keypair
  readonly #listIndex: number
  readonly #programId: PublicKey
  #members = new Set<bigint>()

  private constructor(connection: Connection, issuer: Keypair, listIndex: number, programId: PublicKey) {
    this.#connection = connection
    this.#issuer = issuer
    this.#listIndex = listIndex
    this.#programId = programId
  }

  /**
   * Opens the list and reads its members. Refuses to start unless the key is one of the list's insert
   * keys and the list is open, so a wrong key fails now rather than at the first batch.
   */
  static async open(options: {
    connection: Connection
    issuer: Keypair
    listIndex: number
    programId: PublicKey
  }): Promise<ChainList> {
    const { connection, issuer, listIndex, programId } = options
    const info = await connection.getAccountInfo(listAddress(listIndex, programId), 'confirmed')
    if (!info) throw new Error(`list ${listIndex} does not exist under program ${programId.toBase58()}`)
    const list = decodeIdentityList(new Uint8Array(info.data))
    if (!list.issuers.some((key) => key.equals(issuer.publicKey))) {
      throw new Error(`${issuer.publicKey.toBase58()} is not an insert key of list ${listIndex}`)
    }
    if (list.closed) throw new Error(`list ${listIndex} is closed`)
    const chain = new ChainList(connection, issuer, listIndex, programId)
    await chain.refresh()
    return chain
  }

  async refresh(): Promise<void> {
    const { leaves } = await fetchListLeaves(this.#connection, this.#listIndex, { programId: this.#programId })
    this.#members = new Set(leaves)
  }

  has(commitment: bigint): boolean {
    return this.#members.has(commitment)
  }

  /**
   * One commitment, one transaction, paid by the issuer's key. It waits until the transaction is
   * confirmed or its blockhash has expired, never less: giving up while it can still land would
   * let the next batch send the same commitment again.
   */
  async insert(commitment: bigint): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.#connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: this.#issuer.publicKey, blockhash, lastValidBlockHeight }).add(
      insertIdentityIx({
        issuer: this.#issuer.publicKey,
        listIndex: this.#listIndex,
        commitment,
        programId: this.#programId,
      }),
    )
    tx.sign(this.#issuer)
    const signature = await this.#connection.sendRawTransaction(tx.serialize())

    for (let expired = false; ; ) {
      const { value } = await this.#connection.getSignatureStatuses([signature])
      const status = value[0]
      if (status?.err) throw new InsertFailed('the insert failed on the chain')
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        this.#members.add(commitment)
        return
      }
      // One more look after the blockhash expires, in case it landed in its last block.
      if (expired) throw new InsertFailed('the insert expired without landing')
      expired = (await this.#connection.getBlockHeight('confirmed')) > lastValidBlockHeight
      await sleep(400)
    }
  }
}
