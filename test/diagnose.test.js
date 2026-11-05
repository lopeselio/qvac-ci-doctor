import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { diagnose, exitCodeFor } from '../src/diagnose.js'
import { evaluate } from '../src/evaluate.js'
import { normalizePath } from '../src/detectors.js'

const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url))
const gh = (job, rows) => rows.map((r) => `${job}\tUNKNOWN STEP\t2026-11-05T09:00:00.0000000Z ${r}`).join('\n')

test('every labelled fixture gets the right verdict and root cause', async () => {
  const { results, summary } = await evaluate(fixtures)
  const wrong = results.filter((r) => !r.pass).map((r) => `${r.name}: ${JSON.stringify(r.checks)} got ${JSON.stringify(r.got)}`)
  assert.deepEqual(wrong, [])
  assert.ok(summary.cases >= 18)
})

test('the first real error is the root; later failures are follow-ons', () => {
  const d = diagnose(gh('checks', [
    'npm error code ETARGET',
    'npm error notarget No matching version found for @acme/core@^2.0.0.',
    'src/index.ts(1,10): error TS2305: Module \'"@acme/core"\' has no exported member \'X\'.',
    'not ok 1 - builds',
    '##[error]Process completed with exit code 1.'
  ]))
  assert.equal(d.causes.length, 1)
  assert.equal(d.causes[0].finding.id, 'npm-version-missing')
  assert.deepEqual(d.jobs[0].others.map((f) => f.id), ['typescript', 'test-failed', 'exit-code'])
})

test('the same cause in several matrix jobs is one cause', () => {
  const rows = ['npm error code ERESOLVE', 'npm error While resolving: app@1.0.0', 'npm error Could not resolve dependency:', 'npm error peer react@"^18" from w@1.0.0']
  const d = diagnose([gh('build (20)', rows), gh('build (22)', rows), gh('build (24)', rows)].join('\n'))
  assert.equal(d.causes.length, 1)
  assert.deepEqual(d.causes[0].jobs, ['build (20)', 'build (22)', 'build (24)'])
})

test('a timeout that hits three jobs the same way is not called flaky', () => {
  const rows = ['  1) suite', '       waits for the server:', '     Error: Timeout of 2000ms exceeded.', '', '  1 failing', '', '  1) suite', '       waits for the server:', '     Error: Timeout of 2000ms exceeded. For async tests ensure done() is called']
  const one = diagnose(gh('test (win, 20)', rows))
  assert.equal(one.verdict, 'maybe-flaky')
  const three = diagnose(['20', '22', '24'].map((v) => gh(`test (win, ${v})`, rows)).join('\n'))
  assert.equal(three.verdict, 'failure')
  assert.match(three.causes[0].finding.detail, /same way in 3 jobs/)
})

test('network trouble is flaky; a passing test named after a network error is not', () => {
  assert.equal(diagnose(gh('b', ['npm error code ECONNRESET', 'npm error network aborted'])).verdict, 'flaky')
  const d = diagnose(gh('b', ['✔ download will retry on ECONNRESET (15ms)', '##[error]Process completed with exit code 1.']))
  assert.equal(d.causes[0].finding.id, 'exit-code')
  assert.equal(d.verdict, 'unknown')
})

test('exit codes map to verdicts', () => {
  assert.equal(exitCodeFor('passed'), 0)
  assert.equal(exitCodeFor('flaky'), 1)
  assert.equal(exitCodeFor('maybe-flaky'), 1)
  assert.equal(exitCodeFor('failure'), 2)
  assert.equal(exitCodeFor('unknown'), 3)
})

test('runner checkout paths are reduced to repository paths', () => {
  assert.equal(normalizePath('/home/runner/work/app/app/test/a.js'), 'test/a.js')
  assert.equal(normalizePath('D:\\a\\app\\app\\test\\a.js'), 'test/a.js')
  assert.equal(normalizePath('D:/a/app/app/test.js'), 'test.js')
  assert.equal(normalizePath('file:///home/runner/work/app/app/lib/x.js'), 'lib/x.js')
  assert.equal(normalizePath('./test/a.js'), 'test/a.js')
})

test('Jest names the test file and says where the error was thrown', () => {
  const d = diagnose(gh('t', [
    '  ● wallet › signs',
    '',
    '    The account has been disposed.',
    '',
    '      at Account.sign (src/account.js:212:13)',
    '      at Object.<anonymous> (tests/account.test.js:270:28)',
    'Tests: 1 failed, 1 total'
  ]))
  const f = d.causes[0].finding
  assert.equal(f.file, 'tests/account.test.js')
  assert.equal(f.line, 270)
  assert.match(f.detail, /Thrown at src\/account\.js:212/)
})

test('a sanitizer report in CTest points at the first frame in this repository', () => {
  const d = diagnose(gh('Test / linux', [
    '24/110 Test  #24: asset-directory.js ......***Failed    0.35 sec',
    '==9500==ERROR: AddressSanitizer: attempting free on address which was not malloc()-ed',
    '    #0 0xab in free /home/runner/work/llvm/llvm/compiler-rt/lib/asan/asan_malloc_linux.cpp:51:3',
    '    #1 0xab in uv_fs_scandir_next /home/runner/work/bare/bare/build/_deps/github+libuv+libuv-src/src/uv-common.c:784:5',
    '    #2 0xab in bare_runtime__list /home/runner/work/bare/bare/src/runtime.c:1397:24',
    '',
    'The following tests FAILED:',
    '\t 24 - asset-directory.js (Failed)'
  ]))
  const f = d.causes[0].finding
  assert.equal(f.file, 'src/runtime.c')
  assert.equal(f.line, 1397)
  assert.match(f.fix, /bare_runtime__list/)
})
