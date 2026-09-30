// The scores, as pure functions: plain data in, plain data out, no database and no clock. Every
// rule here is written out in plain words in SCORING.md; the two must say the same thing.
//
// Three scores, never blended into one number:
//   uniqueness  per badge: which issuers' lists vouch for it, by this index's issuer weights
//   standing    per profile: reviews received, each weighed by its reviewer and by its evidence
//   rating      per profile: the reviews' `overall`, averaged with the same weights, 1.0 to 10.0
//
// Uniqueness enters standing only as the starting weight of a reviewer (the handoff: "an unbadged
// reviewer's review weighs near zero"). Without that seed, "weighted by the reviewer's own
// standing" with everyone starting at zero would leave every score at zero forever.

import type { IssuerConfig, ScoringConfig } from '../config.ts'
import { type Directory, splitScope } from '../markets.ts'

/** A profile, with the wallet it declares and the one scope it lives in (`market/role`, from its record). */
export type ProfileIn = { did: string; wallet: string | null; scope: string | null }
export type BadgeIn = { did: string; wallet: string; scope: string; listOwner: string }
export type ReceiptIn = {
  escrow: string
  buyer: string
  seller: string
  /** Who opened the escrow: the seller, for an invoice. */
  creator: 'buyer' | 'seller'
  mint: string
  /** Someone marked the funding. */
  funded: boolean
  /** How it ended, or null while it has not. Every way out pays the whole balance, which must hold the amount. */
  outcome: string | null
  closed: boolean
}
export type ReviewIn = {
  uri: string
  reviewer: string
  subject: string
  /** The review's `overall` rating, 1.0 to 10.0, or null when it gives none. */
  overall: number | null
  dealId: string | null
  createdAt: string | null
}

export type Inputs = {
  profiles: ProfileIn[]
  badges: BadgeIn[]
  receipts: ReceiptIn[]
  reviews: ReviewIn[]
}

export type Settings = {
  directory: Directory
  issuers: IssuerConfig
  scoring: ScoringConfig
}

// ---------------------------------------------------------------------------------------------
// Badges and uniqueness
// ---------------------------------------------------------------------------------------------

export type BadgeStatus =
  | { counted: true; market: string; role: string }
  | { counted: false; why: 'notInDirectory' | 'noRole' | 'notProfileScope' | 'walletNotDeclared' }

/**
 * A badge counts for its profile only when its scope is `market/role`, the market a directory
 * market byte for byte and the role one of that market's roles; when that is the profile's own
 * scope, the one market and side its record names; and when the profile's record declares the
 * wallet the registry's entry names. A plain `market` scope counts for nothing.
 */
export function badgeStatus(
  badge: BadgeIn,
  profile: { wallet: string | null; scope: string | null },
  directory: Directory,
): BadgeStatus {
  const scope = directory.badgeScope(badge.scope)
  if (!scope) {
    const { market, role } = splitScope(badge.scope)
    return { counted: false, why: role === null && directory.markets.has(market) ? 'noRole' : 'notInDirectory' }
  }
  if (badge.scope !== profile.scope) return { counted: false, why: 'notProfileScope' }
  if (profile.wallet === null || profile.wallet !== badge.wallet) return { counted: false, why: 'walletNotDeclared' }
  return { counted: true, ...scope }
}

export function issuerWeight(issuers: IssuerConfig, owner: string): number {
  const w = issuers[owner]?.weight ?? 0
  return Math.min(1, Math.max(0, w))
}

export type Uniqueness = {
  did: string
  scope: string
  market: string
  role: string
  value: number
  issuers: { owner: string; name: string | null; weight: number }[]
}

/**
 * Per profile and badge scope: the distinct list owners behind its counted entries, combined as
 * 1 − Π(1 − weight). One issuer at weight w gives w; two independent issuers give more than either
 * and never more than 1; an issuer at 0 adds nothing.
 */
