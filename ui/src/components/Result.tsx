import { useEffect, useState } from 'react'
import { api, STATIC, type Diagnosis, type Explanation, type State } from '../api'

const TONE: Record<string, { tone: string, icon: string, note: string }> = {
  failure: { tone: 'bad', icon: '✖', note: 'A rerun won\'t help: this needs a fix.' },
  flaky: { tone: 'warn', icon: '↻', note: 'Rerunning is worth a try.' },
  'maybe-flaky': { tone: 'warn', icon: '↻', note: 'Possibly flaky: rerun once before digging in.' },
  unknown: { tone: 'idle', icon: '?', note: 'The log doesn\'t show a recognisable cause. Read the last lines the failing step printed.' },
  passed: { tone: 'ok', icon: '✓', note: 'Nothing failed.' }
}

export function Result ({ d, state, toast }: { d: Diagnosis, state: State, toast: (m: string) => void }) {
  const t = TONE[d.verdict] ?? TONE.unknown
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [explaining, setExplaining] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [explainError, setExplainError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [posting, setPosting] = useState(false)
  const [showOthers, setShowOthers] = useState(false)
  const [postedUrl, setPostedUrl] = useState<string | null>(null)
  const [md, setMd] = useState<string | null>(null)

  useEffect(() => { setExplanation(null); setExplaining(null); setDraft(''); setExplainError(null); setConfirm(false); setShowOthers(false); setPostedUrl(null) }, [d.id])
  // Fetch the report ahead of the click: Safari only allows a clipboard write
  // straight from the click, not after a network round trip.
  useEffect(() => { setMd(null); api.markdown(d.id).then(setMd).catch(() => setMd(null)) }, [d.id, explanation])

  async function explain () {
    setExplainError(null)
    setDraft('')
    setExplaining('Loading the local model…')
    try {
      await api.explain(d.id, (e) => {
        if (e.type === 'status') setExplaining(e.model?.state === 'downloading' ? `Downloading ${state.model} ${e.model.download ?? 0}% (once)…` : e.model?.state === 'ready' ? 'Thinking…' : 'Loading the local model…')
        if (e.type === 'delta') setDraft((x) => x + e.text)
        if (e.type === 'result') setExplanation(e.explanation)
        if (e.type === 'error') setExplainError(e.message)
      })
    } catch (err) {
      setExplainError((err as Error).message)
    } finally {
      setExplaining(null)
    }
  }

  async function post () {
    setPosting(true)
    try {
      const r = await api.comment(d.id)
      toast(`Posted on ${r.where}.`)
      // A link, not window.open: a popup after a network wait gets blocked.
      setPostedUrl(r.url)
    } catch (err) {
      toast((err as Error).message)
    } finally {
      setPosting(false)
      setConfirm(false)
    }
  }

  async function copyMarkdown () {
    try {
      await navigator.clipboard.writeText(md ?? await api.markdown(d.id))
      toast('Copied the Markdown report.')
    } catch (err) { toast((err as Error).message || 'Copy failed.') }
  }

  async function download () {
    let text: string
    try { text = md ?? await api.markdown(d.id) } catch (err) { return toast((err as Error).message) }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `ci-doctor-${d.run?.id ?? 'log'}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className='result'>
      <section className={`verdict ${t.tone}`}>
        <span className='v-icon' aria-hidden='true'>{t.icon}</span>
        <div className='grow'>
          <h2>{d.headline}</h2>
          <p>{t.note} <span className='muted small'>exit code {d.exitCode} · {d.lineCount.toLocaleString()} log lines read</span></p>
        </div>
        {d.run && <a className='btn' href={d.run.url} target='_blank' rel='noopener noreferrer'>Open run ↗</a>}
      </section>

      {d.causes.map((c, i) => (
        <section className='card cause' key={i}>
          <h3 className='cause-title'>{c.title}</h3>
          <p className='meta'>
            {c.job && <span className='tag'>job · {c.job}</span>}
            {c.step && <span className='tag'>step · {c.step}</span>}
            {(c.jobs?.length ?? 0) > 1 && <span className='tag'>{c.jobs!.length} jobs failed the same way</span>}
            <span className='tag subtle'>{c.category}</span>
          </p>
          {c.detail && <p className='detail'>{c.detail}</p>}
          <div className='evidence'>
            <div className='ev-head'>Evidence · {c.evidence.length === 1 ? `line ${c.evidence[0]}` : `lines ${Math.min(...c.evidence)}–${Math.max(...c.evidence)}`}</div>
            <pre>{(d.evidence[i] ?? []).map((l) => (
              <div key={l.n} className={l.hit ? 'hit' : ''}><span className='ln'>{l.n}</span>{l.text || ' '}</div>
            ))}</pre>
          </div>
          <div className='fix'><b>Fix</b><p>{c.fix}</p></div>
        </section>
      ))}

      {d.context.notes.length > 0 && (
        <section className='card'>
          <h3 className='h3'>Context</h3>
          <ul className='notes'>{d.context.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </section>
      )}

      {d.also_failed.length > 0 && (
        <section className='card'>
          <button type='button' className='linkish' onClick={() => setShowOthers((x) => !x)}>
            {showOthers ? '▾' : '▸'} Also failed after this: {d.also_failed.length} (they may follow from the cause above)
          </button>
          {showOthers && <ul className='notes'>{d.also_failed.map((o, i) => <li key={i}>{o.title} <span className='muted small'>(line {o.evidence[0]})</span></li>)}</ul>}
        </section>
      )}

      {d.causes.length > 0 && (
        <section className='card explain'>
          <div className='row row-wrap'>
            <div className='grow'>
              <h3 className='h3'>In plain words</h3>
              <p className='hint'>A small model ({state.model}) explains it on this computer with Tether QVAC. Its answer is only shown if it cites log lines it was shown, names nothing that isn&apos;t in the log, and agrees with the verdict.</p>
            </div>
            {!explanation && <button type='button' className='btn' onClick={() => { void explain() }} disabled={!!explaining || !state.qvac}>{explaining ?? 'Explain with the local model'}</button>}
          </div>
          {explaining && draft && <pre className='draft'>{draft}</pre>}
          {explanation?.accepted && (
            <div className='explained'>
              <span className='tag ok-tag'>✓ checked against line{explanation.evidence!.length > 1 ? 's' : ''} {explanation.evidence!.join(', ')} · {(explanation.ms / 1000).toFixed(1)} s</span>
              <p>{explanation.cause}</p>
              <p>{explanation.fix}</p>
            </div>
          )}
          {explanation && !explanation.accepted && <p className='warn-note'>The model&apos;s answer was discarded: {explanation.reason}. The diagnosis above doesn&apos;t depend on it.</p>}
          {explainError && <p className='err'>{explainError}</p>}
          {!state.qvac && (STATIC
            ? <p className='hint'>The explanation runs a local model with QVAC, so it needs CI Doctor running on your computer: <code>npm install -g qvac-ci-doctor @qvac/sdk</code>, then <code>ci-doctor ui</code>.</p>
            : <p className='hint'>Install <code>@qvac/sdk</code> to turn this on.</p>)}
        </section>
      )}

      <section className='actions'>
        <button type='button' className='btn' onClick={() => { void copyMarkdown() }}>Copy Markdown</button>
        <button type='button' className='btn' onClick={() => { void download() }}>Download .md</button>
        {d.run && d.verdict !== 'passed' && (
          confirm
            ? (
              <span className='confirm'>
                Post this as {state.gh.user ? `@${state.gh.user}` : 'you'} on {d.pr ? `PR #${d.pr}` : `commit ${d.sha?.slice(0, 7)}`}?
                <button type='button' className='btn primary' onClick={() => { void post() }} disabled={posting}>{posting ? 'Posting…' : 'Yes, post'}</button>
                <button type='button' className='btn' onClick={() => setConfirm(false)}>Cancel</button>
              </span>
              )
            : <button type='button' className='btn' onClick={() => setConfirm(true)}>Post to {d.pr ? `PR #${d.pr}` : 'the commit'}…</button>
        )}
        {postedUrl && <a className='btn' href={postedUrl} target='_blank' rel='noopener noreferrer'>View the comment ↗</a>}
      </section>
    </div>
  )
}
