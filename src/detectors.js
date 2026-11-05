import { body } from './parse.js'

// Each detector reads parsed log lines and returns findings:
//
//   { id, category, title, detail, key, lines, job, command, file, line,
//     test, fix, priority, flaky }
//
// `lines` are original line numbers: the evidence for the finding.
// `claims` (optional) are every line the finding accounts for, when that's
// more than the evidence shown, so other detectors don't report them again.
// `priority` says how specific a finding is (higher = more likely to be the
// real cause). `flaky` is 'likely', 'possible' or 'no'.
// `key` identifies the same cause across jobs, so three matrix jobs failing
// for one reason are reported once.

const MAX_DETAIL = 6

/** Strip runner checkout prefixes so paths match the repository. */
export function normalizePath (p) {
  if (!p) return p
  return p
    .replace(/^file:\/\//, '')
    .replace(/^(?:\/home\/runner\/work|\/Users\/runner\/work)\/[^/]+\/[^/]+\//, '')
    .replace(/^[A-Z]:\\a\\[^\\]+\\[^\\]+\\/, '')
    .replace(/^[A-Z]:\/a\/[^/]+\/[^/]+\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

const LOCATION = /\(?((?:file:\/\/)?(?:[A-Za-z]:)?[^\s():'"]+\.(?:[cm]?[jt]sx?)):(\d+)(?::(\d+))?\)?/

/** First stack location that isn't inside node_modules or Node itself. */
export function firstOwnLocation (texts, { testsOnly = false } = {}) {
  for (const t of texts) {
    const m = LOCATION.exec(t)
    if (!m || /node_modules|node:internal|^node:/.test(m[1])) continue
    const file = normalizePath(m[1])
    if (testsOnly && !TEST_FILE.test(file)) continue
    return { file, line: Number(m[2]) }
  }
  return null
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/

function base (l, fields) {
  return { job: l.job, step: l.step, command: l.command, lines: [l.n], file: null, line: null, test: null, ...fields }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Sharpen a test failure's advice when its message points somewhere specific. */
function refineTest (f) {
  const refused = /connect ECONNREFUSED (?:127\.0\.0\.1|::1|localhost|0\.0\.0\.0):(\d+)/.exec(f.detail)
  if (refused) {
    f.fix = `The test couldn't connect to a local service on port ${refused[1]}: it wasn't started, or wasn't ready yet. Start it before the tests and wait until it accepts connections instead of a fixed sleep.`
  } else if (/\b(?:timed? ?out|Timeout of \d+|exceeded timeout)\b/i.test(f.detail)) {
    Object.assign(f, {
      id: 'test-timeout',
      category: 'timeout',
      title: f.title.replace(/^Test failed:/, 'Test timed out:'),
      fix: 'The test waited for something that never happened. If a rerun passes it\'s timing-dependent: wait for the event or state instead of a fixed delay. If it fails again, a promise or event in that test never resolves.',
      flaky: 'possible'
    })
  }
  return f
}

// ---------------------------------------------------------------- tests ---

/** TAP output: brittle (Holepunch), tape, node:test's TAP reporter. */
export function tap (lines) {
  const found = []
  let pending = [] // failing indented assertions waiting for their parent
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i].job !== lines[i - 1].job) pending = []
    const t = body(lines[i].text)
    const m = /^(\s*)(not ok|ok) \d+(?: -)? ?(.*?)(?: # time = [\d.]+m?s)?$/.exec(t)
    if (!m) continue
    const indent = m[1].length
    const title = m[3]
    if (/#\s*(TODO|SKIP)\b/i.test(title)) continue
    const yaml = m[2] === 'not ok' ? readYaml(lines, i + 1) : null
    if (indent > 0) {
      if (m[2] === 'not ok') pending.push({ l: lines[i], title, yaml })
      continue
    }
    if (m[2] === 'ok') { pending = []; continue }

    const asserts = pending
    pending = []
    const frames = [...asserts.map((a) => a.yaml?.at), yaml?.at].filter(Boolean).flatMap((x) => x.split('\n'))
    const loc = [...asserts.map((a) => a.yaml?.location), yaml?.location].find(Boolean)
    const where = firstOwnLocation(frames, { testsOnly: true }) ??
      (loc ? { file: normalizePath(loc.replace(/:\d+(:\d+)?$/, '')), line: Number(/:(\d+)(?::\d+)?$/.exec(loc)?.[1]) || null } : null) ??
      firstOwnLocation(frames)
    const details = (asserts.length ? asserts : [{ l: lines[i], title, yaml }]).slice(0, MAX_DETAIL).map(({ title: a, yaml: y }) => {
      const parts = [a]
      if (y?.error) parts.push(y.error)
      if (y && ('expected' in y || 'actual' in y)) parts.push(`expected ${y.expected ?? '?'}, got ${y.actual ?? '?'}`)
      return parts.join(': ')
    })
    found.push(refineTest(base(lines[i], {
      id: 'test-failed',
      category: 'test',
      title: `Test failed: ${title}`,
      detail: details.join('\n'),
      key: `test:${title}`,
      lines: [...asserts.map((a) => a.l.n), lines[i].n],
      file: where?.file ?? null,
      line: where?.line ?? null,
      test: title,
      fix: where?.file ? `Run this test locally (${where.file}${where.line ? `:${where.line}` : ''}) and compare the expected and actual values.` : 'Run this test locally and compare the expected and actual values.',
      priority: 80,
      flaky: 'no'
    })))
  }
  return found
}

/** Reads the YAML diagnostic block after a TAP "not ok" line. */
function readYaml (lines, from) {
  if (!/^\s*---$/.test(body(lines[from]?.text ?? ''))) return null
  const y = {}
  for (let j = from + 1; j < lines.length && j < from + 80; j++) {
    const t = body(lines[j].text)
    if (/^\s*\.\.\.$/.test(t)) break
    const kv = /^\s*(actual|expected|operator|error|message|location|at|stack|code|failureType):\s*(.*)$/.exec(t)
    if (kv && !(kv[1] in y)) {
      let v = kv[2].trim().replace(/^'(.*)'$/, '$1')
      if (/^[|>]-?$/.test(v)) {
        // Block scalar: every following line indented deeper than the key.
        const indent = /^\s*/.exec(t)[0].length
        const rows = []
        for (let k = j + 1; k < lines.length && k < j + 40; k++) {
          const r = body(lines[k].text)
          if (r.trim() && /^\s*/.exec(r)[0].length <= indent) break
          rows.push(r.trim())
        }
        v = kv[1] === 'stack' || kv[1] === 'at' ? rows.join('\n') : rows.find(Boolean) ?? ''
      }
      y[kv[1] === 'message' ? 'error' : kv[1] === 'stack' ? 'at' : kv[1]] = v
    }
  }
  if (y.failureType === 'subtestsFailed') return { ...y, container: true }
  return y
}

/** Jest and Vitest. */
export function jest (lines) {
  const found = []
  let suiteFile = null
  for (let i = 0; i < lines.length; i++) {
    const t = body(lines[i].text)
    const fail = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)(?:\s+\(.*\))?$/.exec(t)
    if (fail) { suiteFile = normalizePath(fail[1]); continue }

    // Jest: "● Suite › test"; Vitest: "FAIL  file > suite > test"
    const jm = /^\s*● (.+ › .+|[^ ].*)$/.exec(t)
    const vm = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?) > (.+)$/.exec(t)
    if (!jm && !vm) continue
    const name = vm ? vm[2].replace(/ > /g, ' › ') : jm[1]
    if (/^Console$|Cannot log after tests are done|Test suite failed to run/.test(name) && !vm) {
      if (/Test suite failed to run/.test(name)) found.push(...suiteFailed(lines, i, suiteFile))
      continue
    }
    const block = []
    let j = i + 1
    for (; j < lines.length && j < i + 60; j++) {
      const b = body(lines[j].text)
      if (/^\s*● /.test(b) || /^\s*(Test Suites|Tests):/.test(b) || /^\s*FAIL\s/.test(b)) break
      block.push({ n: lines[j].n, t: b })
    }
    const message = block.filter((b) => b.t.trim() && !/^\s*(at |❯ )/.test(b.t) && !/^\s*>?\s*\d+ \||^\s*\|/.test(b.t)).slice(0, 3)
    const frames = block.filter((b) => /^\s*(at |❯ )/.test(b.t)).map((b) => b.t)
    const thrown = firstOwnLocation(frames)
    const where = firstOwnLocation(frames, { testsOnly: true }) ?? thrown ?? (vm ? { file: normalizePath(vm[1]), line: null } : suiteFile ? { file: suiteFile, line: null } : null)
    if (thrown && where && thrown.file !== where.file) message.push({ n: null, t: `Thrown at ${thrown.file}:${thrown.line}` })
    found.push(refineTest(base(lines[i], {
      id: 'test-failed',
      category: 'test',
      title: `Test failed: ${name}`,
      detail: message.map((b) => b.t.trim()).join('\n').slice(0, 600),
      key: `test:${name}`,
      lines: [lines[i].n, ...message.map((b) => b.n).filter(Boolean)],
      file: where?.file ?? suiteFile,
      line: where?.line ?? null,
      test: name,
      fix: `Run ${where?.file ?? suiteFile ?? 'the failing test'} locally and look at the assertion message above.`,
      priority: 80,
      flaky: 'no'
    })))
  }
  return found
}

function suiteFailed (lines, i, suiteFile) {
  const msg = []
  for (let j = i + 1; j < lines.length && msg.length < 3 && j < i + 20; j++) {
    const b = body(lines[j].text).trim()
    if (b) msg.push({ n: lines[j].n, t: b })
  }
  return [base(lines[i], {
    id: 'suite-failed',
    category: 'test',
    title: `Test file failed to load${suiteFile ? `: ${suiteFile}` : ''}`,
    detail: msg.map((m) => m.t).join('\n'),
    key: `suite:${suiteFile ?? msg[0]?.t}`,
    lines: [lines[i].n, ...msg.map((m) => m.n)],
    file: suiteFile,
    fix: 'The test file crashed before any test ran: usually a failed import or a syntax/config error. Run it on its own to see the full error.',
    priority: 80,
    flaky: 'no'
  })]
}

/** node:test's default spec reporter ("✖ name (1.2ms)"). */
export function nodeSpec (lines) {
  const found = []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const t = body(lines[i].text)
    const m = /^(\s*)✖ (.+?) \([\d.]+m?s\)$/.exec(t)
    if (!m) continue
    // The same failure is printed inline and again in the "failing tests" summary; keep the one with an error.
    const nextBody = body(lines[i + 1]?.text ?? '')
    if (/^\s*[✖✔▶ℹ]/.test(nextBody) || !nextBody.trim()) {
      const later = lines.slice(i + 1).findIndex((l) => body(l.text).trim() === t.trim() && body(lines[lines.indexOf(l) + 1]?.text ?? '').trim() && !/^\s*[✖✔▶ℹ]/.test(body(lines[lines.indexOf(l) + 1]?.text ?? '')))
      if (later >= 0) continue
    }
    if (seen.has(m[2])) continue
    // Skip parents whose failure is only their subtests.
    const next = lines.slice(i + 1, i + 4).map((l) => body(l.text)).join('\n')
    if (/'?subtestsFailed'?|\d+ subtests? failed/.test(next)) continue
    seen.add(m[2])
    const block = []
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const b = body(lines[j].text)
      // The GitHub reporter prints the error as an annotation right after the test line.
      if (j === i + 1 && /^##\[error\]/.test(lines[j].text)) { block.push({ n: lines[j].n, t: b.replace(/^'(.*)'$/, '$1') }); continue }
      if (/^\s*[✖✔▶ℹ]/.test(b) || /^##\[/.test(lines[j].text)) break
      block.push({ n: lines[j].n, t: b })
    }
    const before = body(lines[i - 1]?.text ?? '')
    const at = /^\s*test at (\S+):(\d+):\d+/.exec(before)
    const message = block.filter((b) => b.t.trim() && !/^\s*at /.test(b.t) && !/^\s*(code|generatedMessage|operator|expected|actual|matcherResult):|^\s*[{}]\s*$/.test(b.t)).slice(0, 4)
    const where = at ? { file: normalizePath(at[1]), line: Number(at[2]) } : firstOwnLocation(block.filter((b) => /^\s*at /.test(b.t)).map((b) => b.t))
    found.push(refineTest(base(lines[i], {
      id: 'test-failed',
      category: 'test',
      title: `Test failed: ${m[2]}`,
      detail: message.map((b) => b.t.trim()).join('\n').slice(0, 600),
      key: `test:${m[2]}`,
      lines: [lines[i].n, ...message.map((b) => b.n)],
      file: where?.file ?? null,
      line: where?.line ?? null,
      test: m[2],
      fix: where?.file ? `Run node --test ${where.file} locally and compare expected and actual.` : 'Run the failing test locally and compare expected and actual.',
      priority: 80,
      flaky: 'no'
    })))
  }
  // Parent suites are printed with ✖ but no message; keep the tests that carry an error when there are any.
  const withMessage = found.filter((f) => f.detail)
  return withMessage.length ? withMessage : found
}

/** The test that was running at line i: brittle's "# name" header, or mocha's "name:" line just above. */
function runningTest (lines, i) {
  const prev = lines.slice(Math.max(0, i - 3), i).map((l) => body(l.text)).filter((x) => x.trim()).pop()
  if (prev && /^\s{2,}\S.*:$/.test(prev) && !/^\s*at /.test(prev)) return { n: null, t: prev.trim().replace(/:$/, '') }
  for (let j = i - 1; j >= 0 && j > i - 400; j--) {
    const h = /^# (?!tests|asserts|time|pass|fail|ok\b|not ok|Subtest)(.+)$/.exec(body(lines[j].text))
    if (h) return { n: lines[j].n, t: h[1] }
    if (/^(?:not )?ok \d+/.test(body(lines[j].text))) return null
  }
  return null
}

const TEST_TIMEOUT = /(?:Test timed out after (\d+) ?ms|Exceeded timeout of (\d+) ?ms for a (?:test|hook)|test timed out after (\d+)ms|Timeout of (\d+)ms exceeded)/i

/** A single test ran past its time limit. */
export function testTimeout (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const t = body(lines[i].text)
    const m = TEST_TIMEOUT.exec(t)
    if (!m || /^\s*(this\._onend|throw|at )/.test(t)) continue
    const ms = m[1] ?? m[2] ?? m[3] ?? m[4]
    const name = runningTest(lines, i)
    let lastOk = null
    for (let j = i - 1; j >= 0 && j > i - 400; j--) {
      const b = body(lines[j].text)
      const ok = /^\s+ok \d+ - (.+)$/.exec(b)
      if (ok) { lastOk = { n: lines[j].n, t: ok[1] }; break }
      if (/^# /.test(b)) break
    }
    found.push(base(lines[i], {
      id: 'test-timeout',
      category: 'timeout',
      title: `Test timed out after ${Number(ms) / 1000}s${name ? `: ${name.t}` : ''}`,
      detail: lastOk ? `Last passing check before it hung: "${lastOk.t}".` : '',
      key: `timeout:${name?.t ?? ms}`,
      lines: [name?.n, lastOk?.n, lines[i].n].filter(Boolean),
      test: name?.t ?? null,
      fix: `The test waited for something that never happened${lastOk ? ` after "${lastOk.t}"` : ''}. If a rerun passes it's timing-dependent: wait for the event or state instead of a fixed delay. If it fails again, a promise or event in that step never resolves.`,
      priority: 65,
      flaky: 'possible'
    }))
  }
  return found
}

// ---------------------------------------------------------- build / types ---

const TSC = /([\w./@\\-]+\.(?:[cm]?tsx?|json))(?:\((\d+),(\d+)\):?|:(\d+):(\d+) -) error (TS\d+): (.+)$/
const TS_HINT = [
  [/^TS510[0-9]$/, 'A compiler option in tsconfig was removed or renamed in the TypeScript version this run installed. Remove the option, or pin TypeScript to the version you use locally.'],
  [/^TS(2305|2307|2614|2724|2694)$/, "An import doesn't match what the package exports. Usually a dependency or workspace package is at a different version than the code expects, or wasn't built before this step."],
  [/^TS(2339|2353|2322|2345|2741|2554)$/, 'A type changed: either in this change or in a dependency that was upgraded. Check the listed lines against the current type definitions.']
]

/** tsc errors in both the plain and pretty formats; one finding per job. */
export function typescript (lines) {
  const byJob = new Map()
  for (const l of lines) {
    const m = TSC.exec(body(l.text))
    if (!m) continue
    const e = { n: l.n, l, file: normalizePath(m[1]), line: Number(m[2] ?? m[4]), col: Number(m[3] ?? m[5]), code: m[6], msg: m[7] }
    const k = l.job ?? ''
    if (!byJob.has(k)) byJob.set(k, { uniq: new Map(), all: [] })
    const { uniq, all } = byJob.get(k)
    all.push(l.n)
    const id = `${e.file}:${e.line}:${e.col}:${e.code}`
    if (!uniq.has(id)) uniq.set(id, e)
  }
  const found = []
  for (const { uniq, all } of byJob.values()) {
    const errs = [...uniq.values()]
    const first = errs[0]
    const files = new Set(errs.map((e) => e.file))
    const codes = [...new Set(errs.map((e) => e.code))]
    const hint = TS_HINT.find(([re]) => re.test(first.code))?.[1]
    found.push(base(first.l, {
      id: 'typescript',
      category: 'types',
      title: `TypeScript: ${plural(errs.length, 'error')} in ${plural(files.size, 'file')}`,
      detail: errs.slice(0, MAX_DETAIL).map((e) => `${e.file}(${e.line},${e.col}) ${e.code}: ${e.msg}`).join('\n') + (errs.length > MAX_DETAIL ? `\n… and ${errs.length - MAX_DETAIL} more` : ''),
      key: `tsc:${first.code}:${first.file}`,
      lines: errs.slice(0, MAX_DETAIL).map((e) => e.n),
      claims: all,
      file: first.file,
      line: first.line,
      fix: hint ?? `Run the typecheck locally and fix ${first.file}:${first.line} first; later errors often follow from it.`,
      codes,
      priority: 80,
      flaky: 'no'
    }))
  }
  return found
}

/** ESLint's stylish output and standard-style "file:line:col: message". */
export function lint (lines) {
  const byJob = new Map()
  let file = null
  for (const l of lines) {
    const t = body(l.text)
    const path = /^((?:\/|[A-Za-z]:\\)?[\w.@/\\-]+\.(?:[cm]?[jt]sx?|vue|svelte))$/.exec(t.trim())
    if (path && !/^\s/.test(t)) { file = normalizePath(path[1]); continue }
    let e = null
    const stylish = /^\s+(\d+):(\d+)\s+(error)\s+(.+?)\s{2,}(\S+)$/.exec(t)
    if (stylish && file) e = { file, line: Number(stylish[1]), msg: stylish[4], rule: stylish[5] }
    const std = /^\s*((?:\/|[A-Za-z]:\\)?[\w.@/\\-]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+): (.+?)(?: \(([\w@/-]+)\))?$/.exec(t)
    if (!e && std && !/ - error TS\d/.test(t)) e = { file: normalizePath(std[1]), line: Number(std[2]), msg: std[4], rule: std[5] ?? null }
    const lunte = /^\s*((?:\/|[A-Za-z]:\\)?[\w.@/\\-]+\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\s+ERROR(?: \(([\w@/-]+)\))?\s+(.+?)(?: \(\d+:\d+\))?(?: in \S+)?$/.exec(t)
    if (!e && lunte) e = { file: normalizePath(lunte[1]), line: Number(lunte[2]), msg: lunte[5], rule: lunte[4] ?? null }
    if (!e) continue
    const k = l.job ?? ''
    if (!byJob.has(k)) byJob.set(k, [])
    byJob.get(k).push({ ...e, n: l.n, l })
  }
  const found = []
  for (const errs of byJob.values()) {
    const first = errs[0]
    const files = new Set(errs.map((e) => e.file))
    found.push(base(first.l, {
      id: 'lint',
      category: 'lint',
      title: `Lint: ${plural(errs.length, 'error')} in ${plural(files.size, 'file')}`,
      detail: errs.slice(0, MAX_DETAIL).map((e) => `${e.file}:${e.line} ${e.msg}${e.rule ? ` (${e.rule})` : ''}`).join('\n'),
      key: `lint:${first.file}:${first.line}`,
      lines: errs.slice(0, MAX_DETAIL).map((e) => e.n),
      claims: errs.map((e) => e.n),
      file: first.file,
      line: first.line,
      fix: `Run the lint script locally${first.l.command ? ` (\`${first.l.command}\`)` : ''}; many rules fix themselves with --fix.`,
      priority: 75,
      flaky: 'no'
    }))
  }
  return found
}

/** Prettier --check. */
export function prettier (lines) {
  const found = []
  let files = []
  for (const l of lines) {
    const t = body(l.text)
    const w = /^\[warn\] (.+)$/.exec(t)
    if (w && !/Code style issues/.test(w[1])) { files.push({ n: l.n, f: normalizePath(w[1]) }); continue }
    if (/Code style issues (?:found|were found)/.test(t) && files.length) {
      found.push(base(l, {
        id: 'format',
        category: 'format',
        title: `Formatting: ${plural(files.length, 'file')} not formatted with Prettier`,
        detail: files.map((x) => x.f).join('\n'),
        key: `format:${files.map((x) => x.f).join(',')}`,
        lines: [...files.map((x) => x.n), l.n],
        file: files[0].f,
        fix: `Run \`npx prettier --write ${files.map((x) => x.f).join(' ')}\` and commit the result.`,
        priority: 75,
        flaky: 'no'
      }))
      files = []
    }
  }
  return found
}

// ------------------------------------------------------------ npm & deps ---

const NPM = /^npm (?:error|ERR!) ?(.*)$/

/** Groups each run of "npm error" lines and classifies it by error code. */
export function npm (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (!NPM.test(body(lines[i].text))) continue
    const block = []
    const job = lines[i].job
    while (i < lines.length && lines[i].job === job && NPM.test(body(lines[i].text))) {
      block.push({ n: lines[i].n, l: lines[i], t: NPM.exec(body(lines[i].text))[1] })
      i++
    }
    i-- // the outer loop's i++ would otherwise skip the line after this block
    const f = classifyNpm(block)
    if (f) found.push(f)
  }
  return found
}

function classifyNpm (block) {
  const all = block.map((b) => b.t).join('\n')
  const code = /^code (\S+)/m.exec(all)?.[1] ?? null
  const at = block[0].l
  const ev = (re) => block.filter((b) => re.test(b.t)).map((b) => b.n)
  const make = (fields) => base(at, { ...fields, lines: [...new Set([block[0].n, ...(fields.lines ?? [])])].sort((a, b) => a - b) })

  let m
  if (code === 'ETARGET' && (m = /No matching version found for (\S+?)(?:\.$| with a date before ([^\n]+?)\.?$)/m.exec(all))) {
    const spec = m[1]
    const name = spec.replace(/@[^@/]*$/, '')
    const before = m[2] ?? null
    if (before) {
      return make({
        id: 'npm-version-missing',
        category: 'dependency',
        title: `npm can't use ${spec}: no matching version old enough`,
        detail: `This install only accepts versions published before ${before} (npm's "before" / minimum release age setting), and no version of ${name} matching ${spec.slice(name.length + 1)} is that old.`,
        key: `etarget:${spec}`,
        lines: ev(/notarget|code ETARGET/),
        fix: `Wait until a matching ${name} version is old enough, relax the release-age setting for this package, or depend on an older range.`,
        priority: 90,
        flaky: 'no'
      })
    }
    return make({
      id: 'npm-version-missing',
      category: 'dependency',
      title: `npm can't find ${spec}`,
      detail: `No published version of ${name} matches ${spec.slice(name.length + 1)}.`,
      key: `etarget:${spec}`,
      lines: ev(/notarget|code ETARGET/),
      fix: `Check what's published with \`npm view ${name} versions\`. If this change is the release of ${name}, it was requested before it was published: publish first, or keep depending on the last published version until it is.`,
      priority: 90,
      flaky: 'no'
    })
  }
  if (/can only install packages when your package\.json and package-lock\.json[^\n]*in sync|Missing: \S+ from lock file|lockfile.*out of (?:date|sync)/i.test(all)) {
    const missing = [...all.matchAll(/Missing: (\S+) from lock file/g)].map((x) => x[1])
    return make({
      id: 'npm-lockfile',
      category: 'dependency',
      title: 'package-lock.json is out of sync with package.json',
      detail: missing.length ? `Missing from the lock file: ${missing.slice(0, MAX_DETAIL).join(', ')}` : '`npm ci` refuses to install when the two files disagree.',
      key: 'lockfile',
      lines: ev(/in sync|Missing:|lock file/i),
      fix: 'Run `npm install` locally with the same npm major version as CI, then commit package-lock.json.',
      priority: 90,
      flaky: 'no'
    })
  }
  if (code === 'EALLOWGIT') {
    const spec = /Refusing to fetch "([^"]+)"/.exec(all)?.[1] ?? null
    const name = spec?.split('@git')[0] ?? null
    return make({
      id: 'npm-git-dependency',
      category: 'dependency',
      title: `npm refused a git dependency${name ? `: ${name}` : ''}`,
      detail: spec ? `This npm won't fetch packages from git, and the tree needs ${spec}.` : "This npm won't fetch packages from git.",
      key: `allowgit:${name ?? ''}`,
      lines: ev(/git/i),
      fix: `Depend on a published version${name ? ` of ${name}` : ''} instead of a git URL, or allow git dependencies in this job's npm config.`,
      priority: 85,
      flaky: 'no'
    })
  }
  if (code === 'ERESOLVE') {
    return make({
      id: 'npm-peer-conflict',
      category: 'dependency',
      title: "npm couldn't resolve peer dependencies",
      detail: block.filter((b) => /While resolving|Found:|Could not resolve dependency|peer /.test(b.t)).slice(0, 4).map((b) => b.t.trim()).join('\n'),
      key: 'eresolve:' + (/Could not resolve dependency:\s*\n?.*?peer (\S+)/s.exec(all)?.[1] ?? ''),
      lines: ev(/While resolving|Found:|Could not resolve|peer /),
      fix: 'Align the conflicting versions in package.json. `--legacy-peer-deps` hides the conflict but doesn\'t fix it.',
      priority: 85,
      flaky: 'no'
    })
  }
  if (code === 'E404' && (m = /404 Not Found - GET (\S+)/.exec(all))) {
    const pkg = decodeURIComponent(m[1].replace(/^https?:\/\/[^/]+\//, '').replace(/ .*$/, ''))
    return make({
      id: 'npm-not-found',
      category: 'dependency',
      title: `npm package not found: ${pkg}`,
      detail: 'The registry returned 404. The name is wrong, the package was unpublished, or it is private and this job has no access.',
      key: `e404:${pkg}`,
      lines: ev(/404/),
      fix: `Check the name in package.json. If ${pkg} is private, give the job a token that can read it.`,
      priority: 85,
      flaky: 'no'
    })
  }
  if (/^(E401|E403|ENEEDAUTH|EOTP)$/.test(code ?? '')) {
    return make({
      id: 'npm-auth',
      category: 'auth',
      title: `npm authentication failed (${code})`,
      detail: block.slice(1, 3).map((b) => b.t).join('\n'),
      key: `npm-auth:${code}`,
      lines: ev(/auth|token|login|403|401|E4/i),
      fix: 'The npm token is missing, expired or lacks access. Check the secret used for NODE_AUTH_TOKEN / NPM_TOKEN.',
      priority: 85,
      flaky: 'no'
    })
  }
  if (/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ERR_SOCKET_TIMEOUT|ECONNREFUSED)$/.test(code ?? '') || /network (?:timeout|request)/i.test(all)) {
    return make({
      id: 'network',
      category: 'network',
      title: `npm hit a network error${code ? ` (${code})` : ''}`,
      detail: block.slice(0, 2).map((b) => b.t).join('\n'),
      key: `network:npm:${code}`,
      fix: 'A dropped connection to the registry. Rerun the job; if it keeps happening, add npm retries (`npm config set fetch-retries 5`).',
      priority: 60,
      flaky: 'likely'
    })
  }
  if (code === 'ENOSPC') return null // the runner detector reports this with better wording
  if (/^code (?:1|ELIFECYCLE)$|Lifecycle script|command failed/im.test(all)) {
    const script = /Lifecycle script `([^`]+)` failed|failed at the (\S+) script/.exec(all)
    return make({
      id: 'npm-script-failed',
      category: 'exit',
      title: `npm script failed${script ? `: ${script[1] ?? script[2]}` : ''}`,
      detail: 'npm reports the script failed; the reason is in its own output above.',
      key: `npm-script:${script?.[1] ?? script?.[2] ?? ''}`,
      fix: 'See the first error above this line.',
      priority: 20,
      flaky: 'no'
    })
  }
  return make({
    id: 'npm-error',
    category: 'dependency',
    title: `npm failed${code ? ` (${code})` : ''}`,
    detail: block.slice(0, 3).map((b) => b.t).join('\n'),
    key: `npm:${code}`,
    fix: 'Read the npm error above; the full npm debug log is not kept after the job ends.',
    priority: 50,
    flaky: 'no'
  })
}

/** Runtime "Cannot find module" (TypeScript's TS2307 is handled by `typescript`). */
export function moduleNotFound (lines) {
  const found = []
  for (const l of lines) {
    const t = body(l.text)
    if (/error TS\d+/.test(t)) continue
    const m = /Cannot find (?:module|package) '([^']+)'(?: imported from '?([^\s']+)'?)?/.exec(t)
    if (!m) continue
    const from = m[2] ? normalizePath(m[2]) : null
    found.push(base(l, {
      id: 'module-not-found',
      category: 'build',
      title: `Cannot find module ${normalizePath(m[1])}`,
      detail: from ? `Imported from ${from}.` : '',
      key: `module:${m[1]}`,
      file: from,
      fix: "Either it's missing from package.json, it wasn't built before this step, or the import path's case differs from the file (Linux runners are case-sensitive, macOS usually isn't).",
      priority: 75,
      flaky: 'no'
    }))
  }
  return found
}

/** CTest (C/C++ tests, e.g. Bare): "The following tests FAILED:". */
export function ctest (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^The following tests FAILED:$/.test(body(lines[i].text).trim())) continue
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s*(\d+) - (.+?) \((Failed|Timeout|SEGFAULT|Subprocess aborted|Exception|Child aborted|Not Run|ILLEGAL)[^)]*\)$/.exec(body(lines[j].text))
      if (!m) break
      const [, num, name, how] = m
      const run = lines.slice(0, i).findLast((l) => new RegExp(`Test +#${num}: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*\\*\\*\\*`).test(body(l.text)))
      const out = []
      if (run) {
        for (let k = lines.indexOf(run) + 1; k < lines.length && out.length < 40; k++) {
          const b = body(lines[k].text)
          if (/^\s*(Start +\d+:|\d+\/\d+ Test +#)/.test(b)) break
          if (b.trim() && !/^[=\-~*]{5,}$/.test(b.trim())) out.push({ n: lines[k].n, t: b.trim() })
        }
      }
      const timeout = how === 'Timeout'
      // Sanitizers print a native stack: the first frame in this repo (not a vendored _deps) is where to look.
      const sanitizer = out.some((o) => /(Address|Leak|Thread|Memory|UndefinedBehavior)Sanitizer/.test(o.t))
      const frame = sanitizer && out.map((o) => /#\d+ 0x[0-9a-f]+ in (\S+) (\S+?):(\d+)/.exec(o.t)).find((x) => x && !/_deps\/|\/usr\/|compiler-rt|llvm/.test(x[2]))
      const own = frame ? { fn: frame[1], file: normalizePath(frame[2]), line: Number(frame[3]) } : null
      out.splice(5)
      found.push(base(lines[j], {
        id: timeout ? 'test-timeout' : 'test-failed',
        category: timeout ? 'timeout' : 'test',
        title: `${timeout ? 'Test timed out' : 'Test failed'}: ${name}${how !== 'Failed' && !timeout ? ` (${how})` : ''}`,
        detail: out.length ? out.map((o) => o.t).join('\n') : "CTest didn't print this test's output.",
        key: `ctest:${name}`,
        lines: [run?.n, ...out.map((o) => o.n), lines[j].n].filter(Boolean),
        test: name,
        file: own?.file ?? null,
        line: own?.line ?? null,
        fix: own
          ? `A sanitizer caught a memory error in native code. Start at ${own.fn} in ${own.file}:${own.line}, the first frame in this repository, and reproduce with \`ctest -R "${name}" --output-on-failure\`.`
          : `Run \`ctest -R "${name}" --output-on-failure\` in the build directory to see what it printed${out.length ? '' : ', since this run hid it'}.${how === 'SEGFAULT' ? ' A segfault points at native code, not the test script.' : ''}`,
        priority: 80,
        flaky: timeout ? 'possible' : 'no'
      }))
    }
  }
  return found
}

/** Mocha's end-of-run summary: "  1) suite\n       test:\n     Error: ...". */
export function mocha (lines) {
  const found = []
  const jobs = [...new Set(lines.map((l) => l.job))]
  for (const job of jobs) {
    const mine = lines.filter((l) => l.job === job)
    const start = mine.findIndex((l) => /^\s*\d+ failing$/.test(body(l.text)))
    if (start < 0) continue
    const indent = /^\s*/.exec(body(mine[start].text))[0].length
    for (let i = start + 1; i < mine.length; i++) {
      const t = body(mine[i].text)
      const head = /^(\s*)(\d+)\) (.+?):?$/.exec(t)
      if (!head || head[1].length !== indent) continue
      const names = [head[3]]
      let j = i + 1
      if (!/:$/.test(t.trim())) {
        while (j < mine.length && names.length < 6) {
          const b = body(mine[j].text)
          if (!b.trim() || /^\s*(\w*Error\b|at |\+ |- )/.test(b) || /^\s*\d+\) /.test(b)) break
          names.push(b.trim().replace(/:$/, ''))
          j++
          if (/:$/.test(b.trim())) break
        }
      }
      const msg = []
      const frames = []
      for (let k = j; k < mine.length && k < j + 60; k++) {
        const b = body(mine[k].text)
        if (new RegExp(`^\\s{${indent}}\\d+\\) `).test(b) || /^##\[/.test(mine[k].text)) break
        if (/^\s*at /.test(b)) frames.push(b)
        else if (b.trim() && msg.length < 3) msg.push({ n: mine[k].n, t: b.trim() })
      }
      const where = firstOwnLocation(frames, { testsOnly: true }) ?? firstOwnLocation(frames)
      const name = names.join(' › ')
      found.push(refineTest(base(mine[i], {
        id: 'test-failed',
        category: 'test',
        title: `Test failed: ${name}`,
        detail: msg.map((m) => m.t).join('\n').slice(0, 600),
        key: `test:${name}`,
        lines: [mine[i].n, ...msg.map((m) => m.n)],
        file: where?.file ?? null,
        line: where?.line ?? null,
        test: name,
        fix: `Run ${where?.file ?? 'the failing test'} locally with mocha and compare expected and actual.`,
        priority: 80,
        flaky: 'no'
      })))
    }
  }
  return found
}

const NATIVE = /^((?:[A-Za-z]:)?[^\s:()]+\.(?:c|cc|cpp|cxx|h|hh|hpp|m|mm))(?::(\d+):(\d+)|\((\d+),(\d+)\)):? (?:fatal )?error(?: (?:C|LNK)\d+)?: (.+)$/

/** C/C++ compiler errors: GCC/Clang "file:1:2: error:", clang-cl/MSVC "file(1,2): error". */
export function nativeCompile (lines) {
  const byJob = new Map()
  for (const l of lines) {
    const m = NATIVE.exec(body(l.text).trim())
    if (!m) continue
    const k = l.job ?? ''
    if (!byJob.has(k)) byJob.set(k, [])
    byJob.get(k).push({ n: l.n, l, file: normalizePath(m[1]), line: Number(m[2] ?? m[4]), msg: m[6] })
  }
  const found = []
  for (const errs of byJob.values()) {
    const first = errs[0]
    const vendored = /(^|\/)(_deps|deps|vendor|third_party|node_modules)\//.exec(first.file)
    const dep = vendored ? /_deps\/(?:github\+)?(?:[^+/]+\+)?([^/+-]+(?:-[^/]+)?)-src\//.exec(first.file)?.[1] ?? first.file.split('/').slice(0, 3).join('/') : null
    found.push(base(first.l, {
      id: 'native-compile',
      category: 'build',
      title: `C/C++ compile error${errs.length > 1 ? `s (${errs.length})` : ''} in ${first.file.split('/').pop()}`,
      detail: errs.slice(0, MAX_DETAIL).map((e) => `${e.file}:${e.line} ${e.msg}`).join('\n'),
      key: `cc:${first.file}:${first.line}`,
      lines: errs.slice(0, MAX_DETAIL).map((e) => e.n),
      claims: errs.map((e) => e.n),
      file: first.file,
      line: first.line,
      fix: vendored
        ? `The error is inside a dependency built from source (${dep}), not this repository. A newer or stricter compiler on this runner probably rejects its code: update that dependency or pin the compiler version.`
        : `Fix ${first.file}:${first.line}; later errors often follow from the first.`,
      priority: 80,
      flaky: 'no'
    }))
  }
  return found
}

/** Rust: rustc errors, and failed cargo test / nextest tests (with panics and insta snapshots). */
export function rust (lines) {
  const found = []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const t = body(lines[i].text)
    const ce = /^error(\[E\d+\])?: (.+)$/.exec(t)
    if (ce && !/could not compile|aborting due to/.test(ce[2])) {
      const at = lines.slice(i + 1, i + 4).map((l) => /^\s*--> (\S+):(\d+):\d+/.exec(body(l.text))).find(Boolean)
      if (at) {
        const key = `rustc:${at[1]}:${at[2]}`
        if (!seen.has(key)) {
          seen.add(key)
          found.push(base(lines[i], { id: 'rust-compile', category: 'build', title: `Rust compile error${ce[1] ? ` ${ce[1].slice(1, -1)}` : ''}: ${ce[2].slice(0, 120)}`, detail: '', key, file: at[1], line: Number(at[2]), fix: `Fix ${at[1]}:${at[2]}; \`cargo check\` reproduces it quickly.`, priority: 80, flaky: 'no' }))
        }
      }
      continue
    }
    const tf = /^\s*test (\S+) \.\.\. FAILED$/.exec(t)
    if (!tf || seen.has(`test:${tf[1]}`)) continue
    seen.add(`test:${tf[1]}`)
    const short = tf[1].split('::').pop()
    const msg = []
    let panic = null
    for (let k = i + 1; k < lines.length && k < i + 120; k++) {
      const b = body(lines[k].text)
      const p = new RegExp(`thread '[^']*${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^']*'.*panicked at (\\S+?):(\\d+)`).exec(b)
      if (p) {
        panic = { file: normalizePath(p[1]), line: Number(p[2]) }
        for (let q = k + 1; q < lines.length && msg.length < 2; q++) {
          const m = body(lines[q].text).trim()
          if (m) msg.push({ n: lines[q].n, t: m })
        }
        msg.unshift({ n: lines[k].n, t: b.trim().slice(0, 200) })
        break
      }
    }
    const snapshot = msg.some((m) => /snapshot assertion/.test(m.t))
    const vendored = panic && /\.cargo\/registry/.test(panic.file)
    const retried = lines.filter((l) => new RegExp(`TRY \\d+ FAIL.*${short}`).test(body(l.text))).length
    found.push(base(lines[i], {
      id: 'test-failed',
      category: 'test',
      title: `Test failed: ${tf[1]}`,
      detail: [...msg.map((m) => m.t), retried > 1 ? `Failed on all ${retried} tries.` : null].filter(Boolean).join('\n'),
      key: `test:${tf[1]}`,
      lines: [lines[i].n, ...msg.map((m) => m.n)],
      file: panic && !vendored ? panic.file : null,
      line: panic && !vendored ? panic.line : null,
      test: tf[1],
      fix: snapshot
        ? 'The output no longer matches the stored snapshot. If the new output is right, update it with `cargo insta review`; otherwise the change altered behavior.'
        : `Run \`cargo test ${short}\` locally to reproduce.`,
      priority: 80,
      flaky: 'no'
    }))
  }
  return found
}

/** Coverage below a threshold (c8, nyc, tap, Jest). */
export function coverage (lines) {
  const byJob = new Map()
  for (const l of lines) {
    const t = body(l.text)
    const m = /Coverage for (\w+) \(([\d.]+)%\) does not meet (?:global |per-file )?threshold \(([\d.]+)%\)/.exec(t) ??
      /coverage threshold for (\w+) \(([\d.]+)%\) not met: ([\d.]+)%/.exec(t)
    if (!m) continue
    const [what, a, b] = [m[1], m[2], m[3]]
    const jestStyle = /not met/.test(t)
    const k = l.job ?? ''
    if (!byJob.has(k)) byJob.set(k, { l, items: [] })
    byJob.get(k).items.push({ n: l.n, what, got: jestStyle ? b : a, want: jestStyle ? a : b })
  }
  const found = []
  for (const [k, { l, items }] of byJob) {
    const want = Math.max(...items.map((x) => Number(x.want)))
    // Files in the coverage table below the threshold, with their uncovered lines.
    const rows = []
    for (const r of lines) {
      if ((r.job ?? '') !== k) continue
      const m = /^\s*([\w.@/-]+\.[cm]?[jt]sx?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([^|]*?)\s*\|?$/.exec(body(r.text))
      if (m && [m[2], m[3], m[4], m[5]].some((x) => Number(x) < want)) rows.push({ n: r.n, file: m[1], uncovered: m[6] })
    }
    found.push(base(l, {
      id: 'coverage',
      category: 'coverage',
      title: `Coverage below the ${want}% threshold`,
      detail: [...items.map((x) => `${x.what}: ${x.got}% (needs ${x.want}%)`), ...rows.slice(0, MAX_DETAIL).map((r) => `${r.file}${r.uncovered ? `: uncovered ${r.uncovered}` : ''}`)].join('\n'),
      key: `coverage:${k}`,
      lines: [...items.map((x) => x.n), ...rows.slice(0, MAX_DETAIL).map((r) => r.n)],
      file: rows[0]?.file ?? null,
      fix: rows.length ? `Add tests that reach ${rows.slice(0, 3).map((r) => `${r.file}${r.uncovered ? ` (${r.uncovered})` : ''}`).join(', ')}, or remove the unreachable code.` : 'Add tests for the code this change added, or remove code no test reaches.',
      priority: 75,
      flaky: 'no'
    }))
  }
  return found
}

/** Dependabot's error table: "| security_update_not_possible | { ... } |". */
export function dependabot (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\|\s*([a-z_]+_(?:not_possible|not_resolvable|error|failed|unreachable|not_found|incompatible)|[a-z]+(?:_[a-z]+)+)\s*\|\s*(\{?)/.exec(body(lines[i].text))
    if (!m || m[1] === 'type') continue
    const json = []
    const ev = [lines[i].n]
    for (let j = i; j < lines.length && j < i + 30; j++) {
      const cell = /^\|[^|]*\|\s*(.*?)\s*\|?\s*$/.exec(body(lines[j].text))
      if (!cell) break
      json.push(j === i ? cell[1] : cell[1])
      ev.push(lines[j].n)
      if (/^\}/.test(cell[1])) break
    }
    let info = {}
    try { info = JSON.parse(json.join('\n')) } catch {
      // Wide tables get cut off; pull the fields out of the text instead.
      const text = json.join(' ')
      for (const k of ['dependency-name', 'latest-resolvable-version', 'lowest-non-vulnerable-version']) {
        const m = new RegExp(`"${k}":\\s*"([^"]+)"`).exec(text)
        if (m) info[k] = m[1]
      }
    }
    const dep = info['dependency-name']
    const type = m[1]
    const notPossible = type === 'security_update_not_possible'
    found.push(base(lines[i], {
      id: 'dependabot',
      category: 'dependency',
      title: notPossible && dep ? `Dependabot can't move ${dep} to a fixed version` : `Dependabot failed: ${type.replace(/_/g, ' ')}${dep ? ` (${dep})` : ''}`,
      detail: notPossible && dep ? `Highest version it can resolve: ${info['latest-resolvable-version'] ?? '?'}. First fixed version: ${info['lowest-non-vulnerable-version'] ?? '?'}.` : json.join(' ').slice(0, 300),
      key: `dependabot:${type}:${dep ?? ''}`,
      lines: [...new Set(ev)],
      fix: notPossible && dep ? `Other dependencies keep ${dep} below ${info['lowest-non-vulnerable-version'] ?? 'the fixed version'}. Upgrade the packages that pull it in, or add an "overrides" entry for ${dep}.` : 'Open the Dependabot log linked from the job for the full error.',
      priority: 85,
      flaky: 'no'
    }))
    i = Math.max(i, ...ev.map((n) => lines.findIndex((l) => l.n === n)))
  }
  return found
}

/** node-gyp: a native addon failed to build. */
export function nodeGyp (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^gyp ERR! stack Error: (.+)$/.exec(body(lines[i].text))
    if (!m) continue
    let cwd = null
    for (let j = i; j < lines.length && j < i + 30; j++) {
      const c = /^gyp ERR! cwd (\S+)/.exec(body(lines[j].text))
      if (c) { cwd = c[1].split('/').pop(); break }
    }
    const pre = /"pre" versions of node|--nodedir/.test(m[1])
    found.push(base(lines[i], {
      id: 'native-build',
      category: 'build',
      title: `Native addon build failed${cwd ? ` (${cwd})` : ''}: ${m[1].slice(0, 120)}`,
      detail: '',
      key: `gyp:${cwd}:${m[1].slice(0, 60)}`,
      fix: pre
        ? 'node-gyp can\'t download headers for a pre-release Node. Point it at the headers with --nodedir, or skip this package on nightly Node.'
        : 'node-gyp couldn\'t compile this native dependency. Usual causes: no prebuilt binary for this Node version or platform, or a missing compiler or Python on the runner.',
      priority: 80,
      flaky: 'no'
    }))
    while (i + 1 < lines.length && /^gyp ERR!/.test(body(lines[i + 1].text))) i++
  }
  return found
}

/** Knip: unused files, dependencies and exports. */
export function knip (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const h = /^Unused (files|dependencies|devDependencies|exports|exported types|types|enum members|class members)|^Unlisted (dependencies|binaries)|^Unresolved imports|^Duplicate exports/.exec(body(lines[i].text))
    if (!h) continue
    const kind = body(lines[i].text).replace(/\s*\(\d+\)\s*$/, '')
    const items = []
    for (let j = i + 1; j < lines.length && j < i + 50; j++) {
      const b = body(lines[j].text)
      if (!b.trim() || /^(Unused|Unlisted|Unresolved|Duplicate) /.test(b) || /^##\[|^ERROR:|^npm (error|ERR!)/.test(b)) {
        if (/^ERROR:/.test(b) || /^##\[/.test(lines[j].text)) {
          // knip may print its header, then the runner's error, then the items.
          continue
        }
        break
      }
      const it = /^(\S+)\s+(\S+?):(\d+)(?::\d+)?\s*$/.exec(b.trim()) ?? /^(\S+)\s*$/.exec(b.trim())
      if (it) items.push({ n: lines[j].n, name: it[1], file: it[2] ?? null, line: it[3] ? Number(it[3]) : null })
    }
    if (!items.length) continue
    found.push(base(lines[i], {
      id: 'knip',
      category: 'lint',
      title: `Knip: ${kind.toLowerCase()} (${items.length})`,
      detail: items.slice(0, MAX_DETAIL).map((x) => `${x.name}${x.file ? ` (${x.file}${x.line ? `:${x.line}` : ''})` : ''}`).join('\n'),
      key: `knip:${kind}:${items[0].name}`,
      lines: [lines[i].n, ...items.slice(0, MAX_DETAIL).map((x) => x.n)],
      file: items[0].file,
      line: items[0].line,
      fix: /dependencies/i.test(kind)
        ? `Remove ${items.map((x) => x.name).slice(0, 3).join(', ')} from package.json if nothing uses ${items.length === 1 ? 'it' : 'them'}, or list it under ignoreDependencies in the Knip config if it is used in a way Knip can't see.`
        : 'Delete what is unused, or tell Knip about the entry point that uses it.',
      priority: 75,
      flaky: 'no'
    }))
  }
  return found
}

