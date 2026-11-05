import { enterTraceContext, newTraceId } from '@/platform/trace'
import { enterEventContext } from '@/platform/event-context'
import { createLogger } from '@/platform/logger'

/**
 * Give a CLI run the same trace + event context an API request or a queued job
 * gets, so everything it touches logs under one `script-…` id.
 *
 * Without this, a backfill or a repair — the runs that mutate production data
 * with no request behind them — produced log lines with no traceId at all, and
 * the engine code they call (which logs plenty) had nothing to correlate on.
 * `source: 'system'` marks the resulting event/audit rows as engine-initiated
 * rather than attributing them to an operator's API key.
 *
 * Call it once, first thing in the script:
 *
 * ```ts
 * const trace = startScriptTrace('mrr-backfill', { write })
 * ```
 *
 * `enterWith` (not `run`) so the rest of the file needs no re-indent: a script is
 * a single linear execution, which is exactly the case `enterWith` is safe for.
 */
export function startScriptTrace(name: string, details?: Record<string, unknown>): string {
  const { traceId } = enterTraceContext({ traceId: newTraceId('script') })
  // `enterEventContext`, not `runWithEventContext`: the latter's context ends with
  // its callback, which would leave the rest of the script uncontextualized.
  enterEventContext({ source: 'system', actor: `script:${name}` })
  createLogger(`script.${name}`).log('script started', { script: name, argv: process.argv.slice(2), ...(details ?? {}) })
  return traceId
}
