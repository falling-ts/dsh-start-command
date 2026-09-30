# dsh-start-command（开始前命令）

一个 DSH Cordis 插件：**在你主动发送一条对话、且当前没有任何 agent 正在运行时**，于这条消息
正式发给大模型**之前**，在会话的工作目录里执行**一条**配置好的系统命令。

可以把它当作 DSH 版的 `UserPromptSubmit` 钩子：`git pull`、`npm ci`、刷新缓存、
写一份带时间戳的清单——任何"应该在消息到达模型之前就已经做完、又不值得让模型花一次工具
调用去做"的事。

命令的输出**绝不**进入模型请求，只写宿主日志。想让模型看见结果，就让命令把它写进文件，
再让模型去读那个文件。

## 它做什么

| 层 | 行为 |
|----|------|
| Host（`index.js` + `src/`） | 在 **`agent/pre-step`** 上注册一个 waterfall 监听器——官方 Claude Code 桥把 `UserPromptSubmit` 映射到这条缝，它也是请求派生之前的最后一个扩展点。监听器**先**经 `next()` 委托：下游若拒绝该步骤，它的决定获胜，命令绝不执行。步骤合格时，它经**挂载的 shell 执行器**（`ctx.shell`）等待一条命令跑完，沿用**本会话的沙箱策略**与本回合的 `AbortSignal`。 |
| 浏览器（`web/client.js`） | 在设置页加一个**「开始前命令」**分区：一个文本框 + 「保存」按钮，空值时提示一行状态，另有两段说明（执行时机 / 执行方式）。取值经官方 `configForms` 镜像读写——客户端半部不自己发起任何 RPC。 |

## 什么时候会执行

下面每一条都必须成立，否则跳过：

1. 配置了命令（留空则完全跳过，零副作用）；
2. 是**本回合的第一个模型步骤**——回合中途的插话与后续工具步骤都不会重复执行；
3. 该步骤至少带来一条消息，即确实是你发了话，而不是循环自唤醒；
4. **没有别的 agent 正在运行**（读实时 agent 注册表）——这正是子代理自己的首个步骤不会触发它的原因；
5. 该会话不是子代理自己的会话。

之后由一个**按会话的回合闩锁**保证幂等：每个回合至多执行一次。

命令在**会话的工作目录**里运行，因此相对路径的含义与该会话一致。

## 安装

```bash
dsh plugin --profile web add github:falling-ts/dsh-start-command
```

要求 harness `>=0.2.0-rc.1`（peer 范围：`@deepseek-ai/cordis >=4.0.4`、
`@deepseek-ai/schemastery >=3.18.4`、`@deepseek-ai/dsh-* >=0.2.0-rc.1`）。
`package.json` 里的 `dsh.bundle.patch` 负责激活补丁层，`dsh.client` 负责发布浏览器半部。

## 配置（`falling-ts-start-command` 命名空间）

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `startCommand` | string | `''` | 模型请求之前要执行的命令行。空白（或全为空白字符）则不执行任何东西。 |

可在**设置 → 开始前命令**里改，也可以改 profile 的 `cordis.patch.yml`。
该字段是 volatile 的：保存后**下一个回合**即生效，不需要重启。

## 失败时的行为

非零退出、超时、回合被取消、执行器缺席——每一种都被收容：宿主只写一条日志（带退出码与
stdout/stderr 的短尾巴），本回合照常继续，如同命令成功了一样。开始前命令**永远**不会阻塞
或污染一次模型请求。

## 开发

纯 JavaScript、无构建步骤。Host 半部是 Node ESM，浏览器半部是
`__ModuleLoader__.load({ id, factory })` 形式的 artifact。

```bash
# 把本地 checkout 装进 profile（link:，改源码即生效）
dsh plugin --profile web add /path/to/dsh-start-command

# 离线检查门禁、执行路径与 waterfall 语义
node exploration/sc-prestep-probe.mjs
```

插件自身的规则（五道门、为什么命令走 `ctx.shell`、以及它刻意**不**做的事）见 `AGENTS.md`。

---

## 许可证

MIT
