# AGENTS.md — dsh-start-command

本规则适用于 `dsh-start-command/`，并补充[集合约定](../AGENTS.md)。

## 插件定位

一句话：**在你主动发送一条对话、且当前没有任何 agent 正在运行时，于这条消息正式发给大模型
之前，先在会话的工作目录里执行一条配置好的系统命令。**

- 命令的**输出绝不进入模型请求**，只写宿主日志。这是刻意的：任意 shell 输出塞进上下文会同时
  污染 token 预算与 KV 缓存，且违反"模型可见 ⟺ 已落盘"的取向（本插件**不**新增任何模型可见的
  输入，因此也不需要新的会话事件）。
- 想让模型看见结果，就让命令把它写进文件、再让模型去读那个文件。
- **空值 = 不执行**：配置项为空（或全为空白字符）时整个路径短路，不碰 shell 执行器、不写任何
  运行日志。这不是"缺 referent 时静默跳过"——配置项本身存在且默认就是空，空即"未启用"。

## 挂载缝：`agent/pre-step`（waterfall）

- 官方 Claude Code 桥把 `UserPromptSubmit` 映射到这条缝
  （`packages/hooks/hooks-claude-code/src/index.ts`），它是**请求派生之前**的最后一个扩展点。
- 签名（`packages/core/agent/src/runtime-types.ts`）：
  `'agent/pre-step'(this: Scoped<Agent>, payload: { agent, messages, turn, step, signal }, next: () => Promise<PreStepDecision>)`；
  `PreStepDecision = { kind:'reject' } | { kind:'enter', messages, startsRequestSeries? }`。
- **委托顺序**：监听器**先 `await next()`**，只有下游不是 `reject` 时才执行命令。这样"下游会拒绝
  的步骤"绝不会白跑一条命令，而 `next()` 仍然恰好被调用一次（waterfall 契约）。
- 监听器本身**绝不抛**：命令路径的任何异常都在内部吞掉并记 warn，返回值原样透传下游决定。
- 不碰 agent 循环：新行为一律挂已文档化的扩展点。

## 五道门与回合闩锁（`src/hooks/pre-step.js`）

`qualifies()` 是纯函数（不读配置、不碰插件状态），供探针逐条断言；`maybeRunStartCommand()`
按下面的顺序短路，`reason` 是稳定 token：

| # | 门 | 判据 | 不通过时的 reason |
|---|----|------|------------------|
| 0 | 已配置命令 | `readStartCommand()` trim 后非空 | `no-command` |
| 1 | 回合的第一个步骤 | `payload.step === 1` | `not-first-step` |
| 2 | 确实有人发话 | `Array.isArray(messages) && messages.length > 0` | `no-user-messages` |
| 3 | 有调用方 agent | `payload.agent != null` | `no-agent` |
| 4 | 不是子代理自己的会话 | `agent.session.header.origin !== 'subagent'` | `subagent-session` |
| 5 | 没有别的 agent 在跑 | `ctx.get('agents').list()` 里存在 `other !== agent && other.status === 'running'` | `other-agent-running` |
| 6 | 本回合未服务过 | `servedTurns` 闩锁 | `already-served` |

- **门 5 是 fail-open**：`agents` 服务缺席、`list()` 抛异常、返回值不是数组时一律**放行**。理由：
  这道门的存在意义是"有活在飞时压制"，而一个判断不了拓扑的宿主不该把功能永久静音。
- **闩锁**：`servedTurns: Map<sessionId, turn>`，上限 `MAX_TRACKED_SESSIONS = 256`，超限按插入序
  淘汰最旧（内存有界）。**先 `markServed` 再 `await` 命令**，所以重入的 pre-step 不会并发出第二条
  命令；被门禁拒绝的调用**不**消耗闩锁（同一回合内门禁后来放开仍可执行）。
- 客户端与宿主都不依赖"回合"以外的编号语义：`turn` 来自 harness 载荷，插件不自己推算。

## 执行路径：一律走 `ctx.shell`

`src/core/runner.js` 用**挂载的 shell 执行器**（`ctx.get('shell')`，需有 `resolve` + `execute`），
而不是自己 `node:child_process`：

