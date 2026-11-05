// Ask QVAC whether models are likely to fit in memory *before* downloading
// them (assessModelFit reads the registry's weightless description, tens of
// KB, never the weights). Advisory only: "unknown" means "can't say".

const MiB = 1024 * 1024

/**
 * @param {any} sdk @qvac/sdk
 * @param {object[]} loads loadModel-shaped { modelSrc, modelType?, modelConfig? }
 * @param {{ execution?: 'sequential'|'concurrent' }} [opts]
 * @returns {Promise<{ verdict: 'likely-fits'|'likely-too-large'|'unknown', evidence?: string, availableMiB?: number, models: object[], reasons: string[] }>}
 */
export async function checkFit (sdk, loads, { execution = 'sequential' } = {}) {
  if (typeof sdk?.assessModelFit !== 'function') {
    return { verdict: 'unknown', models: [], reasons: ['this SDK build has no assessModelFit'] }
  }
  try {
    const r = await sdk.assessModelFit({ models: loads, execution })
    const avail = r.budget?.availableAfterReserveBytes
    return {
      verdict: r.verdict ?? 'unknown',
      evidence: r.evidence,
      availableMiB: typeof avail === 'number' ? Math.round(avail / MiB) : undefined,
      models: (r.models ?? []).map((m) => ({ name: m.name, verdict: m.verdict, device: m.device, reasons: m.reasons ?? [] })),
      reasons: r.reasons ?? []
    }
  } catch (err) {
    return { verdict: 'unknown', models: [], reasons: [`fit check failed: ${err.message}`] }
  }
}

/** One human line per model, e.g. "QWEN3_600M_INST_Q4: likely fits (gpu)". */
export function describeFit (fit) {
  const label = { 'likely-fits': 'likely fits', 'likely-too-large': 'likely too large', unknown: "can't tell" }
  const lines = fit.models.map((m) => {
    const why = m.verdict === 'likely-fits' ? '' : m.reasons.filter((r) => r !== 'fits').join('; ')
    return `${m.name}: ${label[m.verdict] ?? m.verdict}${m.device ? ` (${m.device})` : ''}${why ? ` — ${why}` : ''}`
  })
  if (!lines.length) lines.push(`${label[fit.verdict] ?? fit.verdict}${fit.reasons.length ? ` — ${fit.reasons.join('; ')}` : ''}`)
  return lines
}

export class ModelTooLargeError extends Error {
  constructor (fit) {
    super(`This device likely can't hold the model:\n  ${describeFit(fit).join('\n  ')}\nPick a smaller model, close other apps, or pass --force to try anyway.`)
    this.name = 'ModelTooLargeError'
    this.fit = fit
  }
}

/** Throws ModelTooLargeError on "likely-too-large" unless forced; returns the fit otherwise. */
export async function ensureFits (sdk, loads, { force = false, execution } = {}) {
  const fit = await checkFit(sdk, loads, { execution })
  if (fit.verdict === 'likely-too-large' && !force) throw new ModelTooLargeError(fit)
  return fit
}
