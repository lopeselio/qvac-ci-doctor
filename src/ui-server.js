// Local web UI for ci-doctor.
//
// A small node:http server (no dependencies) over the same functions the CLI
// uses: diagnoseRun / diagnose → renderJson / renderMarkdown, explainWithLlm
// for the optional local QVAC explanation, and GitHub.upsertComment to post.
// GitHub access goes through the GitHub CLI (`gh`) the user is signed in to.
//
// Like the other QVAC UIs it only listens on 127.0.0.1, rejects foreign Host
// headers (DNS rebinding), serves a strict CSP and only accepts JSON or
// plain-text POSTs, which a cross-site form can't send without a CORS
// preflight we never answer. Posting a comment needs an explicit request
// from the page (a button the user confirms); nothing is posted otherwise.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { diagnose, excerpt, exitCodeFor } from './diagnose.js'
import { diagnoseRun } from './doctor.js'
import { GitHub, parseRunRef } from './github.js'
import { headline, renderJson, renderMarkdown } from './report.js'
import { explainWithLlm, loadExplainer } from './explain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY = 64 * 1024
const MAX_LOG = 64 * 1024 * 1024 // GitHub logs run to tens of MB
const KEEP = 30 // diagnoses kept for explain / comment / download

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const NOT_BUILT = '<!doctype html><meta charset="utf-8"><title>CI Doctor</title><p>The web UI isn\'t built yet. Run <code>npm run build:ui</code>, then reload.</p>'
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function fail (status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined)

/** gh errors, in words a person can act on. */
function ghError (err) {
  const m = String(err?.message ?? err)
  if (/ENOENT|not found: gh|command not found/i.test(m)) return fail(503, 'The GitHub CLI (gh) isn\'t installed. Install it from cli.github.com, run `gh auth login`, then try again.')
  if (/auth login|not logged|authentication/i.test(m)) return fail(401, 'The GitHub CLI isn\'t signed in. Run `gh auth login` in a terminal, then try again.')
  if (/HTTP 404|Could not resolve to a Repository|not found/i.test(m)) return fail(404, 'GitHub couldn\'t find that run or repository (or your account can\'t see it).')
  return fail(502, `GitHub: ${m.split('\n')[0]}`)
}

/**
 * @param {object} [opts]
 * @param {() => Promise<any>} [opts.loadSdk] returns @qvac/sdk, for explanations
 * @param {(repo: string|null) => GitHub} [opts.github] tests pass a fake
 * @param {string} [opts.repo] default repository (owner/name)
 * @param {string} [opts.uiDir] the React build (ui/dist)
 * @param {string} [opts.model] QVAC model constant for explanations
 */
