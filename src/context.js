import { normalizePath } from './detectors.js'

// Facts about the run that the log alone can't give: which matrix jobs
// passed, what this change touched, and whether the default branch was
// already red. All of it is optional; the diagnosis works without it.

/** "build (ubuntu-latest)" → { base: 'build', variant: 'ubuntu-latest' }; "Test / linux" → { base: 'Test', variant: 'linux' } */
export function splitJobName (name) {
  let m = /^(.*?)\s*\(([^()]*)\)$/.exec(name)
  if (m) return { base: m[1], variant: m[2] }
  m = /^(.*?) \/ ([^/]+)$/.exec(name)
  if (m) return { base: m[1], variant: m[2] }
  return { base: name, variant: null }
}

/**
 * For each failing job, the sibling matrix jobs that passed.
 * @param {{ name: string, conclusion: string }[]} jobs
 * @returns {Map<string, { passed: string[], failed: string[] }>}
 */
export function matrixSiblings (jobs) {
  const groups = new Map()
  for (const j of jobs) {
    const { base, variant } = splitJobName(j.name)
    if (!variant) continue
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push({ ...j, variant })
  }
  const out = new Map()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const passed = list.filter((j) => j.conclusion === 'success').map((j) => j.variant)
    const failed = list.filter((j) => j.conclusion === 'failure').map((j) => j.variant)
    for (const j of list) if (j.conclusion === 'failure') out.set(j.name, { passed, failed })
  }
  return out
}

const PLATFORM_HINT = {
  test: 'A test that passes on one OS and fails on another usually depends on file paths, line endings, case-sensitive file names or timing.',
  build: 'Linux file systems are case-sensitive; macOS and Windows usually are not. Check the import path\'s case.',
  timeout: 'Slower runners hit timing limits first. If a rerun passes, the test depends on timing.'
}

export function matrixNote (finding, sibling) {
  if (!sibling || !sibling.passed.length) return null
  return {
    text: `Fails on ${sibling.failed.join(', ')}; passes on ${sibling.passed.join(', ')}.`,
    hint: PLATFORM_HINT[finding.category] ?? null
  }
}

/** Which findings point at files this change touched. */
export function touchedByChange (findings, changedFiles) {
  if (!changedFiles?.length) return []
  const changed = new Set(changedFiles.map(normalizePath))
  const hits = []
  for (const f of findings) {
    const files = [f.file, ...(f.detail.match(/[\w./@-]+\.(?:[cm]?[jt]sx?|json)/g) ?? [])].filter(Boolean).map(normalizePath)
    const match = files.find((p) => changed.has(p) || [...changed].some((c) => c.endsWith('/' + p)))
    if (match) hits.push({ finding: f, file: match, why: 'file' })
  }
  const deps = [...changed].filter((p) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p))
  for (const f of findings) {
    if (f.category === 'dependency' && deps.length && !hits.some((h) => h.finding === f)) hits.push({ finding: f, file: deps[0], why: 'deps' })
  }
  return hits
}
