import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose } from '../src/diagnose.js'
import { packageOf } from '../src/detectors.js'

const gh = (job, rows) => rows.map((r) => `${job}\tUNKNOWN STEP\t2026-11-05T09:00:00.0000000Z ${r}`).join('\n')

test('bundler resolution errors are a real failure, blamed on the importing package', () => {
  const cases = [
    ['Error: Unable to resolve module expo/internal/bundle-origin from /home/runner/work/app/node_modules/expo-asset/build/AssetSources.js: not found', 'Metro', 'expo-asset'],
    ["Module not found: Error: Can't resolve 'stream' in '/home/runner/work/app/node_modules/@scope/lib/dist'", 'webpack', '@scope/lib'],
    ['[vite]: Rollup failed to resolve import "virtual:pwa" from "/home/runner/work/app/src/main.ts".', 'Vite', null],
    ['✘ [ERROR] Could not resolve "lodash-es"', 'esbuild', null]
  ]
  for (const [line, tool, pkg] of cases) {
    const d = diagnose(gh('build', ['##[group]Run npm run build', '##[endgroup]', line, '##[error]Process completed with exit code 1.']))
    assert.equal(d.verdict, 'failure', line)
    const root = d.causes[0].finding
    assert.equal(root.id, 'bundler-unresolved', line)
    assert.match(root.title, new RegExp(`^${tool} can't resolve`), line)
    if (pkg) assert.ok(root.detail.startsWith(`Imported by ${pkg} `), line)
  }
})

test('packageOf finds the package a node_modules path belongs to', () => {
  assert.equal(packageOf('/a/node_modules/expo-asset/build/x.js'), 'expo-asset')
  assert.equal(packageOf('/a/node_modules/@scope/pkg/dist'), '@scope/pkg')
  assert.equal(packageOf('/a/node_modules/x/node_modules/y/index.js'), 'y')
  assert.equal(packageOf('D:\\a\\app\\node_modules\\expo-asset\\build\\x.js'), 'expo-asset')
  assert.equal(packageOf('/a/src/main.ts'), null)
})
