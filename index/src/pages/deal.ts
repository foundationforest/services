// `/deals/<escrow>`: an escrow's receipt as chain.ts reads it, every move with who made it and when,
// the profiles whose `pay` address is the payer or the recipient, and the reviews that name it.

import type { Move, Receipt } from '../chain.ts'
import type { Currency } from '../lists.ts'
import { parse } from '../store.ts'
import { personOf } from './common.ts'
import { html, type Page, short, urls } from './template.ts'

export type DealPage = {
  index: string
  escrow: string
  receipt: Receipt | null
  /** The mint's currency, when this index takes it. */
  money: Currency | null
  moves: Move[]
  profiles: { payer: string[]; recipient: string[] }
  reviews: Array<{ reviewer: string; address: string; subject: string | null; counted: boolean }>
}

/** Base units as decimal text, at the currency's decimals. */
export function amountText(units: string, money: Currency | null): string {
  if (!money) return `${units} base units`
  const padded = units.padStart(money.decimals + 1, '0')
  const whole = padded.slice(0, padded.length - money.decimals)
  const part = padded.slice(padded.length - money.decimals).replace(/0+$/, '')
  return `${whole}${part ? `.${part}` : ''} ${money.code}`
}

export const deal: Page<DealPage> = {
  data({ store, lists, self }, [escrow]) {
    const held = store.db.prepare('select receipt from receipts where escrow = ?').get(escrow ?? '') as { receipt: string } | undefined
    const moves = (store.db.prepare('select move from moves where escrow = ? order by rowid').all(escrow ?? '') as Array<{ move: string }>).map((m) => parse<Move>(m.move))
    if (!held && !moves.length) return null
    const receipt = held ? parse<Receipt>(held.receipt) : null
    const payTo = (pay: string | undefined) => (pay ? (store.db.prepare('select address from profiles where pay = ? order by address').all(pay) as Array<{ address: string }>).map((p) => p.address) : [])
    const reviews = store.db
      .prepare("select address, reviewer, subject, counted from reviews where json_extract(body, '$.evidence') = ? order by time desc, address")
      .all(escrow!) as Array<{ address: string; reviewer: string; subject: string | null; counted: number }>
    return {
      index: self,
      escrow: escrow!,
      receipt,
      money: (receipt && lists.currencies.get(receipt.mint)) ?? null,
      moves,
      profiles: { payer: payTo(receipt?.payer), recipient: payTo(receipt?.recipient) },
      reviews: reviews.map((r) => ({ reviewer: r.reviewer, address: r.address, subject: r.subject, counted: r.counted === 1 })),
    }
  },
  title: (o) => `Forest index: deal ${short(o.escrow)}`,
  body(o, base) {
    const r = o.receipt
    const who = (list: string[]) => (list.length ? list.map((a) => html` <a href="${urls(base).profile(a)}">${short(a)}</a>`) : ' no profile here')
    return html`<h1>Deal</h1><p><code>${o.escrow}</code></p>
${
  r
    ? html`<p>${amountText(r.amount, o.money)}, from <code>${r.payer}</code> (${who(o.profiles.payer)}) to <code>${r.recipient}</code> (${who(o.profiles.recipient)}), opened by the ${r.creator} on ${r.createdAt}.</p>
<p>${r.outcome ? `Ended by ${r.outcome} on ${r.endedAt}: ${amountText(r.toRecipient ?? '0', o.money)} to the recipient, ${amountText(r.toPayer ?? '0', o.money)} to the payer.` : r.closed ? 'Closed without a deal.' : 'Not ended yet.'}</p>
${r.schedule ? html`<p>Schedule: ${r.schedule.windows.map((w) => `until ${w.until} the payer may take back ${w.payerShare / 100}%`).join('; ')}; then ${r.schedule.end}.</p>` : ''}${r.arbiter ? html`<p>Arbiter: <code>${r.arbiter}</code>.</p>` : ''}`
    : html`<p class="muted">No receipt: this index read moves of it but not its opening.</p>`
}
<h2>Moves</h2>${o.moves.map((m) => html`<p>${m.move}, by ${m.by}${m.at ? `, ${m.at}` : ''}.</p>`)}
<h2>Reviews that name it</h2>${o.reviews.length ? o.reviews.map((v) => html`<p><a href="${urls(base).profile(v.reviewer)}">${short(v.reviewer)}</a> reviewed ${v.subject ? html`<a href="${urls(base).profile(v.subject)}">${short(v.subject)}</a>` : 'no one'}${v.counted ? '' : ' (does not count)'}.</p>`) : html`<p class="muted">None.</p>`}`
  },
  ld(o, base, url) {
    const r = o.receipt
    const party = (list: string[]) => (list[0] ? { agent: personOf(list[0], base) } : {})
    return {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', '@id': url, url, name: `Deal ${o.escrow}` },
        ...(r
          ? [
              {
                '@type': 'PayAction',
                identifier: o.escrow,
                ...party(o.profiles.payer),
                ...(o.profiles.recipient[0] && { recipient: personOf(o.profiles.recipient[0], base) }),
                ...(o.money && { price: amountText(r.amount, o.money).split(' ')[0], priceCurrency: o.money.code }),
                startTime: r.createdAt,
                ...(r.endedAt && { endTime: r.endedAt }),
                actionStatus: r.outcome || r.closed ? 'https://schema.org/CompletedActionStatus' : 'https://schema.org/ActiveActionStatus',
              },
            ]
          : []),
      ],
    }
  },
}
