// The page models. One function per page reads the database and returns one object: that object
// is the page's JSON twin, and the HTML is rendered from it (pages.ts), so the two never say
// different things. Field names such as `wallet` and `mint` are the records' own; they are for
// machines, and the HTML shows none of them.

import type { Config } from '../config.ts'
import type { Db } from '../db.ts'
import type { Directory, MarketFile } from '../markets.ts'
import { badgeStatus } from '../scores/compute.ts'
import { STATEMENT_HEADER } from '../scores/sign.ts'
import { type Near, type Urls, SCORING_DOC, SOURCE, PAYLINK_DOC } from './html.ts'
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

export type Offer = ReturnType<typeof offerOut>

function offerOut(ctx: Ctx, row: any) {
  const r = row.record
  // A post names no market or side: they are its author profile's.
  const market = ctx.directory.markets.has(row.profile_market) ? (row.profile_market as string) : null
  const live = row.direction === 'offer' && market !== null && (row.expires === null || new Date(row.expires) > new Date())
  return {
    uri: row.uri,
    cid: row.cid,
    did: row.did,
    name: (row.name as string | null) ?? null,
    profileUrl: ctx.urls.profile(row.did),
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
    expires: iso(row.expires),
    createdAt: iso(row.created_at),
    /** The seller's best uniqueness on a badge in this post's market, and their two numbers. Side by side, never one number. */
    uniqueness: micro(row.uniqueness),
    rating: { value: row.rating === null ? null : micro(row.rating), reviews: Number(row.rating_reviews ?? 0) },
    standing: micro(row.standing),
    /** The Pay link (PAYLINK.md): only on a live, priced offer whose profile names a key to be paid at. */
    payLink: live && row.declared && r.price ? payLink(ctx.urls.base, { uri: row.uri, cid: row.cid, record: r }) : null,
  }
}

const OFFER_SELECT = `select p.*, pr.name, pr.wallet as declared, pr.market as profile_market, pr.role as profile_role,
       (select max(s.value_micro) from scores s where s.did = p.did and s.kind = 'uniqueness'
          and split_part(s.scope, '/', 1) = pr.market) as uniqueness,
       (select s.value_micro from scores s where s.did = p.did and s.kind = 'standing' and s.scope = '') as standing,
       (select s.value_micro from scores s where s.did = p.did and s.kind = 'rating' and s.scope = '') as rating,
       (select (s.details->>'reviews')::int from scores s where s.did = p.did and s.kind = 'rating' and s.scope = '') as rating_reviews
     from posts p left join profiles pr on pr.did = p.did`

/**
 * A live offer: an offer, not expired, whose author profile lives in a market this index's directory
 * lists, byte for byte. Adds the directory's names to `params` as one array.
 */
function liveWhere(ctx: Ctx, params: unknown[]): string {
  params.push([...ctx.directory.markets.keys()])
  return `p.direction = 'offer' and pr.market = any($${params.length}) and (p.expires is null or p.expires > now())`
}

/**
 * Within `km` of a point: the great-circle distance to the post's own point (as the post rounded
 * it), by the haversine formula in plain SQL arithmetic. A post with no point is not near anything.
 * Adds its three parameters to `params`.
 */
function nearWhere(near: Near, params: unknown[]): string {
  params.push(near.lat, near.lon, near.km)
  const [lat, lon, km] = [params.length - 2, params.length - 1, params.length].map((i) => `$${i}`)
  return `p.lat is not null and 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(p.lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(p.lat)) * power(sin(radians(p.lon - ${lon}) / 2), 2)
  ))) <= ${km}`
}

/** Live offers, badged sellers first, then by standing, then newest: two keys side by side. */
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
  return { total: rows.length ? Number(rows[0].total) : 0, offers: rows.map((r) => offerOut(ctx, r)) }
}

/**
 * The market each profile lives in: the one its record names, when this index's directory has it;
 * else null. A profile is one folder in one market.
 */
async function profileMarkets(ctx: Ctx, dids: string[]): Promise<Map<string, string | null>> {
  const { rows } = await ctx.db.query('select did, market from profiles where did = any($1)', [dids])
  const out = new Map<string, string | null>(dids.map((d) => [d, null]))
  for (const r of rows) if (ctx.directory.markets.has(r.market)) out.set(r.did, r.market)
  return out
}

