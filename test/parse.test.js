import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLog, clean, body } from '../src/parse.js'

test('reads gh --log-failed lines: job, step, timestamp, BOM', () => {
  const raw = 'Test / linux\tRun tests\t﻿2026-11-05T09:16:50.1Z ##[group]Run npm test\nTest / linux\tUNKNOWN STEP\t2026-11-05T09:16:51.1Z not ok 1 - adds\n'
  const lines = parseLog(raw)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => l.n), [1, 2])
  assert.equal(lines[0].job, 'Test / linux')
  assert.equal(lines[0].step, 'Run tests')
  assert.equal(lines[1].step, null, 'UNKNOWN STEP is treated as no step name')
  assert.equal(lines[1].command, 'npm test', 'the open "Run" group gives the command')
  assert.equal(lines[1].text, 'not ok 1 - adds')
})

test('reads raw job logs and plain text', () => {
  assert.equal(parseLog('2026-11-05T09:16:50.1234567Z hello')[0].text, 'hello')
  const plain = parseLog('npm test\n✖ adds (1ms)')
  assert.equal(plain[1].text, '✖ adds (1ms)')
  assert.equal(plain[1].job, null)
})

test('strips colour codes in both escape and caret form', () => {
  assert.equal(clean('\u001b[31mred\u001b[39m'), 'red')
  assert.equal(clean('^[[36;1mnpm test^[[0m'), 'npm test')
})

test('body() removes ##[error] and process prefixes but keeps log levels', () => {
  assert.equal(body('##[error]boom'), 'boom')
  assert.equal(body('[TEST] FAIL x.test.js'), 'FAIL x.test.js')
  assert.equal(body('[warn] test/purge.js'), '[warn] test/purge.js')
})

test('a nested group is a section, not a new step', () => {
  const lines = parseLog('##[group]Run make test\n##[group]SDK checks - sdk\nnpm error code ETARGET\n##[endgroup]\nlater')
  assert.equal(lines[2].command, 'make test')
  assert.equal(lines[2].section, 'SDK checks - sdk')
  assert.equal(lines[4].section, null)
})
