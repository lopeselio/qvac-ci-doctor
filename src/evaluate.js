import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diagnose } from './diagnose.js'

// Measure how often ci-doctor is right, on logs where the answer is known.
//
// A case is a log file plus `<name>.expect.json`:
//   { "verdict": "failure", "root": "npm-version-missing",
//     "file": "src/x.ts", "mentions": ["@qvac/registry-client"] }
// Only "verdict" and "root" are required.

export async function loadCases (dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.log')).sort()
  const cases = []
  for (const name of names) {
    const expectPath = join(dir, name.replace(/\.log$/, '.expect.json'))
    const expect = await readFile(expectPath, 'utf8').then(JSON.parse).catch(() => null)
    if (!expect) continue
    cases.push({ name, log: await readFile(join(dir, name), 'utf8'), expect })
  }
  return cases
}

export function scoreCase (c, diagnosis) {
  const root = diagnosis.causes[0]?.finding ?? null
  const text = root ? `${root.title}\n${root.detail}\n${root.fix}` : ''
  const checks = {
    verdict: diagnosis.verdict === c.expect.verdict,
    root: (root?.id ?? null) === c.expect.root
  }
  if (c.expect.file) checks.file = root?.file === c.expect.file
  if (c.expect.mentions) checks.mentions = c.expect.mentions.every((m) => text.includes(m))
  return { name: c.name, pass: Object.values(checks).every(Boolean), checks, got: { verdict: diagnosis.verdict, root: root?.id ?? null, file: root?.file ?? null, title: root?.title ?? null } }
}

/**
 * @param {{ explain?: (diagnosis: object) => Promise<object> }} [opts]
 */
export async function evaluate (dir, { explain } = {}) {
  const results = []
  for (const c of await loadCases(dir)) {
    const diagnosis = diagnose(c.log)
    const r = scoreCase(c, diagnosis)
    if (explain && diagnosis.causes.length) r.explanation = await explain(diagnosis)
    results.push(r)
  }
  const n = results.length || 1
  const rate = (k) => results.filter((r) => r.checks[k] !== false).length / n
  const summary = {
    cases: results.length,
    passed: results.filter((r) => r.pass).length,
    verdictAccuracy: rate('verdict'),
    rootAccuracy: rate('root')
  }
  const explained = results.filter((r) => r.explanation)
  if (explained.length) {
    summary.explanationsAccepted = explained.filter((r) => r.explanation.accepted).length / explained.length
    summary.explanationMs = Math.round(explained.reduce((s, r) => s + r.explanation.ms, 0) / explained.length)
    summary.rejections = explained.filter((r) => !r.explanation.accepted).map((r) => `${r.name}: ${r.explanation.reason}`)
  }
  return { results, summary }
}
