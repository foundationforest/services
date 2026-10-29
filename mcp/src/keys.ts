// This copy's two keys, each 32 random bytes made at its first start in its data directory, readable
// by its own user only, and read on every start after:
//
// - mcp-key.json: the key whose HMAC-SHA256 signs what this copy writes for a login (login.ts);
// - mcp-opening.json: the secret of its opening half, as keys/'s openingHalf makes one from any
//   key's 32-byte secret. Its open key, published at /open-key, is what a person's app locks the
//   pack to (pack.ts); its identity opens the pack, in memory, for each call.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64u } from '@foundationforest/folders'
import { type OpeningHalf, openingHalf } from '@foundationforest/keys'

const KEY_FILE = 'mcp-key.json'
const OPENING_FILE = 'mcp-opening.json'

/** 32 bytes kept in `dir/file` under `field`: made the first time, the same every time after. */
function kept(dir: string, file: string, field: string): Uint8Array {
  const path = join(dir, file)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, `${JSON.stringify({ [field]: b64u.encode(randomBytes(32)) })}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const bytes = b64u.decode((JSON.parse(readFileSync(path, 'utf8')) as { [field: string]: string })[field] ?? '')
  if (bytes.length !== 32) throw new Error(`${path} holds no ${field} of 32 bytes`)
  return bytes
}

/** The key that signs this copy's logins, from `dir`. */
export function loadKey(dir: string): Buffer {
  return Buffer.from(kept(dir, KEY_FILE, 'key'))
}

/** This copy's opening half, from `dir`: its identity, which opens packs, and its open key, which they are locked to. */
export async function loadOpening(dir: string): Promise<OpeningHalf> {
  return openingHalf(kept(dir, OPENING_FILE, 'secret'))
}
