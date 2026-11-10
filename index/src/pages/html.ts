// HTML from template literals: everything interpolated is escaped unless it is already built HTML
// (`Raw`). Its own module, so the template and the icons both build on it.

export class Raw {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false) return ''
  if (v instanceof Raw) return v.value
  if (Array.isArray(v)) return v.map(render).join('')
  return esc(String(v))
}

/** `html\`<p>${text}</p>\`` escapes `text`; nest `html` results, or arrays of them, freely. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]
  return new Raw(out)
}
