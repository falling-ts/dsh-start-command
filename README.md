# dsh-start-command

A DSH Cordis plugin that runs **one configured shell command before the model
request of a turn** — but only when **you** submitted the prompt and **no other
agent is running** at that moment.

Think of it as a `UserPromptSubmit` hook for DSH: `git pull`, `npm ci`, a
cache refresh, a timestamped manifest — anything that should have happened
*before* the message reaches the model, without the model having to spend a
tool call on it.

The command output is **never** put into the model request: it goes to the Host
log only. If you want the model to see something, point the model at a file and
let the command write it.

## What it does

| Layer | What happens |
|-------|--------------|
| Host (`index.js` + `src/`) | Registers a waterfall listener on **`agent/pre-step`** — the extension point the official Claude Code bridge maps `UserPromptSubmit` onto, and the last point before request derivation. It delegates through `next()` first, so a listener further down that rejects the step still wins and the command never runs. When the step qualifies it awaits one command through the mounted **shell executor** (`ctx.shell`), under **this session's sandbox policy** and the running turn's `AbortSignal`. |
| Browser (`web/client.js`) | Adds the **Start command** section to Settings: one text input plus a Save button, a state line when the value is blank, and two explanatory paragraphs (when it runs / how it runs). The value is read and written through the official `configForms` mirror — the client half issues no RPC of its own. |

## When it runs

All of these must hold, otherwise the command is skipped:

1. a command is configured (a blank value skips everything, with no side effects);
2. it is the **first model step of the turn** — mid-turn steering and later
   tool-loop steps never re-run it;
3. the step claims at least one message, i.e. you actually sent something
   rather than the loop waking itself;
4. **no other agent is running** (read from the live agent registry), which is
   what keeps a subagent's own first step from firing it;
5. the session is not a subagent's own session.

A per-session turn latch then makes it idempotent: at most one run per turn.

The command runs in the **session's working directory**, so relative paths mean
what they mean for that session.

## Install

```bash
dsh plugin --profile web add github:falling-ts/dsh-start-command
```

Requires harness `>=0.2.0-rc.1` (peer range: `@deepseek-ai/cordis >=4.0.4`,
`@deepseek-ai/schemastery >=3.18.4`, `@deepseek-ai/dsh-* >=0.2.0-rc.1`).
The `dsh.bundle.patch` declaration in `package.json` activates the patch layer;
`dsh.client` ships the browser half.

## Configuration (`falling-ts-start-command` namespace)

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `startCommand` | string | `''` | The command line to run before the model request. Blank (or all whitespace) runs nothing. |

Edit it from **设置 → 开始前命令**, or from the profile's `cordis.patch.yml`.
The value is volatile, so a saved edit is picked up on the next turn — no
restart.

## Behavior on failure

A non-zero exit, a timeout, a cancelled turn, a missing shell executor — each is
contained: the Host logs one line (with the exit code and a short stdout/stderr
tail) and the turn proceeds as if the command had succeeded. A start command can
never block or corrupt a model request.

## Development

Plain JavaScript, no build step. The Host half is Node ESM, the browser half is a
`__ModuleLoader__.load({ id, factory })` artifact.

```bash
# install a local checkout into a profile (link:, so source edits are live)
dsh plugin --profile web add /path/to/dsh-start-command

# offline check of the gates, the execution path and the waterfall semantics
node exploration/sc-prestep-probe.mjs
```

See `AGENTS.md` for the plugin's own rules (the five gates, why the command runs
through `ctx.shell`, and what it deliberately does not do).

---

## License

MIT
