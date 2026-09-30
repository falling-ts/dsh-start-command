/**
 * dsh-start-command `agent/pre-step` hook — decides whether this step is the
 * moment to run the configured start command, then runs it and records the
 * outcome.
 *
 * `agent/pre-step` is the waterfall the official Claude Code bridge maps
 * `UserPromptSubmit` onto, and it is the last extension point BEFORE request
 * derivation: the loop awaits this waterfall, then assembles and dispatches the
 * model request. Awaiting the command here therefore satisfies "run it before
 * the request reaches the model" without touching the agent loop.
 *
 * The plugin's opening condition, in one sentence: **the user submitted a
 * prompt and nothing else in the harness is executing**. That decomposes into
 * five gates, all of which must hold:
 *
 * 1. a command is configured (a blank one skips everything, no side effects);
 * 2. `step === 1` — the first model step of the turn, so a mid-turn steering
 *    message or a later tool-loop step never re-runs it;
 * 3. the step claims at least one message — the user actually sent something,
 *    rather than the loop waking itself (goal rounds, reminders);
 * 4. no OTHER agent is running, read from the live agent registry — this is the
 *    "no agent is executing" half, and it is what keeps a subagent's own first
 *    step (the lead is still running) from firing the command;
 * 5. the session is not a subagent's own session (`header.origin`), whose
 *    messages come from the parent agent rather than from the user.
 *
 * A per-session turn latch then makes the decision idempotent: at most one run
 * per turn, marked BEFORE the command is awaited so a re-entrant step cannot
 * start a second one.
 *
 * @module @falling-ts/dsh-start-command/pre-step
 */

import { readStartCommand } from '../core/settings.js'
import { describeOutcome, runStartCommand } from '../core/runner.js'

/** Sessions whose turn latch is remembered; bounds process memory. */
const MAX_TRACKED_SESSIONS = 256

/** sessionId -> the highest turn already served (process-local, never durable). */
const servedTurns = new Map()

/** Read an optional Host service without assuming it is mounted. */
function serviceOf(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Forget every remembered turn. Exists for probes; the Host never calls it. */
export function clearLatches() {
  servedTurns.clear()
}

/**
 * Record that `turn` of `sessionId` has been served, evicting the oldest entry
 * once the bound is reached (insertion order is the Map's iteration order).
 * @param {string} sessionId
 * @param {number} turn
 */
export function markServed(sessionId, turn) {
  servedTurns.delete(sessionId)
  servedTurns.set(sessionId, turn)
  while (servedTurns.size > MAX_TRACKED_SESSIONS) {
    const oldest = servedTurns.keys().next()
    if (oldest.done === true) break
    servedTurns.delete(oldest.value)
  }
}

/**
 * Whether this turn was already served for this session.
 * @param {string} sessionId
 * @param {number} turn
 * @returns {boolean}
 */
export function alreadyServed(sessionId, turn) {
  const last = servedTurns.get(sessionId)
  return typeof last === 'number' && last === turn
}

/**
 * Whether any live agent other than `agent` is currently running.
 *
 * An unmounted registry (a composition without the agent service) answers
 * `false`: the gate exists to suppress the command while work is in flight, and
 * a host that cannot tell must not silently suppress the feature forever.
 * @param {object} ctx host plugin context
 * @param {object} agent the agent proposing this step
 * @returns {boolean}
 */
export function otherAgentRunning(ctx, agent) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.list !== 'function') return false
  try {
    const all = agents.list()
    if (!Array.isArray(all)) return false
    return all.some((other) => other !== agent && other !== null && other !== undefined && other.status === 'running')
  } catch {
    return false
  }
}

/**
 * The structural gates (2..5 above), without the latch and without touching the
 * configured command. Pure with respect to plugin state, so a probe can assert
 * each refusal reason directly.
 * @param {object} ctx host plugin context
 * @param {object} payload the `agent/pre-step` payload
 * @returns {{ ok: boolean, reason: string }} `ok:true` with reason `'qualifies'`,
 *   otherwise the first failing gate's stable token.
 */
export function qualifies(ctx, payload) {
  if (payload.step !== 1) return { ok: false, reason: 'not-first-step' }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return { ok: false, reason: 'no-user-messages' }
  }
  const agent = payload.agent
  if (agent === null || agent === undefined) return { ok: false, reason: 'no-agent' }
  const session = agent.session
  if (session !== null && session !== undefined && session.header !== undefined
    && session.header !== null && session.header.origin === 'subagent') {
    return { ok: false, reason: 'subagent-session' }
  }
  if (otherAgentRunning(ctx, agent)) return { ok: false, reason: 'other-agent-running' }
  return { ok: true, reason: 'qualifies' }
}

/**
 * Decide and, when every gate holds, run the configured start command.
 *
 * Never throws: the caller is an `agent/pre-step` waterfall listener, and a
 * start command must be unable to corrupt a model request.
 *
 * @param {object} ctx host plugin context
 * @param {object} payload the `agent/pre-step` payload (`{ agent, messages, turn, step, signal }`)
 * @returns {Promise<{ ran: boolean, reason: string, command?: string,
 *   sessionId?: string, turn?: number, durationMs?: number }>} the outcome,
 *   whose `reason` is `'no-command'`/`'already-served'`/a gate token, or the
 *   {@link runStartCommand} outcome when the command was attempted.
 */
export async function maybeRunStartCommand(ctx, payload) {
  const agent = payload === null || payload === undefined ? undefined : payload.agent
  const session = agent === null || agent === undefined ? undefined : agent.session
  const sessionId = session === null || session === undefined ? undefined : session.id

  const command = readStartCommand()
  if (command === undefined) return { ran: false, reason: 'no-command' }

  const gate = qualifies(ctx, payload)
  if (!gate.ok) return { ran: false, reason: gate.reason }

  if (typeof sessionId === 'string' && alreadyServed(sessionId, payload.turn)) {
    return { ran: false, reason: 'already-served' }
  }
  if (typeof sessionId === 'string') markServed(sessionId, payload.turn)

  const cwd = session !== null && session !== undefined && session.header !== null
    && session.header !== undefined && typeof session.header.cwd === 'string'
    ? session.header.cwd
    : undefined
  const outcome = await runStartCommand(ctx, {
    command,
    ...cwd === undefined ? {} : { cwd },
    ...payload.signal === undefined ? {} : { signal: payload.signal },
    ...session === undefined ? {} : { session },
  })
  const line = describeOutcome(command, outcome)
  try {
    if (line.level === 'warn') ctx.logger.warn(line.text)
    else ctx.logger.info(line.text)
  } catch { /* a logging failure must not fail the step */ }
  return {
    ...outcome,
    command,
    ...sessionId === undefined ? {} : { sessionId },
    turn: payload.turn,
  }
}
