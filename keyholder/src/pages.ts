// The pages a person sees while connecting an assistant: plain HTML, no script, no outside file.
// Every word is plain: a profile, its app, keys, offers, messages. "Connections" is what they see;
// the key holder is behind it.

/** Its own inline style only, no script, never in a frame. */
export const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const STYLE = `body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1b1f1d;background:#fbfcfb}
main{max-width:34rem;margin:0 auto;padding:24px 16px}
code{display:block;padding:8px;background:#eef2ef;border-radius:6px;word-break:break-all;font-size:.95rem}
.muted{color:#5b645f;font-size:.9rem}
@media (prefers-color-scheme:dark){body{color:#e7ece9;background:#121614}code{background:#1a201d}.muted{color:#a3ada7}}`

function layout(title: string, body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`
}

/** The first page: the link the person opens in their app, which hands the keys over. */
export function connectPage(id: string, assistant: string | null, link: string): string {
  const who = assistant ? esc(assistant) : 'An assistant'
  return layout(
    'Connect an assistant · Forest',
    `<h1>Connect an assistant</h1>
<p>${who} asks to act for one of your profiles. It never gets your main key: your app makes keys for it, each for one kind of thing (posting offers and reviews, messages, reading what you choose), and you can remove each one in your app at any time. None of them can pay.</p>
<p>Open this link in your Forest app:</p>
<code>${esc(link)}</code>
<p>This page moves on by itself once your app has given the keys and your profile lists them.</p>
<p class="muted"><a href="/connect/${esc(id)}">Check again</a></p>`,
    true,
  )
}

/** The second page: the keys arrived; waiting for the profile to list them. */
export function waitPage(id: string, profile: string): string {
  return layout(
    'Waiting for your profile · Forest',
    `<h1>Waiting for your profile</h1>
<p>Your app gave the keys for the profile ending ${esc(profile.slice(-6))}. This page moves on by itself once your profile lists them.</p>
<p class="muted">To end this connection later, remove the keys in your app. What it already posted stays.</p>
<p class="muted"><a href="/connect/${esc(id)}">Check again</a></p>`,
    true,
  )
}

export function connectedPage(): string {
  return layout('Connected · Forest', '<h1>Connected</h1><p>You can go back to your assistant.</p>')
}

export function gonePage(): string {
  return layout('Not found · Forest', '<h1>This connection is gone</h1><p>It ran out of time, or it was already made. Start again from your assistant.</p>')
}
