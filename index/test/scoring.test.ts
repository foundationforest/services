// The scoring rules, on plain data: every evidence class, how badges count and combine, the
// dedupe, standing as a fixed point, and the weighted rating. No database, no chain, no host.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Directory } from '../src/markets.ts'
import {
  type BadgeIn,
  type Inputs,
  type ReceiptIn,
  type ReviewIn,
  badgeStatus,
  compute,
  evidenceFor,
  reviewerWeight,
  signal,
  uniqueness,
} from '../src/scores/compute.ts'
import { MARKETS_FOLDER } from './markets-repo.ts'

const tutors = JSON.parse(readFileSync(join(MARKETS_FOLDER, 'freelance-work/online-tutors.json'), 'utf8'))
const exchange = JSON.parse(readFileSync(join(MARKETS_FOLDER, 'learning/language-exchange.json'), 'utf8'))
const directory = new Directory([
  { file: 'freelance-work/online-tutors.json', market: tutors },
  { file: 'learning/language-exchange.json', market: exchange },
])
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const FOUNDATION = 'H7qXWNAeAvedhwuvhAkBYK2WE2nA3KgbufnRz38zFdzS'
const OTHER_ISSUER = 'Other1ssuer11111111111111111111111111111111'
const scoring = {
  evidence: { both: 1, oneSided: 0.5, none: 0.05 },
  unbadgedReviewer: 0.05,
  countedMints: [USDC],
  maxRounds: 100,
  tolerance: 1e-9,
}
const settings = { directory, issuers: { [FOUNDATION]: { name: 'Forest Foundation', weight: 1 } }, scoring }

// Each profile lives in one scope, as its record names it.
const ana = { did: 'did:plc:ana', wallet: 'AnaWallet', scope: 'online-tutors/seller' }
const ben = { did: 'did:plc:ben', wallet: 'BenWallet', scope: 'online-tutors/buyer' }
const cleo = { did: 'did:plc:cleo', wallet: 'CleoDeclared', scope: 'online-tutors/seller' }
const badge = (did: string, wallet: string, scope = 'online-tutors/seller', listOwner = FOUNDATION): BadgeIn => ({ did, wallet, scope, listOwner })
/** A badge's status for a profile declaring `wallet` and living in `scope` (the badge's own, unless another is named). */
const own = (b: BadgeIn, wallet: string | null = ana.wallet, scope: string | null = b.scope) => badgeStatus(b, { wallet, scope }, directory)
// Ana invoiced Ben (the seller created it), and Ben paid in one tap: no funding mark, released.
const receipt = (over: Partial<ReceiptIn> = {}): ReceiptIn => ({
  escrow: 'Deal1111111111111111111111111111111111111111',
  buyer: ben.wallet,
  seller: ana.wallet,
  creator: 'seller',
  mint: USDC,
  funded: false,
  outcome: 'releasedToSeller',
  closed: false,
  ...over,
})
let n = 0
const review = (reviewer: string, subject: string, over: Partial<ReviewIn> = {}): ReviewIn => ({
  uri: `at://${reviewer}/foundation.forest.review/${String(++n).padStart(4, '0')}`,
  reviewer,
  subject,
  overall: 10,
  dealId: null,
  createdAt: `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`,
  ...over,
})

function evidence(v: ReviewIn, receipts: ReceiptIn[], reviews: ReviewIn[] = [v]) {
  return evidenceFor(v, {
    receipts: new Map(receipts.map((r) => [r.escrow, r])),
    wallets: new Map([ana, ben, cleo].map((p) => [p.did, p.wallet])),
    reviews,
    scoring,
  })
}

test('evidence: the seller created it (an invoice) and it was paid: full, however it ended', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 })
  assert.deepEqual(evidence(review(ana.did, ben.did, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 }, 'the other way round')
  const marked = receipt({ funded: true, outcome: null })
  assert.equal(evidence(review(ben.did, ana.did, { dealId: marked.escrow }), [marked]).kind, 'both', 'funding marked, not ended yet')
  for (const outcome of ['releasedToBuyer', 'split', 'arbitrated', 'timerReleased']) {
    const ended = receipt({ outcome })
    assert.equal(evidence(review(ben.did, ana.did, { dealId: ended.escrow }), [ended]).kind, 'both', `an ending proves the payment: ${outcome}`)
  }
})

