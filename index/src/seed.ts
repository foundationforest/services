// The index's seed: 32 random bytes, which are its key.
//
// It is made on the index's own machine, the first time it starts without one (the standard's
// `newSeed`), and kept in one file in its data directory (`index-seed.json` in DATA_DIR), on its
// volume. The file is `{"seed":"<64 hex>"}`, readable by the index's own user only. Nothing prints
// or logs it. `rebuild` never touches it.
//
// The seed is made into a service key, the standard's keys' `serviceKey`, a Baby Jubjub key of 32
// random bytes, with no text. It signs the tree's roots and each profile's rating statement, and its
// address is the index's name.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { newSeed, serviceKey } from '@foundationforest/keys'
import { hex, type Key } from '@foundationforest/folders'

export const SEED_FILE = 'index-seed.json'

/**
 * The index's key from the seed file in `dir`; with no file there, a new seed made here and written
 * first. A file that is not a seed stops the start, with a message that quotes none of it.
 */
export async function loadOrMakeKey(dir: string): Promise<{ key: Key; made: boolean }> {
  const path = join(dir, SEED_FILE)
  const made = !existsSync(path)
  if (made) writeFileSync(path, JSON.stringify({ seed: hex.encode(newSeed()) }), { flag: 'wx', mode: 0o600 })
  let seed: unknown
  try {
    seed = (JSON.parse(readFileSync(path, 'utf8')) as { seed?: unknown })?.seed
  } catch {
    seed = undefined
  }
  if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) throw new Error(`${path} is not the index's seed: {"seed":"<64 lowercase hex>"}`)
  const { scalar, publicKey, address } = serviceKey(hex.decode(seed))
  return { key: { scalar, publicKey, address }, made }
}
