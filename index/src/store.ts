// The index's one file: `index.sqlite` in DATA_DIR, through Node's own SQLite (`node:sqlite`), with
// FTS5 for the text of posts. A fresh schema, made when the file is new; no migrations. Everything
// in it comes back from the hosts but two tables, which `rebuild` keeps:
//
//   seen          when this index first saw a verification of each verifier key on each profile, for
//                 a key's `until`: no host can give that back, since a proof carries no date and an
//                 entry's time is its writer's word
//   roots         every root this index signed, with its time and signature: the reputation proofs
//                 people show are made against them
//
// `rebuild` (main.ts) drops every other table and reads the hosts again.

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

export const FILE = 'index.sqlite'

/** Tables `rebuild` keeps. */
const KEPT = `
create table if not exists seen (
  profile text not null,
  key text not null,
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

/**
 * Tables `rebuild` drops: each comes back from the hosts. `records` is the name the entries' table
 * had before the standard's folders, in a file from then.
 */
const DROPPED = ['hosts', 'entries', 'records', 'profiles', 'posts', 'posts_text', 'reviews', 'vouches', 'reports', 'words', 'checked', 'ratings', 'leaves']

const SCHEMA = `
create table if not exists hosts (url text primary key, cursor integer not null);
-- Every entry a listed host served whose text and signature check, once each.
create table if not exists entries (id text primary key, profile text not null, path text not null, time integer not null, text text not null);
create index if not exists entries_profile on entries (profile);
create index if not exists entries_time on entries (time);
-- Each profile with a current profile entry, and what this index found of it on the last pass.
create table if not exists profiles (
  address text primary key,
  body text not null,
  market text,
  role text,
  time integer not null,
  counted integer not null default 0,
  checks text not null default '[]',
  proofs text not null default '[]'
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
  weight real not null default 0
);
create index if not exists reviews_subject on reviews (subject);
create index if not exists reviews_reviewer on reviews (reviewer);
-- Every live vouch and report, and what this index made of each on the last pass.
create table if not exists vouches (address text primary key, writer text not null, subject text, body text not null, time integer not null, counted integer not null default 0, why text);
create index if not exists vouches_subject on vouches (subject);
create index if not exists vouches_writer on vouches (writer);
create table if not exists reports (address text primary key, writer text not null, subject text, body text not null, time integer not null, counted integer not null default 0, why text);
create index if not exists reports_subject on reports (subject);
create index if not exists reports_writer on reports (writer);
-- Each writer's one word about each profile on the last pass, and its weight.
create table if not exists words (writer text not null, subject text not null, word text not null, weight real not null, primary key (writer, subject));
create index if not exists words_subject on words (subject);
-- A proof check's answer, by a hash of everything the check took.
create table if not exists checked (hash text primary key, ok integer not null);
-- Each counted profile's ratings, trust and uniqueness, as signed, and what search sorts it by.
create table if not exists ratings (
  profile text primary key,
  value real,
  count integer not null,
  trust integer not null,
  uniqueness integer not null,
  sort real,
  statement text not null,
  signature text not null
);
-- The newest tree's leaves, in order: each a counted profile's address and its trust.
create table if not exists leaves (n integer primary key, profile text not null, score integer not null);
`

export type Store = {
  db: DatabaseSync
  /** Runs `fn` in one transaction. */
  tx<T>(fn: () => T): T
  /** Drops every table but `seen` and `roots`, and makes them again, empty; `seen` loses a column a file from before the standard's folders has. */
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
        // A file from before the standard's folders has a column in seen, `tag` (`stamp` before
        // that), for the number each proof showed then; the kept table is never made again, so the
        // column goes here, once, and each row's profile, key and time stay.
        for (const column of ['tag', 'stamp']) if (db.prepare('select 1 from pragma_table_info(?) where name = ?').get('seen', column)) db.exec(`alter table seen drop column ${column}`)
      })
      db.exec(SCHEMA)
    },
    close: () => db.close(),
  }
}

/** A JSON column, parsed. */
export const parse = <T>(text: unknown): T => JSON.parse(text as string) as T
