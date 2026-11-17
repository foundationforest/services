// The service, from its settings (README.md, Settings): serves the file `npm run build` made in
// DATA_DIR, read-only.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { FILE, openPlaces } from './places.ts'
import { serve, web } from './web.ts'

const env = process.env
const file = join(env.DATA_DIR || './data', FILE)
if (!existsSync(file)) throw new Error(`${file} is missing: npm run build makes it`)
const port = Number(env.PORT || '8080')
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT is a port number')

const places = openPlaces(file)
const server = await serve(web(places), port, '0.0.0.0')
const { built, counts } = places.about() as { built: string; counts: Record<string, number> }
console.log(`places: ${counts.towns} towns and ${counts.colonias} colonias, built ${built}, listening on ${port}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => (places.close(), process.exit(0))))
