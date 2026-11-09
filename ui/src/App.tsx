import { useCallback, useEffect, useRef, useState } from 'react'
import { api, STATIC, type Diagnosis, type State } from './api'
import { Input } from './components/Input'
import { Result } from './components/Result'

export function App () {
  const [state, setState] = useState<State | null>(null)
  const [offline, setOffline] = useState(false)
  const [result, setResult] = useState<Diagnosis | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const toast = useCallback((m: string) => {
    setToastMsg(m)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToastMsg(null), 4000)
  }, [])

  useEffect(() => { api.state().then(setState).catch(() => setOffline(true)) }, [])

  async function run (task: () => Promise<Diagnosis>, label: string) {
    setBusy(true)
    setError(null)
    try {
      setResult(await task())
      setSource(label)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pill = offline
    ? { tone: 'bad', text: "CI Doctor isn't running" }
    : !state
        ? { tone: 'idle', text: 'Connecting…' }
        : STATIC ? { tone: 'ok', text: 'Runs in your browser · logs stay here' }
          : state.gh.signedIn ? { tone: 'ok', text: `GitHub · @${state.gh.user}` } : { tone: 'warn', text: 'GitHub CLI not signed in' }

  return (
    <div className='wrap'>
      <header className='top'>
        <div className='brand'>
          <img src='/favicon.svg' alt='' width='34' height='34' />
          <div><h1>CI Doctor</h1><p>Why did CI fail? The first real error, real failure or flaky, and the exact log lines.</p></div>
        </div>
        <div className='pills'>
          <span className='pill'><span className={`dot ${pill.tone}`} />{pill.text}</span>
          {state && !STATIC && <span className='pill'><span className={`dot ${state.qvac ? 'ok' : 'idle'}`} />{state.qvac ? 'QVAC · explanations on this computer' : 'QVAC off'}</span>}
        </div>
      </header>

      {offline && <p className='warn-note'>Can&apos;t reach the local server. Start it with <code>ci-doctor ui</code>, then reload.</p>}
      {state && (
        <Input
          state={state}
          busy={busy}
          onRun={(ref, repo, context) => { void run(() => api.diagnose(ref, repo, context), ref) }}
          onLog={(text, name) => { void run(() => api.log(text), name) }}
        />
      )}
      {error && <p className='err' role='alert'>{error}</p>}
      {busy && <p className='muted loading'>Reading the log and checking it against ci-doctor&apos;s rules…</p>}
      {result && state && !busy && (
        <>
          {source && <p className='muted small source'>Diagnosis of <span className='mono'>{source}</span></p>}
          <Result d={result} state={state} toast={toast} />
        </>
      )}

      <footer>
        <span><b>Rules make the diagnosis.</b> The local model only explains it, and only when its answer passes checks.</span>
        {STATIC
          ? <span><b>Logs stay in your browser.</b> The diagnosis runs on this page; nothing is uploaded.</span>
          : <span><b>Logs stay on this computer.</b> GitHub is read through your <code>gh</code> login.</span>}
        <span><a href='https://github.com/lopeselio/qvac-ci-doctor' rel='noopener noreferrer' target='_blank'>Source on GitHub</a></span>
      </footer>
      <div className={`toast ${toastMsg ? 'show' : ''}`} role='status'>{toastMsg}</div>
    </div>
  )
}
