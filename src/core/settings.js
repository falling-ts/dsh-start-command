/**
 * dsh-start-command settings — one field, `startCommand`.
 *
 * The field is deliberately the ONLY tunable: the plugin's whole behavior is
 * "run this command, or skip when it is blank". Everything else (working
 * directory, timeout, sandbox mode) is supplied by the harness around it — the
 * session's cwd, the mounted shell executor's own deadline, and the resolved
 * per-session sandbox policy — so there is nothing else for a user to get
 * wrong here.
 *
 * Harness 0.1.7 replaced the old `settings.register(ns, schema, { base })` API
 * with a Config-driven model: the plugin exports `Config`, the settings form
 * namespace is the LOADER ENTRY ID (`falling-ts-start-command`, see
 * cordis.patch.yml), defaults come from `.default()`, and only `.volatile()`
 * fields may be written by the form.
 *
 * @module @falling-ts/dsh-start-command/settings
 */

/** The settings form namespace key. It MUST equal this plugin's LOADER ENTRY ID
 *  (`falling-ts-start-command`, see cordis.patch.yml): harness derives the form
 *  namespace from `entry.options.id`, and the client half addresses it by that id. */
export const NS = 'falling-ts-start-command'

/** The single settings field: the command line, or `''` to skip. */
export const COMMAND_FIELD = 'startCommand'

/** Defaults — the schema `.default()` values in {@link buildConfigSchema}. */
export const DEFAULTS = Object.freeze({
  startCommand: '',
})

/**
 * Live Config refs handed to `apply`. The Host hook reads the command through
 * this holder on every turn, so a settings-form edit is picked up on the next
 * read (the ConfigForm volatile-commit contract). Set once by the plugin entry.
 */
let liveConfig

/**
 * Bind the resolved plugin Config.
 * @param {object|undefined} config schemastery-resolved Config (volatile refs).
 */
export function bindConfig(config) {
  liveConfig = config
}

/**
 * Read ONE live config field. Never throws.
 * @param {string} field
 * @returns {unknown} the current value, or `undefined` when unset/unavailable.
 */
export function readConfigField(field) {
  try {
    const ref = liveConfig === null || liveConfig === undefined ? undefined : liveConfig[field]
    if (ref === undefined || ref === null || typeof ref.get !== 'function') return undefined
    return ref.get()
  } catch {
    return undefined
  }
}

/**
 * Read the configured command, normalized: a non-string or blank value means
 * "not configured".
 * @returns {string|undefined} the trimmed command line, or undefined to skip.
 */
export function readStartCommand() {
  const raw = readConfigField(COMMAND_FIELD)
  if (typeof raw !== 'string') return undefined
  const command = raw.trim()
  return command === '' ? undefined : command
}

/**
 * Resolve the schemastery `z` constructor, tolerating BOTH layouts:
 *  - a monorepo/dev layout where `@deepseek-ai/schemastery` resolves as a
 *    bare specifier;
 *  - this plugin as a STANDALONE repo whose node_modules lacks schemastery
 *    (it lives in the sibling `deepseek-harness/vendor/` copy). Then walk up
 *    from this file looking for the vendored build and import it via a
 *    file:// URL (required on Windows).
 * @returns {Promise<object|undefined>} resolved `z`, or undefined.
 */
async function resolveZ() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const z = mod.default ?? mod
    if (typeof z.object === 'function') return z
  } catch { /* fall through to candidate 2 */ }
  try {
    const { fileURLToPath, pathToFileURL } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let hop = 0; hop < 8; hop += 1) {
      const cand = join(dir, 'deepseek-harness/vendor/schemastery/lib/index.mjs')
      if (existsSync(cand)) {
        const mod = await import(pathToFileURL(cand).href)
        const z = mod.default ?? mod
        if (typeof z.object === 'function') return z
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* candidate 2 unavailable */ }
  return undefined
}

/**
 * Build the plugin's schemastery `Config` — the settings form namespace the
 * Loader auto-derives for this entry.
 *
 * Returns `undefined` when schemastery is unresolvable: the entry then simply
 * has no settings form, and the Host hook falls back to {@link DEFAULTS}
 * (i.e. never runs anything).
 * @returns {Promise<object|undefined>}
 */
export async function buildConfigSchema() {
  try {
    const z = await resolveZ()
    if (z === undefined) return undefined
    return z.object({
      startCommand: z.string().default(DEFAULTS.startCommand).volatile(),
    })
  } catch {
    return undefined
  }
}