/** Python couldn't write to the job log (stdout left non-blocking), which kills scripts like Node's installers. */
export function pythonStdout (lines) {
  const found = []
  const jobs = new Set()
  for (const l of lines) {
    if (jobs.has(l.job) || !/BlockingIOError: \[Errno 11\] write could not complete without blocking/.test(body(l.text))) continue
    jobs.add(l.job)
    const near = lines.slice(Math.max(0, lines.indexOf(l) - 30), lines.indexOf(l)).find((x) => /Exception ignored while flushing sys\.stdout/.test(x.text))
    found.push(base(l, {
      id: 'stdout-blocked',
      category: 'runner',
      title: 'A Python script couldn\'t write its output and exited (BlockingIOError)',
      detail: 'stdout was in non-blocking mode, so a write failed when the log pipe was full. Python then exits with code 120.',
      key: 'stdout-blocked',
      lines: [near?.n, l.n].filter(Boolean),
      fix: 'This is the job environment, not the code: an earlier step left stdout non-blocking. Rerun; if it repeats, pipe the step through `| cat` so it writes to a normal pipe.',
      priority: 60,
      flaky: 'possible'
    }))
  }
  return found
}

/** npm-run-all / run-s / run-p, and make: which target failed. */
export function runners (lines) {
  const found = []
  for (const l of lines) {
    const t = body(l.text)
    let m
    if ((m = /^ERROR: "([^"]+)" exited with (\d+)\.?$/.exec(t))) {
      found.push(base(l, { id: 'script-failed', category: 'exit', title: `Script "${m[1]}" failed (exit ${m[2]})`, detail: '', key: `run-all:${m[1]}`, fix: `Run \`npm run ${m[1]}\` locally; its own output is just above this line.`, priority: 25, flaky: 'no' }))
    } else if ((m = /^make(?:\[\d+\])?: \*\*\* \[(?:[^\]]*?: )?([^\]]+)\] Error (\d+)$/.exec(t))) {
      found.push(base(l, { id: 'make-failed', category: 'exit', title: `make target "${m[1]}" failed (Error ${m[2]})`, detail: '', key: `make:${m[1]}`, fix: `Run \`make ${m[1]}\` locally; the first error above this line is the cause.`, priority: 15, flaky: 'no' }))
    }
  }
  return found
}

