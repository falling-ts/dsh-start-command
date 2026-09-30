/**
 * dsh-start-command 浏览器半部:在设置页注册「开始前命令」分区。
 *
 * 这是一个闭包工厂 artifact:window.__ModuleLoader__.load({ id, factory }),
 * factory(require) 通过注入的 require 解析外部模块(react、
 * @deepseek-ai/dsh-client-store),并返回插件面 { name, inject, apply }。宿主半部
 * (根 index.js)与本文件是同一 package 的两个面:宿主半部由 main 入口加载,本文件由
 * exports["./client"] 导出,经 dsh.client 声明被 client module 系统自动组成并服务。
 *
 * 职责:
 *   1. 把 ui-settings 的 `configForms` 服务按命名空间 `falling-ts-start-command`
 *      镜像成 uSES 安全的 SnapshotStore —— 这就是设置区读取宿主配置的唯一入口。
 *   2. 注册 settings.section「开始前命令」分区:一个文本框(本地缓冲,失焦/回车/点
 *      「保存」才提交一次 scope.set),外加两块说明(执行时机、执行方式)。
 *
 * 分区只做读与写两个动作:命令的解析、执行、沙箱与取消全在宿主半部,本文件不发起
 * 任何 RPC,也不碰宿主 DOM。
 *
 * @module @falling-ts/dsh-start-command/client
 */

