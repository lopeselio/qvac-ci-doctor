import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitHub, parseRunRef, MARKER, LogsUnavailableError } from '../src/github.js'
import { diagnoseRun } from '../src/doctor.js'
import { matrixSiblings, matrixNote, touchedByChange, splitJobName } from '../src/context.js'

/** A fake `gh`: answers by matching the joined arguments, and records every call. */
function fakeGh (routes) {
  const calls = []
  const exec = async (args, { input } = {}) => {
    const cmd = args.join(' ')
    calls.push({ cmd, input })
    for (const [re, out] of routes) {
      if (re.test(cmd)) {
        if (out instanceof Error) throw out
        return typeof out === 'string' ? out : JSON.stringify(out)
      }
    }
    throw new Error(`unexpected gh call: ${cmd}`)
  }
  return { exec, calls }
}

const RUN = {
  databaseId: 7,
  workflowName: 'CI',
  workflowDatabaseId: 99,
  headSha: 'abc1234def',
  headBranch: 'fix-x',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/o/r/actions/runs/7',
  attempt: 1,
  jobs: [
    { name: 'test (ubuntu-latest)', conclusion: 'failure', databaseId: 1, steps: [{ name: 'npm test', conclusion: 'failure' }] },
    { name: 'test (macos-latest)', conclusion: 'success', databaseId: 2, steps: [] }
  ]
}
const LOG = 'test (ubuntu-latest)\tnpm test\t2026-11-05T09:00:00.0Z Error [ERR_MODULE_NOT_FOUND]: Cannot find module \'/home/runner/work/r/r/lib/Util.js\' imported from /home/runner/work/r/r/index.js'

test('run references: ids and URLs', () => {
  assert.deepEqual(parseRunRef('123'), { id: '123', repo: null })
  assert.deepEqual(parseRunRef('https://github.com/tetherto/qvac/actions/runs/42001014530/job/5'), { id: '42001014530', repo: 'tetherto/qvac' })
  assert.throws(() => parseRunRef('nope'), /Not a run id/)
})

test('diagnoseRun adds matrix, PR files and default-branch context', async () => {
  const { exec } = fakeGh([
    [/^run view 7 -R o\/r --json/, RUN],
    [/^run view 7 -R o\/r --log-failed/, LOG],
    [/^api repos\/o\/r\/commits\/abc1234def\/pulls/, [{ number: 12, state: 'open' }]],
    [/^pr view 12 -R o\/r --json files/, { files: [{ path: 'lib/Util.js' }, { path: 'index.js' }] }],
    [/^repo view o\/r --json defaultBranchRef/, { defaultBranchRef: { name: 'main' } }],
    [/^run list -R o\/r --workflow 99 --branch main/, [{ status: 'completed', conclusion: 'success', url: 'u', createdAt: '2026-11-04T10:00:00Z' }]]
  ])
  const { diagnosis, context } = await diagnoseRun({ ref: 'https://github.com/o/r/actions/runs/7', gh: new GitHub({ exec }) })
  assert.equal(diagnosis.causes[0].finding.id, 'module-not-found')
  assert.equal(context.pr, 12)
  assert.match(context.matrix.text, /Fails on ubuntu-latest; passes on macos-latest/)
  assert.match(context.matrix.hint, /case-sensitive/)
  assert.deepEqual(context.touched.map((t) => t.file), ['index.js'])
  assert.equal(context.defaultBranch.date, '2026-11-04')
})

test('expired logs fall back to the failing step and annotations', async () => {
  const { exec } = fakeGh([
    [/^run view 7 --json/, RUN],
    [/--log-failed/, new Error('failed to get run log: HTTP 410: Server Error')],
    [/^repo view --json nameWithOwner/, 'o/r\n'],
    [/^api repos\/o\/r\/check-runs\/1\/annotations/, [{ annotation_level: 'failure', message: 'Process completed with exit code 2.' }]]
  ])
  const { diagnosis, context } = await diagnoseRun({ ref: '7', gh: new GitHub({ exec }), context: false })
  assert.match(context.logsExpired, /deleted this run's logs/)
  assert.equal(diagnosis.verdict, 'unknown')
  assert.match(diagnosis.causes[0].finding.title, /npm test/)
})

test('other gh errors are not mistaken for expired logs', async () => {
  const gh = new GitHub({ repo: 'o/r', exec: async () => { throw new Error('HTTP 401: Bad credentials') } })
  await assert.rejects(gh.failedLog(7), (e) => !(e instanceof LogsUnavailableError) && /401/.test(e.message))
})

test('a passing run is reported as passed without reading logs', async () => {
  const { exec, calls } = fakeGh([[/^run view 7 -R o\/r --json/, { ...RUN, conclusion: 'success' }]])
  const { diagnosis } = await diagnoseRun({ ref: '7', repo: 'o/r', gh: new GitHub({ repo: 'o/r', exec }) })
  assert.equal(diagnosis.verdict, 'passed')
  assert.equal(calls.length, 1)
})

test('the PR comment is updated in place, not duplicated', async () => {
  const { exec, calls } = fakeGh([
    [/issues\/12\/comments -q/, '555\n'],
    [/-X PATCH repos\/o\/r\/issues\/comments\/555/, { id: 555 }]
  ])
  await new GitHub({ repo: 'o/r', exec }).upsertComment({ pr: 12 }, `${MARKER}\nhello`)
  const patch = calls.find((c) => /PATCH/.test(c.cmd))
  assert.equal(JSON.parse(patch.input).body, `${MARKER}\nhello`)
  assert.ok(!calls.some((c) => /-X POST/.test(c.cmd)))
})

test('a first comment is created; without a PR it goes on the commit', async () => {
  const a = fakeGh([[/issues\/12\/comments -q/, ''], [/-X POST repos\/o\/r\/issues\/12\/comments/, { id: 1 }]])
  await new GitHub({ repo: 'o/r', exec: a.exec }).upsertComment({ pr: 12 }, 'x')
  assert.ok(a.calls.some((c) => /-X POST repos\/o\/r\/issues\/12\/comments/.test(c.cmd)))
  const b = fakeGh([[/-X POST repos\/o\/r\/commits\/abc\/comments/, { id: 2 }]])
  await new GitHub({ repo: 'o/r', exec: b.exec }).upsertComment({ pr: null, sha: 'abc' }, 'x')
  assert.equal(b.calls.length, 1)
})

test('job names split into a base and a matrix variant', () => {
  assert.deepEqual(splitJobName('build (ubuntu-latest, 22)'), { base: 'build', variant: 'ubuntu-latest, 22' })
  assert.deepEqual(splitJobName('Test / linux'), { base: 'Test', variant: 'linux' })
  assert.deepEqual(splitJobName('lint'), { base: 'lint', variant: null })
  const sib = matrixSiblings([{ name: 'Test / linux', conclusion: 'failure' }, { name: 'Test / mac', conclusion: 'success' }])
  assert.equal(matrixNote({ category: 'test' }, sib.get('Test / linux')).text, 'Fails on linux; passes on mac.')
})

test('a dependency error is linked to an edited package.json', () => {
  const hits = touchedByChange([{ category: 'dependency', file: null, detail: '' }], ['packages/a/package.json', 'README.md'])
  assert.deepEqual(hits.map((h) => [h.file, h.why]), [['packages/a/package.json', 'deps']])
})
