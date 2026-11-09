import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUiServer } from '../src/ui-server.js'

const METRO = fileURLToPath(new URL('./fixtures/metro-unresolved.log', import.meta.url))

function call (url, { method = 'GET', body, headers = {} } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
const post = (url, obj) => call(url, { method: 'POST', body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } })

/** A stand-in for the GitHub CLI wrapper: one failed run whose log is a real fixture. */
function fakeGitHub (log, posted) {
  return (repo) => ({
    repo,
    user: async () => 'octo',
    recentFailures: async () => [{ databaseId: 42, displayTitle: 'Mobile: app icon', workflowName: 'CI', headBranch: 'icon', event: 'pull_request', createdAt: '2026-11-09T09:00:00Z', url: 'https://github.com/o/r/actions/runs/42', number: 7 }],
    run: async (id) => ({ databaseId: Number(id), url: `https://github.com/o/r/actions/runs/${id}`, workflowName: 'CI', headSha: 'abc1234def', headBranch: 'icon', status: 'completed', conclusion: 'failure', attempt: 1, jobs: [] }),
    failedLog: async () => log,
    annotations: async () => [],
    pullRequestFor: async () => 12,
    changedFiles: async () => ({ files: ['mobile/package.json'], base: 'PR #12' }),
    defaultBranchStatus: async () => null,
    upsertComment: async (target, body) => { posted.push({ target, body }); return { html_url: 'https://github.com/o/r/pull/12#issuecomment-1' } }
  })
}

function fakeSdk () {
  return {
    QWEN3_1_7B_INST_Q4: { name: 'qwen' },
    loadModel: async () => 'm1',
    unloadModel: async () => {},
    completion: () => ({
      events: (async function * () {
        yield { type: 'contentDelta', text: '{"cause": "The bundler could not resolve a module that a dependency imports.", ' }
        yield { type: 'contentDelta', text: '"fix": "Pin the dependency to the version the framework expects.", "evidence": ["E4"]}' }
      })()
    })
  }
}

async function withServer (t, opts, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cid-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const uiDir = join(dir, 'dist')
  await mkdir(join(uiDir, 'assets'), { recursive: true })
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>CI Doctor</title><script type="module" src="/assets/app.js"></script>')
  await writeFile(join(dir, 'secret.txt'), 'not for the browser')
  const ui = createUiServer({ uiDir, repo: 'o/r', ...opts })
  const url = await ui.listen(0)
  try { await fn(url) } finally { await ui.close() }
}

test('serves the build with a strict CSP, only to local, JSON or text requests', async (t) => {
  await withServer(t, { github: fakeGitHub('', []) }, async (url) => {
    const page = await call(url)
    assert.equal(page.status, 200)
    assert.match(page.headers['content-security-policy'], /script-src 'self';/)
    for (const p of ['../secret.txt', '..%2Fsecret.txt']) assert.ok([400, 404].includes((await call(url + p)).status))
    assert.equal((await call(url + 'api/state', { headers: { host: 'evil.example' } })).status, 421)
    const form = await call(url + 'api/diagnose', { method: 'POST', body: 'ref=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    assert.equal(form.status, 415)
  })
})

test('diagnoses a run end to end, explains it with the local model, and posts only when asked', async (t) => {
  const log = await readFile(METRO, 'utf8')
  const posted = []
  await withServer(t, { github: fakeGitHub(log, posted), loadSdk: async () => fakeSdk() }, async (url) => {
    const state = (await call(url + 'api/state')).json()
    assert.deepEqual(state.gh, { signedIn: true, user: 'octo' })
    assert.equal(state.qvac, true)

    const runs = (await call(url + 'api/runs?repo=o/r')).json()
    assert.equal(runs[0].id, 42)
    assert.equal((await call(url + 'api/runs?repo=not a repo')).status, 400)

    assert.equal((await post(url + 'api/diagnose', { ref: 'not a run' })).status, 400)
    const d = (await post(url + 'api/diagnose', { ref: 'https://github.com/o/r/actions/runs/42' })).json()
    assert.equal(d.verdict, 'failure')
    assert.equal(d.exitCode, 2)
    assert.equal(d.headline, 'Real failure: needs a fix')
    assert.equal(d.causes[0].id, 'bundler-unresolved')
    assert.match(d.causes[0].detail, /Imported by expo-asset/)
    assert.ok(d.evidence[0].some((l) => l.hit && /Unable to resolve module/.test(l.text)))
    assert.equal(d.pr, 12)
    assert.equal(posted.length, 0, 'nothing is posted without a request')

    // Explanation streams, and is only shown if it passes the checks.
    const ex = await post(url + 'api/explain', { id: d.id })
    const events = ex.body.trim().split('\n').map((l) => JSON.parse(l))
    const result = events.find((e) => e.type === 'result').explanation
    assert.equal(result.accepted, true, JSON.stringify(result))
    assert.ok(result.evidence.length)
    assert.ok(events.some((e) => e.type === 'delta'))

    const md = await call(url + `api/report/${d.id}.md`)
    assert.match(md.headers['content-disposition'], /ci-doctor-42\.md/)
    assert.match(md.body, /Metro can't resolve/)
    assert.match(md.body, /In plain words/)

    const c = (await post(url + 'api/comment', { id: d.id })).json()
    assert.equal(c.where, 'PR #12')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].target.pr, 12)
    assert.match(posted[0].body, /Metro can't resolve/)
    assert.equal((await post(url + 'api/comment', { id: '00000000-0000-0000-0000-000000000000' })).status, 404)
  })
})

test('a pasted log is diagnosed without GitHub, and has nothing to post', async (t) => {
  await withServer(t, { github: fakeGitHub('', []) }, async (url) => {
    const log = await readFile(METRO, 'utf8')
    const d = (await call(url + 'api/log', { method: 'POST', body: log, headers: { 'content-type': 'text/plain' } })).json()
    assert.equal(d.verdict, 'failure')
    assert.equal(d.run, null)
    assert.equal((await post(url + 'api/comment', { id: d.id })).status, 409)
    assert.equal((await call(url + 'api/log', { method: 'POST', body: '  ', headers: { 'content-type': 'text/plain' } })).status, 400)
    // No QVAC in this session: explanations say so instead of failing oddly.
    const ex = await post(url + 'api/explain', { id: d.id })
    assert.match(ex.body, /QVAC isn't available/)
  })
})