// --------------------------------------------------- environment / infra ---

const NETWORK = /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|getaddrinfo ENOTFOUND|Could not resolve host|TLS handshake timeout|connection reset by peer|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out|API rate limit exceeded|secondary rate limit|429 Too Many Requests)\b/i
const PASSED_TEST = /^\s*(?:✔|✓|√|ok \d+|PASS\b|\[PASS\])/
const LOCAL_REFUSED = /connect ECONNREFUSED (127\.0\.0\.1|::1|localhost|0\.0\.0\.0):(\d+)/

export function network (lines) {
  const found = []
  for (const l of lines) {
    const t = body(l.text)
    if (/\bwarn\b/i.test(t) || NPM.test(t) || PASSED_TEST.test(t)) continue
    const local = LOCAL_REFUSED.exec(t)
    if (local) {
      found.push(base(l, {
        id: 'service-down',
        category: 'service',
        title: `Nothing was listening on port ${local[2]}`,
        detail: t.trim().slice(0, 200),
        key: `refused:${local[2]}`,
        fix: `A local service the tests need (port ${local[2]}) wasn't running yet. Start it before the tests and wait until it accepts connections, instead of a fixed sleep.`,
        priority: 70,
        flaky: 'no'
      }))
      continue
    }
    const m = NETWORK.exec(t)
    if (!m) continue
    found.push(base(l, {
      id: 'network',
      category: 'network',
      title: `Network error: ${m[1]}`,
      detail: t.trim().slice(0, 200),
      key: `network:${m[1].toLowerCase()}`,
      fix: 'A connection to an outside service dropped or was rate-limited. Rerun the job; if it recurs, add retries around that call.',
      priority: 60,
      flaky: 'likely'
    }))
  }
  return found
}