export function uniqueness(inputs: Pick<Inputs, 'profiles' | 'badges'>, settings: Settings): Uniqueness[] {
  const profiles = new Map(inputs.profiles.map((p) => [p.did, p]))
  const groups = new Map<string, { did: string; scope: string; market: string; role: string; owners: Set<string> }>()
  for (const b of inputs.badges) {
    const profile = profiles.get(b.did)
    if (!profile) continue
    const status = badgeStatus(b, profile, settings.directory)
    if (!status.counted) continue
    const key = `${b.did}\u0000${b.scope}`
    const g = groups.get(key) ?? { did: b.did, scope: b.scope, market: status.market, role: status.role, owners: new Set() }
    g.owners.add(b.listOwner)
    groups.set(key, g)
  }
  const out: Uniqueness[] = []
  for (const g of groups.values()) {
    const issuers = [...g.owners].sort().map((owner) => ({
      owner,
      name: settings.issuers[owner]?.name ?? null,
      weight: issuerWeight(settings.issuers, owner),
    }))
    const value = 1 - issuers.reduce((p, i) => p * (1 - i.weight), 1)
    out.push({ did: g.did, scope: g.scope, market: g.market, role: g.role, value, issuers })
  }
  return out.sort((a, b) => cmp(a.did, b.did) || cmp(a.scope, b.scope))
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/**
 * What stands under a review's deal id (the handoff's "who said yes": a receipt counts fully when
 * the seller signed for it: created the escrow, signed its ending, or reviewed the deal).
 *   both                paid, and the seller signed: created the escrow (an invoice), or signed
 *                       its ending (a split, or a release back to the buyer)
 *   oneSidedConfirmed   paid, the buyer created it, and the seller reviewed the same deal
 *   oneSided            paid, the buyer created it, and the seller has not reviewed it
 *   none                no receipt this index counts, with the reason in `note`
 */
export type EvidenceKind = 'both' | 'oneSidedConfirmed' | 'oneSided' | 'none'
export type EvidenceNote =
  | 'noDealId'
  | 'noReceipt'
  | 'notTheParties'
  | 'tokenNotCounted'
  | 'notPaid'
export type Evidence = { kind: EvidenceKind; weight: number; note?: EvidenceNote }

/**
 * Paid: someone marked the funding, or it ended. Every way out of the escrow pays out a balance
 * that held the amount (the program checks it), so an ending proves the payment; a one-tap payment
 * has no funding mark at all.
 */
export function paid(r: Pick<ReceiptIn, 'funded' | 'outcome'>): boolean {
  return r.funded || r.outcome !== null
}

export function evidenceFor(
  review: ReviewIn,
  ctx: {
    receipts: Map<string, ReceiptIn>
    wallets: Map<string, string | null>
    reviews: ReviewIn[]
    scoring: ScoringConfig
  },
): Evidence {
  const w = ctx.scoring.evidence
  const none = (note: EvidenceNote): Evidence => ({ kind: 'none', weight: w.none, note })
  if (!review.dealId) return none('noDealId')
  const r = ctx.receipts.get(review.dealId)
  if (!r || r.closed) return none('noReceipt')
  if (!partiesMatch(r, ctx.wallets.get(review.reviewer) ?? null, ctx.wallets.get(review.subject) ?? null)) {
    return none('notTheParties')
  }
  if (!ctx.scoring.countedMints.includes(r.mint)) return none('tokenNotCounted')
  if (!paid(r)) return none('notPaid')
  if (r.creator === 'seller' || (r.outcome !== null && SELLER_SIGNS.has(r.outcome))) return { kind: 'both', weight: w.both }
  const sellerReviewed = ctx.reviews.some(
    (v) => v.dealId === r.escrow && ctx.wallets.get(v.reviewer) === r.seller && ctx.wallets.get(v.subject) === r.buyer,
  )
  return sellerReviewed ? { kind: 'oneSidedConfirmed', weight: w.both } : { kind: 'oneSided', weight: w.oneSided }
}

/** The endings the seller signs: a split (both sign) and a release back to the buyer (a refund). */
const SELLER_SIGNS = new Set(['split', 'releasedToBuyer'])

/** The reviewer and the subject are the escrow's two parties, by their declared wallets, either way round. */
function partiesMatch(r: ReceiptIn, reviewerWallet: string | null, subjectWallet: string | null): boolean {
  if (!reviewerWallet || !subjectWallet || reviewerWallet === subjectWallet) return false
  return (
    (reviewerWallet === r.buyer && subjectWallet === r.seller) ||
    (reviewerWallet === r.seller && subjectWallet === r.buyer)
  )
}

// ---------------------------------------------------------------------------------------------
// Standing and rating
// ---------------------------------------------------------------------------------------------

/** An overall rating as a signal: 10 is +1, 5.5 is 0, 1 is −1. No rating says neither, so 0. */
export function signal(overall: number | null): number {
  return overall === null ? 0 : (overall - 5.5) / 4.5
}

/** How much a reviewer's word weighs: its best badge (or the floor), scaled by its own standing. */
export function reviewerWeight(u: number, t: number, scoring: ScoringConfig): number {
  return Math.max(u, scoring.unbadgedReviewer) * (1 + t / (Math.abs(t) + 1))
}

export type ScoredReview = ReviewIn & {
  counted: boolean
  /** Why a review does not count: its reviewer is its subject, or a later review replaces it. */
  skipped?: 'self' | 'replaced'
  evidence: Evidence
  reviewerWeight: number
  signal: number
  contribution: number
}

export type Standing = {
  did: string
  value: number
  reviews: { received: number; counted: number; withReceipt: number }
}

/**
 * The weighted `overall`: each counted review that gives one, weighed by its reviewer's weight
 * times the evidence under it, the same weights standing uses. Null when no counted review rates.
 */
export type Rating = {
  did: string
  value: number | null
  /** How many counted reviews give an `overall`. */
  reviews: number
}

export type Scores = {
  uniqueness: Uniqueness[]
  standing: Standing[]
  rating: Rating[]
  reviews: ScoredReview[]
  rounds: number
}

export function compute(inputs: Inputs, settings: Settings): Scores {
  const { scoring } = settings
  const wallets = new Map(inputs.profiles.map((p) => [p.did, p.wallet]))
  const receipts = new Map(inputs.receipts.map((r) => [r.escrow, r]))
  const uniq = uniqueness(inputs, settings)
  const best = new Map<string, number>()
  for (const u of uniq) best.set(u.did, Math.max(best.get(u.did) ?? 0, u.value))

  // Which reviews count. Per reviewer and subject: one per deal id that has evidence under it,
  // and one in all for everything else (the latest), so a reviewer cannot add weight by repeating
  // itself or by inventing deal ids.
  const ctx = { receipts, wallets, reviews: inputs.reviews, scoring }
  const evidence = new Map(inputs.reviews.map((v) => [v.uri, evidenceFor(v, ctx)]))
  const latest = [...inputs.reviews].sort((a, b) => cmp(b.createdAt ?? '', a.createdAt ?? '') || cmp(b.uri, a.uri))
  const kept = new Set<string>()
  const seen = new Set<string>()
  for (const v of latest) {
    if (v.reviewer === v.subject) continue
    const e = evidence.get(v.uri)!
    const key = e.kind === 'none' ? `${v.reviewer}\u0000${v.subject}\u0000` : `${v.reviewer}\u0000${v.subject}\u0000${v.dealId}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.add(v.uri)
  }
  const counted = inputs.reviews.filter((v) => kept.has(v.uri))

  // Standing: repeat the sum, each reviewer weighed by the standing the last round gave it, until
  // no profile moves by more than the tolerance.
  const dids = new Set<string>([...wallets.keys(), ...inputs.reviews.map((v) => v.subject), ...inputs.reviews.map((v) => v.reviewer)])
  let t = new Map<string, number>([...dids].map((d) => [d, 0]))
  let rounds = 0
  for (; rounds < scoring.maxRounds; ) {
    rounds++
    const next = new Map<string, number>([...dids].map((d) => [d, 0]))
    for (const v of counted) {
      const w = reviewerWeight(best.get(v.reviewer) ?? 0, t.get(v.reviewer)!, scoring)
      next.set(v.subject, next.get(v.subject)! + w * evidence.get(v.uri)!.weight * signal(v.overall))
    }
    let delta = 0
    for (const d of dids) delta = Math.max(delta, Math.abs(next.get(d)! - t.get(d)!))
    t = next
    if (delta < scoring.tolerance) break
  }

  const reviews: ScoredReview[] = inputs.reviews.map((v) => {
    const e = evidence.get(v.uri)!
    const w = reviewerWeight(best.get(v.reviewer) ?? 0, t.get(v.reviewer)!, scoring)
    const isCounted = kept.has(v.uri)
    return {
      ...v,
      counted: isCounted,
      ...(isCounted ? {} : { skipped: v.reviewer === v.subject ? ('self' as const) : ('replaced' as const) }),
      evidence: e,
      reviewerWeight: w,
      signal: signal(v.overall),
      contribution: isCounted ? w * e.weight * signal(v.overall) : 0,
    }
  })

  const standing: Standing[] = [...wallets.keys()].sort().map((did) => {
    const received = reviews.filter((v) => v.subject === did)
    return {
      did,
      value: t.get(did) ?? 0,
      reviews: {
        received: received.length,
        counted: received.filter((v) => v.counted).length,
        withReceipt: received.filter((v) => v.counted && v.evidence.kind !== 'none').length,
      },
    }
  })

  const rating: Rating[] = [...wallets.keys()].sort().map((did) => {
    const rated = reviews.filter((v) => v.subject === did && v.counted && v.overall !== null)
    let sum = 0
    let weights = 0
    for (const v of rated) {
      const weight = v.reviewerWeight * v.evidence.weight
      sum += weight * v.overall!
      weights += weight
    }
    return { did, value: weights > 0 ? sum / weights : null, reviews: rated.length }
  })

  return { uniqueness: uniq, standing, rating, reviews, rounds }
}

/** Millionths, the unit every score is stored, signed and served in. */
export function toMicro(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000))
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
