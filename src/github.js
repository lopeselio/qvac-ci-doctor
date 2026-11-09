import { spawn } from 'node:child_process'

// Everything GitHub-related goes through the `gh` CLI: it is already logged
// in on developer machines and preinstalled on GitHub's runners (with
// GH_TOKEN). `exec` is injectable so tests never touch the network.

import { MARKER } from './marker.js'

export { MARKER }

export class LogsUnavailableError extends Error {
  constructor (detail) {
    super(`GitHub no longer has this run's logs (${detail}). Logs are kept for 90 days by default.`)
    this.name = 'LogsUnavailableError'
  }
}

/** Runs `gh` and resolves with stdout. */
export function ghExec (args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('The GitHub CLI (gh) is not installed: https://cli.github.com') : e))
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(Buffer.concat(err).toString('utf8').trim() || `gh exited with ${code}`))
    })
    child.stdin.end(input ?? '')
  })
}

/** "123", or a run / job URL → { id, repo } */
export function parseRunRef (ref) {
  const s = String(ref).trim()
  if (/^\d+$/.test(s)) return { id: s, repo: null }
  const m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(s)
  if (m) return { id: m[2], repo: m[1] }
  throw new Error(`Not a run id or GitHub Actions run URL: ${ref}`)
}

const RUN_FIELDS = 'databaseId,name,workflowName,workflowDatabaseId,headSha,headBranch,event,conclusion,status,url,attempt,jobs'

export class GitHub {
  constructor ({ repo = null, exec = ghExec } = {}) {
    this.repo = repo
    this.exec = exec
  }

  _r () { return this.repo ? ['-R', this.repo] : [] }

  async json (args, opts) {
    const out = await this.exec(args, opts)
    return out.trim() ? JSON.parse(out) : null
  }

  async resolveRepo () {
    if (!this.repo) this.repo = (await this.exec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim()
    return this.repo
  }

  run (id) { return this.json(['run', 'view', String(id), ...this._r(), '--json', RUN_FIELDS]) }

  async failedLog (id) {
    try {
      return await this.exec(['run', 'view', String(id), ...this._r(), '--log-failed'])
    } catch (err) {
      if (/HTTP 410|log not found|logs? (?:have|has) expired/i.test(err.message)) throw new LogsUnavailableError(err.message.split('\n')[0])
      throw err
    }
  }

  async annotations (jobId) {
    const repo = await this.resolveRepo()
    return (await this.json(['api', `repos/${repo}/check-runs/${jobId}/annotations`])) ?? []
  }

  async latestFailedRun ({ branch, workflow } = {}) {
    const args = ['run', 'list', ...this._r(), '-s', 'failure', '-L', '1', '--json', 'databaseId']
    if (branch) args.push('--branch', branch)
    if (workflow) args.push('--workflow', String(workflow))
    const list = await this.json(args)
    return list?.[0]?.databaseId ?? null
  }

  /** Recent failed runs, newest first, for picking one to diagnose. */
  async recentFailures ({ limit = 15 } = {}) {
    const fields = 'databaseId,displayTitle,workflowName,headBranch,event,createdAt,url,number'
    return (await this.json(['run', 'list', ...this._r(), '-s', 'failure', '-L', String(limit), '--json', fields])) ?? []
  }

  /** The signed-in GitHub user, or null if gh isn't signed in. */
  async user () {
    try { return (await this.exec(['api', 'user', '-q', '.login'])).trim() || null } catch { return null }
  }

  async pullRequestFor (run) {
    const repo = await this.resolveRepo()
    const prs = await this.json(['api', `repos/${repo}/commits/${run.headSha}/pulls`])
    const open = (prs ?? []).find((p) => p.state === 'open') ?? prs?.[0]
    return open?.number ?? null
  }

  /** Files this run's change touched: the PR's files, or the diff since the last green run. */
  async changedFiles (run, pr) {
    const repo = await this.resolveRepo()
    if (pr) {
      const files = await this.json(['pr', 'view', String(pr), '-R', repo, '--json', 'files'])
      return { files: (files?.files ?? []).map((f) => f.path), base: `PR #${pr}` }
    }
    const green = await this.json(['run', 'list', '-R', repo, '--workflow', String(run.workflowDatabaseId), '--branch', run.headBranch, '-s', 'success', '-L', '1', '--json', 'headSha'])
    const base = green?.[0]?.headSha
    if (!base || base === run.headSha) return { files: [], base: null }
    const cmp = await this.json(['api', `repos/${repo}/compare/${base}...${run.headSha}`])
    return { files: (cmp?.files ?? []).map((f) => f.filename), base: base.slice(0, 7) }
  }

  /** The latest finished run of the same workflow on the default branch. */
  async defaultBranchStatus (run) {
    const repo = await this.resolveRepo()
    const meta = await this.json(['repo', 'view', repo, '--json', 'defaultBranchRef'])
    const branch = meta?.defaultBranchRef?.name
    if (!branch || branch === run.headBranch) return null
    const runs = await this.json(['run', 'list', '-R', repo, '--workflow', String(run.workflowDatabaseId), '--branch', branch, '-L', '10', '--json', 'conclusion,status,url,createdAt'])
    const done = (runs ?? []).find((r) => r.status === 'completed')
    return done ? { branch, conclusion: done.conclusion, url: done.url, date: done.createdAt?.slice(0, 10) ?? null } : null
  }

  /** Creates or updates ci-doctor's one comment on a PR (or commit). */
  async upsertComment ({ pr, sha }, body) {
    const repo = await this.resolveRepo()
    const payload = JSON.stringify({ body })
    if (pr) {
      const ids = await this.exec(['api', '--paginate', `repos/${repo}/issues/${pr}/comments`, '-q', `.[] | select(.body | contains("${MARKER}")) | .id`])
      const id = ids.trim().split('\n').filter(Boolean).pop()
      if (id) return this.json(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', '-'], { input: payload })
      return this.json(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], { input: payload })
    }
    return this.json(['api', '-X', 'POST', `repos/${repo}/commits/${sha}/comments`, '--input', '-'], { input: payload })
  }
}
