// The page models. One function per page reads the database and returns one object: that object
// is the page's JSON twin, and the HTML is rendered from it (pages.ts), so the two never say
// different things. Field names such as `mint` are the records' own; they are for machines, and the
// HTML shows none of them. A profile is named by its address. A picture a record names is shown from
// a host this index read the record from, when that host holds the bytes as the type the record
// names (src/records/blobs.ts); the index never keeps the bytes.

import { base58, hex } from '../../../forest/records/src/index.ts'

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import { COUNTED } from '../chain/registry.ts'
import { type Directory, type MarketFile, splitLabel } from '../markets.ts'
import type { StoredProof } from '../records/store.ts'
import { stampStatus } from '../scores/compute.ts'
import { STATEMENT_HEADER } from '../scores/sign.ts'
import { type Near, type Urls, LISTS, PAYLINK_DOC, SCORING_DOC, SOURCE } from './html.ts'
import { type PayLink, payLink } from './paylink.ts'

export type Ctx = { db: Db; directory: Directory; config: Config; urls: Urls }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
const micro = (v: string | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(BigInt(v)) / 1_000_000)

/** Every model says what page it is and where it and its twin live. */
type Self = { kind: string; url: string; json: string }
const self = (ctx: Ctx, kind: string, url: string): Self => ({ kind, url, json: ctx.urls.json(url) })

/** A profile's two numbers, side by side, never one: its rating out of 10 (or none yet), and its standing. */
export type Numbers = { rating: { value: number | null; reviews: number }; standing: number }

// -----------------------------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------------------------

/** A photo or a video, as a record names it: by the SHA-256 of its bytes, with its type. */
type Named = { sha256: string; mimeType: string }
/** A picture and where to see it: on a host that served the record and holds the bytes as that type; null when none does. */
export type Picture = Named & { url: string | null }

const mediaOf = (r: any): Named[] => (r.media ?? []) as Named[]
const photoOf = (r: any): Named[] => (r.photo ? [r.photo as Named] : [])

/** Where each picture these records name can be seen, as found by the readers (`blobs`). */
async function pictures(ctx: Ctx, records: { id: string; named: Named[] }[]): Promise<(id: string, n: Named) => Picture> {
  const named = records.filter((r) => r.named.length)
  const held = new Map<string, string>()
  if (named.length) {
    const { rows } = await ctx.db.query(
      `select h.id, b.sha256, b.type, b.host from blobs b join host_records h on h.host = b.host and h.id = any($1)
       where b.sha256 = any($2) order by b.host`,
      [named.map((r) => r.id), [...new Set(named.flatMap((r) => r.named.map((n) => n.sha256)))]],
    )
    for (const r of rows) {
      const key = `${r.id} ${r.sha256} ${r.type}`
      if (!held.has(key)) held.set(key, `${r.host}/v1/blobs/${r.sha256}`)
    }
  }
  return (id, n) => ({ sha256: n.sha256, mimeType: n.mimeType, url: held.get(`${id} ${n.sha256} ${n.mimeType}`) ?? null })
}

export type Offer = ReturnType<typeof offerOut>

function offerOut(ctx: Ctx, row: any, seen: (id: string, n: Named) => Picture) {
  const r = row.record
  // A post names no market or side: they are its author profile's.
  const market = ctx.directory.markets.has(row.profile_market) ? (row.profile_market as string) : null
  const live = row.direction === 'offer' && market !== null && (row.expires === null || new Date(row.expires) > new Date())
  return {
    uri: row.uri as string,
    /** The id of the record that holds the offer now: which version its terms are from. */
    id: row.id as string,
    profile: row.profile as string,
    name: (row.name as string | null) ?? null,
    profileUrl: ctx.urls.profile(row.profile),
    direction: row.direction as 'offer' | 'request',
    /** The author profile's market, when this index's directory has it; its side there. */
    market,
    marketUrl: market ? ctx.urls.market(market) : null,
    role: (row.profile_role ?? null) as string | null,
    description: row.description as string,
    /** Optional on every post. */
    price: (r.price ?? null) as PayLink['price'] | null,
    /** The escrow's two options as the post writes them, plain data; what to say about them is an app's. */
    terms: (r.terms ?? null) as PayLink['terms'],
    availability: (r.availability ?? null) as string | null,
    remote: (row.remote ?? null) as boolean | null,
    /** As the post wrote it: degrees as decimal text, how far the real place may be, and the place. */
    location: (r.location ?? null) as { lat: string; lon: string; precisionKm: number; area: string } | null,
    /** Its photos and videos. */
    media: mediaOf(r).map((m) => seen(row.id, m)),
    expires: iso(row.expires),
    createdAt: iso(row.created_at),
    /** The seller's best uniqueness on a counted row in this offer's market, and their two numbers. Side by side, never one number. */
    uniqueness: micro(row.uniqueness),
    rating: { value: row.rating === null ? null : micro(row.rating), reviews: Number(row.rating_reviews ?? 0) },
    standing: micro(row.standing),
    /** The Pay link (README.md, "The Pay link"): only on a live offer with a price. The profile's address is where it is paid. */
    payLink: live && r.price ? payLink(ctx.urls.base, { uri: row.uri, id: row.id, record: r }) : null,
  }
}

