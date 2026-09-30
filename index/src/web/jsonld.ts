// Structured data for machines: schema.org JSON-LD, one `@graph` per page, so search engines and
// shopping AIs read the page natively. Built from the same model as the HTML and the twin.
//
// Two things schema.org decides for us:
//   - `review` and `aggregateRating` do not take a Person. So a profile's reviews and its rating are
//     nodes of their own whose `itemReviewed` (any Thing) is the profile, Person or LocalBusiness
//     alike. An Offer takes both, so each offer also carries its seller's rating.
//   - A rating needs a bounded scale; standing has none (a sum that can go below zero). So the
//     rating, the weighted overall from 1 to 10, is the AggregateRating, and standing rides on each
//     offer as a PropertyValue. Neither is blended with the other, or with uniqueness.

import type { CurrencyConfig as Currencies } from '../config.ts'
import type { DealModel, FolderModel, HomeModel, MarketModel, Offer, ProfileModel, Review, SearchModel } from './data.ts'
import { money, moneyFromBase, title } from './words.ts'

type Node = Record<string, unknown>
const CONTEXT = 'https://schema.org'
const graph = (nodes: Node[]) => ({ '@context': CONTEXT, '@graph': nodes })
const ref = (id: string) => ({ '@id': id })

export const RATING_EXPLANATION =
  'The weighted average of the overall ratings, from 1 to 10, in the reviews this index counts, each weighed by who wrote it and by the payment behind it. See index/SCORING.md in the Forest repository.'

export const STANDING_EXPLANATION =
  'The seller’s standing in this index: the reviews they received, each weighed by who wrote it and by the payment behind it, summed. Everyone starts at 0; it can go below. See index/SCORING.md in the Forest repository.'

/** A rating out of 10, one decimal, as the pages show it. */
const tenth = (v: number) => Math.round(v * 10) / 10

function aggregateRating(r: { value: number | null; reviews: number }): Node | null {
  if (r.value === null || r.reviews === 0) return null
  return { '@type': 'AggregateRating', ratingValue: tenth(r.value), bestRating: 10, worstRating: 1, reviewCount: r.reviews, ratingExplanation: RATING_EXPLANATION }
}

function offerNode(o: Offer, currencies: Currencies, seller: Node): Node {
  const m = o.price ? money(o.price.amount, o.price.mint, currencies) : null
  const rating = aggregateRating(o.rating)
  const node: Node = {
    '@type': 'Offer',
    identifier: o.uri,
    url: o.profileUrl,
    seller,
    itemOffered: {
      '@type': 'Service',
      ...(o.market ? { name: title(o.market), serviceType: o.market } : {}),
      description: o.description,
      provider: seller,
      ...(o.remote ? {} : o.location ? { areaServed: o.location.area } : {}),
    },
    ...(rating ? { aggregateRating: rating } : {}),
    additionalProperty: { '@type': 'PropertyValue', name: 'standing', value: o.standing, description: STANDING_EXPLANATION },
  }
  if (m?.known && o.price) {
    node.price = m.decimal
    node.priceCurrency = m.code
    node.priceSpecification = { '@type': 'UnitPriceSpecification', price: m.decimal, priceCurrency: m.code, unitText: o.price.per }
  }
  if (o.expires) node.validThrough = o.expires
  return node
}

function personRef(name: string | null, url: string): Node {
  return { '@type': 'Person', ...(name ? { name } : {}), url }
}

function reviewNode(v: Review, itemReviewed: Node, id: string): Node {
  return {
    '@type': 'Review',
    '@id': id,
    identifier: v.uri,
    itemReviewed,
    author: personRef(v.reviewerName, v.reviewerUrl),
    ...(v.overall !== null ? { reviewRating: { '@type': 'Rating', ratingValue: v.overall, bestRating: 10, worstRating: 1 } } : {}),
    ...(v.text ? { reviewBody: v.text } : {}),
    ...(v.createdAt ? { datePublished: v.createdAt } : {}),
  }
}

