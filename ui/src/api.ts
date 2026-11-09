// Typed client for the local CI Doctor server (src/ui-server.js), or, in the
// in-browser build (VITE_STATIC=1), the rules engine running in this page.
import { diagnoseHere, markdownHere } from './local'

/** True for the hosted, in-browser build. */
export const STATIC = import.meta.env.VITE_STATIC === '1'

export type Verdict = 'passed' | 'flaky' | 'maybe-flaky' | 'failure' | 'unknown' | string

export interface Cause {
  id: string
  category: string
  title: string
  detail: string
  file: string | null
  line: number | null
  test: string | null
  job: string | null
  step: string | null
  command: string | null
  fix: string
  flaky: string
  evidence: number[]
  jobs?: string[]
}

export interface Explanation { accepted: boolean, cause?: string, fix?: string, evidence?: number[], reason?: string, ms: number }

export interface Diagnosis {
  id: string
  repo: string | null
  headline: string
  exitCode: number
  verdict: Verdict
  run: { id: number, url: string, workflow: string, sha: string, attempt: number } | null
  causes: Cause[]
  also_failed: Cause[]
  context: { notes: string[], touched: string[] }
  evidence: { n: number, text: string, hit: boolean }[][]
  pr: number | null
  sha: string | null
  lineCount: number
}

export interface FailedRun { id: number, title: string, workflow: string, branch: string, event: string, at: string, url: string, number: number }

export interface State {
  static?: boolean
  repo: string | null
  gh: { signedIn: boolean, user: string | null }
  qvac: boolean
  model: string
  explainer: { state: string, download: number | null } | null
}

export type ExplainEvent =
  | { type: 'status', model: { state: string, download?: number | null } | null }
  | { type: 'delta', text: string }
  | { type: 'result', explanation: Explanation }
  | { type: 'error', message: string }

async function request<T> (path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  state: (): Promise<State> => STATIC
    ? Promise.resolve({ static: true, repo: null, gh: { signedIn: false, user: null }, qvac: false, model: 'QWEN3_1_7B_INST_Q4', explainer: null })
    : request<State>('/api/state'),
  runs: (repo: string) => request<FailedRun[]>(`/api/runs?repo=${encodeURIComponent(repo)}`),
  diagnose: (ref: string, repo: string, context: boolean) => post<Diagnosis>('/api/diagnose', { ref, repo, context }),
  log: (text: string): Promise<Diagnosis> => STATIC
    ? Promise.resolve(diagnoseHere(text))
    // octet-stream, not text/plain: the server refuses "simple" requests any site could send.
    : request<Diagnosis>('/api/log', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text }),
  /** The Markdown report for a diagnosis. */
  markdown: async (id: string): Promise<string> => {
    if (STATIC) return markdownHere(id)
    const res = await fetch(`/api/report/${id}.md`)
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'That diagnosis has expired. Diagnose it again.')
    return res.text()
  },
  comment: (id: string) => post<{ url: string | null, where: string }>('/api/comment', { id }),

  /** Streams the local model's explanation as NDJSON events. */
  async explain (id: string, onEvent: (e: ExplainEvent) => void) {
    const res = await fetch('/api/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    // An explanation already made for this diagnosis comes back as plain JSON.
    if (res.headers.get('content-type')?.startsWith('application/json')) {
      const body = await res.json()
      onEvent({ type: 'result', explanation: body.explanation })
      return
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) onEvent(JSON.parse(line) as ExplainEvent)
      }
    }
  }
}