export function memory (lines) {
  const found = []
  for (const l of lines) {
    const t = body(l.text)
    const heap = /JavaScript heap out of memory|Reached heap limit/.test(t)
    const killed = /Process completed with exit code 137|^Killed$/.test(t.trim())
    if (!heap && !killed) continue
    found.push(base(l, {
      id: 'out-of-memory',
      category: 'memory',
      title: heap ? 'Node ran out of memory' : 'The process was killed (exit 137, usually out of memory)',
      detail: t.trim(),
      key: 'oom',
      fix: heap ? 'Raise the heap limit (`NODE_OPTIONS=--max-old-space-size=4096`) or run fewer tests in parallel.' : 'The runner killed the process, almost always for memory. Run fewer workers in parallel or use a larger runner.',
      priority: 65,
      flaky: 'possible'
    }))
  }
  return found
}

export function runner (lines) {
  const found = []
  for (const l of lines) {
    const t = body(l.text)
    let m
    if ((m = /has exceeded the maximum execution time of (\d+) minutes/.exec(t))) {
      found.push(base(l, { id: 'job-timeout', category: 'timeout', title: `Job hit its ${m[1]}-minute time limit`, detail: t.trim(), key: 'job-timeout', fix: 'Something hung (a test, a server that never exits, a prompt waiting for input) or the job is just too slow. Look at the last step that was still printing.', priority: 55, flaky: 'possible' }))
    } else if (/No space left on device|\bENOSPC\b/.test(t)) {
      found.push(base(l, { id: 'disk-full', category: 'runner', title: 'The runner ran out of disk space', detail: t.trim().slice(0, 200), key: 'enospc', fix: 'Free space before the heavy step (caches, Docker images) or use a larger runner.', priority: 65, flaky: 'no' }))
    } else if (/runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|The runner .* did not connect/i.test(t)) {
      found.push(base(l, { id: 'runner-lost', category: 'runner', title: 'The CI runner itself failed', detail: t.trim().slice(0, 200), key: 'runner-lost', fix: 'This is a GitHub runner problem, not your code. Rerun the job.', priority: 60, flaky: 'likely' }))
    } else if (/^##\[error\]The operation was canceled\.?$/.test(l.text)) {
      found.push(base(l, { id: 'canceled', category: 'canceled', title: 'Job was canceled', detail: 'Canceled jobs are usually a side effect: another matrix job failed first (fail-fast), or a newer push replaced this run.', key: 'canceled', fix: 'Look at the job that failed first.', priority: 10, flaky: 'no' }))
    }
  }
  return found
}