- **沙箱策略**由执行器施加——命令与 agent 自己的命令落在**同一条围栏**内，不会静默绕过；
  `resolveSandboxPolicy()` 按调用会话 `ctx.get('sandboxPolicy').resolve({ session })`，解析失败则
  不传该字段（交给执行器按部署策略默认）。
- **deadline** 归执行器所有（`timeoutMs` 与上限由实现决定，到期杀进程组）。
- **取消**：把本回合的 `payload.signal` 交给执行器，所以"停止回合"能杀掉一条挂住的开始前命令，
  它不可能活过它阻塞的那个步骤。
- **工作目录**：会话 `header.cwd`；会话没有 cwd 时不传 `workdir`（交给执行器默认）。
- **失败策略**：非零退出 / 超时 / 中止 / 执行器缺席 / 执行器抛异常，全部收容为一条日志
  （成功 info、其余 warn；`describeOutcome()` 把 `timedOut`、`aborted` 与普通失败区分开），
  并截断 stdout/stderr 尾巴（`LOG_TAIL_CHARS = 400`）。**绝不**抛入 waterfall、绝不拒绝该步骤。

**实测坑（2026-09-30）**：pwsh 的 `echo … >> file` 落盘是 **UTF-16LE + BOM**，宿主的 `read`
工具会把它判为 `binary file` 而**拒读**（`Error: cannot read "…": binary file …`）。
写标记类文件请用 `Add-Content -Encoding ascii`；读回这类文件要按 BOM 判定解码
（`exploration/sc-e2e-probe.mjs` 两处都做了）。

## 设置面

- `src/core/settings.js`：`NS = 'falling-ts-start-command'`、`COMMAND_FIELD = 'startCommand'`、
  `buildConfigSchema() = z.object({ startCommand: z.string().default('').volatile() })`。
- **命名空间 = 该 profile 条目的 loader id**，所以 `cordis.patch.yml` 的 `insert[].id`、客户端常量
  `NS_SETTINGS`、宿主 `NS` 三者必须逐字相同；`sc-prestep-probe.mjs` 第一组断言就是这条
  （不一致的表现是**静默**读不到值，不报错）。
- 只有 `.volatile()` 字段可被表单写；宿主每次读都走 `readConfigField()` → 改完**下一个回合**生效，
  不需要重启。
- 设置表单声明走**惰性** `ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`
  ——`settings` 服务挂载晚于本插件的 boot effect，且 `configure({ auto: false })` 告诉 harness
  本插件自带页面（客户端半部注册 `settings.section`），不要自动生成一个。
- `resolveZ()` 兜两种布局：裸说明符 `@deepseek-ai/schemastery`，失败则从本文件向上 8 跳找
  `deepseek-harness/vendor/schemastery/lib/index.mjs`（用 `file://` URL 导入，Windows 必需）。
  本插件是**独立仓库**，自己 `node_modules` 里没有 schemastery，这条兜底是它在 standalone
  工作树里也能被 import 的原因。两者都失败时 `Config` 为 `undefined`：入口没有设置表单，
  钩子什么都不跑（而不是崩）。

## 客户端半部（`web/client.js`）

- `window.__ModuleLoader__.load({ id: "@falling-ts/dsh-start-command", factory })`——`id` 逐字等于包名。
- Cordis `inject = ["slots", "locale", "configForms"]`；`@deepseek-ai/dsh-client-store` 是
  `PLATFORM_MODULES` 的基线模块，**不**写 `dsh.client.external`（重复基线会被
  `verify-client-packages` 判违规）。
- 值来源：`ctx.configForms.get(NS_SETTINGS)`（0.1.7 起取代 `ctx.settingsScope`）→
  `createSnapshotStore` 镜像 `getSnapshot()`/`subscribe()`；写回用 `scope.set(field, value)`。
  快照三态 `'loading' | 'ready' | 'unavailable'`，本分区分三种渲染（不可用 / 加载中 / 表单）。