async function offersOut(ctx: Ctx, rows: any[]): Promise<Offer[]> {
  const seen = await pictures(ctx, rows.map((r) => ({ id: r.id, named: mediaOf(r.record) })))
  return rows.map((r) => offerOut(ctx, r, seen))
}

const OFFER_SELECT = `select p.*, pr.name, pr.market as profile_market, pr.role as profile_role,
       (select max(s.value_micro) from scores s where s.profile = p.profile and s.kind = 'uniqueness'
          and split_part(s.label, '/', 1) = pr.market) as uniqueness,
       (select s.value_micro from scores s where s.profile = p.profile and s.kind = 'standing' and s.label = '') as standing,
       (select s.value_micro from scores s where s.profile = p.profile and s.kind = 'rating' and s.label = '') as rating,
       (select (s.details->>'reviews')::int from scores s where s.profile = p.profile and s.kind = 'rating' and s.label = '') as rating_reviews
     from offers p left join profiles pr on pr.address = p.profile`

/**
 * A live offer: an offer, not expired, whose author profile lives in a market this index uses, byte
 * for byte. Adds the markets' names to `params` as one array.
 */
function liveWhere(ctx: Ctx, params: unknown[]): string {
  params.push([...ctx.directory.markets.keys()])
  return `p.direction = 'offer' and pr.market = any($${params.length}) and (p.expires is null or p.expires > now())`
}

/**
 * Within `km` of a point: the great-circle distance to the offer's own point (as the offer rounded
 * it), by the haversine formula in plain SQL arithmetic. An offer with no point is not near anything.
 * Adds its three parameters to `params`.
 */
function nearWhere(near: Near, params: unknown[]): string {
  params.push(near.lat, near.lon, near.km)
  const [lat, lon, km] = [params.length - 2, params.length - 1, params.length].map((i) => `$${i}`)
  return `p.lat is not null and 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(p.lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(p.lat)) * power(sin(radians(p.lon - ${lon}) / 2), 2)
  ))) <= ${km}`
}

/** Live offers, sellers with a counted row first, then by standing, then newest: two keys side by side. */
async function offers(ctx: Ctx, where: string, params: unknown[], limit: number, offset: number, near: Near | null) {
  const all = [...params]
  const live = liveWhere(ctx, all)
  const clause = near ? `${where} and ${nearWhere(near, all)}` : where
  const { rows } = await ctx.db.query(
    `select * , count(*) over () as total from (${OFFER_SELECT} where ${live} and ${clause}) o
     order by (coalesce(o.uniqueness, 0) > 0) desc, coalesce(o.standing, 0) desc, o.created_at desc nulls last, o.uri
     limit ${limit} offset ${offset}`,
    all,
  )
  return { total: rows.length ? Number(rows[0].total) : 0, offers: await offersOut(ctx, rows) }
}

/**
 * The market each profile lives in: the one its record names, when this index uses it; else null.
 * A profile is one label in one market.
 */
async function profileMarkets(ctx: Ctx, addresses: string[]): Promise<Map<string, string | null>> {
  const { rows } = await ctx.db.query('select address, market from profiles where address = any($1)', [addresses])
  const out = new Map<string, string | null>(addresses.map((a) => [a, null]))
  for (const r of rows) if (ctx.directory.markets.has(r.market)) out.set(r.address, r.market)
  return out
}

/** A profile's own label, `market/role`, as its record names it. */
const labelOf = (p: { market: string | null; role: string | null }): string | null => (p.market && p.role ? `${p.market}/${p.role}` : null)

