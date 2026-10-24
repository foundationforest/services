// The index's one file: `index.sqlite` in DATA_DIR, through Node's own SQLite (`node:sqlite`), with
// FTS5 for the text of posts. A fresh schema, made when the file is new; no migrations. Everything
// in it comes back from the hosts and the chain but two tables, which `rebuild` keeps:
//
//   seen    when this index first saw each stamp proof, for a key's `until`: no host can give that
//           back, since a proof carries no date and a record's time is its signer's word
//   roots   every root this index signed, with its time and signature: the reputation proofs people
//           show are made against them
//
// `rebuild` (main.ts) drops every other table and reads the hosts and the chain again.

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export const FILE = 'index.sqlite'

/** Tables `rebuild` keeps. */
const KEPT = `
create table if not exists seen (
  profile text not null,
  key text not null,
  tag text not null,
  first integer not null,
  primary key (profile, key)
);
create table if not exists roots (
  root text primary key,
  time integer not null,
  signature text not null,
  leaves integer not null
);
`

/** Tables `rebuild` drops: each comes back from the hosts and the chain. */
const DROPPED = ['hosts', 'records', 'profiles', 'posts', 'posts_text', 'reviews', 'checked', 'evidence', 'receipts', 'moves', 'chain', 'ratings', 'leaves']

const SCHEMA = `
create table if not exists hosts (url text primary key, cursor integer not null);
-- Every record a listed host served whose text and signature check, once each.
create table if not exists records (id text primary key, profile text not null, path text not null, time integer not null, text text not null);
create index if not exists records_profile on records (profile);
create index if not exists records_time on records (time);
-- Each profile with a current profile record, and what this index found of it on the last pass.
create table if not exists profiles (
  address text primary key,
  body text not null,
  market text,
  role text,
  time integer not null,
  counted integer not null default 0,
  points real not null default 0,
  checks text not null default '[]',
  proofs text not null default '[]',
  tags text not null default '[]'
);
-- Every post this index has read; a deleted one keeps its last body.
create table if not exists posts (
  address text primary key,
  profile text not null,
  body text not null,
  time integer not null,
  deleted integer not null default 0,
  listed integer not null default 0,
  why text
);
create index if not exists posts_profile on posts (profile);
create virtual table if not exists posts_text using fts5 (address unindexed, text);
-- Every live review, and what this index made of it on the last pass.
create table if not exists reviews (
  address text primary key,
  reviewer text not null,
  subject text,
  body text not null,
  time integer not null,
  counted integer not null default 0,
  why text,
  evidence text not null default 'without',
  weight real not null default 0
);
create index if not exists reviews_subject on reviews (subject);
create index if not exists reviews_reviewer on reviews (reviewer);
-- A proof check's answer, by a hash of everything the check took.
create table if not exists checked (hash text primary key, ok integer not null);
-- An evidence check's answer, once: by kind, value and the two pay addresses.
create table if not exists evidence (kind text not null, value text not null, a text not null, b text not null, ok integer not null, primary key (kind, value, a, b));
-- Each escrow's receipt, from its events, and every move.
create table if not exists receipts (escrow text primary key, receipt text not null);
create table if not exists moves (signature text not null, n integer not null, escrow text not null, move text not null, primary key (signature, n));
create index if not exists moves_escrow on moves (escrow);
create table if not exists chain (one integer primary key check (one = 1), cursor text not null);
-- Each counted profile's rating, as signed.
create table if not exists ratings (
  profile text primary key,
  value real,
  reviews integer not null,
  with_payment integer not null,
  weight real not null,
  shrunk real,
  statement text not null,
  signature text not null
);
-- The newest tree's leaves, in order.
create table if not exists leaves (n integer primary key, tag text not null, scope text not null, score integer not null, count integer not null);
`

export type Store = {
  db: DatabaseSync
  /** Runs `fn` in one transaction. */
  tx<T>(fn: () => T): T
  /** Drops every table but `seen` and `roots`, and makes them again, empty; `seen` takes its column's new name. */
  drop(): void
  close(): void
}

export function openStore(dir: string): Store {
  const db = new DatabaseSync(join(dir, FILE))
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  db.exec(KEPT + SCHEMA)
  const tx = <T>(fn: () => T): T => {
    db.exec('begin')
    try {
      const out = fn()
      db.exec('commit')
      return out
    } catch (err) {
      db.exec('rollback')
      throw err
    }
  }
  return {
    db,
    tx,
    drop() {
      tx(() => {
        for (const t of DROPPED) db.exec(`drop table if exists ${t}`)
        // A file from before the standard called a tag a tag holds it in seen's column stamp; the
        // kept table is never made again, so its column is renamed here, once.
        if (db.prepare("select 1 from pragma_table_info('seen') where name = 'stamp'").get()) db.exec('alter table seen rename column stamp to tag')
      })
      db.exec(SCHEMA)
    },
    close: () => db.close(),
  }
}

/** A JSON column, parsed. */
export const parse = <T>(text: unknown): T => JSON.parse(text as string) as T
