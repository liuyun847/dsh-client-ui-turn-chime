# dsh-client-ui-turn-chime

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)Web 客户端插件:**任何会话**的 AI 回复真正结束,或者轮到你在某个会话里介入(提问/审批/计划待审)时,播放一声双音"叮咚"提示音 —— 不用盯着屏幕,也不用盯在某一个会话上。

两类触发:

1. **回复真正结束** = 某会话 `running` 由 `true` 变 `false`,**且该会话没有任何仍在运行的后代子代理**。
   协调者类预设(如 `coordinator`)里主模型常先派发一批后台子代理、随即停止生成去等回报,这种"暂停等待"不再误响:提示音会挂起,等该会话名下的子代理全部结束、它空闲时补响一次。
2. **轮到你介入** = 某会话出现 `pendingInteraction`(待答 `question` / 待批 `approval` / 计划待审 `plan-review`),**立刻**响一次,不等本轮收尾。
   这条是必需的:DSH 默认的 `ask_user_question` 是**阻塞式**——工具体内一直 await 你的回答,那一轮 turn 没结束、`running` 始终为 `true`,收尾边沿根本不会发生,只订阅 `running` 就永远听不到提示音。
   **同一轮工作只响一次**:已因"轮到你介入"响过的那一轮,收尾时不再补响。

**盯所有会话(v0.5.0)**:旧版挂在会话作用域的座位上,只订阅"当前正在看的那个会话",你在别的会话里时后台的提问与收尾没人观察(实测:后台会话的提问卡片出现时不响,切回去才响)。现在直接订阅客户端服务 `sessions.list` 与 `uiSession.sessionStatus`,对每个用户会话各跑一遍判定;同一轮求值里多个会话同时该响,只响一声。

## 特性

- 双音提示音(C6→G6)由 Web Audio 实时合成,不依赖任何音频文件
- **全局监听(v0.5.0)**:订阅 `sessions.list`(会话摘要表:`origin` / `parentId` / `running`)与 `uiSession.sessionStatus`(每会话 `running` / `pendingInteraction`),覆盖当前会话与后台会话;子代理会话不单独响(它的收尾由所属父会话"子代理全部结束"补响覆盖,避免一个协调者轮次连响好几声)
- **待介入提示(v0.4.x)**:`pendingInteraction` 出现即响(待答/待批/计划待审;新增 kind 也自动覆盖);同一轮只响一次;判定状态按会话存**模块级**(页面级),组件被重挂也不丢判定
- **子代理门控(v0.3.0)**:回复完成时若该会话仍有运行中的后代子代理,则不响并挂起;子代理全部结束且该会话空闲时补响一次。待介入提示不受这道门控 —— 会话在问你话,后台有多少子代理在跑都照样响
- 子代理统计沿 `parentId` 上溯(覆盖孙代理等任意深度),只计 `running`,已结束(inactive/ready)的子代理不拦截
- 不渲染任何可见 UI,无侵入
- 退化安全:**全局监听**装上后,座位路径(座位契约兜底)与降级实现同时保留 —— 拿不到 `sessions.list` / `uiSession.sessionStatus` 时自动退回"只盯当前会话"(v0.4.x 行为);座位标准 props 缺 `useSessions` 再退回 v0.2.0 的"回复完成即响";缺 `useSession` 则座位兜底停用。两条路径共用同一份判定状态,不会重复响
- 已知边界:子代理会话在摘要表里缺行时计 0(表现是**可能提前响一次**,不是不响);带着未答问题**刷新页面**会响一次(判定状态是页面级的,刷新即清空 ⇒ 第一个待介入被当作"还没为它响过");判定状态按会话累积在内存里,数量以本页见过的会话数为上限

## 使用

安装并启用后即自动播放提示音,无其他配置。

## 安装

本包是**组合包(bundle)**:注册行(`id: turn-chime`)随包发布在包内 `cordis.patch.yml` 里,
宿主按 profile `package.json` 的 `dsh.profile.bundles` 加载 —— **不需要**再往 profile 的
`cordis.patch.yml` 里贴任何 `- insert:` 行。

在 profile 目录(如 `~/.dsh/profiles/desktop/`)下执行:

```powershell
dshpm add file:./plugins/dsh-client-ui-turn-chime --profile desktop
```

`dshpm` 是替代 `dsh plugin add` 的装卸 CLI,装包的同时会把包名写进 `dsh.profile.bundles`。
装完重启 dsh,刷新页面后生效。

- **启停**:插件页 →「已安装」区里本卡的总开关(写 `dsh.profile.bundles`);
  点开卡片后每一行还有行级开关(向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖 ——
  profile 层在包层之后应用,所以覆写优先)。
- **卸载**:`dshpm remove dsh-client-ui-turn-chime --profile desktop`。
  ⚠ 若 profile 的 pnpm 带供应链策略,`pnpm remove` 会报
  `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`;绕过办法是进 profile 目录直接跑
  `pnpm remove dsh-client-ui-turn-chime --config.minimum-release-age=0`
  (dshpm 的 `--fast` 只对 `add` 有效 —— `pnpm remove` 不接受 `--minimum-release-age` 这类参数)。
- 发布路径不变:从 npm registry / GitHub 装(`github:liuyun847/dsh-client-ui-turn-chime` 或
  `^0.5.0`)时,同样只要包名在 `dsh.profile.bundles` 里,注册行由包内 `cordis.patch.yml` 提供。

## 工作原理

