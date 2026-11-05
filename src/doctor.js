import { diagnose } from './diagnose.js'
import { GitHub, LogsUnavailableError, parseRunRef } from './github.js'
import { matrixSiblings, matrixNote, touchedByChange } from './context.js'

/**
 * When GitHub has deleted a run's logs, rebuild a minimal log from what it
 * still keeps: which job and step failed, and the error annotations.
 */
export async function logFromMetadata (gh, run) {
  const rows = []
  const ts = '2000-01-01T00:00:00.0000000Z'
  for (const job of run.jobs ?? []) {
    if (job.conclusion !== 'failure') continue
    const failed = (job.steps ?? []).filter((s) => s.conclusion === 'failure')
    for (const step of failed.length ? failed : [{ name: 'unknown step' }]) {
      rows.push(`${job.name}\t${step.name}\t${ts} ##[group]Run ${step.name}`)
    }
    const notes = await gh.annotations(job.databaseId).catch(() => [])
    for (const a of notes) {
      if (a.annotation_level === 'failure') rows.push(`${job.name}\tUNKNOWN STEP\t${ts} ##[error]${String(a.message).split('\n')[0]}`)
    }
  }
  return rows.join('\n')
}

/**
 * Diagnose a GitHub Actions run end to end.
 * @param {{ ref: string|number, repo?: string, gh?: GitHub, context?: boolean }} opts
 */
export async function diagnoseRun ({ ref, repo = null, gh = null, context: wantContext = true }) {
  const parsed = parseRunRef(ref)
  gh ??= new GitHub({ repo: parsed.repo ?? repo })
  if (parsed.repo) gh.repo = parsed.repo
  const run = await gh.run(parsed.id)
  if (run.status !== 'completed') throw new Error(`Run ${parsed.id} is still ${run.status}.`)
  if (run.conclusion === 'success') return { run, diagnosis: { verdict: 'passed', causes: [], jobs: [], findings: [], lines: [] }, context: {} }

  const context = {}
  let log
  try {
    log = await gh.failedLog(parsed.id)
  } catch (err) {
    if (!(err instanceof LogsUnavailableError)) throw err
    log = await logFromMetadata(gh, run)
    context.logsExpired = 'GitHub has deleted this run\'s logs, so this is based only on which step failed and its annotations.'
  }
  const diagnosis = diagnose(log)
  if (!wantContext) return { run, diagnosis, context }

  const root = diagnosis.causes[0]
  if (root) {
    const siblings = matrixSiblings(run.jobs ?? [])
    context.matrix = matrixNote(root.finding, siblings.get(root.jobs[0]))
  }
  const pr = await gh.pullRequestFor(run).catch(() => null)
  context.pr = pr
  const changed = await gh.changedFiles(run, pr).catch(() => null)
  if (changed?.base) {
    context.changed = changed
    context.touched = touchedByChange(diagnosis.causes.map((c) => c.finding), changed.files)
  }
  context.defaultBranch = await gh.defaultBranchStatus(run).catch(() => null)
  return { run, diagnosis, context }
}
