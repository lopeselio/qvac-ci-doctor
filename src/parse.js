// Turn a CI log into numbered, cleaned lines that remember which job and
// step they came from.
//
// Three input shapes are understood:
//   1. `gh run view --log-failed`:  "<job>\t<step>\t<timestamp> <text>"
//   2. a raw GitHub Actions job log: "<timestamp> <text>"
//   3. plain text (a local `npm test` run, a log from another CI)
//
// Line numbers always refer to the original input, so evidence can be
// checked against the file a person (or a model) was shown.

const GH_LINE = /^([^\t]*)\t([^\t]*)\t\ufeff?(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/
const TS_LINE = /^\ufeff?(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/

// Real escape sequences, and the caret form ("^[[36;1m") that some log
// viewers and `gh` write out literally.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\^\[\[[0-9;?]*[A-Za-z]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

export function clean (text) {
  return text.replace(ANSI, '').replace(CONTROL, '').replace(/\s+$/, '')
}

/**
 * @param {string} raw
 * @returns {{ n: number, job: string|null, step: string|null, command: string|null, section: string|null, text: string }[]}
 */
export function parseLog (raw) {
  const out = []
  const state = new Map() // job → { command, section }
  const rows = raw.replace(/^\ufeff/, '').split(/\r?\n/)
  if (rows.length && rows[rows.length - 1] === '') rows.pop()

  rows.forEach((row, i) => {
    let job = null
    let step = null
    let text = row
    let m = GH_LINE.exec(row)
    if (m) {
      job = m[1] || null
      step = m[2] && m[2] !== 'UNKNOWN STEP' ? m[2] : null
      text = m[4]
    } else if ((m = TS_LINE.exec(row))) {
      text = m[2]
    }
    text = clean(text)

    const key = job ?? ''
    if (!state.has(key)) state.set(key, { command: null, section: null })
    const s = state.get(key)
    if (text.startsWith('##[group]')) {
      const title = text.slice(9).trim()
      // "Run npm test" opens a step; any other group is a section inside it.
      if (/^Run /.test(title)) { s.command = title.slice(4).trim(); s.section = null } else s.section = title
    }

    out.push({ n: i + 1, job, step, command: s.command, section: s.section, text })
    if (text.startsWith('##[endgroup]')) s.section = null
  })
  return out
}

/** Text with GitHub's "##[error]" style marker and a concurrently-style "[TEST] " prefix removed. */
export function body (text) {
  return text
    .replace(/^##\[(?:error|warning|notice)\]/, '')
    .replace(/^\[(?!(?:warn|warning|error|info|debug|notice|log|verbose|success|fail)\])[A-Za-z0-9_ -]{1,20}\] /i, '')
}

/** The jobs that appear in a parsed log, in order. */
export function jobsOf (lines) {
  return [...new Set(lines.map((l) => l.job))]
}
