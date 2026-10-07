// The scoring rules, on plain data: every evidence class, how rows count and combine, the dedupe,
// standing as a fixed point, and the weighted rating. No database, no chain, no host.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { Directory } from '../src/markets.ts'
import {
  type Inputs,
  type ReceiptIn,
  type ReviewIn,
  type StampIn,
  stampStatus,
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
/** Issuers by key, as a row holds one: 128 hex, x then y. */
const FOUNDATION = '2185f564303f0c1cd8efdb1e35e59cc128f388f1da07511a412c186b6bb5b4bf186ac19097701f2619d447c5cd68484674e48194dd7ed4d025b20ea9d063a549'
const OTHER_ISSUER = 'ef'.repeat(64)
const scoring = {
  evidence: { both: 1, oneSided: 0.5, none: 0.05 },
  unstampedReviewer: 0.05,
  countedMints: [USDC],
  maxRounds: 100,
  tolerance: 1e-9,
}
const settings = { directory, issuers: { [FOUNDATION]: { name: 'Forest Foundation', weight: 1 } }, scoring }

// Each profile lives in one label, as its record names it. Its address is its name and its Solana address.
const ana = { address: 'AnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAn', label: 'online-tutors/seller' }
const ben = { address: 'BenBenBenBenBenBenBenBenBenBenBenBenBenBenBe', label: 'online-tutors/buyer' }
const cleo = { address: 'CLeoCLeoCLeoCLeoCLeoCLeoCLeoCLeoCLeoCLeoCLe', label: 'online-tutors/seller' }
const stamp = (profile: string, label = 'online-tutors/seller', issuer = FOUNDATION): StampIn => ({ profile, label, issuer })
/** A row's status for a profile living in `label` (the row's own, unless another is named). */
const own = (b: StampIn, label: string | null = b.label) => stampStatus(b, { label }, directory)
// Ana invoiced Ben (the seller created it), and Ben paid in one tap: no funding mark, released.
const receipt = (over: Partial<ReceiptIn> = {}): ReceiptIn => ({
  escrow: 'Deal1111111111111111111111111111111111111111',
  buyer: ben.address,
  seller: ana.address,
  creator: 'seller',
  mint: USDC,
  funded: false,
  outcome: 'releasedToSeller',
  closed: false,
  ...over,
})
let n = 0
const review = (reviewer: string, subject: string, over: Partial<ReviewIn> = {}): ReviewIn => ({
  uri: `${reviewer}/review/${String(++n).padStart(4, '0')}`,
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
    reviews,
    scoring,
  })
}

test('evidence: the seller created it (an invoice) and it was paid: full, however it ended', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 })
  assert.deepEqual(evidence(review(ana.address, ben.address, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 }, 'the other way round')
  const marked = receipt({ funded: true, outcome: null })
  assert.equal(evidence(review(ben.address, ana.address, { dealId: marked.escrow }), [marked]).kind, 'both', 'funding marked, not ended yet')
  for (const outcome of ['releasedToBuyer', 'split', 'arbitrated', 'timerReleased']) {
    const ended = receipt({ outcome })
    assert.equal(evidence(review(ben.address, ana.address, { dealId: ended.escrow }), [ended]).kind, 'both', `an ending proves the payment: ${outcome}`)
  }
})

test('evidence: the buyer created it and the seller signed its ending (a split, a refund): full', () => {
  for (const outcome of ['split', 'releasedToBuyer']) {
    const r = receipt({ creator: 'buyer', outcome })
    assert.deepEqual(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [r]), { kind: 'both', weight: 1 }, outcome)
  }
})

