#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  diagnose, diagnoseRun, exitCodeFor, renderText, renderMarkdown, renderJson, GitHub,
  explainWithLlm, loadExplainer, describeFit, ModelTooLargeError, evaluate
} from '../src/index.js'

const HELP = `ci-doctor: find out why CI failed

Usage:
  ci-doctor run <run-id | run URL>     diagnose a GitHub Actions run
  ci-doctor latest                     diagnose the latest failed run
  ci-doctor log <file | ->             diagnose a log file (or stdin), no GitHub needed
  ci-doctor eval <dir>                 score ci-doctor against logs with known answers
  ci-doctor ui [--port 4500]           open the web UI (runs, pasted logs, explanations)

Options:
  -R, --repo <owner/name>   repository (default: the one you're in)
  --branch <name>           with latest: only runs on this branch
  --workflow <name|file>    with latest: only this workflow
  --comment                 post (or update) the diagnosis as a PR comment, or a commit comment
  --markdown                print Markdown instead of text
  --json                    print JSON
  --explain                 add a plain-words explanation from a local QVAC model
  --model <const>           QVAC model for --explain (default QWEN3_1_7B_INST_Q4)
  --force                   load the model even if the memory check says it won't fit
  --no-context              skip the PR, diff and default-branch lookups
  --min <0..1>              with eval: exit 1 if root-cause accuracy is below this
  --exit-zero               always exit 0 (for workflows that only report)

Exit code: 0 nothing failed · 1 worth a rerun (likely or possibly flaky) · 2 real failure · 3 cause unclear.
Needs the GitHub CLI (gh) for run/latest. In GitHub Actions, set GH_TOKEN.
`

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', short: 'R' },
    branch: { type: 'string' },
    workflow: { type: 'string' },
    comment: { type: 'boolean' },
    markdown: { type: 'boolean' },
    json: { type: 'boolean' },
    explain: { type: 'boolean' },
    model: { type: 'string' },
    force: { type: 'boolean' },
    'no-context': { type: 'boolean' },
    min: { type: 'string' },
    'exit-zero': { type: 'boolean' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }
  }
})

const say = (s) => process.stderr.write(s)
// Results go to stdout; anything else that prints (like the QVAC SDK's own logs) goes to stderr,
// so `--json` and `--markdown` stay clean when piped.
const RESULT_FD = process.env.CI_DOCTOR_RESULT_FD ? Number(process.env.CI_DOCTOR_RESULT_FD) : null
const print = (s) => RESULT_FD ? writeSync(RESULT_FD, s + '\n') : process.stdout.write(s + '\n')
console.log = console.info = console.debug = (...a) => process.stderr.write(a.join(' ') + '\n')
process.env.QVAC_CONFIG_PATH ??= fileURLToPath(new URL('../qvac.config.json', import.meta.url))

// The QVAC worker process inherits our stdout and logs to it, which would corrupt --json or
// --markdown. So in that case, run again as a child: results come back on fd 3 and go to our
// stdout, while everything the child (and the worker) prints goes to stderr.
if (v.explain && (v.json || v.markdown) && !RESULT_FD) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'inherit', 'pipe'],
    env: { ...process.env, CI_DOCTOR_RESULT_FD: '3' }
  })
  child.stdio[1].pipe(process.stderr)
  child.stdio[3].pipe(process.stdout)
  await new Promise((resolve) => child.on('close', (code) => { process.exitCode = code ?? 3; resolve() }))
  process.stdout.write('', () => process.exit(process.exitCode))
  await new Promise(() => {})
}

async function loadModel () {
  const sdk = await import('@qvac/sdk').catch(() => { throw new Error('--explain needs @qvac/sdk: npm install @qvac/sdk') })
  say('▸ loading the local explanation model…\n')
  try {
    const modelId = await loadExplainer(sdk, {
      model: v.model,
      force: v.force,
      onFit: (fit) => { for (const l of describeFit(fit)) say(`▸ memory check: ${l}\n`) },
      onProgress: (p) => say(`\r▸ downloading ${Math.floor(p.percentage ?? 0)}%   `)
    })
    say('\r\x1b[K')
    return { sdk, modelId }
  } catch (err) {
    if (!(err instanceof ModelTooLargeError)) throw err
    say(`⚠ ${err.message}\n▸ continuing without the explanation\n`)
    return null
  }
}