// ------------------------------------------------------------- fallbacks ---

/** Uncaught exceptions: "TypeError: x is not a function". */
export function uncaught (lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const t = body(lines[i].text)
    const m = /^(?:Uncaught )?([A-Z]\w*(?:Error|Exception))(?: \[[A-Z_]+\])?: (.+)$/.exec(t)
    if (!m) continue
    const stack = lines.slice(i + 1, i + 12).map((l) => body(l.text)).filter((x) => /^\s+at /.test(x))
    if (!stack.length) continue
    const where = firstOwnLocation(stack)
    const test = runningTest(lines, i)
    found.push(base(lines[i], {
      id: 'uncaught',
      category: 'error',
      title: `${m[1]}: ${m[2].slice(0, 120)}${test ? ` (in test "${test.t}")` : ''}`,
      test: test?.t ?? null,
      detail: where ? `Thrown at ${where.file}:${where.line}.` : '',
      key: `uncaught:${m[1]}:${m[2].slice(0, 60)}`,
      file: where?.file ?? null,
      line: where?.line ?? null,
      fix: where ? `Start at ${where.file}:${where.line}.` : 'Follow the stack trace to the first file in this repository.',
      priority: 45,
      flaky: 'no'
    }))
  }
  return found
}

/** "::error::" messages a workflow printed itself. */
export function annotations (lines) {
  const found = []
  for (const l of lines) {
    if (!l.text.startsWith('##[error]')) continue
    const msg = l.text.slice(9).trim()
    if (/^Process completed with exit code \d+\.?$/.test(msg) || /^The operation was canceled/.test(msg)) continue
    found.push(base(l, {
      id: 'workflow-error',
      category: 'error',
      title: `Workflow reported: ${msg.slice(0, 140)}`,
      detail: '',
      key: `annotation:${msg.slice(0, 80)}`,
      fix: 'See the output just above this line.',
      priority: 30,
      flaky: 'no'
    }))
  }
  return found
}

/** Last resort: "Process completed with exit code N." */
export function exitCode (lines) {
  const found = []
  for (const l of lines) {
    const m = /^##\[error\]Process completed with exit code (\d+)\.?$/.exec(l.text)
    if (!m || m[1] === '137') continue
    found.push(base(l, {
      id: 'exit-code',
      category: 'exit',
      title: `${l.step ? `Step "${l.step}"` : l.command ? `\`${l.command.split('\n')[0].slice(0, 80)}\`` : 'A step'} exited with code ${m[1]}`,
      detail: "The log doesn't say why: the command failed without an error message ci-doctor recognises.",
      key: `exit:${l.command ?? ''}:${m[1]}`,
      fix: 'Read the last lines the step printed before it exited.',
      priority: 5,
      flaky: 'no'
    }))
  }
  return found
}

/** In priority order: earlier detectors claim a line first. */
export const DETECTORS = [npm, dependabot, nodeGyp, typescript, nativeCompile, rust, tap, jest, nodeSpec, mocha, ctest, coverage, prettier, lint, knip, moduleNotFound, network, memory, testTimeout, runner, pythonStdout, uncaught, runners, annotations, exitCode]
