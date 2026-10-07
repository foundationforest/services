// The scores, as pure functions: plain data in, plain data out, no database and no clock. Every
// rule here is written out in plain words in README.md; the two must say the same thing.
//
// Three scores, never blended into one number:
//   uniqueness  per label: which trusted issuers' rows the profile holds under it, each by its
//               issuer's weight at the tier the profile's card shows for it
//   standing    per profile: reviews received, each weighed by its reviewer and by its evidence
//   rating      per profile: the reviews' `overall`, averaged with the same weights, 1.0 to 10.0
//
// Uniqueness enters standing only as the starting weight of a reviewer (README.md, "How it scores":
// a reviewer with no counted row gets the floor, so its review weighs near zero). Without that seed,
// "weighted by the reviewer's own standing" with everyone starting at zero would leave every score at
// zero forever.
//
// A profile is named by its address, which is also its Solana address: the escrow's buyer and seller
// are compared with it directly.

import type { IssuerConfig, ScoringConfig } from '../config.ts'
import { type Directory, splitLabel } from '../markets.ts'

/** A profile, and the one label it lives in (`market/role`, from its record). */
export type ProfileIn = { address: string; label: string | null }
/** A counted row: a trusted issuer's. */
export type StampIn = {
  profile: string
  label: string
  /** The issuer's key, 128 hex. */
  issuer: string
  /** The row's stamp, 64 hex: the reputation tree's leaf (reputation.ts). */
  stamp?: string
  /** The tiers the profile's card shows for this row, each a person proof checked against it (records/store.ts). */
  tiers?: string[]
}
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
  stamps: StampIn[]
  receipts: ReceiptIn[]
  reviews: ReviewIn[]
}

export type Settings = {
  directory: Directory
  issuers: IssuerConfig
  scoring: ScoringConfig
}

// ---------------------------------------------------------------------------------------------
// Rows and uniqueness
// ---------------------------------------------------------------------------------------------

export type StampStatus =
  | { counted: true; market: string; role: string }
  | { counted: false; why: 'notAMarketHere' | 'noRole' | 'notTheProfilesLabel' }

/**
 * A row counts for its profile only when its label is `market/role`, the market one this index
 * uses, byte for byte, and the role one of that market's roles; and when that is the profile's own
 * label, the one market and side its record names. A plain `market` counts for nothing. The row
 * always names the profile's own key: it is found by the profile it names.
 */
export function stampStatus(stamp: Pick<StampIn, 'label'>, profile: { label: string | null }, directory: Directory): StampStatus {
  const label = directory.labelOf(stamp.label)
  if (!label) {
    const { market, role } = splitLabel(stamp.label)
    return { counted: false, why: role === null && directory.markets.has(market) ? 'noRole' : 'notAMarketHere' }
  }
  if (stamp.label !== profile.label) return { counted: false, why: 'notTheProfilesLabel' }
  return { counted: true, ...label }
}

/**
 * A row's weight: its issuer's weight at the tier its profile shows for it, the best when it shows
 * more than one, and that tier. A row that shows no tier, or only tiers the list does not weigh,
 * weighs its issuer's smallest weight, with no tier: which tier its note was is not shown. An issuer
 * not on the list weighs 0.
 */
export function rowWeight(issuers: IssuerConfig, issuer: string, tiers: readonly string[] = []): { weight: number; tier: string | null } {
  const weights = Object.hasOwn(issuers, issuer) ? issuers[issuer]!.weights : {}
  const clamp = (w: number) => Math.min(1, Math.max(0, w))
  let best: { weight: number; tier: string | null } | null = null
  for (const tier of tiers) {
    if (Object.hasOwn(weights, tier) && (!best || weights[tier]! > best.weight)) best = { weight: clamp(weights[tier]!), tier }
  }
  const all = Object.values(weights)
  return best ?? { weight: all.length ? clamp(Math.min(...all)) : 0, tier: null }
}

export type Uniqueness = {
  profile: string
  label: string
  market: string
  role: string
  value: number
  issuers: { issuer: string; name: string | null; weight: number; tier: string | null }[]
}

/**
 * Per profile and label: the distinct issuers whose counted rows the profile holds under it, each at
 * its row's weight (`rowWeight`), combined as 1 − Π(1 − weight). One issuer at weight w gives w; two
 * independent issuers give more than either and never more than 1; an issuer at 0 adds nothing.
 */
