/**
 * dsh-start-command outcome log — one line per decision, on disk.
 *
 * Why this exists. `ctx.logger` output is not persisted by any deployment this
 * plugin runs in (no console exporter is mounted in either profile), so from the
 * outside "nothing appeared on screen" is indistinguishable from four different
 * situations: the command never ran, a gate refused it, the executor killed it,
 * or the command ran and failed quietly. The plugin already renders exactly the
 * line that answers this (`describeOutcome`); this module writes the same line
 * to a file the user can read.
 *
 * Properties kept deliberately boring:
 *
 * - **write-only**: nothing here is ever read back, so the plugin still holds no
 *   durable state — the log is evidence, not input;
 * - **never throws**: a logging failure must not fail a turn, so every error is
 *   swallowed (an unwritable path degrades to "no log", not to a broken turn);
 * - **bounded**: the file is trimmed to the most recent {@link KEEP_LINES} lines
 *   once it passes {@link MAX_BYTES}, so a long-lived instance cannot fill a disk;
 * - **path**: `DSH_START_COMMAND_LOG` when set to a non-empty value (probes and
 *   tests point this at a scratch file; an explicitly empty value disables the
 *   sink), else `$DSH_HOME/logs/dsh-start-command.log`, else
 *   `~/.dsh/logs/dsh-start-command.log`.
 *
 * @module @falling-ts/dsh-start-command/outcome-log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Trim threshold in bytes; the file keeps the newest {@link KEEP_LINES} lines. */
export const MAX_BYTES = 512 * 1024

/** Lines kept when the file is trimmed. */
export const KEEP_LINES = 200

/**
 * Where the outcome log lives, or `undefined` when the sink is disabled.
 *
 * Resolved on every write (not cached) so a probe can redirect it mid-run.
 * @returns {string|undefined} an absolute path, or `undefined` for "no sink"
 */
export function logFilePath() {
  const explicit = process.env.DSH_START_COMMAND_LOG
  if (typeof explicit === 'string') {
    if (explicit === '') return undefined
    return explicit
  }
  const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
    ? join(homedir(), '.dsh')
    : process.env.DSH_HOME
  return join(home, 'logs', 'dsh-start-command.log')
}

/** Keep only the newest `KEEP_LINES` lines of `file`, ignoring failures. */
function trimToRecentLines(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`)
  } catch { /* 裁剪失败就让它继续长,不影响本回合 */ }
}

/**
 * Append one decision line. Never throws, never blocks on anything but a local
 * synchronous write, and does nothing when the sink is disabled.
 * @param {string} line the line to record (no trailing newline required)
 */
export function appendOutcome(line) {
  try {
    const file = logFilePath()
    if (file === undefined || file === null) return
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX_BYTES) trimToRecentLines(file)
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志绝不失败一个回合 —— 这是本模块唯一的错误策略 */ }
}
