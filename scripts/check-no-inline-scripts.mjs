// Fails if an HTML file has a <script> without src, or with a body. The web
// UI is served with CSP script-src 'self', so an inline script would be
// blocked at runtime: catch it in CI instead.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = readFileSync(file, 'utf8')
const bad = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter(([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) || body.trim())
if (bad.length) {
  console.error(`${file}: ${bad.length} inline script(s), which the UI's CSP blocks:\n${bad.map((m) => '  ' + m[0].slice(0, 80)).join('\n')}`)
  process.exit(1)
}
console.log(`${file}: no inline scripts`)
