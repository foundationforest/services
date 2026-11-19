// How a price and a place read on these pages, as the Forest app says them (foundationforest/app,
// src/show.ts), in English's number format, this page having no reader's own:
//
//   a price   its amount in its currency (€15, $12.50, MX$1,300; as written when it is no number or
//             its currency no code), then what it is for: a count of 1 as "a" or "an" and its per
//             (€15 an hour, £20 a visit), per hour another count as a length (for 3 hours, for 45
//             minutes), any other per counted (for 5 lessons, for 2 people), no per the amount
//             alone (€40); a request's with "Up to " first, the most it would pay
//   a place   its size and the caption the places service gives its centre: Within 10 km of
//             Camden, London; Exact spot near Sol, Madrid; with no caption, Within 10 km, An exact
//             spot
//
// Pure functions: the pages draw with them, and the tests read them alone.

/**
 * An amount in its currency, as people write a price: $30, €12.50, MX$1,300, no decimals on a whole
 * amount; as written when the amount is no number or the currency no code, "30 coins".
 */
export function amountText(amount: unknown, currency: unknown): string {
  const n = Number(amount)
  if (typeof amount === 'string' && amount.trim() !== '' && Number.isFinite(n)) {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: String(currency), trailingZeroDisplay: 'stripIfInteger' }).format(n)
    } catch {
      // Not a currency code: as it was written.
    }
  }
  return `${String(amount)} ${String(currency)}`
}

/** A word for several of a `per`: "lessons", "classes", a person's "people". */
export const perPlural = (per: string) => (per === 'person' ? 'people' : /(s|x|z|ch|sh)$/.test(per) ? `${per}es` : `${per}s`)

/** A length in hours as people say it, the app's rule: 1 hour, 3 hours, 45 minutes, 90 minutes, 2.5 hours. */
export function lengthWords(n: number): string {
  if (Number.isInteger(n)) return `${n} ${n === 1 ? 'hour' : 'hours'}`
  const minutes = Math.round(n * 60)
  return n < 2 ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : `${n} hours`
}

/**
 * A price in its parts, as a page shows them: the amount (€15); what it is for, "an hour", "for 3
 * hours", "for 2 people", or nothing for the whole deal; and its note, the writer's few words on it,
 * or none. Its count is decimal text, read as a number, so a listing that does not fit, with a count
 * written as a number, reads too. None for a value that is not a price.
 */
export function priceParts(money: unknown): { amount: string; per: string; note: string } | null {
  if (!money || typeof money !== 'object' || Array.isArray(money) || !('amount' in money) || !('currency' in money)) return null
  const m = money as { amount: unknown; currency: unknown; per?: unknown; count?: unknown; note?: unknown }
  const per = typeof m.per === 'string' && m.per ? m.per : ''
  const held = Number(m.count ?? 1)
  const count = Number.isFinite(held) && held > 0 ? held : 1
  const forWhat = !per ? '' : count === 1 ? `${/^(hour|[aeio])/.test(per) ? 'an' : 'a'} ${per}` : per === 'hour' ? `for ${lengthWords(count)}` : `for ${count} ${perPlural(per)}`
  return { amount: amountText(m.amount, m.currency), per: forWhat, note: typeof m.note === 'string' ? m.note : '' }
}

/** A price in one line: "€15 an hour", "€40"; a request's "Up to €60 for 3 hours". Its note apart. Empty for no price. */
export function priceText(money: unknown, request = false): string {
  const p = priceParts(money)
  if (!p) return ''
  const said = [p.amount, p.per].filter(Boolean).join(' ')
  return request ? `Up to ${said}` : said
}

/** A place in words: its size, then the caption places gave its centre, where it gave one. */
export function placeText(p: { radiusKm: number }, caption?: string | null): string {
  if (caption) return p.radiusKm === 0 ? `Exact spot near ${caption}` : `Within ${p.radiusKm} km of ${caption}`
  return p.radiusKm === 0 ? 'An exact spot' : `Within ${p.radiusKm} km`
}

/**
 * Which of places' names for a point names a circle there: the first, nearest first, whose own size
 * times 5 is at least the circle's, so a town names a wide circle and a colonia a small one; else the
 * nearest. None when places gave none.
 */
export function captionOf(answers: Array<{ caption: string; radiusKm: number }>, radiusKm: number): string | null {
  return (answers.find((a) => a.radiusKm * 5 >= radiusKm) ?? answers[0])?.caption ?? null
}
