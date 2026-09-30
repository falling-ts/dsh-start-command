/**
 * dsh-start-command runner — executes ONE configured command line through the
 * harness's own shell executor (`ctx.shell`, the same seam the bash/pwsh tools
 * use) and reports the outcome without ever throwing.
 *
 * Why the executor rather than a bespoke `node:child_process` spawn:
 *
 * - the deployment's **sandbox policy** is applied by the mounted executor, so
 *   a start command obeys the same file-policy fence as the agent's own
 *   commands instead of silently bypassing it;
 * - the executor owns the **deadline** (`timeoutMs`, implementation-configured
 *   and capped) and kills the process group on expiry;
 * - the caller's `AbortSignal` — here the running turn's signal — kills the
 *   command when the user stops the turn, so a hung start command can never
 *   outlive the step it blocks.
 *
 * Failure policy mirrors the official hook protocol: any failure — a non-zero
 * exit, a timeout, a missing executor — is contained and logged. It never
 * throws into the `agent/pre-step` dispatch and never rejects the step; the
 * turn proceeds as if the command had succeeded.
 *
 * @module @falling-ts/dsh-start-command/runner
 */

/**
 * Character cap for the stdout/stderr tails carried into the Host log. This is
 * a logging bound, not behavior: the command's full output is the executor's
 * to capture and spill, and nothing here is model-visible.
 */
const LOG_TAIL_CHARS = 400

/** Read an optional Host service without assuming it is mounted. */
function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Error -> message, tolerating non-Error throws. */
function messageOf(error) {
  return error instanceof Error ? (error.message || String(error)) : String(error)
}

/** Last `LOG_TAIL_CHARS` characters of `text`, trimmed; `undefined` when blank. */
function tail(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return trimmed.length > LOG_TAIL_CHARS ? '…' + trimmed.slice(-LOG_TAIL_CHARS) : trimmed
}

/**
 * Resolve the calling session's sandbox policy so the start command runs under
 * exactly the fence that session's own commands run under. Falls back to the
 * deployment policy (the executor does that itself when the request omits the
 * field) if the policy service or the session is unavailable.
 * @param {object} ctx host plugin context
 * @param {object|undefined} session the calling session
 * @returns {object|undefined} a resolved SandboxExecutionPolicy
 */
function resolveSandboxPolicy(ctx, session) {
  const policy = serviceOf(ctx, 'sandboxPolicy')
  if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return undefined
  try {
    return policy.resolve(session === undefined || session === null ? {} : { session })
  } catch {
    return undefined
  }
}

/**
 * Run one start command through `ctx.shell`. Never throws.
 *
 * @param {object} ctx host plugin context
 * @param {{ command: string, cwd?: string|undefined, signal?: AbortSignal|undefined,
 *   session?: object|undefined }} options the resolved command line, the session
 *   working directory, the running turn's signal, and the calling session.
 * @returns {Promise<{ ran: boolean, reason: string, exitCode?: number|null,
 *   timedOut?: boolean, aborted?: boolean, durationMs: number,
 *   stdoutTail?: string, stderrTail?: string, error?: string }>}
 *   `ran` distinguishes "the executor started the command" from "it never
 *   started"; `reason` is a stable token for probes and logs.
 */
export async function runStartCommand(ctx, options) {
  const started = Date.now()
  const shell = serviceOf(ctx, 'shell')
  if (shell === undefined || shell === null
    || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function') {
    return { ran: false, reason: 'no-shell', durationMs: Date.now() - started }
  }
  const policy = resolveSandboxPolicy(ctx, options.session)
  const request = {
    command: options.command,
    ...options.cwd === undefined || options.cwd === '' ? {} : { workdir: options.cwd },
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...policy === undefined ? {} : { sandboxPolicy: policy },
  }
  try {
    const execution = await shell.execute(shell.resolve(request))
    const result = await execution.result()
    return {
      ran: true,
      reason: 'completed',
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      durationMs: Date.now() - started,
      ...tail(result.stdout.text) === undefined ? {} : { stdoutTail: tail(result.stdout.text) },
      ...tail(result.stderr.text) === undefined ? {} : { stderrTail: tail(result.stderr.text) },
    }
  } catch (error) {
    return {
      ran: false,
      reason: 'execute-failed',
      durationMs: Date.now() - started,
      error: messageOf(error),
    }
  }
}

/**
 * Render one outcome as a single Host log line, including the tails and the
 * distinguishing flags so a timeout is never mistaken for a plain failure.
 * @param {string} command the command line that ran
 * @param {object} outcome a {@link runStartCommand} result
 * @returns {{ level: 'info'|'warn', text: string }} the level to log at and the line
 */
export function describeOutcome(command, outcome) {
  const parts = [`[start-command] "${command}"`]
  if (outcome.ran !== true) {
    parts.push(`did not run (${outcome.reason})`)
    if (outcome.error !== undefined) parts.push(`error=${outcome.error}`)
  } else {
    parts.push(`exit=${outcome.exitCode === null ? 'signal' : outcome.exitCode}`)
    if (outcome.timedOut === true) parts.push('timedOut')
    if (outcome.aborted === true) parts.push('aborted')
  }
  parts.push(`${outcome.durationMs}ms`)
  if (outcome.stdoutTail !== undefined) parts.push(`stdout=${outcome.stdoutTail}`)
  if (outcome.stderrTail !== undefined) parts.push(`stderr=${outcome.stderrTail}`)
  const failed = outcome.ran !== true
    || outcome.timedOut === true
    || outcome.aborted === true
    || (outcome.exitCode !== null && outcome.exitCode !== 0)
  return { level: failed ? 'warn' : 'info', text: parts.join(' ') }
}
