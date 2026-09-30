// The files for machines at the root: sitemap.xml, robots.txt, llms.txt and the read skill. The
// last two are plain files in index/ written for https://forest.foundation; each index serves them
// with its own address in their place.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INDEX_ROOT } from '../config.ts'
import { esc } from './html.ts'

export const WRITTEN_FOR = 'https://forest.foundation'

export function textFile(name: 'llms.txt' | 'skill.md', base: string): string {
  return readFileSync(join(INDEX_ROOT, name), 'utf8').replaceAll(WRITTEN_FOR, base)
}

export function robots(base: string): string {
  return `# Everyone may read everything here: people, search engines and AI agents alike.\nUser-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`
}

/** One urlset. Past 50,000 pages it needs a sitemap index; not yet. */
export function sitemap(urls: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `<url><loc>${esc(u)}</loc></url>\n`).join('') +
    '</urlset>\n'
  )
}