test('evidence: the buyer created it and the seller signed its ending (a split, a refund): full', () => {
  for (const outcome of ['split', 'releasedToBuyer']) {
    const r = receipt({ creator: 'buyer', outcome })
    assert.deepEqual(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 }, outcome)
  }
})

test('evidence: the buyer created it: one-sided until the seller reviews the same deal', () => {
  for (const outcome of ['arbitrated', 'timerReleased']) {
    const r = receipt({ creator: 'buyer', outcome })
    assert.deepEqual(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [r]), { kind: 'oneSided', weight: 0.5 }, `the seller signed nothing: ${outcome}`)
  }
  const marked = receipt({ creator: 'buyer', funded: true, outcome: null })
  assert.equal(evidence(review(ben.did, ana.did, { dealId: marked.escrow }), [marked]).kind, 'oneSided', 'paid, not ended')
  const r = receipt({ creator: 'buyer' })
  const byBuyer = review(ben.did, ana.did, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r]), { kind: 'oneSided', weight: 0.5 })
  const bySeller = review(ana.did, ben.did, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r], [byBuyer, bySeller]), { kind: 'oneSidedConfirmed', weight: 1 })
  assert.deepEqual(evidence(bySeller, [r], [bySeller]), { kind: 'oneSidedConfirmed', weight: 1 }, 'the seller reviewing the deal is the seller saying yes')
})

test('evidence: what counts little', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.did, ana.did), [r]), { kind: 'none', weight: 0.05, note: 'noDealId' })
  assert.equal(evidence(review(ben.did, ana.did, { dealId: 'ab'.repeat(32) }), [r]).note, 'noReceipt')
  assert.equal(evidence(review(cleo.did, ana.did, { dealId: r.escrow }), [r]).note, 'notTheParties', "someone else's receipt")
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ mint: 'SelfMinted111111111111111111111111111111111' })]).note, 'tokenNotCounted')
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ funded: false, outcome: null })]).note, 'notPaid', 'invoiced, never paid')
  assert.equal(evidence(review(ben.did, ana.did, { dealId: r.escrow }), [receipt({ closed: true, funded: false, outcome: null })]).note, 'noReceipt', 'closed, never funded')
})

test('a badge counts only as market/role under a directory name, and only for the wallet the profile declares', () => {
  assert.deepEqual(own(badge(ana.did, ana.wallet)), { counted: true, market: 'online-tutors', role: 'seller' }, 'market/role; a file with no roles has seller and buyer')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors/buyer')), { counted: true, market: 'online-tutors', role: 'buyer' })
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors')), { counted: false, why: 'noRole' }, 'a plain market counts for nothing')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors:seller')), { counted: false, why: 'notInDirectory' }, 'only the slash separates a role')
  assert.deepEqual(own(badge(ana.did, 'NotDeclared')), { counted: false, why: 'walletNotDeclared' })
  assert.deepEqual(own(badge(ana.did, ana.wallet), null), { counted: false, why: 'walletNotDeclared' })
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutor/seller')), { counted: false, why: 'notInDirectory' }, 'another spelling is another name, not in the directory')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'plumbing/seller')), { counted: false, why: 'notInDirectory' }, 'a name the directory does not list')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'Online-Tutors/seller')), { counted: false, why: 'notInDirectory' }, 'byte for byte')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors/plumber')), { counted: false, why: 'notInDirectory' }, 'a role the market does not have')
})

test('a badge counts only under a role its market’s sides allow: peer in a one-sided market', () => {
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'language-exchange/peer')), { counted: true, market: 'language-exchange', role: 'peer' })
  for (const role of ['seller', 'buyer']) {
    assert.deepEqual(own(badge(ana.did, ana.wallet, `language-exchange/${role}`)), { counted: false, why: 'notInDirectory' }, `no ${role} in a one-sided market`)
  }
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors/peer')), { counted: false, why: 'notInDirectory' }, 'no peer in a two-sided one')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors/tutor')), { counted: false, why: 'notInDirectory' }, 'a label is a word for pages, not a role')
})