test('evidence: the buyer created it: one-sided until the seller reviews the same deal', () => {
  for (const outcome of ['arbitrated', 'timerReleased']) {
    const r = receipt({ creator: 'buyer', outcome })
    assert.deepEqual(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [r]), { kind: 'oneSided', weight: 0.5 }, `the seller signed nothing: ${outcome}`)
  }
  const marked = receipt({ creator: 'buyer', funded: true, outcome: null })
  assert.equal(evidence(review(ben.address, ana.address, { dealId: marked.escrow }), [marked]).kind, 'oneSided', 'paid, not ended')
  const r = receipt({ creator: 'buyer' })
  const byBuyer = review(ben.address, ana.address, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r]), { kind: 'oneSided', weight: 0.5 })
  const bySeller = review(ana.address, ben.address, { dealId: r.escrow })
  assert.deepEqual(evidence(byBuyer, [r], [byBuyer, bySeller]), { kind: 'oneSidedConfirmed', weight: 1 })
  assert.deepEqual(evidence(bySeller, [r], [bySeller]), { kind: 'oneSidedConfirmed', weight: 1 }, 'the seller reviewing the deal is the seller saying yes')
})

test('evidence: what counts little', () => {
  const r = receipt()
  assert.deepEqual(evidence(review(ben.address, ana.address), [r]), { kind: 'none', weight: 0.05, note: 'noDealId' })
  assert.equal(evidence(review(ben.address, ana.address, { dealId: 'ab'.repeat(32) }), [r]).note, 'noReceipt')
  assert.equal(evidence(review(cleo.address, ana.address, { dealId: r.escrow }), [r]).note, 'notTheParties', "someone else's receipt")
  assert.equal(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [receipt({ mint: 'SelfMinted111111111111111111111111111111111' })]).note, 'tokenNotCounted')
  assert.equal(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [receipt({ funded: false, outcome: null })]).note, 'notPaid', 'invoiced, never paid')
  assert.equal(evidence(review(ben.address, ana.address, { dealId: r.escrow }), [receipt({ closed: true, funded: false, outcome: null })]).note, 'noReceipt', 'closed, never funded')
})

test('a row counts only as market/role under a market this index uses', () => {
  assert.deepEqual(own(stamp(ana.address)), { counted: true, market: 'online-tutors', role: 'seller' }, 'market/role; a file with no roles has seller and buyer')
  assert.deepEqual(own(stamp(ana.address, 'online-tutors/buyer')), { counted: true, market: 'online-tutors', role: 'buyer' })
  assert.deepEqual(own(stamp(ana.address, 'online-tutors')), { counted: false, why: 'noRole' }, 'a plain market counts for nothing')
  assert.deepEqual(own(stamp(ana.address, 'online-tutors:seller')), { counted: false, why: 'notAMarketHere' }, 'only the slash separates a role')
  assert.deepEqual(own(stamp(ana.address, 'online-tutor/seller')), { counted: false, why: 'notAMarketHere' }, 'another spelling is another name, not a market here')
  assert.deepEqual(own(stamp(ana.address, 'plumbing/seller')), { counted: false, why: 'notAMarketHere' }, 'a name this index does not use')
  assert.deepEqual(own(stamp(ana.address, 'Online-Tutors/seller')), { counted: false, why: 'notAMarketHere' }, 'byte for byte')
  assert.deepEqual(own(stamp(ana.address, 'online-tutors/plumber')), { counted: false, why: 'notAMarketHere' }, 'a role the market does not have')
})

test('a row counts only under a role its market’s sides allow: peer in a one-sided market', () => {
  assert.deepEqual(own(stamp(ana.address, 'language-exchange/peer')), { counted: true, market: 'language-exchange', role: 'peer' })
  for (const role of ['seller', 'buyer']) {
    assert.deepEqual(own(stamp(ana.address, `language-exchange/${role}`)), { counted: false, why: 'notAMarketHere' }, `no ${role} in a one-sided market`)
  }
  assert.deepEqual(own(stamp(ana.address, 'online-tutors/peer')), { counted: false, why: 'notAMarketHere' }, 'no peer in a two-sided one')
  assert.deepEqual(own(stamp(ana.address, 'online-tutors/tutor')), { counted: false, why: 'notAMarketHere' }, 'a role name is a word for pages, not a role')
})