/** Each profile's two numbers, from the last recompute. */
async function numbers(ctx: Ctx, addresses: string[]): Promise<Map<string, Numbers>> {
  const { rows } = await ctx.db.query(`select profile, kind, value_micro, details from scores where kind in ('standing', 'rating') and profile = any($1)`, [addresses])
  const out = new Map<string, Numbers>(addresses.map((a) => [a, { rating: { value: null, reviews: 0 }, standing: 0 }]))
  for (const r of rows) {
    const n = out.get(r.profile)!
    if (r.kind === 'standing') n.standing = micro(r.value_micro)
    else n.rating = { value: micro(r.value_micro), reviews: Number(r.details.reviews) }
  }
  return out
}

/** A value of a market's extra field, as the record holds it. */
export type FieldValue = string | number | boolean | (string | number | boolean)[]

export type Review = Awaited<ReturnType<typeof reviews>>[number]

/**
 * Reviews with how each was weighed, and the names and pages of both sides. A review's market is
 * the market of the profile it is about; its extra fields are the ones that market's file adds.
 */
async function reviews(ctx: Ctx, where: string, params: unknown[]) {
  const { rows } = await ctx.db.query(
    `select v.*, w.counted, w.skipped, w.evidence_kind, w.evidence_note, w.evidence_weight, w.reviewer_weight, w.contribution,
            a.name as reviewer_name, b.name as subject_name, (e.escrow is not null) as has_receipt,
            e.objected_by, e.objected_at
     from reviews v left join review_weights w on w.uri = v.uri
       left join profiles a on a.address = v.reviewer left join profiles b on b.address = v.subject
       left join escrow_receipts e on e.escrow = v.deal_id and e.program_id = $${params.length + 1}
     where ${where} order by v.created_at desc nulls last, v.uri`,
    [...params, ctx.config.escrowProgramId],
  )
  const [markets, seen] = await Promise.all([
    profileMarkets(ctx, [...new Set(rows.map((r) => r.subject as string))]),
    pictures(ctx, rows.map((r) => ({ id: r.id, named: mediaOf(r.record) }))),
  ])
  return rows.map((row) => {
    const r = row.record
    const market = markets.get(row.subject) ?? null
    const defined = Object.keys((market && ctx.directory.markets.get(market)?.reviewFields?.properties) ?? {})
    return {
      uri: row.uri as string,
      reviewer: row.reviewer as string,
      reviewerName: (row.reviewer_name ?? null) as string | null,
      reviewerUrl: ctx.urls.profile(row.reviewer),
      subject: row.subject as string,
      subjectName: (row.subject_name ?? null) as string | null,
      subjectUrl: ctx.urls.profile(row.subject),
      /** The subject's market, whose file names this review's extra fields; null when the subject lives in no one market. */
      market,
      overall: row.overall === null ? null : Number(row.overall),
      /** Every rating the review gives, by name, from 1 to 10. */
      ratings: Object.fromEntries(Object.entries((r.ratings ?? {}) as Record<string, string>).map(([k, v]) => [k, Number(v)])),
      text: row.text as string | null,
      /** Its photos and videos. */
      media: mediaOf(r).map((m) => seen(row.id, m)),
      /** The market's review fields this review fills in. */
      fields: Object.fromEntries(defined.filter((k) => r[k] !== undefined).map((k) => [k, r[k] as FieldValue])),
      dealId: row.deal_id as string | null,
      dealUrl: row.deal_id ? ctx.urls.deal(row.deal_id) : null,
      hasReceipt: Boolean(row.has_receipt),
      /** A side of the deal objected: which, the plain word for it in the subject's market, and when. */
      objection: row.objected_by ? objectionOut(ctx, market, row.objected_by, row.objected_at) : null,
      createdAt: iso(row.created_at),
      counted: (row.counted ?? false) as boolean,
      skipped: (row.skipped ?? null) as string | null,
      evidence: { kind: (row.evidence_kind ?? 'none') as string, note: (row.evidence_note ?? null) as string | null, weight: (row.evidence_weight ?? 0) as number },
      reviewerWeight: (row.reviewer_weight ?? 0) as number,
      contribution: (row.contribution ?? 0) as number,
    }
  })
}

function objectionOut(ctx: Ctx, market: string | null, by: 'buyer' | 'seller', at: unknown) {
  return { by, side: ctx.directory.sideWord(market, by), at: iso(at) }
}