export function homeLd(m: HomeModel): unknown {
  return graph([
    { '@type': 'WebSite', '@id': m.url, url: m.url, name: 'Forest', description: m.index.about },
    {
      '@type': 'ItemList',
      name: 'Markets, by folder',
      itemListElement: m.folders.map((f, i) => ({ '@type': 'ListItem', position: i + 1, name: title(f.folder), url: f.url })),
    },
  ])
}

export function folderLd(m: FolderModel): unknown {
  return graph([
    {
      '@type': 'CollectionPage',
      '@id': m.url,
      url: m.url,
      name: title(m.folder),
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: m.markets.map((x, i) => ({ '@type': 'ListItem', position: i + 1, name: title(x.name), url: x.url })),
      },
    },
  ])
}

export function marketLd(m: MarketModel, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'CollectionPage',
      '@id': m.url,
      url: m.url,
      name: title(m.market.name),
      description: m.market.description,
      mainEntity: {
        '@type': 'OfferCatalog',
        name: `${title(m.market.name)}: offers`,
        numberOfItems: m.total,
        itemListElement: m.offers.map((o) => offerNode(o, currencies, personRef(o.name, o.profileUrl))),
      },
    },
  ])
}

export function profileLd(m: ProfileModel, currencies: Currencies): unknown {
  const id = `${m.url}#profile`
  const place = m.offers.find((o) => !o.remote && o.location)?.location?.area ?? null
  const subject: Node = {
    '@type': place ? 'LocalBusiness' : 'Person',
    '@id': id,
    name: m.profile.name,
    url: m.url,
    identifier: m.did,
    ...(m.profile.about ? { description: m.profile.about } : {}),
    ...(place ? { address: place } : {}),
    makesOffer: m.offers.map((o) => offerNode(o, currencies, ref(id))),
  }
  const nodes: Node[] = [{ '@type': 'ProfilePage', '@id': m.url, url: m.url, name: m.profile.name, mainEntity: ref(id) }, subject]
  const rating = m.scores.rating ? aggregateRating({ value: m.scores.rating.value, reviews: (m.scores.rating.details as { reviews: number }).reviews }) : null
  if (rating) nodes.push({ ...rating, '@id': `${m.url}#rating`, itemReviewed: ref(id) })
  m.reviews.received.forEach((v, i) => nodes.push(reviewNode(v, ref(id), `${m.url}#review-${i + 1}`)))
  return graph(nodes)
}

export function dealLd(m: DealModel, currencies: Currencies): unknown {
  const nodes: Node[] = [{ '@type': 'WebPage', '@id': m.url, url: m.url, name: 'Payment receipt' }]
  const r = m.receipt
  if (r) {
    const buyer = r.buyerProfiles[0]
    const seller = r.sellerProfiles[0]
    const amount = moneyFromBase(r.amount, r.mint, currencies)
    nodes.push({
      '@type': 'PayAction',
      '@id': `${m.url}#payment`,
      identifier: r.escrow,
      ...(buyer ? { agent: personRef(buyer.name, buyer.url) } : {}),
      ...(seller ? { recipient: personRef(seller.name, seller.url) } : {}),
      ...(amount.known ? { price: amount.decimal, priceCurrency: amount.code } : {}),
      ...(r.createdAt ? { startTime: r.createdAt } : {}),
      ...(r.endedAt ? { endTime: r.endedAt } : {}),
      actionStatus: r.endedAt ? 'https://schema.org/CompletedActionStatus' : 'https://schema.org/ActiveActionStatus',
    })
  }
  m.reviews.forEach((v, i) => nodes.push(reviewNode(v, personRef(v.subjectName, v.subjectUrl), `${m.url}#review-${i + 1}`)))
  return graph(nodes)
}

export function searchLd(m: SearchModel, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'SearchResultsPage',
      '@id': m.url,
      url: m.url,
      name: m.q ? `Search: ${m.q}` : 'Search',
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: m.total,
        itemListElement: m.offers.map((o) => offerNode(o, currencies, personRef(o.name, o.profileUrl))),
      },
    },
  ])
}

export function payLd(url: string, offer: Offer | null, currencies: Currencies): unknown {
  return graph([
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name: 'Pay for an offer',
      ...(offer ? { mainEntity: offerNode(offer, currencies, personRef(offer.name, offer.profileUrl)) } : {}),
    },
  ])
}