test('a row counts only under its profile’s own label: one market, one side', () => {
  assert.deepEqual(own(stamp(ana.address), ana.label), { counted: true, market: 'online-tutors', role: 'seller' })
  assert.deepEqual(own(stamp(ana.address, 'online-tutors/buyer'), ana.label), { counted: false, why: 'notTheProfilesLabel' }, 'the other side of the same market')
  assert.deepEqual(own(stamp(ana.address, 'language-exchange/peer'), ana.label), { counted: false, why: 'notTheProfilesLabel' }, 'another market')
  assert.deepEqual(own(stamp(ana.address), null), { counted: false, why: 'notTheProfilesLabel' }, 'a profile that names no label')
  // Uniqueness counts only the row under the profile's own label.
  const u = uniqueness({ profiles: [ana], stamps: [stamp(ana.address), stamp(ana.address, 'language-exchange/peer')] }, settings)
  assert.deepEqual(u.map((x) => x.label), ['online-tutors/seller'])
})

test('uniqueness: issuers combine, an issuer at 0 adds nothing', () => {
  const one = uniqueness({ profiles: [ana], stamps: [stamp(ana.address)] }, settings)
  assert.equal(one.length, 1)
  assert.equal(one[0].value, 1)
  assert.deepEqual(one[0].issuers, [{ issuer: FOUNDATION, name: 'Forest Foundation', weight: 1 }])

  const unknown = uniqueness({ profiles: [ana], stamps: [stamp(ana.address, 'online-tutors/seller', OTHER_ISSUER)] }, settings)
  assert.equal(unknown[0].value, 0, 'others start at 0')

  const halves = { ...settings, issuers: { [FOUNDATION]: { name: 'F', weight: 0.5 }, [OTHER_ISSUER]: { name: 'O', weight: 0.5 } } }
  const two = uniqueness(
    { profiles: [ana], stamps: [stamp(ana.address), stamp(ana.address, 'online-tutors/seller', OTHER_ISSUER)] },
    halves,
  )
  assert.equal(two[0].value, 0.75, 'two issuers at 0.5: 1 − 0.5 × 0.5')
})

test('standing: everyone starts at zero; the scenario the end-to-end test runs', () => {
  const deal = receipt()
  const inputs: Inputs = {
    profiles: [ana, ben, cleo],
    stamps: [stamp(ana.address), stamp(ben.address, 'online-tutors/buyer'), stamp(cleo.address, 'online-tutors/buyer')],
    receipts: [deal],
    reviews: [
      review(ben.address, ana.address, { dealId: deal.escrow, overall: 10 }),
      review(ana.address, ben.address, { dealId: deal.escrow, overall: 10 }),
      review(cleo.address, ana.address, { dealId: 'cd'.repeat(32), overall: 1 }),
    ],
  }
  assert.deepEqual(compute({ ...inputs, reviews: [] }, settings).standing.map((t) => t.value), [0, 0, 0])

  const s = compute(inputs, settings)
  const t = Object.fromEntries(s.standing.map((x) => [x.profile, x.value]))
  // Ana and Ben vouch for each other, both counted at 1: each converges to x = 1 + x / (x + 1),
  // the golden ratio, less Cleo's small negative on Ana. Cleo counts at the floor, with no receipt.
  const cleoPart = 0.05 * 0.05 * -1
  assert.ok(Math.abs(t[ben.address] - 1.618034) < 1e-3, `Ben ${t[ben.address]}`)
  assert.ok(t[ana.address] < t[ben.address] && t[ana.address] > t[ben.address] + cleoPart - 1e-3, `Ana ${t[ana.address]}`)
  assert.equal(t[cleo.address], 0)
  // The exact fixed point, recomputed from the rule itself.
  const wBen = reviewerWeight(1, t[ben.address], scoring)
  const wAna = reviewerWeight(1, t[ana.address], scoring)
  assert.ok(Math.abs(t[ana.address] - (wBen + cleoPart)) < 1e-6)
  assert.ok(Math.abs(t[ben.address] - wAna) < 1e-6)
  assert.ok(s.rounds < 100, `converged in ${s.rounds} rounds`)
  const cleoReview = s.reviews.find((v) => v.reviewer === cleo.address)!
  assert.equal(cleoReview.evidence.note, 'noReceipt')
  assert.equal(cleoReview.reviewerWeight, 0.05, 'her row, under the other side of her market, does not count: the floor')
  assert.deepEqual(s.standing.find((x) => x.profile === ana.address)!.reviews, { received: 2, counted: 2, withReceipt: 1 })
})