- 分区注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id: "start-command",
  order: 90, label: () => tr("nav"), inject: () => ({ hooks: { startCommand: store }, update }) }, StartCommandSection))`。
- 文本框是**本地缓冲**（`BufferedCommandInput`）：失焦 / 回车 / 点「保存」且 `draft !== committed`
  时才提交一次；外部值变化会同步进缓冲，提交后两侧一致。
- 文案全部经 `ctx.locale.bind(NS)`；zh 是键集事实源，en/ja/ko 必须逐键对齐（缺键静默回落到 en，
  故由 `i18n-parity-probe.mjs` 守住）。ja/ko 经 `locale.addLanguage` 作为**语言包**贡献，容忍
  兄弟插件已注册同一 id 的 `is already registered`（其余错误照抛）。
- 主题：注入 `<style id="falling-ts-theme-tokens">`（按 id 幂等，规则与同集合插件**逐字相同**），
  组件只引用 `var(--fcts-*)`；暗色分支改指上游 `--dsw-alias-*` 语义别名。
- **零 RPC**：客户端不手拼 wire 信封、不自铸 rpcId、不读宿主 DOM 做定位。

## harness 0.2.0-rc.2 适配核对（2026-09-30）

peer 下界一律 `>=0.2.0-rc.1`（0.2.0 列车；**不收窄到 rc.2**——收窄只会让 0.2.0 的 boot 期 peer
预检在 rc.1 运行时静默禁用本插件）。逐缝核对：

- `agent/pre-step` 的载荷字段与 `PreStepDecision` 判别式未变（见上）。
- `ctx.agents.list(): Agent[]`（服务键 `agents`）与 `AgentStatus = 'idle' | 'running'` 未变。
- `ctx.shell.resolve(ShellExecRequest): ShellExecSpec` / `execute(ShellExecSpec): Promise<ShellExecution>`
  与 `execution.result()` 未变；`ctx.sandboxPolicy.resolve()` 仍在（`pwsh-sandbox` 自己就用它兜底）。
- `settings.configure({ auto }, owner)`、ConfigForm 五方法、`ctx.locale.bind/register/addLanguage`、
  `ctx.slots.inject('settings.section')`、`createSnapshotStore` 均未变。
- `session.header.origin === 'subagent'`（子代理标）未变。

## 验证

离线（可重复、不连实例）：

- `node exploration/sc-prestep-probe.mjs` —— **63 项**：命名空间三处一致、六组结构门禁（含
  `messages` 缺失不抛异常、注册表抛异常时 fail-open）、空值零副作用（不碰 shell、不写日志）、
  执行路径（命令原文、`workdir` 取会话 cwd、signal 透传、沙箱策略按会话解析并透传、非零退出/
  超时/中止/执行器缺席/执行器抛异常各自的收敛与日志级别）、回合闩锁（同回合拦重入、下一回合重跑、
  门禁拒绝不消耗闩锁、256 上限淘汰最旧）、waterfall 语义（下游决定原样返回、下游 reject 时绝不
  执行、命令抛异常不污染返回值、`next()` 恰好一次、apply 只注册一个监听器、设置表单走
  `ctx.inject`）。
- 三个共用门禁已把本插件纳入：`plugin-manifest-check.mjs`（严格 JSON + peer 纯下界 + locale/icon/
  exports/files 覆盖，4 个 manifest）、`i18n-parity-probe.mjs`（74 项，四词典对齐 + 词典外零硬编码
  CJK）、`theme-token-probe.mjs`（46 项，三插件 token 表逐字相同 + 暗色对比度 + 浅色未漂移）。

线上端到端（3080 实例，`DSH_HOME=~/.dsh-web`）：

- `node exploration/sc-e2e-probe.mjs 3080` —— **17 项**，真实回合两连：① 写入命令 → 建会话 → 发提示词，
  断言**标记文件里恰好出现 1 行本次标记**（命令确实执行了一次）、**该文件 mtime 早于本回合首条
  `assistant/message`**（命令在模型开始回答之前就已结束）、**模型在第一个步骤里成功读取并复述了
  标记**（命令产物在首个步骤就已就位，不是后续步骤补上的）、回合 `reason=completed`；② 清空命令
  后再发一次，断言标记文件**不增长**、宿主日志**不新增** `[start-command]` 行。探针在 `finally`
  里把设置**还原**成本次运行前的值。
- `node exploration/sc-settings-ui-probe.mjs 3080` —— **7 项**，真浏览器（Playwright/chromium）验证
  客户端半部那三个缝：设置导航里点得开「开始前命令」、分区里有文本框与「保存」按钮、**输入框初值
  等于宿主当前值**（读路径）、**在界面里改值并点「保存」后宿主 `user.startCommand` 随之改变**
  （写路径确实走了 `scope.set`）、再改回原值也生效、页面无未捕获异常。渲染文本与截图落在
  `exploration/sc-settings-ui.txt` / `sc-settings-section.png`；设置同样在 `finally` 里还原。
- `pluginInventory/list`：`@falling-ts/dsh-start-command` `enabled:true` / `fiberPhase:active`，
  显示元数据（en `Start command` / zh `开始前命令` + `icon`）正常解析；
  `settings/describe` 出现 `falling-ts-start-command`，`autoGenerate:false`、`applies:"live"`。
- 已知观测（2026-09-30 查明机制）：插件的 `ctx.logger` 输出**在这两个部署里都不落盘**——
  两个 profile 的 `cordis.yml` 都没有 `logger` 条目，即没挂
  `@deepseek-ai/cordis-plugin-logger-console`（console exporter），而 cordis 的 logger
  没有 exporter 就等于丢弃。于是 `dsh-web-3080.log` 里只有**直接 `console.log`** 的行：
  判据是 `[dsh-local-no-auth] active`（`console.log`）、`[force-compact] BUILTIN ENGINE
  LOADED`（`console.log`）都在，而 force-compact 启动时必然执行的
  `ctx.logger.info('[force-compact] apply START/END')` 一行都没有。唯一会落盘的 logger 记录是
  app-boot 的**启动失败**转储 `$DSH_HOME/logs/startup-*.log`（只收 warn/error、只在启动失败时写；
  force-compact 那份 `dsh-force-compact.log` 是它**自己**装了 `ctx.logger.exporter`）。
  所以"日志里查不到 `[start-command] … exit=…`"是部署性质、不是插件缺陷：判据始终是标记文件
  与会话记录；真要留证据，就让命令自己写日志——
  `node <仓库>/test-start.js --wait *>&1 | Out-File -LiteralPath <file> -Encoding ascii`
  （别用 `>` / `>>`，pwsh 会写成 UTF-16LE+BOM，宿主 `read` 判其为 binary 而拒读）。
  **补充（同日查明）**：`~/.dsh/logs/dsh-force-compact.log` **不能**当"别的插件有没有加载"的
  证据——那个 exporter 在出口处按 `[force-compact]` 标记过滤（`src/core/log.js` 的
  `shouldInclude`），别的命名空间的行根本不写。另一个推论：**中途装上的插件无法用"当回合"
  验证**，门 1 是 `payload.step === 1`（每回合只在第一个模型步骤执行），本回合的 step 1 早已
  过去——判据必须是**新回合**。
- `node exploration/sc-live-verify.mjs 3080` —— **门 5 的两支活体表现**：① 先轮询**等到
  `session/list` 里没有任何 `running:true`**，再发真实回合，断言命令执行（正例）；② 会话 A 的
  回合还在 running 时投递会话 B，断言 B **不执行**命令、但 B 的回合照常跑完（反例，证明压制
  不是卡住）；`--demo`（旧名 `--toast` 仍接受）追加第三段，用工作区根的 `test-start.js`
  （`--text=sc-live-verify --no-launch`，headless）验一次真实命令，并断言标记里的 `text=`
  正是本次写进命令的那一个（默认关闭：那个文件属于容器仓库、不属于本插件）。
  退出码 **2 = 拿不到干净窗口**（环境不满足，不是缺陷）。
- 工作区根的 `test-start.js`（不属于本插件）是这套链路的**可视 demo**：默认动作是
  **在屏幕右下角新弹一个自绘窗口**（`popup` 模式，写着 `Harness 开始了。` + `第 N 次执行 · 时刻`
  + 会话工作目录），**每次执行都新开一个窗口**（叠着往上排），不合并、不替换、不受系统通知策略
  影响，默认 9 秒淡出、点一下立即关（`--sticky` 不自动关、`--duration=` / `--silent` / `--focus` /
  `--text=` / `--no-launch` 可调；`--notepad` / `--notify` / `--toast` / `--card` 是旧行为）。
  枚举窗口用 `node exploration/win-window-probe.mjs [标题子串] [--all]`。
  **它在这条链上验证出的一条硬结论（2026-09-30，对任何"必须活过这条命令"的动作都成立）**：
  宿主那条命令是以自己的 shell 执行的，命令一退出它的进程树就跟着走，所以
  - `spawn(…, { detached: true })` 在本机是**假成功**：实测四种起法各写一个"12 秒后我还活着"
    的文件，detached 那个**连启动都没启动**（`started=False`），普通子进程也活不过 12 秒；
  - 真正活下来的是 **`Start-Process` 的孙进程**与 **WMI `Win32_Process.Create` 建的进程**。
  `test-start.js` 因此按 ① `Start-Process`（`-WindowStyle Hidden`，不影响 WinForms 窗口显示）→
  ② WMI → ③ 直接 spawn 的顺序派发，每档以"动作进程有没有刷新
  `%TEMP%\dsh-start-command-child.txt`"为准，stdout 打 `dispatched via=start-process confirmed=Y`。
  写这类命令时的教益：**别相信"我发出去了"，要有一个动作进程自己写的落地信号**。
- **装到一半的插件无法用"当回合"验证**（同日实测的推论）：门 1 是 `payload.step === 1`，插件若在
  本回合中途才装上，这一回合永远不会再触发——**用户的下一条消息**才是判据。

> **测这条链时最容易踩的坑：探针发起者自己就是那个"在跑的 agent"。** 2026-09-30 实测：本会话
> 就跑在 3080 这台 host 上（`session/list` 里一直是 `running:true`），于是我**在自己的回合里**
> 连发三个真实回合去测开始前命令，三次都没执行——因为"我"正是门 5 要压制的那一个。当时的
> 判据是 `session/list` 的 `running` 字段，**不是**看标记文件：把命令换成不依赖 node 的
> `Add-Content` 做隔离后同样不执行，才排除掉命令本身的嫌疑。要自动化复现，必须等空窗
> （`sc-live-verify.mjs` 就是为此写的），或者在一个只有你自己的隔离实例上测
> （`PORT=3099 DSH_HOME='D:/…/.dsh-verify'`，见根 AGENTS.md）。

## 官方规范符合性（2026-09-30）与已知偏离

符合：`dsh.bundle.patch` 指向 `./cordis.patch.yml` 且按**包名**引用；`exports` 含 `./client`、
`./locale/*.json`、`./package.json`；`files` 覆盖全部运行时入口（`index.js`/`src/`/`web/`/
`cordis.patch.yml`/`locale/*.json`/`icon.svg`）；`icon` 为相对路径 SVG 且远小于 256 KiB；
`locale/{en,zh}.json` 的 `meta.{title,description}` 齐备；只具名导出 `name`/`Config`/`apply`、
**无 default export**；注册即 effect（`ctx.on` 监听、`ctx.effect` 管样式表/词典/订阅/语言目录项）；
可选服务一律 `ctx.get`/惰性 `ctx.inject`；客户端不写 `dsh.client.external`；UI 文案全走 locale。

有意保留的偏离（勿"顺手修"）：

1. **peer 只声明 `peerDependencies`（+ optional meta），不声明 `devDependencies`**：本插件是 plain JS、
   没有独立类型检查与测试工程，profile 里由 dsh 提供实例。
2. **`--fcts-*` token 表的浅色分支保留字面值**：与集合约定一致——组件本身只引用 `var()`，
   字面量只活在 token 表里；改成上游别名会让浅色外观漂移。
3. **命令输出不进模型上下文**：见"插件定位"。这是本插件的核心取向，不是遗漏。
4. **`agent/pre-step` 上的"吞掉异常"**：与官方 hook 协议一致（钩子失败不该让这一回合失败），
   代价是失败只体现在宿主日志里——因此日志级别把"没执行成"一律标 warn。

## 状态与约束

- **无 timer、无持久化**。唯一的进程内存态是 `servedTurns`（256 上限、FIFO、随进程消失）。
  探针用的 `clearLatches()` 是导出的测试缝，宿主从不调用。
- 命令**永远**在会话的工作目录里运行，不是插件的、也不是部署的。
- 命令是**一条命令行**（经 shell 解释），不是脚本文件；多语句请自行用 `;` / `&&` 组合。
- 新增能力时守住两条红线：① 输出不进模型请求（除非另开一条明确的设计）；② 只经 `ctx.shell`
  执行，绝不自己 spawn（否则绕过沙箱、deadline 与取消）。
