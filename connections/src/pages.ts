// The pages a person sees while connecting an assistant: plain HTML, no script, no outside file.
// Every word is plain: a profile, its app, a writer key, offers and reviews.

/** Its own inline style only, no script, forms posting back here only, never in a frame. */
export const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const STYLE = `body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1b1f1d;background:#fbfcfb}
main{max-width:34rem;margin:0 auto;padding:24px 16px}
input{width:100%;box-sizing:border-box;padding:8px;font:inherit;border:1px solid #c9d1cc;border-radius:6px}
button{margin-top:12px;padding:8px 16px;border:0;border-radius:6px;background:#1f6b45;color:#fff;font:inherit;font-weight:600}
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

/** The first page: which profile the assistant will post for. */
export function namePage(id: string, assistant: string | null, problem: string | null = null): string {
  const who = assistant ? esc(assistant) : 'An assistant'
  return layout(
    'Connect an assistant · Forest',
    `<h1>Connect an assistant</h1>
<p>${who} asks to post offers and reviews for one of your profiles. It will never hold your profile’s key: it gets a writer key of its own, which your app adds to your profile, and which you can remove there at any time.</p>
<form method="post" action="/connect/${esc(id)}">
<label for="profile">Your profile’s address, from your Forest app:</label>
<input id="profile" name="profile" autocomplete="off" spellcheck="false" required>
${problem ? `<p>${esc(problem)}</p>` : ''}
<button type="submit">Continue</button>
</form>`,
  )
}

/** The second page: add this writer key in the app; it moves on by itself once the profile lists it. */
export function waitPage(id: string, profile: string, writer: string, paths: string[]): string {
  return layout(
    'Add the writer key · Forest',
    `<h1>Add this writer key in your app</h1>
<p>In your Forest app, add this writer key to the profile ending ${esc(profile.slice(-6))}, for ${paths.map((p) => `${esc(p)}s`).join(' and ')}:</p>
<code>${esc(writer)}</code>
<p>Your app signs that change with your profile’s key. This page moves on by itself once your profile lists the key.</p>
<p class="muted">To end this connection later, remove the writer key in your app. What it already posted stays.</p>
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
