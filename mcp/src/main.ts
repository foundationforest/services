// The hosted copy, started from its settings, each a variable in the environment. It writes one line
// when it starts, and nothing for a request.

import { normalizeOrigin } from '@foundationforest/records'
import { INDEX, refuse } from './forest.ts'
import { serve } from './server.ts'

/** A variable, or undefined when it is not set or empty. */
const env = (name: string) => process.env[name] || undefined

function settings() {
  const origin = env('PUBLIC_URL') ?? 'https://mcp.forest.foundation'
  if (normalizeOrigin(origin) !== origin) refuse(`PUBLIC_URL is an origin, https://host[:port], as a person's permissions name it: not ${origin}`)
  const appUrl = env('APP_URL')
  if (appUrl !== undefined && !(URL.canParse(appUrl) && normalizeOrigin(new URL(appUrl).origin))) refuse(`APP_URL is the app's connect page, an https address (http only on loopback): not ${appUrl}`)
  const port = Number(env('PORT') ?? 8080)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) refuse('PORT is a port number')
  return {
    origin,
    ...(appUrl && { appUrl }),
    dataDir: env('DATA_DIR') ?? refuse('DATA_DIR is where this copy keeps its key, on a volume'),
    read: { index: env('INDEX_URL') ?? INDEX },
    // Loopback unless told otherwise: the image says 0.0.0.0.
    hostname: env('BIND') ?? '127.0.0.1',
    port,
  }
}

try {
  const { hostname, port, ...rest } = settings()
  const served = await serve(rest, hostname, port)
  const at = served.http.address()
  console.error(`forest mcp: ${rest.origin}, listening on ${typeof at === 'object' && at ? `${at.address}:${at.port}` : at}${rest.appUrl ? '' : ', logins waiting for APP_URL'}`)
} catch (err) {
  console.error((err as Error).message)
  process.exitCode = 1
}
