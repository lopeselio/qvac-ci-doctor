import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { api, type FailedRun, type State } from '../api'

type Mode = 'run' | 'log'

function ago (iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function Input ({ state, busy, onRun, onLog }: { state: State, busy: boolean, onRun: (ref: string, repo: string, context: boolean) => void, onLog: (text: string, name: string) => void }) {
  const [mode, setMode] = useState<Mode>('run')
  const [ref, setRef] = useState('')
  const [repo, setRepo] = useState(state.repo ?? '')
  const [context, setContext] = useState(true)
  const [runs, setRuns] = useState<FailedRun[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [paste, setPaste] = useState('')
  const [drag, setDrag] = useState(false)

  useEffect(() => {
    if (!state.gh.signedIn || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { setRuns(null); return }
    let live = true
    setRunsError(null)
    const t = setTimeout(() => {
      api.runs(repo).then((r) => { if (live) setRuns(r) }).catch((err) => { if (live) { setRuns(null); setRunsError((err as Error).message) } })
    }, 300)
    return () => { live = false; clearTimeout(t) }
  }, [repo, state.gh.signedIn])

  function submitRun (e: FormEvent) {
    e.preventDefault()
    if (ref.trim()) onRun(ref.trim(), repo.trim(), context)
  }

  async function readFile (file: File) {
    onLog(await file.text(), file.name)
  }

  function onDrop (e: DragEvent) {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) void readFile(f)
  }

  return (
    <section className='card input'>
      <div className='seg' role='tablist'>
        <button type='button' role='tab' aria-selected={mode === 'run'} onClick={() => setMode('run')}>GitHub run</button>
        <button type='button' role='tab' aria-selected={mode === 'log'} onClick={() => setMode('log')}>Paste or drop a log</button>
      </div>

      {mode === 'run' && (
        <>
          <form className='row' onSubmit={submitRun}>
            <input className='grow mono' value={ref} onChange={(e) => setRef(e.target.value)} placeholder='https://github.com/owner/repo/actions/runs/123… or a run ID' aria-label='Run URL or ID' />
            <button className='btn primary' disabled={busy || !ref.trim() || !state.gh.signedIn}>{busy ? 'Reading the log…' : 'Diagnose'}</button>
          </form>
          <div className='row row-wrap small-row'>
            <label className='inline'>
              <span className='label'>Repository</span>
              <input className='mono repo' value={repo} onChange={(e) => setRepo(e.target.value)} placeholder='owner/name' />
            </label>
            <label className='check'>
              <input type='checkbox' checked={context} onChange={(e) => setContext(e.target.checked)} />
              Look up the PR, the changed files and the default branch
            </label>
          </div>
          {!state.gh.signedIn && <p className='warn-note'>The GitHub CLI isn&apos;t signed in. Run <code>gh auth login</code> in a terminal, then reload. Pasted logs work without it.</p>}

          {runs && (
            <div className='recent'>
              <h3>Recent failures in {repo}</h3>
              {runs.length === 0 && <p className='hint'>No failed runs. 🎉</p>}
              <ul>
                {runs.map((r) => (
                  <li key={r.id}>
                    <button type='button' disabled={busy} onClick={() => { setRef(r.url); onRun(r.url, repo, context) }}>
                      <span className='dot bad' />
                      <span className='grow'>
                        <b>{r.title}</b>
                        <span className='muted small'>{r.workflow} · {r.branch} · {r.event} · {ago(r.at)}</span>
                      </span>
                      <span className='muted small mono'>#{r.number}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {runsError && <p className='hint'>{runsError}</p>}
        </>
      )}

      {mode === 'log' && (
        <div className={`drop ${drag ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} placeholder='Paste a CI log here, or drop a .log / .txt file on this box. Nothing leaves this computer.' className='mono' />
          <div className='row'>
            <label className='btn upload'>
              <input type='file' accept='.log,.txt,text/plain' onChange={(e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readFile(f) }} />
              Choose a file
            </label>
            <span className='grow' />
            <button type='button' className='btn primary' disabled={busy || !paste.trim()} onClick={() => onLog(paste, 'pasted log')}>{busy ? 'Reading…' : 'Diagnose'}</button>
          </div>
        </div>
      )}
    </section>
  )
}