test('a badge counts only under its profile’s own scope: one folder, one market, one side', () => {
  assert.deepEqual(own(badge(ana.did, ana.wallet), ana.wallet, ana.scope), { counted: true, market: 'online-tutors', role: 'seller' })
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'online-tutors/buyer'), ana.wallet, ana.scope), { counted: false, why: 'notProfileScope' }, 'the other side of the same market')
  assert.deepEqual(own(badge(ana.did, ana.wallet, 'language-exchange/peer'), ana.wallet, ana.scope), { counted: false, why: 'notProfileScope' }, 'another market')
  assert.deepEqual(own(badge(ana.did, ana.wallet), ana.wallet, null), { counted: false, why: 'notProfileScope' }, 'a profile that names no scope')
  // Uniqueness counts only the badge under the profile's own scope.
  const u = uniqueness({ profiles: [ana], badges: [badge(ana.did, ana.wallet), badge(ana.did, ana.wallet, 'language-exchange/peer')] }, settings)
  assert.deepEqual(u.map((x) => x.scope), ['online-tutors/seller'])
})

test('uniqueness: issuers combine, an issuer at 0 adds nothing', () => {
  const one = uniqueness({ profiles: [ana], badges: [badge(ana.did, ana.wallet)] }, settings)
  assert.equal(one.length, 1)
  assert.equal(one[0].value, 1)
  assert.deepEqual(one[0].issuers, [{ owner: FOUNDATION, name: 'Forest Foundation', weight: 1 }])

  const unknown = uniqueness({ profiles: [ana], badges: [badge(ana.did, ana.wallet, 'online-tutors/seller', OTHER_ISSUER)] }, settings)
  assert.equal(unknown[0].value, 0, 'others start at 0')

  const halves = { ...settings, issuers: { [FOUNDATION]: { name: 'F', weight: 0.5 }, [OTHER_ISSUER]: { name: 'O', weight: 0.5 } } }
  const two = uniqueness(
    { profiles: [ana], badges: [badge(ana.did, ana.wallet), badge(ana.did, ana.wallet, 'online-tutors/seller', OTHER_ISSUER)] },
    halves,
  )
  assert.equal(two[0].value, 0.75, 'two issuers at 0.5: 1 − 0.5 × 0.5')

  assert.deepEqual(uniqueness({ profiles: [cleo], badges: [badge(cleo.did, 'CleoOther')] }, settings), [], 'wallet not declared')
})

test('standing: everyone starts at zero; the scenario the end-to-end test runs', () => {
  const deal = receipt()
  const inputs: Inputs = {
    profiles: [ana, ben, cleo],
    badges: [badge(ana.did, ana.wallet), badge(ben.did, ben.wallet, 'online-tutors/buyer'), badge(cleo.did, 'CleoUndeclared')],
    receipts: [deal],
    reviews: [
      review(ben.did, ana.did, { dealId: deal.escrow, overall: 10 }),
      review(ana.did, ben.did, { dealId: deal.escrow, overall: 10 }),
      review(cleo.did, ana.did, { dealId: 'cd'.repeat(32), overall: 1 }),
    ],
  }
  assert.deepEqual(compute({ ...inputs, reviews: [] }, settings).standing.map((t) => t.value), [0, 0, 0])

  const s = compute(inputs, settings)
  const t = Object.fromEntries(s.standing.map((x) => [x.did, x.value]))
  // Ana and Ben vouch for each other, both badged at 1: each converges to x = 1 + x / (x + 1),
  // the golden ratio, less Cleo's small negative on Ana. Cleo counts at the floor, with no receipt.
  const cleoPart = 0.05 * 0.05 * -1
  assert.ok(Math.abs(t[ben.did] - 1.618034) < 1e-3, `Ben ${t[ben.did]}`)
  assert.ok(t[ana.did] < t[ben.did] && t[ana.did] > t[ben.did] + cleoPart - 1e-3, `Ana ${t[ana.did]}`)
  assert.equal(t[cleo.did], 0)
  // The exact fixed point, recomputed from the rule itself.
  const wBen = reviewerWeight(1, t[ben.did], scoring)
  const wAna = reviewerWeight(1, t[ana.did], scoring)
  assert.ok(Math.abs(t[ana.did] - (wBen + cleoPart)) < 1e-6)
  assert.ok(Math.abs(t[ben.did] - wAna) < 1e-6)
  assert.ok(s.rounds < 100, `converged in ${s.rounds} rounds`)
  const cleoReview = s.reviews.find((v) => v.reviewer === cleo.did)!
  assert.equal(cleoReview.evidence.note, 'noReceipt')
  assert.equal(cleoReview.reviewerWeight, 0.05, 'her badge is not counted, so the floor')
  assert.deepEqual(s.standing.find((x) => x.did === ana.did)!.reviews, { received: 2, counted: 2, withReceipt: 1 })
})

