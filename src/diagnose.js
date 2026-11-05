import { parseLog, jobsOf } from './parse.js'
import { DETECTORS } from './detectors.js'

// How a root cause is chosen, per failing job:
//   1. the earliest finding that is specific (priority >= 70), else
//   2. the earliest finding with some signal (priority >= 50), else
//   3. the most specific finding there is.
// "Earliest" matters: when a dependency fails to install, every later
// typecheck, build and test also fails, and only the first error is worth
// fixing. Everything after the root is reported as "may follow from it".

const SPECIFIC = 70
const SIGNAL = 50
const CONSISTENT = 3 // jobs failing identically before a timeout stops looking flaky

/** Runs every detector; a line claimed by an earlier detector isn't reused. */
export function detect (lines) {
  const claimed = new Set()
  const out = []
  for (const d of DETECTORS) {
    for (const f of d(lines)) {
      if (claimed.has(f.lines[0])) continue
      for (const n of f.claims ?? f.lines) claimed.add(n)
      out.push(f)
    }
  }
  return out.sort((a, b) => a.lines[0] - b.lines[0])
}

export function pickRoot (findings) {
  if (!findings.length) return null
  return findings.find((f) => f.priority >= SPECIFIC) ??
    findings.find((f) => f.priority >= SIGNAL) ??
    [...findings].sort((a, b) => b.priority - a.priority || a.lines[0] - b.lines[0])[0]
}

const RANK = { failure: 3, 'maybe-flaky': 2, flaky: 1, unknown: 0 }
// A bare exit code or a canceled job says something failed, not what.
const verdictOf = (f) => f.priority <= 10 ? 'unknown' : f.flaky === 'likely' ? 'flaky' : f.flaky === 'possible' ? 'maybe-flaky' : 'failure'

/**
 * @param {string|object[]} log raw text or parsed lines
 * @returns {{ verdict: string, causes: object[], jobs: object[], findings: object[], lines: object[] }}
 */
export function diagnose (log) {
  const lines = typeof log === 'string' ? parseLog(log) : log
  const findings = detect(lines)
  const jobs = []
  for (const job of jobsOf(lines)) {
    const mine = findings.filter((f) => f.job === job)
    const root = pickRoot(mine)
    if (!root && job === null && jobs.length) continue
    jobs.push({ job, root, others: mine.filter((f) => f !== root) })
  }

  // The same cause in several jobs (a matrix) is one cause.
  const byKey = new Map()
  for (const j of jobs) {
    if (!j.root) continue
    const c = byKey.get(j.root.key) ?? { finding: j.root, jobs: [] }
    if (j.job) c.jobs.push(j.job)
    byKey.set(j.root.key, c)
  }
  // A "possibly flaky" failure that hits several jobs the same way isn't random.
  for (const c of byKey.values()) {
    if (c.finding.flaky === 'possible' && c.jobs.length >= CONSISTENT) {
      c.finding.flaky = 'no'
      c.finding.detail = [c.finding.detail, `It failed the same way in ${c.jobs.length} jobs, so this is consistent rather than flaky.`].filter(Boolean).join('\n')
    }
  }
  const causes = [...byKey.values()].sort((a, b) =>
    RANK[verdictOf(b.finding)] - RANK[verdictOf(a.finding)] || b.finding.priority - a.finding.priority)

  let verdict = 'unknown'
  if (causes.length) verdict = causes.map((c) => verdictOf(c.finding)).sort((a, b) => RANK[b] - RANK[a])[0]
  return { verdict, causes, jobs, findings, lines }
}

/** 0 nothing failed · 1 worth a rerun · 2 real failure · 3 failed, cause unclear */
export function exitCodeFor (verdict) {
  return { passed: 0, flaky: 1, 'maybe-flaky': 1, failure: 2, unknown: 3 }[verdict] ?? 3
}

/** Up to `max` lines around a finding's evidence, with original numbers. */
export function excerpt (lines, finding, { before = 3, after = 2, max = 40 } = {}) {
  const byN = new Map(lines.map((l) => [l.n, l]))
  const want = new Set()
  for (const n of finding.lines) for (let k = n - before; k <= n + after; k++) if (byN.has(k)) want.add(k)
  return [...want].sort((a, b) => a - b).slice(0, max).map((n) => ({ n, text: byN.get(n).text }))
}