/** A profile's own scope, `market/role`, as its record names it. */
const scopeOf = (p: { market: string | null; role: string | null }): string | null => (p.market && p.role ? `${p.market}/${p.role}` : null)

/** Each profile's two numbers, from the last recompute. */
async function numbers(ctx: Ctx, dids: string[]): Promise<Map<string, Numbers>> {
  const { rows } = await ctx.db.query(`select did, kind, value_micro, details from scores where kind in ('standing', 'rating') and did = any($1)`, [dids])
  const out = new Map<string, Numbers>(dids.map((d) => [d, { rating: { value: null, reviews: 0 }, standing: 0 }]))
  for (const r of rows) {
    const n = out.get(r.did)!
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
            a.name as reviewer_name, b.name as subject_name, (e.escrow is not null) as has_receipt
     from reviews v left join review_weights w on w.uri = v.uri
       left join profiles a on a.did = v.reviewer left join profiles b on b.did = v.subject
       left join escrow_receipts e on e.escrow = v.deal_id
     where ${where} order by v.created_at desc nulls last, v.uri`,
    params,
  )
  const markets = await profileMarkets(ctx, [...new Set(rows.map((r) => r.subject as string))])
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
      media: ((r.media ?? []) as { ref?: { $link?: string }; mimeType?: string }[]).map((m) => ({ cid: m.ref?.$link ?? null, mimeType: m.mimeType ?? null })),
      /** The market's review fields this review fills in. */
      fields: Object.fromEntries(defined.filter((k) => r[k] !== undefined).map((k) => [k, r[k] as FieldValue])),
      dealId: row.deal_id as string | null,
      dealUrl: row.deal_id ? ctx.urls.deal(row.deal_id) : null,
      hasReceipt: Boolean(row.has_receipt),
      createdAt: iso(row.created_at),
      counted: (row.counted ?? false) as boolean,
      skipped: (row.skipped ?? null) as string | null,
      evidence: { kind: (row.evidence_kind ?? 'none') as string, note: (row.evidence_note ?? null) as string | null, weight: (row.evidence_weight ?? 0) as number },
      reviewerWeight: (row.reviewer_weight ?? 0) as number,
      contribution: (row.contribution ?? 0) as number,
    }
  })
}

function scoreOut(row: any) {
  return {
    scope: row.scope as string,
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
    `select pr.market, count(*)::int as n from posts p join profiles pr on pr.did = p.did where ${live} group by pr.market`,
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
      about: 'Profiles, badges, reviews and payment receipts, read from signed records and the programs’ own events, each profile scored apart: a rating, a standing, and how sure the index is it is one real person.',
      scoring: { version: 'v1', rules: SCORING_DOC },
      payLink: PAYLINK_DOC,
      source: SOURCE,
      keys: (keys.rows[0]?.value ?? null) as { ed25519: string; eddsaPoseidon: [string, string] } | null,
      statement: {
        header: STATEMENT_HEADER,
        lines: ['kind <uniqueness|standing|rating>', 'did <did>', 'scope <badge scope, or empty>', 'value <millionths>', 'at <unix seconds>'],
        ed25519: 'over the statement text, UTF-8',
        eddsaPoseidon: 'over message = Poseidon(domain, kind, did, scope, value + 2^63, at); see index/SCORING.md',
      },
      machines: {
        sitemap: ctx.urls.file('sitemap.xml'),
        llms: ctx.urls.file('llms.txt'),
        skill: ctx.urls.file('skill.md'),
        search: `${ctx.urls.base}/search.json?q={q}`,
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
  const [posts, badges, page] = await Promise.all([
    ctx.db.query(
      `select p.direction, count(*)::int as n from posts p join profiles pr on pr.did = p.did
       where pr.market = $1 and (p.expires is null or p.expires > now()) group by p.direction`,
      [name],
    ),
    ctx.db.query(
      `select b.did, b.wallet, b.scope, b.list_owner, p.wallet as declared, p.market as profile_market, p.role as profile_role
       from badges b join profiles p on p.did = b.did where b.market = $1`,
      [name],
    ),
    offers(ctx, 'pr.market = $1', [name], PAGE_SIZE, offset, near),
  ])
  const counted = new Set(
    badges.rows
      .filter(
        (b) =>
          badgeStatus(
            { did: b.did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner },
            { wallet: b.declared, scope: scopeOf({ market: b.profile_market, role: b.profile_role }) },
            ctx.directory,
          ).counted,
      )
      .map((b) => b.did),
  )
  const by = new Map(posts.rows.map((r) => [r.direction, r.n]))
  return {
    ...self(ctx, 'market', ctx.urls.market(name, offset, near)),
    market: file,
    folderUrl: ctx.urls.folder(file.folder),
    counts: { offers: by.get('offer') ?? 0, requests: by.get('request') ?? 0, badgedProfiles: counted.size },
    near,
    limit: PAGE_SIZE,
    offset,
    total: page.total,
    next: offset + PAGE_SIZE < page.total ? ctx.urls.market(name, offset + PAGE_SIZE, near) : null,
    offers: page.offers,
  }
}

export async function profile(ctx: Ctx, did: string) {
  const { rows } = await ctx.db.query('select * from profiles where did = $1', [did])
  if (!rows.length) return null
  const p = rows[0]
  const r = p.record
  const [badges, scores, posts, credentials, received, given] = await Promise.all([
    ctx.db.query(
      `select b.*, t.block_time as registered_at from badges b join chain_transactions t on t.signature = b.signature
       where b.did = $1 order by b.slot, b.ix`,
      [did],
    ),
    ctx.db.query('select * from scores where did = $1 order by kind, scope', [did]),
    ctx.db.query(`${OFFER_SELECT} where p.did = $1 order by p.created_at desc nulls last, p.uri`, [did]),
    ctx.db.query('select * from credentials where did = $1 order by created_at desc nulls last, uri', [did]),
    reviews(ctx, 'v.subject = $1', [did]),
    reviews(ctx, 'v.reviewer = $1', [did]),
  ])
  const standing = scores.rows.find((s) => s.kind === 'standing')
  const rating = scores.rows.find((s) => s.kind === 'rating')
  const allPosts = posts.rows.map((row) => offerOut(ctx, row))
  const isLive = (o: Offer) => o.market !== null && (o.expires === null || new Date(o.expires) > new Date())
  const home = ctx.directory.markets.get(p.market)
  return {
    ...self(ctx, 'profile', ctx.urls.profile(did)),
    did,
    profile: {
      name: p.name as string,
      /** The one market this profile lives in, and its side there, as its record names them. */
      market: p.market as string | null,
      marketUrl: home ? ctx.urls.market(p.market) : null,
      role: p.role as string | null,
      /** The plain word for its side: the market's label, the role itself, or null in a one-sided market. */
      side: home?.sides === 'two' && (p.role === 'seller' || p.role === 'buyer') ? ctx.directory.sideWord(p.market, p.role) : null,
      about: (r.about ?? null) as string | null,
      contact: (r.contact ?? null) as string | null,
      wallet: (p.wallet ?? null) as string | null,
      photo: r.photo ? { cid: (r.photo.ref?.$link ?? null) as string | null, mimeType: (r.photo.mimeType ?? null) as string | null } : null,
      createdAt: iso(p.created_at),
      cid: p.cid as string,
    },
    badges: badges.rows.map((b) => {
      const status = badgeStatus({ did, wallet: b.wallet, scope: b.scope, listOwner: b.list_owner }, { wallet: p.wallet, scope: scopeOf(p) }, ctx.directory)
      const issuer = ctx.config.issuers[b.list_owner]
      const file = ctx.directory.markets.get(b.market)
      return {
        scope: b.scope as string,
        market: b.market as string,
        marketUrl: file ? ctx.urls.market(b.market) : null,
        role: b.role as string | null,
        /** The plain word for the role: the market's label, the role itself, or null in a one-sided market. */
        side: status.counted && file?.sides === 'two' ? ctx.directory.sideWord(b.market, status.role as 'seller' | 'buyer') : null,
        listIndex: b.list_index as number,
        listOwner: b.list_owner as string,
        issuer: { name: (issuer?.name ?? null) as string | null, weight: (issuer?.weight ?? 0) as number },
        wallet: b.wallet as string,
        counted: status.counted,
        why: status.counted ? null : status.why,
        registeredAt: iso(b.registered_at),
        transaction: b.signature as string,
      }
    }),
    scores: {
      uniqueness: scores.rows.filter((s) => s.kind === 'uniqueness').map(scoreOut),
      standing: standing ? scoreOut(standing) : null,
      rating: rating ? scoreOut(rating) : null,
    },
    offers: allPosts.filter((o) => o.direction === 'offer' && isLive(o)),
    requests: allPosts.filter((o) => o.direction === 'request' && isLive(o)),
    credentials: credentials.rows.map((c) => ({ uri: c.uri, issuer: c.issuer, createdAt: iso(c.created_at), credential: c.record.credential })),
    reviews: { received, given },
  }
}

export async function deal(ctx: Ctx, dealId: string) {
  const [receipt, named] = await Promise.all([
    ctx.db.query('select * from escrow_receipts where escrow = $1', [dealId]),
    reviews(ctx, 'v.deal_id = $1', [dealId]),
  ])
  if (!receipt.rowCount && !named.length) return null
  let out = null
  if (receipt.rowCount) {
    const e = receipt.rows[0]
    const profiles = await ctx.db.query('select did, name, wallet from profiles where wallet = any($1) order by did', [[e.buyer, e.seller]])
    const dids = profiles.rows.map((p) => p.did as string)
    const [scores, markets] = await Promise.all([numbers(ctx, dids), profileMarkets(ctx, dids)])
    const of = (w: string) =>
      profiles.rows.filter((p) => p.wallet === w).map((p) => ({ did: p.did as string, name: p.name as string, url: ctx.urls.profile(p.did), ...scores.get(p.did)! }))
    const sellerProfiles = of(e.seller)
    // A deal names no market; the seller's profile lives in one, whose labels name the two sides.
    const sellerMarkets = [...new Set(sellerProfiles.map((p) => markets.get(p.did)).filter((m) => m))]
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
      /** The seller's market, whose labels the page uses for the two sides; null when there is none. */
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
          const words = [...m.roles, ...Object.values(m.labels ?? {})]
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
  const page = q ? await offers(ctx, `p.search @@ websearch_to_tsquery('simple', $1)`, [q], PAGE_SIZE, 0, near) : { total: 0, offers: [] }
  return { ...self(ctx, 'search', ctx.urls.search(q, near)), q, near, markets, offers: page.offers, total: page.total }
}

/** Every page meant for search engines, for the sitemap. Search, pay and deals with no receipt are left out (noindex). */
export async function pages(ctx: Ctx): Promise<string[]> {
  const [profiles, deals] = await Promise.all([
    ctx.db.query('select did from profiles order by did'),
    ctx.db.query('select escrow from escrow_receipts order by escrow'),
  ])
  return [
    ctx.urls.home(),
    ...[...ctx.directory.folders().keys()].map((f) => ctx.urls.folder(f)),
    ...[...ctx.directory.markets.keys()].sort().map((m) => ctx.urls.market(m)),
    ...profiles.rows.map((r) => ctx.urls.profile(r.did)),
    ...deals.rows.map((r) => ctx.urls.deal(r.escrow)),
  ]
}

/** One offer, by its record address, for the pay page. */
export async function offerByUri(ctx: Ctx, uri: string): Promise<Offer | null> {
  const { rows } = await ctx.db.query(`${OFFER_SELECT} where p.uri = $1`, [uri])
  return rows.length ? offerOut(ctx, rows[0]) : null
}

export type HomeModel = Awaited<ReturnType<typeof home>>
export type FolderModel = NonNullable<Awaited<ReturnType<typeof folder>>>
export type MarketModel = NonNullable<Awaited<ReturnType<typeof market>>>
export type ProfileModel = NonNullable<Awaited<ReturnType<typeof profile>>>
export type DealModel = NonNullable<Awaited<ReturnType<typeof deal>>>
export type SearchModel = Awaited<ReturnType<typeof search>>