window.__ModuleLoader__.load({
  id: "@falling-ts/dsh-start-command",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    // 基线外部(web 平台预载):把 configForms 镜像成 uSES 安全的 SnapshotStore。
    // `createSnapshotStore` 的正确来源是 PLATFORM_MODULES seed 表内的静态包
    // `@deepseek-ai/dsh-client-store`;它在基线里,故不需要写 dsh.client.external
    // (重复基线反而会被 verify-client-packages 判违规)。
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");

    /** 宿主侧设置命名空间(必须等于该插件在 cordis.patch.yml 里的条目 id)。 */
    const NS_SETTINGS = "falling-ts-start-command";

    /** 该分区拥有的文案命名空间。 */
    const NS = "settings.startCommand";

    /** 与宿主 src/core/settings.js 的 COMMAND_FIELD 一致。 */
    const COMMAND_FIELD = "startCommand";

    /** 必需服务(slots 提供分区注册;configForms 由 ui-settings 提供;locale 提供词典与 t)。 */
    const inject = ["slots", "locale", "configForms"];

    /**
     * 翻译入口。apply 时绑定到 ctx.locale.bind(NS)——绑定函数保留稳定身份、按调用
     * 时刻读取活动语言,故切换语言不需要重注册任何东西。所有产品可见文案都经它取词,
     * 代码里不留硬编码副本(上游 packages/client/AGENTS.md 的 locale-owned copy 红线)。
     */
    let tr = (key) => key;

    // ── 词典 --------------------------------------------------------------------
    // zh 是键集事实源,en/ja/ko 必须与之逐键对齐——缺键不报错,只会沿查找链静默回落
    // 到 en,故键集一致性由 exploration/i18n-parity-probe.mjs 守住。ja / ko 由本插件
    // 作为**语言包**贡献(上游 @deepseek-ai/dsh-client-locale 只内置 zh/en)。
    const zh = {
      nav: "开始前命令",
      intro: "在消息正式发给大模型之前,先在会话的工作目录里执行下面这条系统命令。只有当这条消息由你主动发送、且当时没有任何 agent 正在运行时才会执行。",
      unavailable: "设置不可用(宿主端未注册 falling-ts-start-command 命名空间)。",
      loading: "加载中…",
      commandLabel: "开始前命令",
      commandPlaceholder: "留空则不执行。例如:git pull",
      save: "保存",
      emptyHint: "当前为空 —— 发送对话时不会执行任何命令。",
      hintTrigger: "执行时机:本回合的第一个模型步骤之前,且当前没有任何 agent 在运行。回合中途的插话与后续工具步骤都不会重复执行。",
      hintShell: "执行方式:经宿主挂载的 shell 执行器运行,沿用该会话的沙箱策略;命令失败或超时只写宿主日志,不会阻塞本回合对话。",
    };
    const en = {
      nav: "Start command",
      intro: "Runs the shell command below in the session working directory before the message reaches the model. It runs only when you sent this message yourself and no agent was running at that moment.",
      unavailable: "Settings unavailable (the host has not registered the falling-ts-start-command namespace).",
      loading: "Loading…",
      commandLabel: "Start command",
      commandPlaceholder: "Leave blank to skip. For example: git pull",
      save: "Save",
      emptyHint: "Currently blank — sending a message runs no command.",
      hintTrigger: "When it runs: before the first model step of the turn, and only while no agent is running. Mid-turn steering and later tool steps never run it again.",
      hintShell: "How it runs: through the host's mounted shell executor, under this session's sandbox policy. A failure or timeout is logged on the host and never blocks the turn.",
    };
    const ja = {
      nav: "開始前コマンド",
      intro: "メッセージがモデルに送られる前に、セッションの作業ディレクトリで下記のシステムコマンドを実行します。あなた自身がこのメッセージを送信し、その時点で実行中の agent が一つもない場合にのみ実行されます。",
      unavailable: "設定を利用できません(ホスト側で falling-ts-start-command 名前空間が登録されていません)。",
      loading: "読み込み中…",
      commandLabel: "開始前コマンド",
      commandPlaceholder: "空欄なら実行しません。例:git pull",
      save: "保存する",
      emptyHint: "現在は空欄です —— メッセージを送ってもコマンドは実行されません。",
      hintTrigger: "実行のタイミング:このターンの最初のモデルステップの前、かつ実行中の agent が一つもないときだけです。ターン途中の追加入力や以降のツールステップでは再実行されません。",
      hintShell: "実行方法:ホストに組み込まれた shell 実行器を通し、このセッションのサンドボックス方針に従います。失敗やタイムアウトはホストのログに残るだけで、ターンは止まりません。",
    };
    const ko = {
      nav: "시작 전 명령",
      intro: "메시지가 모델로 전달되기 전에 세션 작업 디렉터리에서 아래 시스템 명령을 실행합니다. 이 메시지를 직접 보냈고 그 시점에 실행 중인 agent가 하나도 없을 때만 실행됩니다.",
      unavailable: "설정을 사용할 수 없습니다(호스트에서 falling-ts-start-command 네임스페이스가 등록되지 않았습니다).",
      loading: "불러오는 중…",
      commandLabel: "시작 전 명령",
      commandPlaceholder: "비워 두면 실행하지 않습니다. 예: git pull",
      save: "저장",
      emptyHint: "현재 비어 있습니다 —— 메시지를 보내도 아무 명령도 실행되지 않습니다.",
      hintTrigger: "실행 시점: 이 턴의 첫 모델 단계 이전이며, 실행 중인 agent가 하나도 없을 때만입니다. 턴 도중의 추가 입력이나 이후 도구 단계에서는 다시 실행되지 않습니다.",
      hintShell: "실행 방식: 호스트에 연결된 shell 실행기를 통해 이 세션의 샌드박스 정책 아래에서 실행됩니다. 실패나 시간 초과는 호스트 로그에만 남고 턴을 막지 않습니다.",
    };

    /**
     * 把本插件贡献的语言(ja / ko)注册进 locale 目录。
     *
     * 上游只内置 zh / en(LOCALE_IDS 为 ['zh','en']);'ja'/'ko' 这类 id 是**语言包
     * 插件**的扩展点:addLanguage 会把它们加进设置页「语言」下拉,并让浏览器语言探测
     * 命中它们。label 用该语言自述,fallback 必须已注册且以 en 为终点。
     *
     * 幂等容错:同集合的其它插件也贡献这两种语言(每个插件都必须能独立安装,不能约定
     * 只由其中一个注册)。先到者拥有该目录项,后到者命中 "already registered" 而让位
     * ——字典仍按 id 生效,只是该语言目录项的生存期不归本插件所有。
     * @param {object} locale - ctx.locale(LocaleRuntime)。
     * @returns {() => void} 撤销本插件添加的语言目录项。
     */
    function contributeLanguages(locale) {
      const owned = [];
      const languages = [
        { id: "ja", label: "日本語", fallback: "en" },
        { id: "ko", label: "한국어", fallback: "en" },
      ];
      for (const lang of languages) {
        try {
          owned.push(locale.addLanguage(lang));
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!/is already registered/.test(message)) throw error;
        }
      }
      return () => { for (const dispose of owned) dispose(); };
    }

    // ── 设置分区 UI --------------------------------------------------------------
    /**
     * 主题感知的颜色别名（浅色 / 暗色两套）。与集合内其它插件注入的规则**逐字相同**
     * （同一份 `--fcts-` 工作区命名空间；各插件都按元素 id 幂等，谁先注入都一样）。
     *
     * 本插件是 plain JS、无构建步骤，组件用内联 style 而非 CSS Module，但内联 style 里
     * 的 var() 照样沿 DOM 继承解析，所以：样式表只定义变量，组件只引用 `var(--fcts-*)`。
     *
     * - **浅色**：逐个取改动前的字面值（`rgba(0,0,0,…)` 系），浅色外观逐字节不变。
     * - **暗色**（选择器 `body[data-ds-dark-theme]`，官方 ui-theme 切主题时打的属性）：
     *   改指上游语义别名。**说明文字取 `--dsw-alias-label-primary`**——暗色下解析为
     *   `rgb(249,250,251)`（纯白）；分隔/边框取 `border-l*`。官方主题包按肤定义这些别名
     *   （packages/client/ui-theme/src/styles/design-platform.css），随主题自动翻转。
     */
    const THEME_TOKENS_CSS = [
      "body{",
      "--fcts-text-hint:rgba(0,0,0,0.45);",
      "--fcts-text-muted:rgba(0,0,0,0.55);",
      "--fcts-text-body:rgba(0,0,0,0.65);",
      "--fcts-line:rgba(0,0,0,0.08);",
      "--fcts-line-soft:rgba(0,0,0,0.18);",
      "--fcts-line-strong:rgba(0,0,0,0.22);",
      "--fcts-fill-subtle:rgba(0,0,0,0.14);",
      "--fcts-fill-off:rgba(0,0,0,0.16);",
      "--fcts-fill-off-hover:rgba(0,0,0,0.24);",
      "--fcts-fill-hover:rgba(0,0,0,0.06);",
      "}",
      "body[data-ds-dark-theme]{",
      "--fcts-text-hint:var(--dsw-alias-label-primary);",
      "--fcts-text-muted:var(--dsw-alias-label-secondary);",
      "--fcts-text-body:var(--dsw-alias-label-secondary);",
      "--fcts-line:var(--dsw-alias-border-l2);",
      "--fcts-line-soft:var(--dsw-alias-border-l2);",
      "--fcts-line-strong:var(--dsw-alias-border-l3);",
      "--fcts-fill-subtle:var(--dsw-alias-border-l3);",
      "--fcts-fill-off:var(--dsw-alias-interactive-bg-active);",
      "--fcts-fill-off-hover:var(--dsw-alias-interactive-bg-hover-accent);",
      "--fcts-fill-hover:var(--dsw-alias-interactive-bg-hover);",
      "}",
    ].join("");

    /**
     * 确保主题别名样式表已挂在 <head>（幂等，至多一次）。
     * @returns {() => void} 撤销函数（本插件不主动摘除共享样式表）。
     */
    function ensureThemeTokensInlined() {
      if (typeof document === "undefined") return () => {};
      if (document.getElementById("falling-ts-theme-tokens")) return () => {};
      const el = document.createElement("style");
      el.id = "falling-ts-theme-tokens";
      el.textContent = THEME_TOKENS_CSS;
      document.head.appendChild(el);
      return () => {};
    }

    const divider = "var(--fcts-line)";
    const hintColor = "var(--fcts-text-hint)";
    const gridCols = "200px minmax(0,1fr)";
    const wrapStyle = { padding: "4px 0" };
    const titleStyle = { margin: "2px 0 2px", fontSize: 15, lineHeight: 1.4 };
    const introStyle = { margin: "0 0 6px", color: hintColor, lineHeight: 1.65, fontSize: 13, maxWidth: 680 };
    const rowStyle = { display: "grid", gridTemplateColumns: gridCols, columnGap: 16, rowGap: 5, padding: "13px 0", borderBottom: "1px solid " + divider, alignItems: "center" };
    const labelStyle = { fontSize: 13.5, fontWeight: 500, lineHeight: 1.35 };
    const controlStyle = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
    const hintStyle = { gridColumn: "1 / 3", color: hintColor, fontSize: 12, lineHeight: 1.55 };
    const buttonStyle = { padding: "6px 14px", borderRadius: 8, border: "1px solid var(--fcts-line-strong)", background: "transparent", cursor: "pointer", fontSize: 13, fontWeight: 500 };
    const inputTextStyle = {
      flex: 1,
      minWidth: 220,
      padding: "6px 10px",
      borderRadius: 8,
      border: "1px solid var(--fcts-line-strong)",
      background: "transparent",
      color: "inherit",
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    };

    /**
     * 缓冲文本框:本地 state 只在输入时更新(仅重渲染这一个 input),失焦 / 回车 /
     * 点「保存」时才提交一次 `update`。外部值变化(别的标签页或外部编辑)会同步进
     * 本地缓冲;提交后两侧一致,该 effect 幂等,不会打断输入。
     * @param {{committed:string, disabled:boolean, onSubmit:(next:string)=>void}} props
     */
    function BufferedCommandInput(props) {
      const [draft, setDraft] = React.useState(props.committed);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      React.useEffect(() => { setDraft(props.committed); }, [props.committed]);
      const dirty = draft !== props.committed;
      const commit = () => {
        if (props.disabled || !dirty) return;
        props.onSubmit(draft);
      };
      return h("span", { style: controlStyle },
        h("input", {
          type: "text",
          value: draft,
          disabled: props.disabled,
          spellCheck: false,
          autoComplete: "off",
          placeholder: tr("commandPlaceholder"),
          style: inputTextStyle,
          onChange: (ev) => setDraft(ev.target.value),
          onBlur: commit,
          onKeyDown: (ev) => {
            if (ev.key !== "Enter") return;
            ev.preventDefault();
            commit();
          },
        }),
        h("button", {
          type: "button",
          style: buttonStyle,
          disabled: props.disabled || !dirty,
          onClick: commit,
        }, tr("save")));
    }

    /**
     * 「开始前命令」分区。三种非就绪状态(不可用 / 加载中)各自早退,避免在快照到位
     * 之前渲染半个表单。
     * @param {object} props 由 slots.register 的 inject 舱室展开:useStartCommand + update。
     */
    function StartCommandSection(props) {
      const { update } = props;
      const snap = props.useStartCommand((s) => s);
      const value = snap.value;
      if (snap.status === "unavailable") {
        return h("div", { style: wrapStyle },
          h("h2", { style: titleStyle }, tr("nav")),
          h("p", { style: hintStyle }, tr("unavailable")));
      }
      if (snap.status === "loading" || value === undefined) {
        return h("div", { style: wrapStyle },
          h("h2", { style: titleStyle }, tr("nav")),
          h("p", { style: hintStyle }, tr("loading")));
      }
      const disabled = !snap.writable;
      const v = (value && typeof value === "object") ? value : {};
      const committed = typeof v[COMMAND_FIELD] === "string" ? v[COMMAND_FIELD] : "";
      return h("div", { style: wrapStyle },
        h("h2", { style: { ...titleStyle, fontSize: 16 } }, tr("nav")),
        h("p", { style: introStyle }, tr("intro")),
        h("div", { style: rowStyle },
          h("span", { style: labelStyle }, tr("commandLabel")),
          h(BufferedCommandInput, {
            committed,
            disabled,
            onSubmit: (next) => update(COMMAND_FIELD, next),
          })),
        h("p", { style: hintStyle }, tr("hintTrigger")),
        h("p", { style: hintStyle }, tr("hintShell")),
        committed === "" ? h("p", { style: hintStyle }, tr("emptyHint")) : null);
    }

    /**
     * 注册分区、把宿主命名空间镜像成快照。
     * @param {import('@deepseek-ai/cordis').Context} ctx - client 根上下文。
     */
    function apply(ctx) {
      // 绑定翻译入口:此后分区每一句文案都跟随活动语言。ctx.locale.bind 返回的函数按
      // 调用时刻读取活动语言,故切换语言无需重注册。
      tr = ctx.locale.bind(NS);
      // 主题别名(浅色/暗色两套取值)。注入失败只影响取色、不影响功能。
      ctx.effect(() => ensureThemeTokensInlined(), "start-command: theme tokens");
      // zh 是键集事实源,en/ja/ko 必须与之逐键对齐。语言目录项与字典分开登记:
      // addLanguage 可能因兄弟插件已注册同一 id 而让位(见 contributeLanguages),
      // 字典注册则始终由本插件持有。
      ctx.effect(() => {
        const disposeLanguages = contributeLanguages(ctx.locale);
        const disposeDicts = ctx.locale.register(NS, { zh, en, ja, ko });
        return () => { disposeDicts(); disposeLanguages(); };
      }, "start-command: dictionaries and languages");
      // ui-settings 的 configForms 服务按命名空间交出 ConfigForm(getSnapshot/subscribe
      // 与旧 settingsScope 同形;status 枚举为 'loading'|'ready'|'unavailable';
      // set/unset/mutate 回答 Promise<boolean>,本插件忽略该返回值)。
      const scope = ctx.configForms.get(NS_SETTINGS);
      const store = createSnapshotStore({ status: "loading", value: undefined, writable: false });
      const derive = () => {
        try {
          const s = scope.getSnapshot();
          if (s === undefined || s === null || typeof s !== "object") return;
          store.update((d) => {
            d.status = s.status;
            d.value = s.value;
            d.writable = s.writable;
          });
        } catch { /* never let a cosmetic derive take down the panel */ }
      };
      const unsub = scope.subscribe(derive);
      derive();
      ctx.effect(() => unsub, "start-command: scope subscription");
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "start-command",
        order: 90,
        label: () => tr("nav"),
        inject: () => ({
          hooks: { startCommand: store },
          update: (field, fieldValue) => scope.set(field, fieldValue),
        }),
      }, StartCommandSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
