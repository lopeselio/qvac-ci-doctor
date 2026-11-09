import { excerpt } from './diagnose.js'
import { MARKER } from './marker.js'

const HEADLINE = {
  failure: { icon: '✖', md: '🔴', text: 'Real failure: needs a fix' },
  flaky: { icon: '↻', md: '🟡', text: 'Likely flaky: rerun the job' },
  'maybe-flaky': { icon: '?', md: '🟠', text: 'Possibly flaky: rerun once, and if it fails again treat it as real' },
  unknown: { icon: '?', md: '⚪', text: "Failed, but the log doesn't show a recognisable cause" },
  passed: { icon: '✔', md: '🟢', text: 'Nothing failed' }
}

export function headline (verdict) { return HEADLINE[verdict] ?? HEADLINE.unknown }

const range = (ns) => ns.length === 1 ? `line ${ns[0]}` : `lines ${Math.min(...ns)}–${Math.max(...ns)}`

function contextLines (ctx) {
  const out = []
  if (ctx?.matrix) out.push(ctx.matrix.text + (ctx.matrix.hint ? ` ${ctx.matrix.hint}` : ''))
  for (const t of ctx?.touched ?? []) {
    out.push(t.why === 'deps'
      ? `This change edited ${t.file}, and the failure is a dependency error.`
      : `This change touched ${t.file}, where the failure points.`)
  }
  if (ctx?.changed && !ctx.touched?.length && ctx.changed.files.length) out.push(`None of the ${ctx.changed.files.length} files changed since ${ctx.changed.base} appear in the failure.`)
  if (ctx?.defaultBranch) {
    const d = ctx.defaultBranch
    const when = d.date ? ` (${d.date})` : ''
    out.push(d.conclusion === 'success'
      ? `The last run of this workflow on ${d.branch}${when} passed, so this failure is new.`
      : `The last run of this workflow on ${d.branch}${when} failed too, so ${d.branch} may already be broken: ${d.url}`)
  }
  if (ctx?.logsExpired) out.push(ctx.logsExpired)
  return out
}

function followOns (diagnosis) {
  const roots = new Set(diagnosis.causes.map((c) => c.finding))
  return diagnosis.findings.filter((f) => !roots.has(f) && f.priority >= 20)
}

// ---------------------------------------------------------------- text ---

export function renderText (diagnosis, { context = {}, explanation = null, maxOthers = 6 } = {}) {
  const h = headline(diagnosis.verdict)
  const out = [`${h.icon} ${h.text}`]
  diagnosis.causes.forEach((c, i) => {
    const f = c.finding
    out.push('', `${diagnosis.causes.length > 1 ? `${i + 1}. ` : ''}${f.title}`)
    const step = f.step ?? f.command?.split('\n')[0].slice(0, 80)
    const where = [c.jobs.length ? `job: ${c.jobs.join(', ')}` : null, step ? `step: ${step}` : null, f.file ? `at ${f.file}${f.line ? `:${f.line}` : ''}` : null].filter(Boolean)
    if (where.length) out.push(`  ${where.join(' · ')}`)
    if (f.detail) out.push(...f.detail.split('\n').map((l) => `  ${l}`))
    out.push('', `  Evidence (${range(f.lines)}):`)
    for (const l of excerpt(diagnosis.lines, f, { before: 1, after: 0, max: 12 })) out.push(`  ${String(l.n).padStart(6)} │ ${l.text.slice(0, 160)}`)
    out.push('', `  Fix: ${f.fix}`)
  })
  const ctx = contextLines(context)
  if (ctx.length) out.push('', 'Context:', ...ctx.map((l) => `  • ${l}`))
  const others = followOns(diagnosis)
  if (others.length) {
    out.push('', `Also failed after this (${others.length}, may follow from it):`)
    for (const f of others.slice(0, maxOthers)) out.push(`  • ${f.title} (line ${f.lines[0]})`)
    if (others.length > maxOthers) out.push(`  … and ${others.length - maxOthers} more`)
  }
  if (explanation?.accepted) {
    out.push('', `In plain words (local model, checked against lines ${explanation.evidence.join(', ')}):`, `  ${explanation.cause}`, `  ${explanation.fix}`)
  } else if (explanation && !explanation.accepted) {
    out.push('', `(The local model's explanation was discarded: ${explanation.reason}.)`)
  }
  return out.join('\n')
}