export function uniqueness(inputs: Pick<Inputs, 'profiles' | 'stamps'>, settings: Settings): Uniqueness[] {
  const profiles = new Map(inputs.profiles.map((p) => [p.address, p]))
  type Weighed = ReturnType<typeof rowWeight>
  const groups = new Map<string, { profile: string; label: string; market: string; role: string; issuers: Map<string, Weighed> }>()
  for (const st of inputs.stamps) {
    const profile = profiles.get(st.profile)
    if (!profile) continue
    const status = stampStatus(st, profile, settings.directory)
    if (!status.counted) continue
    const key = `${st.profile}\u0000${st.label}`
    const g = groups.get(key) ?? { profile: st.profile, label: st.label, market: status.market, role: status.role, issuers: new Map() }
    const weighed = rowWeight(settings.issuers, st.issuer, st.tiers)
    const held = g.issuers.get(st.issuer)
    if (!held || weighed.weight > held.weight) g.issuers.set(st.issuer, weighed)
    groups.set(key, g)
  }
  const out: Uniqueness[] = []
  for (const g of groups.values()) {
    const issuers = [...g.issuers.keys()].sort().map((issuer) => ({
      issuer,
      name: settings.issuers[issuer]?.name ?? null,
      ...g.issuers.get(issuer)!,
    }))
    const value = 1 - issuers.reduce((p, k) => p * (1 - k.weight), 1)
    out.push({ profile: g.profile, label: g.label, market: g.market, role: g.role, value, issuers })
  }
  return out.sort((a, b) => cmp(a.profile, b.profile) || cmp(a.label, b.label))
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/**
 * What stands under a review's deal id (README.md, "Evidence: what backs a review"): a receipt
 * counts fully when the seller signed for it: created the escrow, signed its ending, or reviewed
 * the deal.
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
    reviews: ReviewIn[]
    scoring: ScoringConfig
  },
): Evidence {
  const w = ctx.scoring.evidence
  const none = (note: EvidenceNote): Evidence => ({ kind: 'none', weight: w.none, note })
  if (!review.dealId) return none('noDealId')
  const r = ctx.receipts.get(review.dealId)
  if (!r || r.closed) return none('noReceipt')
  if (!partiesMatch(r, review.reviewer, review.subject)) return none('notTheParties')
  if (!ctx.scoring.countedMints.includes(r.mint)) return none('tokenNotCounted')
  if (!paid(r)) return none('notPaid')
  if (r.creator === 'seller' || (r.outcome !== null && SELLER_SIGNS.has(r.outcome))) return { kind: 'both', weight: w.both }
  const sellerReviewed = ctx.reviews.some((v) => v.dealId === r.escrow && v.reviewer === r.seller && v.subject === r.buyer)
  return sellerReviewed ? { kind: 'oneSidedConfirmed', weight: w.both } : { kind: 'oneSided', weight: w.oneSided }
}

/** The endings the seller signs: a split (both sign) and a release back to the buyer (a refund). */
const SELLER_SIGNS = new Set(['split', 'releasedToBuyer'])

/** The reviewer and the subject are the escrow's two parties, either way round: a profile's address is where the escrow pays it. */
function partiesMatch(r: ReceiptIn, reviewer: string, subject: string): boolean {
  if (reviewer === subject) return false
  return (reviewer === r.buyer && subject === r.seller) || (reviewer === r.seller && subject === r.buyer)
}

// ---------------------------------------------------------------------------------------------
// Standing and rating
// ---------------------------------------------------------------------------------------------

/** An overall rating as a signal: 10 is +1, 5.5 is 0, 1 is −1. No rating says neither, so 0. */
export function signal(overall: number | null): number {
  return overall === null ? 0 : (overall - 5.5) / 4.5
}

/** How much a reviewer's word weighs: its best uniqueness (or the floor), scaled by its own standing. */
export function reviewerWeight(u: number, t: number, scoring: ScoringConfig): number {
  return Math.max(u, scoring.unstampedReviewer) * (1 + t / (Math.abs(t) + 1))
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
  profile: string
  value: number
  reviews: { received: number; counted: number; withReceipt: number }
}

/**
 * The weighted `overall`: each counted review that gives one, weighed by its reviewer's weight
 * times the evidence under it, the same weights standing uses. Null when no counted review rates.
 */
export type Rating = {
  profile: string
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
  const profiles = inputs.profiles.map((p) => p.address)
  const receipts = new Map(inputs.receipts.map((r) => [r.escrow, r]))
  const uniq = uniqueness(inputs, settings)
  const best = new Map<string, number>()
  for (const u of uniq) best.set(u.profile, Math.max(best.get(u.profile) ?? 0, u.value))

  // Which reviews count. Per reviewer and subject: one per deal id that has evidence under it,
  // and one in all for everything else (the latest), so a reviewer cannot add weight by repeating
  // itself or by inventing deal ids.
  const ctx = { receipts, reviews: inputs.reviews, scoring }
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
  const all = new Set<string>([...profiles, ...inputs.reviews.map((v) => v.subject), ...inputs.reviews.map((v) => v.reviewer)])
  let t = new Map<string, number>([...all].map((d) => [d, 0]))
  let rounds = 0
  for (; rounds < scoring.maxRounds; ) {
    rounds++
    const next = new Map<string, number>([...all].map((d) => [d, 0]))
    for (const v of counted) {
      const w = reviewerWeight(best.get(v.reviewer) ?? 0, t.get(v.reviewer)!, scoring)
      next.set(v.subject, next.get(v.subject)! + w * evidence.get(v.uri)!.weight * signal(v.overall))
    }
    let delta = 0
    for (const d of all) delta = Math.max(delta, Math.abs(next.get(d)! - t.get(d)!))
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

  const standing: Standing[] = [...profiles].sort().map((profile) => {
    const received = reviews.filter((v) => v.subject === profile)
    return {
      profile,
      value: t.get(profile) ?? 0,
      reviews: {
        received: received.length,
        counted: received.filter((v) => v.counted).length,
        withReceipt: received.filter((v) => v.counted && v.evidence.kind !== 'none').length,
      },
    }
  })

  const rating: Rating[] = [...profiles].sort().map((profile) => {
    const rated = reviews.filter((v) => v.subject === profile && v.counted && v.overall !== null)
    let sum = 0
    let weights = 0
    for (const v of rated) {
      const weight = v.reviewerWeight * v.evidence.weight
      sum += weight * v.overall!
      weights += weight
    }
    return { profile, value: weights > 0 ? sum / weights : null, reviews: rated.length }
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
