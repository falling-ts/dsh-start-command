/**
 * dsh-start-command — a DSH Cordis function plugin.
 *
 * Runs one configured shell command before the model request of a turn, but
 * only when the user submits a prompt while no agent is executing. The command
 * is the plugin's single setting ("开始前命令" / "Start command", registered by
 * the browser client half as a `settings.section`); a blank value skips
 * execution entirely.
 *
 * The Host half is a waterfall listener on `agent/pre-step` — the extension
 * point the official Claude Code bridge maps `UserPromptSubmit` onto, and the
 * last point before request derivation. It delegates through `next()` first, so
 * a listener further down that rejects the step still wins and the command
 * never runs for a step that will not reach the model. The command itself runs
 * through the mounted shell executor, inheriting its sandbox policy, deadline,
 * and cancellation (see src/core/runner.js).
 *
 * Layout:
 * - index.js            — this file; the Cordis plugin entry (listener registration).
 * - core/settings.js    — the `falling-ts-start-command` settings namespace (one field).
 * - core/runner.js      — the shell-executor call and its non-throwing outcome report.
 * - hooks/pre-step.js   — the gate (first step + user prompt + nobody else running) and the latch.
 * - web/client.js       — the browser half: registers the settings.section.
 *
 * @module @falling-ts/dsh-start-command
 */

import { bindConfig, buildConfigSchema } from './src/core/settings.js'
import { maybeRunStartCommand } from './src/hooks/pre-step.js'

/** @type {string} the function plugin's display name. */
export const name = 'start-command'

/**
 * The plugin's schemastery `Config` — the settings form namespace the Loader
 * auto-derives for this entry. `apply` receives the resolved values and the
 * Host hook reads them through `bindConfig`. Top-level await because
 * schemastery is resolved lazily (bare specifier first, vendored copy second).
 * `undefined` simply leaves the entry with no settings form, and the hook then
 * never runs anything.
 */
export const Config = await buildConfigSchema()

/**
 * Register the `agent/pre-step` listener and declare the plugin's own settings
 * form for the "开始前命令" surface.
 *
 * No boot-time `inject` is declared: the `settings` service mounts later than
 * this plugin's boot effect, so the form declaration rides a lazy `ctx.inject`.
 * `configure({ auto: false })` tells the harness this plugin ships its OWN page
 * (web/client.js registers a `settings.section`), so none must be generated.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object|undefined} config resolved plugin Config (schemastery volatile refs).
 */
const __applyInner = (ctx, config) => {
  bindConfig(config)

  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`[start-command] settings.configure declaration failed (cosmetic only) — ${message}`)
  }

  // ── agent/pre-step: run the configured command before the model request ──
  // The waterfall contract requires delegating through `next()` exactly once.
  // Delegating FIRST means a downstream rejection wins, so a command is never
  // run for a step that will not reach the model; the command is then awaited
  // before this listener returns, which is strictly before request derivation.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision !== null && decision !== undefined && decision.kind === 'reject') return decision
    try {
      await maybeRunStartCommand(ctx, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`[start-command] pre-step handler degraded (swallowed) — ${message}`)
    }
    return decision
  })

  ctx.logger.info('[start-command] active: agent/pre-step listener registered; own settings.section declared')
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object|undefined} config resolved plugin Config (schemastery volatile refs).
 */
export const apply = (ctx, config) => {
  try {
    return __applyInner(ctx, config)
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error)
    try {
      ctx.logger.error(`[start-command] apply FAILED — ${message}`)
    } catch { /* never */ }
    throw error
  }
}