// ------------------------------------------------------------ markdown ---

/** Inline code that survives backticks in the content. */
export function code (s) {
  const str = String(s)
  const longest = Math.max(0, ...(str.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${longest ? ' ' : ''}${str}${longest ? ' ' : ''}${fence}`
}

/** Plain text from a log, safe in a comment: no HTML, no accidental @mentions. */
export function safe (s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/(^|[\s(])(@[\w.-]+(?:\/[\w.@^~*-]+)?)/g, (_, pre, name) => `${pre}${code(name)}`)
}

function block (lines) {
  const text = lines.map((l) => `${String(l.n).padStart(6)} │ ${l.text.slice(0, 200)}`).join('\n')
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

export function renderMarkdown (diagnosis, { run = null, context = {}, explanation = null, maxOthers = 10 } = {}) {
  const h = headline(diagnosis.verdict)
  const out = [MARKER, `### ${h.md} CI doctor: ${h.text}`]
  if (run) out.push(`Run: [${safe(run.workflowName ?? run.name)} #${run.databaseId}](${run.url})${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''} · commit ${code(run.headSha.slice(0, 7))}`)
  diagnosis.causes.forEach((c) => {
    const f = c.finding
    out.push('', `#### ${safe(f.title)}`)
    const step = f.step ?? f.command?.split('\n')[0].slice(0, 80)
    const where = [c.jobs.length ? `Job ${c.jobs.map(code).join(', ')}` : null, step ? `step ${code(step)}` : null, f.file ? `${code(`${f.file}${f.line ? `:${f.line}` : ''}`)}` : null].filter(Boolean)
    if (where.length) out.push(where.join(' · '))
    if (f.detail) out.push('', ...f.detail.split('\n').map((l) => `> ${safe(l)}`))
    out.push('', `**Fix:** ${safe(f.fix)}`)
    out.push('', `<details><summary>Evidence: log ${range(f.lines)}</summary>`, '', block(excerpt(diagnosis.lines, f, { before: 2, after: 1, max: 30 })), '', '</details>')
  })
  if (explanation?.accepted) {
    out.push('', `**In plain words** (local QVAC model, checked against log lines ${explanation.evidence.join(', ')}): ${safe(explanation.cause)} ${safe(explanation.fix)}`)
  }
  const ctx = contextLines(context)
  if (ctx.length) out.push('', ...ctx.map((l) => `- ${safe(l)}`))
  const others = followOns(diagnosis)
  if (others.length) {
    out.push('', `<details><summary>Also failed after this (${others.length}), may follow from it</summary>`, '')
    for (const f of others.slice(0, maxOthers)) out.push(`- ${safe(f.title)} (line ${f.lines[0]})`)
    if (others.length > maxOthers) out.push(`- … and ${others.length - maxOthers} more`)
    out.push('', '</details>')
  }
  out.push('', '<sub>From [qvac-ci-doctor](https://github.com/lopeselio/qvac-ci-doctor): rules read the log and decide the verdict. Any plain-words explanation comes from a local model and is only shown if it cites lines from the log.</sub>')
  const md = out.join('\n')
  return md.length > 60000 ? md.slice(0, 60000) + '\n\n_(truncated)_' : md
}

export function renderJson (diagnosis, { run = null, context = {}, explanation = null } = {}) {
  const strip = (f) => f && { id: f.id, category: f.category, title: f.title, detail: f.detail, file: f.file, line: f.line, test: f.test, job: f.job, step: f.step, command: f.command, fix: f.fix, flaky: f.flaky, evidence: f.lines }
  return {
    verdict: diagnosis.verdict,
    run: run && { id: run.databaseId, url: run.url, workflow: run.workflowName, sha: run.headSha, attempt: run.attempt },
    causes: diagnosis.causes.map((c) => ({ ...strip(c.finding), jobs: c.jobs })),
    also_failed: followOns(diagnosis).map(strip),
    context: { notes: contextLines(context), touched: (context.touched ?? []).map((t) => t.file) },
    explanation
  }
}
