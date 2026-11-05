import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diagnose } from '../src/diagnose.js'
import { renderMarkdown, renderText, renderJson, safe, code } from '../src/report.js'
import { MARKER } from '../src/github.js'

const bin = fileURLToPath(new URL('../bin/ci-doctor.js', import.meta.url))
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const d = diagnose([
  'build\tUNKNOWN STEP\t2026-11-05T09:00:00.0Z not ok 1 - pings @everyone <img src=x onerror=alert(1)> ```',
  'build\tUNKNOWN STEP\t2026-11-05T09:00:00.0Z ##[error]Process completed with exit code 1.'
].join('\n'))

test('Markdown carries the marker, and log text cannot ping people or inject HTML', () => {
  const md = renderMarkdown(d)
  assert.ok(md.startsWith(MARKER))
  const prose = md.replace(/(`{3,})text\n[\s\S]*?\n\1/g, '') // fenced log excerpts don't notify anyone
  assert.ok(!/(^|[^`])@everyone/.test(prose), 'mentions outside code blocks are wrapped in code')
  assert.ok(!prose.includes('<img'), 'HTML outside code blocks is escaped')
  assert.match(md, /<details><summary>Evidence: log line/)
})

test('evidence fences survive backticks inside the log', () => {
  const md = renderMarkdown(d)
  const fence = /\n(`{3,})text\n/.exec(md)[1]
  assert.ok(fence.length >= 4, 'fence is longer than the ``` in the log')
  assert.equal(code('a`b'), '`` a`b ``')
  assert.equal(safe('see @scope/pkg'), 'see `@scope/pkg`')
})

test('text and JSON reports name the verdict, cause and evidence', () => {
  assert.match(renderText(d), /^✖ Real failure/)
  const j = renderJson(d)
  assert.equal(j.verdict, 'failure')
  assert.equal(j.causes[0].id, 'test-failed')
  assert.deepEqual(j.causes[0].evidence, [1])
})

test('CLI: log command prints the diagnosis and exits with the verdict code', () => {
  const r = spawnSync(process.execPath, [bin, 'log', fixture('lockfile.log')], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stdout, /package-lock\.json is out of sync/)
  const flaky = spawnSync(process.execPath, [bin, 'log', fixture('network.log'), '--json'], { encoding: 'utf8' })
  assert.equal(flaky.status, 1)
  assert.equal(JSON.parse(flaky.stdout).verdict, 'flaky')
})

test('CLI: reads stdin, and --exit-zero always exits 0', () => {
  const r = spawnSync(process.execPath, [bin, 'log', '-', '--exit-zero'], { input: 'npm error code ECONNRESET\n', encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Likely flaky/)
})

test('CLI: eval scores the fixtures and honours --min', () => {
  const r = spawnSync(process.execPath, [bin, 'eval', fileURLToPath(new URL('./fixtures', import.meta.url)), '--min', '0.9'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /cases right · verdict 100% · root cause 100%/)
})