function scoreOut(row: any) {
  return {
    label: row.label as string,
    value: micro(row.value_micro),
    valueMicro: String(row.value_micro),
    details: row.details,
    computedAt: Number(row.computed_at),
    signed: { statement: row.statement, message: row.message, ed25519: row.sig_ed25519, eddsaPoseidon: row.sig_eddsa },
  }
}

function marketOut(ctx: Ctx, m: MarketFile, counts: Map<string, number>) {
  return { name: m.name, url: ctx.urls.market(m.name), description: m.description, offers: counts.get(m.name) ?? 0 }
}

async function liveOfferCounts(ctx: Ctx): Promise<Map<string, number>> {
  const params: unknown[] = []
  const live = liveWhere(ctx, params)
  const { rows } = await ctx.db.query(
    `select pr.market, count(*)::int as n from offers p join profiles pr on pr.address = p.profile where ${live} group by pr.market`,
    params,
  )
  return new Map(rows.map((r) => [r.market, r.n]))
}

// -----------------------------------------------------------------------------------------------
// Pages
// -----------------------------------------------------------------------------------------------

export async function home(ctx: Ctx) {
  const counts = await liveOfferCounts(ctx)
  const keys = await ctx.db.query(`select value from index_meta where key = 'publicKeys'`)
  return {
    ...self(ctx, 'home', ctx.urls.home()),
    index: {
      name: 'Forest index',
      about: 'Profiles, offers, reviews and payment receipts, read from signed records on the hosts it lists, the registry’s rows of the issuers it trusts, and the escrow’s own events, each profile scored apart: a rating, a standing, and how sure the index is it is one real person.',
      scoring: { version: 'v2', rules: SCORING_DOC },
      payLink: PAYLINK_DOC,
      source: SOURCE,
      /** What this index reads, as three public lists: anyone can rebuild it from them, the hosts and the chain. */
      lists: LISTS,
      keys: (keys.rows[0]?.value ?? null) as { ed25519: string; eddsaPoseidon: [string, string] } | null,
      statement: {
        header: STATEMENT_HEADER,
        lines: ['kind <uniqueness|standing|rating>', 'profile <address>', 'label <row label, or empty>', 'value <millionths>', 'at <unix seconds>'],
        ed25519: 'over the statement text, UTF-8',
        eddsaPoseidon: 'over message = Poseidon(domain, kind, profile, label, value + 2^63, at); see index/README.md',
      },
      machines: {
        sitemap: ctx.urls.file('sitemap.xml'),
        llms: ctx.urls.file('llms.txt'),
        skill: ctx.urls.file('skill.md'),
        search: `${ctx.urls.base}/search.json?q={q}`,
        reputation: ctx.urls.file('v1/reputation'),
      },
    },
    folders: [...ctx.directory.folders()].map(([folder, names]) => ({
      folder,
      url: ctx.urls.folder(folder),
      markets: names.map((n) => marketOut(ctx, ctx.directory.markets.get(n)!, counts)),
    })),
  }
}

export async function folder(ctx: Ctx, name: string) {
  const names = ctx.directory.folders().get(name)
  if (!names) return null
  const counts = await liveOfferCounts(ctx)
  return {
    ...self(ctx, 'folder', ctx.urls.folder(name)),
    folder: name,
    markets: names.map((n) => marketOut(ctx, ctx.directory.markets.get(n)!, counts)),
  }
}

export const PAGE_SIZE = 50

export async function market(ctx: Ctx, name: string, offset: number, near: Near | null) {
  const file = ctx.directory.markets.get(name)
  if (!file) return null
  const [posts, stamps, page] = await Promise.all([
    ctx.db.query(
      `select p.direction, count(*)::int as n from offers p join profiles pr on pr.address = p.profile
       where pr.market = $1 and (p.expires is null or p.expires > now()) group by p.direction`,
      [name],
    ),
    ctx.db.query(
      `select r.profile, r.label, p.market as profile_market, p.role as profile_role
       from rows r join profiles p on p.address = r.profile where r.market = $2 and ${COUNTED}`,
      [Object.keys(ctx.config.issuers), name],
    ),
    offers(ctx, 'pr.market = $1', [name], PAGE_SIZE, offset, near),
  ])
  const counted = new Set(
    stamps.rows
      .filter((b) => stampStatus({ label: b.label }, { label: labelOf({ market: b.profile_market, role: b.profile_role }) }, ctx.directory).counted)
      .map((b) => b.profile),
  )
  const by = new Map(posts.rows.map((r) => [r.direction, r.n]))
  return {
    ...self(ctx, 'market', ctx.urls.market(name, offset, near)),
    market: file,
    folderUrl: ctx.urls.folder(file.folder),
    counts: { offers: by.get('offer') ?? 0, requests: by.get('request') ?? 0, realPeople: counted.size },
    near,
    limit: PAGE_SIZE,
    offset,
    total: page.total,
    next: offset + PAGE_SIZE < page.total ? ctx.urls.market(name, offset + PAGE_SIZE, near) : null,
    offers: page.offers,
  }
}

