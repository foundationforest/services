// The words a price and a place read in on these pages, as the Forest app says them: every phrase
// of the brief's section 10, and how places' names for a point pick the one for a circle.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { amountText, captionOf, lengthWords, placeText, priceParts, priceText } from '../src/pages/words.ts'

const price = (amount: string, currency: string, more: { per?: string; count?: string; note?: string } = {}) => ({ amount, currency, ...more })

test('an amount in its currency, in English number format, no decimals on a whole amount; as written when it is no code', () => {
  assert.equal(amountText('15', 'EUR'), '€15')
  assert.equal(amountText('12.5', 'USD'), '$12.50')
  assert.equal(amountText('1300', 'MXN'), 'MX$1,300')
  assert.equal(amountText('20', 'GBP'), '£20')
  assert.equal(amountText('30', 'coins'), '30 coins')
  assert.equal(amountText('a lot', 'EUR'), 'a lot EUR')
})

test('a price for one of its per: "a" or "an" and the per', () => {
  assert.equal(priceText(price('15', 'EUR', { per: 'hour' })), '€15 an hour')
  assert.equal(priceText(price('20', 'GBP', { per: 'visit' })), '£20 a visit')
  assert.equal(priceText(price('900', 'EUR', { per: 'month' })), '€900 a month')
  assert.equal(priceText(price('5', 'EUR', { per: 'item', count: '1' })), '€5 an item')
  assert.equal(priceText(price('40', 'EUR', { per: 'day' })), '€40 a day')
})

test('per hour another count is a length: whole hours, or minutes under 2 hours', () => {
  assert.equal(priceText(price('60', 'EUR', { per: 'hour', count: '3' })), '€60 for 3 hours')
  assert.equal(priceText(price('25', 'EUR', { per: 'hour', count: '0.75' })), '€25 for 45 minutes')
  assert.equal(priceText(price('40', 'EUR', { per: 'hour', count: '1.5' })), '€40 for 90 minutes')
  assert.equal(priceText(price('70', 'EUR', { per: 'hour', count: '2.5' })), '€70 for 2.5 hours')
  assert.deepEqual([1, 2, 0.75, 1 / 60].map(lengthWords), ['1 hour', '2 hours', '45 minutes', '1 minute'])
})

test('any other per is counted: s, or es after s, x, z, ch and sh, and a person is people', () => {
  assert.equal(priceText(price('100', 'EUR', { per: 'lesson', count: '5' })), '€100 for 5 lessons')
  assert.equal(priceText(price('30', 'EUR', { per: 'person', count: '2' })), '€30 for 2 people')
  assert.equal(priceText(price('30', 'EUR', { per: 'class', count: '4' })), '€30 for 4 classes')
  assert.equal(priceText(price('30', 'EUR', { per: 'box', count: '3' })), '€30 for 3 boxes')
  assert.equal(priceText(price('30', 'EUR', { per: 'batch', count: '2' })), '€30 for 2 batches')
  assert.equal(priceText(price('30', 'EUR', { per: 'wash', count: '2' })), '€30 for 2 washes')
})

test('no per is the amount alone; a request says Up to first; the note apart', () => {
  assert.equal(priceText(price('40', 'EUR')), '€40')
  assert.equal(priceText(price('60', 'EUR', { per: 'hour', count: '3' }), true), 'Up to €60 for 3 hours')
  assert.equal(priceText(price('40', 'EUR'), true), 'Up to €40')
  assert.deepEqual(priceParts(price('25', 'USD', { per: 'hour', count: '0.75', note: 'The first lesson is free' })), { amount: '$25', per: 'for 45 minutes', note: 'The first lesson is free' })
  assert.equal(priceText(null), '')
  assert.equal(priceText({ amount: '5' }), '')
})

test('a place: its size and the caption places gives its centre, or its size alone', () => {
  assert.equal(placeText({ radiusKm: 10 }, 'Camden, London'), 'Within 10 km of Camden, London')
  assert.equal(placeText({ radiusKm: 0 }, 'Sol, Madrid'), 'Exact spot near Sol, Madrid')
  assert.equal(placeText({ radiusKm: 10 }, null), 'Within 10 km')
  assert.equal(placeText({ radiusKm: 0 }), 'An exact spot')
})

test("of places' names for a point, nearest first, the first whose size times 5 reaches the circle's, else the nearest", () => {
  const answers = [
    { caption: 'Del Valle, San Pedro Garza García', radiusKm: 1 },
    { caption: 'San Pedro Garza García, Nuevo León', radiusKm: 3 },
    { caption: 'Monterrey, Nuevo León', radiusKm: 10 },
  ]
  assert.equal(captionOf(answers, 0), 'Del Valle, San Pedro Garza García')
  assert.equal(captionOf(answers, 5), 'Del Valle, San Pedro Garza García')
  assert.equal(captionOf(answers, 6), 'San Pedro Garza García, Nuevo León')
  assert.equal(captionOf(answers, 50), 'Monterrey, Nuevo León')
  assert.equal(captionOf(answers, 51), 'Del Valle, San Pedro Garza García')
  assert.equal(captionOf([], 5), null)
})
