// The in-browser build (VITE_STATIC=1, hosted on GitHub Pages): the same
// rules engine the CLI uses, running in this page. Logs never leave the
// browser. GitHub runs and local-model explanations need `ci-doctor ui`.
// @ts-expect-error untyped JS module shared with the CLI
import { diagnose } from '../../src/diagnose.js'
// @ts-expect-error untyped JS module shared with the CLI
import { diagnosisView } from '../../src/view.js'
// @ts-expect-error untyped JS module shared with the CLI
import { renderMarkdown } from '../../src/report.js'
import type { Diagnosis } from './api'
import metro from '../../test/fixtures/metro-unresolved.log?raw'
import etarget from '../../test/fixtures/npm-etarget-cascade.log?raw'
import network from '../../test/fixtures/network.log?raw'
import oom from '../../test/fixtures/oom.log?raw'
import nodeSpec from '../../test/fixtures/node-test-spec.log?raw'

/** Real CI logs (from the labelled fixtures) to try it with. */
export const EXAMPLES = [
  { name: 'Expo build: a dependency too new', log: metro },
  { name: 'npm: a version that isn\'t published yet', log: etarget },
  { name: 'Network hiccup during install', log: network },
  { name: 'Out of memory', log: oom },
  { name: 'node:test failure', log: nodeSpec }
]

const results = new Map<string, unknown>()
let next = 1

export function diagnoseHere (text: string): Diagnosis {
  const id = `local-${next++}`
  const entry = { run: null, diagnosis: diagnose(text), context: {}, repo: null }
  results.set(id, entry)
  return diagnosisView(id, entry) as Diagnosis
}

export function markdownHere (id: string): string {
  const entry = results.get(id) as { diagnosis: unknown } | undefined
  return entry ? renderMarkdown(entry.diagnosis, {}) : ''
}