/** This index's signing key as an address: the `index` a reputation proof made against its tree names. */
async function ownIndex(ctx: Ctx): Promise<string | null> {
  const { rows } = await ctx.db.query(`select value from index_meta where key = 'publicKeys'`)
  return rows[0] ? base58.encode(hex.decode(rows[0].value.ed25519)) : null
}

/**
 * The reputation proofs a profile shows: the ones that checked when its card was stored (store.ts),
 * from an index in lists/indexes.json, against one of that index's newest `roots` roots. This index
 * knows only its own roots, so a proof from any other index shows nothing.
 */
async function proofsShown(ctx: Ctx, stored: StoredProof[]) {
  if (!stored.length) return []
  const own = await ownIndex(ctx)
  const { rows } = await ctx.db.query('select root from reputation_roots order by id desc limit $1', [ctx.config.roots])
  const roots = new Set(rows.map((r) => r.root as string))
  return stored
    .filter((x) => x.index === own && ctx.config.indexes[x.index] && roots.has(x.root))
    .map((x) => ({
      circuit: 'reputation' as const,
      /** Out of 10: the proof's score, which is ten times it. */
      score: x.score / 10,
      /** The label the proof shows, or null when it counts profiles it does not name. */
      label: x.label,
      market: x.label === null ? null : splitLabel(x.label).market,
      index: { address: x.index, name: ctx.config.indexes[x.index]!.name },
      root: x.root,
      /** When the index signed the root. */
      time: new Date(x.time).toISOString(),
    }))
}

/** The newest reputation tree: its root, when the index signed it, the signature, and how many leaves. Null with no tree. */
export async function reputation(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    'select root, time, signature, leaves from reputation_roots where exists (select 1 from reputation_leaves) order by id desc limit 1',
  )
  if (!rows.length) return null
  return { index: await ownIndex(ctx), root: rows[0].root as string, time: Number(rows[0].time), signature: rows[0].signature as string, leaves: rows[0].leaves as number }
}

/** The newest tree's every leaf, in its order, and the root they make. One statement, so the two always match. */
export async function reputationLeaves(ctx: Ctx) {
  const { rows } = await ctx.db.query(
    `select (select root from reputation_roots order by id desc limit 1) as root,
            coalesce(json_agg(json_build_object('stamp', stamp, 'scope', scope, 'score', score, 'count', count) order by position), '[]') as leaves
     from reputation_leaves`,
  )
  const leaves = rows[0].leaves as { stamp: string; scope: string; score: number; count: number }[]
  return leaves.length ? { root: rows[0].root as string, leaves } : null
}

