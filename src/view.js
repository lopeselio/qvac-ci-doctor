// What the web UI shows for one diagnosis: renderJson plus the evidence lines
// around each cause. Used by the local server and by the in-browser build.
// No Node-only imports.
import { excerpt, exitCodeFor } from './diagnose.js'
import { headline, renderJson } from './report.js'

export function diagnosisView (id, { run = null, diagnosis, context = {}, repo = null }) {
  const json = renderJson(diagnosis, { run, context })
  const evidence = diagnosis.causes.map((c) => excerpt(diagnosis.lines, c.finding).map((l) => ({ n: l.n, text: l.text, hit: (c.finding.lines ?? []).includes(l.n) })))
  return {
    id,
    repo,
    headline: headline(diagnosis.verdict).text,
    exitCode: exitCodeFor(diagnosis.verdict),
    ...json,
    evidence,
    pr: context?.pr ?? null,
    sha: run?.headSha ?? null,
    lineCount: diagnosis.lines.length
  }
}
