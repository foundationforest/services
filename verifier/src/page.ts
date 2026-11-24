// The payment page, `GET /id/pay`: the ID check's payment, made with no `returnUrl` (stripe.ts), on a
// page of the verifier's that an app frames, so the person pays without leaving it. The app frames
// `/id/pay#<clientSecret>`, the client secret `POST /id/payment` answered: after the `#`, which no
// browser sends, so it is in no request and no log. The page loads Stripe's script, the only page
// here that does, mounts the embedded Checkout with that client secret, and once the person has paid
// posts PAYMENT_DONE to the app around it, once, and only to the apps' origins (APP_ORIGINS).
//
// Stripe's script and its function as Stripe's documents give them (docs.stripe.com, Stripe.js
// versioning and Embedded Checkout): `https://js.stripe.com/<release>/stripe.js`, the release of the
// API version the verifier sends (STRIPE_VERSION's `endive`); `Stripe(publishableKey)`;
// `createEmbeddedCheckoutPage({fetchClientSecret, onComplete})`, which answers a promise of the
// Checkout, put on the page with `mount`; `onComplete` is called once the session is complete, and
// with `redirect_on_completion=never` Stripe never takes the person anywhere. Moving STRIPE_VERSION to
// another release moves the script with it, with its test.

import { PAYMENT_DONE } from './codes.ts'

/** Stripe's script, from Stripe and nowhere else, as its terms ask: of the release STRIPE_VERSION is in. */
export const STRIPE_SCRIPT = 'https://js.stripe.com/endive/stripe.js'

/** Who may use the Payment Request API in the page, for Apple Pay and Google Pay: the page and Stripe's two origins, which Stripe's frames are on. */
export const PAYMENT_ORIGINS = 'payment=(self "https://js.stripe.com" "https://checkout.stripe.com")'

/** Who may frame the page: the apps' origins only, and with none, nobody. */
export const frameAncestors = (appOrigins: string[]) => `frame-ancestors ${appOrigins.length ? appOrigins.join(' ') : "'none'"}`

/** JSON inside a script: no `<`, so no text in it can close the script. */
const inScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/**
 * The page and its headers, for this publishable key and these apps. The message is posted to each
 * app's origin, so the browser delivers it to the one framing the page, whichever it is, and drops it
 * for every other: `frame-ancestors` lets no other frame it.
 */
export function payPage(publishableKey: string, appOrigins: string[]): { headers: Record<string, string>; html: string } {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay for the ID check</title>
<script src="${STRIPE_SCRIPT}"></script>
</head>
<body style="margin:0">
<div id="checkout"></div>
<script>
const clientSecret = location.hash.slice(1)
const origins = ${inScript(appOrigins)}
let done = false
Stripe(${inScript(publishableKey)}).createEmbeddedCheckoutPage({
  fetchClientSecret: async () => clientSecret,
  onComplete: () => {
    if (done) return
    done = true
    for (const origin of origins) parent.postMessage(${inScript(PAYMENT_DONE)}, origin)
  },
}).then((checkout) => checkout.mount('#checkout'))
</script>
</body>
</html>
`
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': frameAncestors(appOrigins),
      'permissions-policy': PAYMENT_ORIGINS,
    },
    html,
  }
}