async function output ({ diagnosis, run = null, context = {} }, model) {
  let explanation = null
  if (model && diagnosis.causes.length) {
    say('▸ explaining…\n')
    explanation = await explainWithLlm({ ...model, diagnosis, context })
  }
  const opts = { run, context, explanation }
  if (v.json) print(JSON.stringify(renderJson(diagnosis, opts), null, 2))
  else if (v.markdown) print(renderMarkdown(diagnosis, opts))
  else print(renderText(diagnosis, opts))

  if (process.env.GITHUB_STEP_SUMMARY && run) await appendFile(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(diagnosis, opts) + '\n')
  if (v.comment && run && diagnosis.verdict !== 'passed') {
    const gh = new GitHub({ repo: v.repo ?? null })
    if (!v.repo) gh.repo = new URL(run.url).pathname.split('/').slice(1, 3).join('/')
    await gh.upsertComment({ pr: context.pr ?? null, sha: run.headSha }, renderMarkdown(diagnosis, opts))
    say(`▸ posted the diagnosis on ${context.pr ? `PR #${context.pr}` : `commit ${run.headSha.slice(0, 7)}`}\n`)
  }
  return diagnosis.verdict
}

async function ui () {
  const { createUiServer } = await import('../src/ui-server.js')
  // Import the SDK first: importing it registers SIGINT/SIGTERM handlers,
  // which are replaced below so Ctrl+C unloads the model and exits cleanly.
  let sdk = null
  try { sdk = await import('@qvac/sdk') } catch { say('▸ @qvac/sdk isn\'t installed: diagnoses work, plain-words explanations are off\n') }
  const repo = v.repo ?? await new GitHub().resolveRepo().catch(() => null)
  const server = createUiServer({ loadSdk: sdk ? async () => sdk : undefined, repo, model: v.model, log: (l) => say(`▸ ${l}\n`) })
  const url = await server.listen(Number(v.port ?? 4500))
  say(`CI Doctor: ${url}${repo ? `  (repository ${repo})` : ''}  Ctrl+C to stop\n`)
  if (!v['no-open']) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  }
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  let stopping = false
  const stop = async () => {
    if (stopping) process.exit(130)
    stopping = true
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return new Promise(() => {})
}

async function main () {
  const [cmd, arg] = positionals
  if (v.help || !cmd) { print(HELP); return 0 }
  if (cmd === 'ui') return ui()
  const model = v.explain ? await loadModel() : null
  try {
    if (cmd === 'log') {
      const raw = arg && arg !== '-' ? await readFile(arg, 'utf8') : await new Response(process.stdin).text()
      return exitCodeFor(await output({ diagnosis: diagnose(raw) }, model))
    }
    if (cmd === 'run' || cmd === 'latest') {
      let ref = arg
      if (cmd === 'latest') {
        ref = await new GitHub({ repo: v.repo ?? null }).latestFailedRun({ branch: v.branch, workflow: v.workflow })
        if (!ref) { say('No failed runs found.\n'); return 0 }
      }
      if (!ref) throw new Error('Usage: ci-doctor run <run-id | run URL>')
      say(`▸ reading run ${ref}…\n`)
      const result = await diagnoseRun({ ref, repo: v.repo ?? null, context: !v['no-context'] })
      return exitCodeFor(await output(result, model))
    }
    if (cmd === 'eval') {
      if (!arg) throw new Error('Usage: ci-doctor eval <dir>')
      const { results, summary } = await evaluate(arg, model ? { explain: (d) => explainWithLlm({ ...model, diagnosis: d }) } : {})
      if (v.json) print(JSON.stringify({ summary, results }, null, 2))
      else {
        for (const r of results) {
          const why = r.pass ? '' : `  expected ${Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k).join(', ')} · got ${r.got.verdict} / ${r.got.root}`
          const ex = r.explanation ? `  [model: ${r.explanation.accepted ? 'accepted' : `rejected, ${r.explanation.reason}`}]` : ''
          print(`${r.pass ? '✔' : '✖'} ${r.name}${why}${ex}`)
        }
        const pct = (x) => `${Math.round(x * 100)}%`
        print(`\n${summary.passed}/${summary.cases} cases right · verdict ${pct(summary.verdictAccuracy)} · root cause ${pct(summary.rootAccuracy)}`)
        if ('explanationsAccepted' in summary) print(`model explanations accepted: ${pct(summary.explanationsAccepted)} · average ${summary.explanationMs} ms`)
      }
      const min = v.min ? Number(v.min) : null
      return min !== null && summary.rootAccuracy < min ? 1 : 0
    }
    throw new Error(`Unknown command: ${cmd}\n\n${HELP}`)
  } finally {
    if (model) await model.sdk.unloadModel({ modelId: model.modelId, clearStorage: false }).catch(() => {})
  }
}

// Exit only once stdout has drained: process.exit() can cut off output that is still going into a pipe.
const exit = (code) => process.stdout.write('', () => process.exit(v['exit-zero'] ? 0 : code))
main().then(exit, (err) => {
  say(`✖ ${err.message}\n`)
  exit(3)
})