> v0.5.0 起"盯所有会话"(全局监听 + 座位兜底);v0.4.x 待介入判定;v0.3.0 子代理门控;
> v0.2.0 起使用标准 props 的 `useSession`(适配 DSH 0.1.2-rc.1 slots 契约)。
> 提示音播放依赖浏览器 AudioContext,需用户交互后解锁。

- 通过 `dsh.client` 声明(见 `package.json`)注册为浏览器端插件。
- **主路径:全局监听**。`apply` 里可选读取两个客户端服务(用 `ctx.get`,不写进 `inject` —— `inject` 是"全有才 apply"的硬门,列进来会把兜底路径一起挡掉):
  - `sessions.list`:会话摘要表快照(`byId[id]` 含 `origin` / `parentId` / `running`,`phase` 表示列表是否就绪);
  - `uiSession.sessionStatus`:每会话一行 `{ running, pendingInteraction, completionUnread }`。
  两个 store 的 `subscribe` 各挂一次求值;每次求值对所有"用户会话"(`origin !== 'subagent'`)跑一遍判定状态机,任一会话该响就在这一轮播一声。
- **兜底路径:座位**。仍在 `conversation.composer.dock`(scope 为 `session`)注册一个不渲染 UI 的监听组件,用标准 props `useSession` / `useSessions` / `useSessionStatus` 只盯绑定会话(v0.4.x 行为)。全局监听装不上时才指望它。
- 活跃子代理数 = 摘要表里 `origin === 'subagent' && running === true`、且沿 `parentId` 上溯能命中该会话 id 的行数(上溯规则与官方 `dsh-client-ui-subagent` 页头谱系的 `indexSubagentDescendants` 一致,只取 running 口径;`dsh-client-ui-workspace` 会话树也用这份摘要)。带环保护;`inactive`/`ready` 的子代理不计入。
- 待介入标识 `pendingKeyOf(status)` = `pendingInteraction` 的 `key`(审批是 `approval:<n>`,问题是卡片 key),缺 `key` 时退回 `callId`、再退回 `kind`;`undefined` 表示没人等你。判定只看标识变没变、不看具体 `kind`。
- 判定状态机 `stepChime(state, running, activeSubagents, pendingKey)`(纯函数,单会话):
  - 有待介入且这个标识还没为它响过 → 响,并标记该轮已响(注意依据是"标识 ≠ 上次响过的标识",不是"从无到有的边沿" —— 边沿判定会在组件重挂时整条漏响,真机实测过);
  - `running` 由 `true` 变 `false`:本轮已因待介入响过 → 不响并清标记;否则无子代理在跑 → 响;仍有子代理在跑 → 挂起;
  - 挂起后"该会话空闲且子代理归零" → 补响一次。
- 全局求值 `stepAll(states, byId, status, prune)`(纯函数,多会话):逐个用户会话推进状态机,返回新状态表与"这一轮是否有会话该响";列表未就绪(`phase !== 'ready'`)时不丢弃未知会话的状态,避免把基线当没建过。判定状态存在模块级 `Map<sessionId, state>`,两条路径共用。
- 双音由 `AudioContext` 实时合成(C6 1046.5Hz → G6 1568Hz),失败时静默降级,不影响使用。

### 生效方式(开发时)

- 本包在 profile 里以 `file:` 形态安装:源码在 `plugins/dsh-client-ui-turn-chime/`,运行时加载的是
  `node_modules/dsh-client-ui-turn-chime/` 那份。pnpm 会把这两份**硬链接成同一 inode**(本机实测
  Windows 下 `fsutil hardlink list` 两侧互列;`lib/`、`package.json`、`README.md`、`cordis.patch.yml`
  全部如此),所以改一处即改两处 —— 但必须**原地写入**(Node `fs.writeFileSync` 或
  `[System.IO.File]::WriteAllText`):`write`/`edit` 那类"换文件"式写入会当场断链,只剩一侧生效。
  `tests/` 不在包内 `files` 白名单,不进运行时副本,从源码目录跑。
- 本插件是**纯客户端**插件(宿主半身 `lib/index.js` 为空),改 `lib/client.js` 后由 DSH 的
  `@deepseek-ai/dsh-client-hmr`(500 ms stat 轮询图内 bundle)推送重建帧,运行中的页面**原地重载本插件**,
  无需重启 DSH、无需刷新页面;控制台可见 `[turn-chime] v0.5.0 已加载:盯所有会话 …` 确认。
- 包内 `cordis.patch.yml` 属**包层 patch**,改它不需要重启 DSH,但它**不会自己触发重组合**:
  dsh-hmr 只监视 profile 的 `cordis.patch.yml`、home 层 `cordis.patch.yml` 与 profile 的 `package.json`
  三个输入(`dsh-hmr/lib/index.js:353-376`),包内文件不在其中;重组合时会重读全部 bundle 层,所以改完
  要在插件页点一下本卡(或任意行级)开关、或保存 profile patch 的任意一处改动才会被读入。
  只有宿主侧接线(如 `package.json` 的 `dsh` 声明)改了才需要重新安装/重启。
- 若 HMR 未生效(未挂载或监听失败),再重启 DSH(桌面端:关掉再打开 DeepSeek Harness 窗口) 并刷新页面。

## 开发

```bash
# 纯函数单测(活跃子代理计数 / 待介入标识 / 单会话状态机 / 多会话全局求值):
# 注入 window/react 桩后加载 client.js 取 __test 导出,不渲染组件
node tests/descendants.test.mjs

# 语法检查
node --check lib/client.js
```

## License

MIT