export function createUiServer ({ loadSdk, github = (repo) => new GitHub({ repo }), repo = null, uiDir = join(ROOT, 'ui', 'dist'), model = 'QWEN3_1_7B_INST_Q4', log = () => {} } = {}) {
  const uiRoot = resolve(uiDir)
  const results = new Map() // id → { run, diagnosis, context, repo }
  let sdkPromise = null
  let explainer = null // Promise<{ sdk, modelId }>
  let explaining = Promise.resolve()
  const status = { model: null } // { state, download } while the explainer loads
  let closing = false

  function remember (entry) {
    const id = randomUUID()
    results.set(id, entry)
    while (results.size > KEEP) results.delete(results.keys().next().value)
    return id
  }

  /** What the page shows: renderJson plus the evidence lines around each cause. */
  function view (id) {
    const { run, diagnosis, context, repo: r } = results.get(id)
    const json = renderJson(diagnosis, { run, context })
    const evidence = diagnosis.causes.map((c) => excerpt(diagnosis.lines, c.finding).map((l) => ({ n: l.n, text: l.text, hit: (c.finding.lines ?? []).includes(l.n) })))
    return {
      id,
      repo: r,
      headline: headline(diagnosis.verdict).text,
      exitCode: exitCodeFor(diagnosis.verdict),
      ...json,
      evidence,
      pr: context?.pr ?? null,
      sha: run?.headSha ?? null,
      lineCount: diagnosis.lines.length
    }
  }

  function sdk () {
    if (!loadSdk) throw fail(503, "QVAC isn't available in this session, so the local explanation can't run. Install @qvac/sdk.")
    sdkPromise ??= loadSdk().catch((err) => { sdkPromise = null; throw fail(503, `Could not load @qvac/sdk: ${err.message}`) })
    return sdkPromise
  }

  function getExplainer () {
    explainer ??= (async () => {
      const s = await sdk()
      status.model = { state: 'loading', download: null }
      const modelId = await loadExplainer(s, {
        model,
        onProgress: (p) => { status.model = { state: 'downloading', download: Math.floor(p.percentage ?? 0) } }
      })
      status.model = { state: 'ready', download: null }
      return { sdk: s, modelId }
    })().catch((err) => {
      explainer = null
      status.model = null
      throw err.status ? err : fail(503, `Couldn't load the local model: ${err.message}`)
    })
    return explainer
  }

  // ---------- actions ----------

  async function diagnoseRef (body) {
    const ref = str(body.ref, 300)?.trim()
    if (!ref) throw fail(400, 'Paste a run URL or a run ID.')
    try { parseRunRef(ref) } catch (err) { throw fail(400, err.message) }
    const r = str(body.repo, 140)?.trim() || repo
    if (r && !REPO.test(r)) throw fail(400, 'Repositories look like owner/name.')
    let out
    try {
      out = await diagnoseRun({ ref, repo: r, gh: github(r), context: body.context !== false })
    } catch (err) {
      if (/still (?:in_progress|queued|waiting|pending)/.test(err.message)) throw fail(409, err.message)
      if (/must be|Not a run|invalid/i.test(err.message)) throw fail(400, err.message)
      throw ghError(err)
    }
    const used = parseRunRef(ref).repo ?? r
    return view(remember({ ...out, repo: used }))
  }

  async function recent (r) {
    if (!r || !REPO.test(r)) throw fail(400, 'Pick a repository (owner/name).')
    try {
      const runs = await github(r).recentFailures()
      return runs.map((x) => ({ id: x.databaseId, title: x.displayTitle, workflow: x.workflowName, branch: x.headBranch, event: x.event, at: x.createdAt, url: x.url, number: x.number }))
    } catch (err) { throw ghError(err) }
  }

  async function explain (req, res) {
    const body = await readJson(req)
    const entry = results.get(body.id)
    if (!entry) throw fail(404, 'That diagnosis has expired. Diagnose the run again.')
    if (!entry.diagnosis.causes.length) throw fail(409, 'There is nothing to explain.')
    if (entry.explanation) return send(res, 200, { explanation: entry.explanation })
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const emit = (ev) => { if (!res.destroyed) res.write(JSON.stringify(ev) + '\n') }
    const timer = setInterval(() => { if (status.model?.state !== 'ready') emit({ type: 'status', model: status.model }) }, 500)
    try {
      const m = await getExplainer()
      clearInterval(timer)
      emit({ type: 'status', model: { state: 'ready' } })
      // One explanation at a time: the model answers one request at a time.
      const work = explaining.then(() => explainWithLlm({ ...m, diagnosis: entry.diagnosis, context: entry.context, onText: (text) => emit({ type: 'delta', text }) }))
      explaining = work.catch(() => {})
      const explanation = await work
      delete explanation.raw
      entry.explanation = explanation
      emit({ type: 'result', explanation })
    } catch (err) {
      emit({ type: 'error', message: err.message })
    } finally {
      clearInterval(timer)
      res.end()
    }
  }

  async function comment (body) {
    const entry = results.get(body.id)
    if (!entry) throw fail(404, 'That diagnosis has expired. Diagnose the run again.')
    if (!entry.run) throw fail(409, 'Only a diagnosis of a GitHub run can be posted.')
    if (entry.diagnosis.verdict === 'passed') throw fail(409, 'That run passed: there is nothing to post.')
    const target = { pr: entry.context?.pr ?? null, sha: entry.run.headSha }
    const md = renderMarkdown(entry.diagnosis, { run: entry.run, context: entry.context, explanation: entry.explanation ?? null })
    let out
    try { out = await github(entry.repo).upsertComment(target, md) } catch (err) { throw ghError(err) }
    return { url: out?.html_url ?? null, where: target.pr ? `PR #${target.pr}` : `commit ${target.sha.slice(0, 7)}` }
  }

  // ---------- http ----------

  function notClosing () { if (closing) throw fail(503, 'CI Doctor is shutting down.') }

  function send (res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': headers['cache-control'] ?? 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
      ...headers
    })
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
  }

  async function staticFile (res, pathname) {
    let rel
    try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname) } catch { return send(res, 400, { error: 'bad path' }) }
    const file = resolve(uiRoot, '.' + rel)
    if (!file.startsWith(uiRoot + sep) || rel.includes('\0')) return send(res, 404, { error: 'not found' })
    try {
      const body = await readFile(file)
      const cache = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'
      return send(res, 200, body, MIME[extname(file)] ?? 'application/octet-stream', { 'cache-control': cache })
    } catch {
      if (rel === '/index.html') return send(res, 503, NOT_BUILT, 'text/html; charset=utf-8')
      return send(res, 404, { error: 'not found' })
    }
  }

  async function readBody (req, type, limit) {
    if (!String(req.headers['content-type'] ?? '').startsWith(type)) throw fail(415, `expected ${type}`)
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > limit * 2) { req.destroy(); throw fail(413, 'too large') }
      if (size <= limit) chunks.push(c)
    }
    if (size > limit) throw fail(413, `too large (${Math.round(limit / 1024 / 1024)} MB max)`)
    return Buffer.concat(chunks)
  }

  async function readJson (req) {
    const body = await readBody(req, 'application/json', MAX_BODY)
    try { return JSON.parse(body.toString('utf8')) ?? {} } catch { throw fail(400, 'invalid JSON') }
  }

  const server = createServer(async (req, res) => {
    try {
      const { port } = server.address()
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 421, { error: 'unexpected Host header' })
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      const p = url.pathname
      if (req.method === 'GET') {
        if (p === '/api/state') {
          const user = await github(repo).user().catch(() => null)
          return send(res, 200, { repo, gh: { signedIn: !!user, user }, qvac: !!loadSdk, model, explainer: status.model })
        }
        if (p === '/api/runs') return send(res, 200, await recent(url.searchParams.get('repo')?.trim() || repo))
        const md = /^\/api\/report\/([0-9a-f-]{36})\.md$/.exec(p)
        if (md) {
          const entry = results.get(md[1])
          if (!entry) return send(res, 404, { error: 'That diagnosis has expired.' })
          const body = renderMarkdown(entry.diagnosis, { run: entry.run, context: entry.context, explanation: entry.explanation ?? null })
          return send(res, 200, body, 'text/markdown; charset=utf-8', { 'content-disposition': `attachment; filename="ci-doctor-${entry.run?.databaseId ?? 'log'}.md"` })
        }
        if (!p.startsWith('/api/')) return await staticFile(res, p)
      }
      if (req.method === 'POST') {
        notClosing()
        if (p === '/api/diagnose') return send(res, 200, await diagnoseRef(await readJson(req)))
        if (p === '/api/log') {
          const text = (await readBody(req, 'text/plain', MAX_LOG)).toString('utf8')
          if (!text.trim()) throw fail(400, 'Paste or drop a log first.')
          return send(res, 200, view(remember({ run: null, diagnosis: diagnose(text), context: {}, repo: null })))
        }
        if (p === '/api/explain') return await explain(req, res)
        if (p === '/api/comment') return send(res, 200, await comment(await readJson(req)))
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (res.headersSent) return res.end()
      if (!err.status) log(`error: ${err.stack ?? err.message}`)
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' })
    }
  })

  return {
    server,
    listen (port = 4500) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
      })
    },
    async close () {
      closing = true
      await explaining
      const m = await explainer?.catch(() => null)
      if (m) await m.sdk.unloadModel({ modelId: m.modelId, clearStorage: false }).catch(() => {})
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