test('standing: repeating yourself or inventing deal ids adds nothing; self-reviews are ignored', () => {
  const spam = Array.from({ length: 20 }, (_, i) => review(ben.address, ana.address, { dealId: i.toString(16).padStart(64, '0'), overall: 10 }))
  const s = compute({ profiles: [ana, ben], stamps: [stamp(ben.address, 'online-tutors/buyer')], receipts: [], reviews: spam }, settings)
  assert.equal(s.reviews.filter((v) => v.counted).length, 1, 'only the latest no-receipt review counts')
  assert.ok(Math.abs(s.standing.find((x) => x.profile === ana.address)!.value - 0.05) < 1e-9, '1 × 0.05 × 1')

  const self = review(ana.address, ana.address)
  const t = compute({ profiles: [ana], stamps: [stamp(ana.address)], receipts: [], reviews: [self] }, settings)
  assert.equal(t.standing[0].value, 0)
  assert.equal(t.reviews[0].skipped, 'self')
})

test('standing: a bad review with a receipt lowers standing below zero; no rating is neutral', () => {
  const deal = receipt()
  const bad = compute(
    { profiles: [ana, ben], stamps: [stamp(ben.address, 'online-tutors/buyer')], receipts: [deal], reviews: [review(ben.address, ana.address, { dealId: deal.escrow, overall: 1 })] },
    settings,
  )
  assert.equal(bad.standing.find((x) => x.profile === ana.address)!.value, -1)
  const thin = compute(
    { profiles: [ana, ben], stamps: [stamp(ben.address, 'online-tutors/buyer')], receipts: [deal], reviews: [review(ben.address, ana.address, { dealId: deal.escrow, overall: null })] },
    settings,
  )
  assert.equal(thin.standing.find((x) => x.profile === ana.address)!.value, 0)
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
      stamps: [stamp(ben.address, 'online-tutors/buyer')],
      receipts: [deal],
      reviews: [
        // Ben: counted, with a receipt both said yes to: weight 1 × 1.
        review(ben.address, ana.address, { dealId: deal.escrow, overall: 9 }),
        // Cleo: no counted row, no receipt: weight 0.05 × 0.05.
        review(cleo.address, ana.address, { dealId: 'cd'.repeat(32), overall: 1 }),
        // Ana gives no overall, so Ben has no rating.
        review(ana.address, ben.address, { dealId: deal.escrow, overall: null }),
      ],
    },
    settings,
  )
  const r = Object.fromEntries(s.rating.map((x) => [x.profile, x]))
  const wBen = s.reviews.find((v) => v.reviewer === ben.address)!.reviewerWeight
  const wCleo = s.reviews.find((v) => v.reviewer === cleo.address)!.reviewerWeight * 0.05
  assert.ok(Math.abs(r[ana.address].value! - (9 * wBen + 1 * wCleo) / (wBen + wCleo)) < 1e-9, `Ana ${r[ana.address].value}`)
  assert.ok(r[ana.address].value! > 8.97, 'a stranger with no counted row and nothing under their review barely moves it')
  assert.equal(r[ana.address].reviews, 2)
  assert.deepEqual(r[ben.address], { profile: ben.address, value: null, reviews: 0 }, 'no counted review gives an overall: no rating, not zero')
  assert.deepEqual(r[cleo.address], { profile: cleo.address, value: null, reviews: 0 })

  // A replaced review is not counted, so it does not rate either.
  const again = compute(
    { profiles: [ana, ben], stamps: [], receipts: [], reviews: [review(ben.address, ana.address, { overall: 2 }), review(ben.address, ana.address, { overall: 8 })] },
    settings,
  )
  assert.deepEqual(again.rating.find((x) => x.profile === ana.address), { profile: ana.address, value: 8, reviews: 1 }, 'the latest no-receipt review is the one that counts')
})