export async function profile(ctx: Ctx, address: string) {
  const { rows } = await ctx.db.query('select * from profiles where address = $1', [address])
  if (!rows.length) return null
  const p = rows[0]
  const r = p.record
  const [stamps, scores, posts, received, given, proofs] = await Promise.all([
    // Each row of a trusted issuer whose signature checks. Any other row counts for nothing here.
    ctx.db.query(`select r.* from rows r where r.profile = $2 and ${COUNTED} order by r.label, r.issuer, r.address`, [Object.keys(ctx.config.issuers), address]),
    ctx.db.query('select * from scores where profile = $1 order by kind, label', [address]),
    ctx.db.query(`${OFFER_SELECT} where p.profile = $1 order by p.created_at desc nulls last, p.uri`, [address]),
    reviews(ctx, 'v.subject = $1', [address]),
    reviews(ctx, 'v.reviewer = $1', [address]),
    proofsShown(ctx, p.proofs as StoredProof[]),
  ])
  const standing = scores.rows.find((s) => s.kind === 'standing')
  const rating = scores.rows.find((s) => s.kind === 'rating')
  const seen = await pictures(ctx, [{ id: p.id, named: photoOf(r) }, ...posts.rows.map((row) => ({ id: row.id, named: mediaOf(row.record) }))])
  const allPosts = posts.rows.map((row) => offerOut(ctx, row, seen))
  const isLive = (o: Offer) => o.market !== null && (o.expires === null || new Date(o.expires) > new Date())
  const home = ctx.directory.markets.get(p.market)
  return {
    ...self(ctx, 'profile', ctx.urls.profile(address)),
    /** The profile's name: its key's address, which is also where it is paid. */
    address,
    profile: {
      name: p.name as string,
      /** The one market this profile lives in, and its side there, as its record names them. */
      market: p.market as string | null,
      marketUrl: home ? ctx.urls.market(p.market) : null,
      role: p.role as string | null,
      /** The plain word for its side: the market's role name, the role itself, or null in a one-sided market. */
      side: home?.sides === 'two' && (p.role === 'seller' || p.role === 'buyer') ? ctx.directory.sideWord(p.market, p.role) : null,
      about: (r.about ?? null) as string | null,
      /** Its reading key, for whoever makes a private record for it or sends it a message; null when it publishes none. */
      read: (r.read ?? null) as string | null,
      /** Who may deliver a message to it, as its card says; null when it takes none. Messages go to its hosts, never here. */
      inbox: (r.inbox ?? null) as { senders: 'anyone' | { issuer: string }; once?: true; maxBytes?: number } | null,
      /** Its photo, and where to see it. */
      photo: photoOf(r).map((m) => seen(p.id, m))[0] ?? null,
      createdAt: iso(p.created_at),
      /** The id of the record that holds the profile card now. */
      id: p.id as string,
    },
    /** Each row of an issuer this index trusts: a market stamp on its list, under a label. */
    stamps: stamps.rows.map((b) => {
      const status = stampStatus({ label: b.label }, { label: labelOf(p) }, ctx.directory)
      const file = ctx.directory.markets.get(b.market)
      return {
        label: b.label as string,
        market: b.market as string,
        marketUrl: file ? ctx.urls.market(b.market) : null,
        role: b.role as string | null,
        /** The plain word for the role: the market's role name, the role itself, or null in a one-sided market. */
        side: status.counted && file?.sides === 'two' ? ctx.directory.sideWord(b.market, status.role as 'seller' | 'buyer') : null,
        issuer: {
          address: b.issuer as string,
          name: (ctx.config.issuers[b.issuer]?.name ?? null) as string | null,
          weight: (ctx.config.issuers[b.issuer]?.weight ?? 0) as number,
        },
        counted: status.counted,
        why: status.counted ? null : status.why,
        /** The row's address: the registry account anyone can read to check it. */
        row: b.address as string,
        root: b.root as string,
        issuerSignature: b.issuer_signature as string,
      }
    }),
    scores: {
      uniqueness: scores.rows.filter((s) => s.kind === 'uniqueness').map(scoreOut),
      standing: standing ? scoreOut(standing) : null,
      rating: rating ? scoreOut(rating) : null,
    },
    /** The reputation proofs its card carries that this index shows: a score from profiles of the same person, naming none of them. */
    proofs,
    offers: allPosts.filter((o) => o.direction === 'offer' && isLive(o)),
    requests: allPosts.filter((o) => o.direction === 'request' && isLive(o)),
    reviews: { received, given },
  }
}