test('standing: repeating yourself or inventing deal ids adds nothing; self-reviews are ignored', () => {
  const spam = Array.from({ length: 20 }, (_, i) => review(ben.did, ana.did, { dealId: i.toString(16).padStart(64, '0'), overall: 10 }))
  const s = compute({ profiles: [ana, ben], badges: [badge(ben.did, ben.wallet, 'online-tutors/buyer')], receipts: [], reviews: spam }, settings)
  assert.equal(s.reviews.filter((v) => v.counted).length, 1, 'only the latest no-receipt review counts')
  assert.ok(Math.abs(s.standing.find((x) => x.did === ana.did)!.value - 0.05) < 1e-9, '1 × 0.05 × 1')

  const self = review(ana.did, ana.did)
  const t = compute({ profiles: [ana], badges: [badge(ana.did, ana.wallet)], receipts: [], reviews: [self] }, settings)
  assert.equal(t.standing[0].value, 0)
  assert.equal(t.reviews[0].skipped, 'self')
})

test('standing: a bad review with a receipt lowers standing below zero; no rating is neutral', () => {
  const deal = receipt()
  const bad = compute(
    { profiles: [ana, ben], badges: [badge(ben.did, ben.wallet, 'online-tutors/buyer')], receipts: [deal], reviews: [review(ben.did, ana.did, { dealId: deal.escrow, overall: 1 })] },
    settings,
  )
  assert.equal(bad.standing.find((x) => x.did === ana.did)!.value, -1)
  const thin = compute(
    { profiles: [ana, ben], badges: [badge(ben.did, ben.wallet, 'online-tutors/buyer')], receipts: [deal], reviews: [review(ben.did, ana.did, { dealId: deal.escrow, overall: null })] },
    settings,
  )
  assert.equal(thin.standing.find((x) => x.did === ana.did)!.value, 0)
})

test('the signal: an overall of 10 is +1, 5.5 is 0, 1 is −1; none says neither', () => {
  assert.deepEqual([signal(10), signal(5.5), signal(1), signal(null)], [1, 0, -1, 0])
  assert.ok(Math.abs(signal(8.2) - 0.6) < 1e-12)
})

test('rating: the counted overalls, averaged with the weights standing uses', () => {
  const deal = receipt()
  const s = compute(
    {
      profiles: [ana, ben, cleo],
      badges: [badge(ben.did, ben.wallet, 'online-tutors/buyer')],
      receipts: [deal],
      reviews: [
        // Ben: badged, with a receipt both said yes to: weight 1 × 1.
        review(ben.did, ana.did, { dealId: deal.escrow, overall: 9 }),
        // Cleo: no counted badge, no receipt: weight 0.05 × 0.05.
        review(cleo.did, ana.did, { dealId: 'cd'.repeat(32), overall: 1 }),
        // Ana gives no overall, so Ben has no rating.
        review(ana.did, ben.did, { dealId: deal.escrow, overall: null }),
      ],
    },
    settings,
  )
  const r = Object.fromEntries(s.rating.map((x) => [x.did, x]))
  const wBen = s.reviews.find((v) => v.reviewer === ben.did)!.reviewerWeight
  const wCleo = s.reviews.find((v) => v.reviewer === cleo.did)!.reviewerWeight * 0.05
  assert.ok(Math.abs(r[ana.did].value! - (9 * wBen + 1 * wCleo) / (wBen + wCleo)) < 1e-9, `Ana ${r[ana.did].value}`)
  assert.ok(r[ana.did].value! > 8.97, 'an unbadged stranger with nothing under their review barely moves it')
  assert.equal(r[ana.did].reviews, 2)
  assert.deepEqual(r[ben.did], { did: ben.did, value: null, reviews: 0 }, 'no counted review gives an overall: no rating, not zero')
  assert.deepEqual(r[cleo.did], { did: cleo.did, value: null, reviews: 0 })

  // A replaced review is not counted, so it does not rate either.
  const again = compute(
    { profiles: [ana, ben], badges: [], receipts: [], reviews: [review(ben.did, ana.did, { overall: 2 }), review(ben.did, ana.did, { overall: 8 })] },
    settings,
  )
  assert.deepEqual(again.rating.find((x) => x.did === ana.did), { did: ana.did, value: 8, reviews: 1 }, 'the latest no-receipt review is the one that counts')
})
