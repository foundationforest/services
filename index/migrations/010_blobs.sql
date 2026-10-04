-- Pictures (forest/records/README.md, "Blobs"): which listed host holds which bytes, named by their
-- SHA-256, and the type it serves them as. Never the bytes. A row is added when the readers fetched
-- the bytes from that host and their hash checked (src/records/blobs.ts); a picture no host holds
-- has no row, and is asked for again.
create table blobs (
  sha256      text not null,
  host        text not null,
  type        text not null,
  checked_at  timestamptz not null default now(),
  primary key (sha256, host)
);