export async function deal(ctx: Ctx, dealId: string) {
  const [receipt, named] = await Promise.all([
    ctx.db.query('select * from escrow_receipts where escrow = $1 and program_id = $2', [dealId, ctx.config.escrowProgramId]),
    reviews(ctx, 'v.deal_id = $1', [dealId]),
  ])
  if (!receipt.rowCount && !named.length) return null
  let out = null
  if (receipt.rowCount) {
    const e = receipt.rows[0]
    // A party's key is a profile's address: each side is one profile here, or none this index holds.
    const profiles = await ctx.db.query('select address, name from profiles where address = any($1) order by address', [[e.buyer, e.seller]])
    const addresses = profiles.rows.map((p) => p.address as string)
    const [scores, markets] = await Promise.all([numbers(ctx, addresses), profileMarkets(ctx, addresses)])
    const of = (key: string) =>
      profiles.rows
        .filter((p) => p.address === key)
        .map((p) => ({ address: p.address as string, name: p.name as string, url: ctx.urls.profile(p.address), ...scores.get(p.address)! }))
    const sellerProfiles = of(e.seller)
    // A deal names no market; the seller's profile lives in one, whose role names name the two sides.
    const sellerMarkets = [...new Set(sellerProfiles.map((p) => markets.get(p.address)).filter((m) => m))]
    const market = sellerMarkets.length === 1 ? sellerMarkets[0]! : null
    const sides = { seller: ctx.directory.sideWord(market, 'seller'), buyer: ctx.directory.sideWord(market, 'buyer') }
    out = {
      escrow: e.escrow as string,
      program: e.program_id as string,
      buyer: e.buyer as string,
      seller: e.seller as string,
      creator: e.creator as 'buyer' | 'seller',
      buyerProfiles: of(e.buyer),
      sellerProfiles,
      /** The seller's market, whose role names the page uses for the two sides; null when there is none. */
      market,
      sides,
      mint: e.mint as string,
      amount: e.amount as string,
      arbiter: (e.arbiter ?? null) as string | null,
      timer: e.timer_days ? { days: e.timer_days as number, to: e.timer_to as 'buyer' | 'seller' } : null,
      createdAt: iso(e.created_at),
      fundedAt: iso(e.funded_at),
      endedAt: iso(e.ended_at),
      outcome: (e.outcome ?? null) as string | null,
      toSeller: (e.to_seller ?? null) as string | null,
      toBuyer: (e.to_buyer ?? null) as string | null,
      closed: e.closed as boolean,
      /** A side objected, and when. It moved no money. */
      objection: e.objected_by ? { by: e.objected_by as 'buyer' | 'seller', side: sides[e.objected_by as 'buyer' | 'seller'], at: iso(e.objected_at) } : null,
      transaction: e.signature as string,
    }
  }
  return { ...self(ctx, 'deal', ctx.urls.deal(dealId)), dealId, receipt: out, reviews: named }
}

export async function search(ctx: Ctx, q: string, near: Near | null) {
  const needle = q.toLowerCase()
  const counts = await liveOfferCounts(ctx)
  const markets = q
    ? [...ctx.directory.markets.values()]
        .map((m) => {
          const words = [...m.roles, ...Object.values(m.roleNames ?? {})]
          const matched = m.name.includes(needle)
            ? 'name'
            : m.folder.includes(needle)
              ? 'folder'
              : words.some((r) => r.toLowerCase().includes(needle))
                ? 'role'
                : null
          return matched ? { ...marketOut(ctx, m, counts), folder: m.folder, matched } : null
        })
        .filter((m) => m !== null)
    : []
  const page = q ? await offers(ctx, `p.search @@ websearch_to_tsquery('simple', $1)`, [q], PAGE_SIZE, 0, near) : { total: 0, offers: [] as Offer[] }
  return { ...self(ctx, 'search', ctx.urls.search(q, near)), q, near, markets, offers: page.offers, total: page.total }
}

/** Every page meant for search engines, for the sitemap. Search, pay and deals with no receipt are left out (noindex). */
export async function pages(ctx: Ctx): Promise<string[]> {
  const [profiles, deals] = await Promise.all([
    ctx.db.query('select address from profiles order by address'),
    ctx.db.query('select escrow from escrow_receipts where program_id = $1 order by escrow', [ctx.config.escrowProgramId]),
  ])
  return [
    ctx.urls.home(),
    ...[...ctx.directory.folders().keys()].map((f) => ctx.urls.folder(f)),
    ...[...ctx.directory.markets.keys()].sort().map((m) => ctx.urls.market(m)),
    ...profiles.rows.map((r) => ctx.urls.profile(r.address)),
    ...deals.rows.map((r) => ctx.urls.deal(r.escrow)),
  ]
}

/** One offer, by its record address, for the pay page. */
export async function offerByUri(ctx: Ctx, uri: string): Promise<Offer | null> {
  const { rows } = await ctx.db.query(`${OFFER_SELECT} where p.uri = $1`, [uri])
  return rows.length ? (await offersOut(ctx, rows))[0]! : null
}

export type HomeModel = Awaited<ReturnType<typeof home>>
export type FolderModel = NonNullable<Awaited<ReturnType<typeof folder>>>
export type MarketModel = NonNullable<Awaited<ReturnType<typeof market>>>
export type ProfileModel = NonNullable<Awaited<ReturnType<typeof profile>>>
export type DealModel = NonNullable<Awaited<ReturnType<typeof deal>>>
export type SearchModel = Awaited<ReturnType<typeof search>>
