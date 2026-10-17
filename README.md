# dsh-client-ui-turn-chime

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.5-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)Web 客户端插件:**任何会话**的 AI 回复真正结束,或者轮到你在某个会话里介入(提问/审批/计划待审)时,播放一声双音"叮咚"提示音 —— 不用盯着屏幕,也不用盯在某一个会话上。

两类触发:

1. **回复真正结束** = 某会话 `running` 由 `true` 变 `false`,**且该会话没有任何仍在运行的后代子代理**。
   协调者类预设(如 `coordinator`)里主模型常先派发一批后台子代理、随即停止生成去等回报,这种"暂停等待"不再误响:提示音会挂起,等该会话名下的子代理全部结束、它空闲时补响一次。
2. **轮到你介入** = 某会话出现 `pendingInteraction`(待答 `question` / 待批 `approval` / 计划待审 `plan-review`),**立刻**响一次,不等本轮收尾。
   这条是必需的:DSH 默认的 `ask_user_question` 是**阻塞式**——工具体内一直 await 你的回答,那一轮 turn 没结束、`running` 始终为 `true`,收尾边沿根本不会发生,只订阅 `running` 就永远听不到提示音。
   **同一轮工作只响一次**:已因"轮到你介入"响过的那一轮,收尾时不再补响(v0.5.4 起这条在"摘要表缺行"与"会话整条消失一轮"这两种时序下同样成立 —— 标记的作废按**已知**的 `running` 判定,不再靠"缺行就当标记过期"或"状态被 `prune` 丢掉"来兜)。

**盯所有会话(v0.5.1 起)**:旧版挂在会话作用域的座位上,只订阅"当前正在看的那个会话",你在别的会话里时后台的提问与收尾没人观察(实测:后台会话的提问卡片出现时不响,切回去才响)。v0.5.0 声称如此,实际因取服务太早**从未装上**(现象同旧版;根因与修法见《工作原理》末节)。现在改为等服务就绪后订阅客户端服务 `sessions.list` 与 `uiSession.sessionStatus`,对每个用户会话各跑一遍判定;同一轮求值里多个会话同时该响,只响一声。v0.5.2 又补两处:页面首次被点击/敲键时解锁音频(否则浏览器会把提示音静音),以及"没有会话摘要行的会话只判待介入、不判收尾"。v0.5.3 再修五处(见《v0.5.3 修的五处缺陷》):缺行期间的标记吞掉下一轮收尾、子代理会话的待介入被整条跳过、安装期就创建 AudioContext(静音且不会补响)、子代理行状态被 `prune` 丢掉导致同一条待介入二次响、解锁失败后永久静音。v0.5.4 再修 v0.5.3 那几处修法自身的三个开口(见《v0.5.4 修的三处缺陷(M1–M3)》):同一轮在"缺行期已为待介入响过"之后收尾时又多响一声(M1)、整条消失一轮的会话带着陈旧标记回来、把消失期间新起那一轮的收尾响吞掉(M2)、插件 HMR 原地重载后音频被重新锁上、该响要等下一次用户手势才出声(M3)。v0.5.5 只改性能:子代理计数从"每个用户会话各扫一遍全表"改成"每轮建一次父→子索引、在索引上从根向下 BFS",判定语义与"同一轮只响一次"等契约一字未动。

## 特性

- 双音提示音(C6→G6)由 Web Audio 实时合成,不依赖任何音频文件
- **全局监听(v0.5.1 修好;v0.5.2 起缺行会话只判待介入;v0.5.3 起子代理会话的待介入也响)**:订阅 `sessions.list`(会话摘要表:`origin` / `parentId` / `running`)与 `uiSession.sessionStatus`(每会话 `running` / `pendingInteraction`),覆盖当前会话与后台会话;子代理会话的**待介入照响**(那时父会话 `running` 仍是 `true`、没有收尾边沿,不判就整段静默),但它的**收尾不单独响** —— 由所属父会话"子代理全部结束"补响覆盖,避免一个协调者轮次连响好几声
- **待介入提示(v0.4.x)**:`pendingInteraction` 出现即响(待答/待批/计划待审;新增 kind 也自动覆盖);同一轮只响一次(v0.5.4 起在摘要表缺行、会话整条消失一轮这两种时序下也成立);判定状态按会话存**模块级**(页面级),组件被重挂也不丢判定
- **子代理门控(v0.3.0)**:回复完成时若该会话仍有运行中的后代子代理,则不响并挂起;子代理全部结束且该会话空闲时补响一次。待介入提示不受这道门控 —— 会话在问你话,后台有多少子代理在跑都照样响;子代理会话的待介入同理(v0.5.3),它的收尾仍不单独响
- 子代理统计沿 `parentId` 上溯(覆盖孙代理等任意深度),只计 `running`,已结束(inactive/ready)的子代理不拦截。v0.5.5 起实现改为**每轮建一次父→子索引 + 索引上向下 BFS**:消息列表与会话行数增长到千级时,单次通知的开销随"用户会话数 × 会话行数"增长,改后在同等规模下回落到 1 ms 量级,判定结果逐字不变(随机差分零不一致)
- 不渲染任何可见 UI,无侵入
- 退化安全:**全局监听**装上后,座位路径(座位契约兜底)与降级实现同时保留 —— 拿不到 `sessions.list` / `uiSession.sessionStatus` 时自动退回"只盯当前会话"(v0.4.x 行为);座位标准 props 缺 `useSessions` 再退回 v0.2.0 的"回复完成即响";缺 `useSession` 则座位兜底停用。两条路径共用同一份判定状态,不会重复响
- 已知边界:子代理会话在摘要表里缺行时计 0(表现是**可能提前响一次**,不是不响);带着未答问题**刷新页面**会响一次(判定状态是页面级的,刷新即清空 ⇒ 第一个待介入被当作"还没为它响过");判定状态按会话累积在内存里,数量以本页见过的会话数为上限;没有会话摘要行(`sessions.list` 里查不到、只在 `uiSession.sessionStatus` 有行)的会话只按待介入提示,不判收尾 —— 无法判断它是不是子代理,判了会与父会话"子代理归零补响"叠成一轮两声;页面从未被点击/敲键时提示音会被浏览器静音 —— v0.5.2 起在首次手势时解锁,而**未解锁期间被吞掉的那些响会在首次手势解锁成功后补响一次**(只补一次,不是每来一次事件补一次;那段时间既不创建 AudioContext 也不排振荡器,所以静音期不再刷浏览器警告;页面**已被用户激活过**时例外,见本节末);子代理会话的待介入也响、收尾仍不单独响(v0.5.3);HMR 原地重载本插件会重建**模块级**音频状态,但页面**已被用户激活过**时(`navigator.userActivation.hasBeenActive`,v0.5.4 M3)浏览器本来就允许出声,重载后照旧当场响 —— 只有从未被激活过的页面才需要再来一次用户手势(点击/敲键即可)才解锁
  - 已知边界(挂起欠响 × 待介入,极窄时序;v0.5.4 B1):某会话先"挂起等子代理"(那一轮还欠一声),随后**同一会话**又出现待介入并被判为"该响" ⇒ 该轮收尾时那声欠响会被**吞掉**,整轮恰好 1 声而不是 2 声。
    取舍:保留 `stepChime` 里那枚 `!pending` 守卫 —— 契约 2 是"同一轮工作只响一次",要补回那一声就得在同一轮里响第二次,两害相权取"同一轮不重复响"。回归用例 `全局(B1)` 钉的就是这条:去掉 `!pending` 时同一轮响 2 声、该用例即 FAIL。

## 使用

安装并启用后即自动播放提示音,无其他配置。

## 安装

本包是**组合包(bundle)**:注册行(`id: turn-chime`)随包发布在包内 `cordis.patch.yml` 里,
宿主按 profile `package.json` 的 `dsh.profile.bundles` 加载 —— **不需要**再往 profile 的
`cordis.patch.yml` 里贴任何 `- insert:` 行。

在 profile 目录(如 `~/.dsh/profiles/<profile 名>/`)下执行:

```powershell
dshpm add file:./plugins/dsh-client-ui-turn-chime --profile <profile 名>
```

`dshpm` 是替代 `dsh plugin add` 的装卸 CLI,装包的同时会把包名写进 `dsh.profile.bundles`。
装完重启 dsh,刷新页面后生效。

- **启停**:插件页 →「已安装」区里本卡的总开关(写 `dsh.profile.bundles`);
  点开卡片后每一行还有行级开关(向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖 ——
  profile 层在包层之后应用,所以覆写优先)。
- **卸载**:`dshpm remove dsh-client-ui-turn-chime --profile <profile 名>`。
  ⚠ 若 profile 的 pnpm 带供应链策略,`pnpm remove` 会报
  `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`;绕过办法是进 profile 目录直接跑
  `pnpm remove dsh-client-ui-turn-chime --config.minimum-release-age=0`
  (dshpm 的 `--fast` 只对 `add` 有效 —— `pnpm remove` 不接受 `--minimum-release-age` 这类参数)。
- 发布路径不变:从 npm registry / GitHub 装(`github:liuyun847/dsh-client-ui-turn-chime` 或
  `^0.5.5`)时,同样只要包名在 `dsh.profile.bundles` 里,注册行由包内 `cordis.patch.yml` 提供。

## 工作原理

> v0.5.4 修三处"修法镜像/副作用"开口(第二轮独立对抗性复核查出):缺行期响过待介入的那一轮收尾时
> 多响一声(M1:复位时机从"缺行轮次"挪到"摘要行回来那一轮"、按已知 `running` 判定)、整条消失一轮的
> 会话带着陈旧标记回来时吞掉消失期间新起那一轮的收尾响(M2:`prune` 补回时清掉"本轮已响过"标记)、
> 插件 HMR 原地重载后音频被重新锁上、该响要等下一次用户手势(M3:用 `navigator.userActivation.hasBeenActive`
> 初始化解锁状态);
> v0.5.3 修五处缺陷(缺行期间的标记吞掉下一轮收尾、子代理会话的待介入被整条跳过、安装期就创建 AudioContext
> 且那一声不会补响、子代理行状态被 `prune` 丢掉导致二次响、解锁失败后永久静音;逐条见下节);
> v0.5.2 加"用户手势音频解锁"(页面从未被点击/敲键时浏览器会把提示音静音;`resume()` 失败不再静默吞掉)、
> 修正"没有会话摘要行的会话"判定(只判待介入,不判收尾)、补两处健壮性(读会话状态兜错、等不到服务 15 s 告警);
> v0.5.1 修好全局监听(v0.5.0 声称"盯所有会话"但从未装上,根因见下节);v0.4.x 待介入判定;v0.3.0 子代理门控;
> v0.2.0 起使用标准 props 的 `useSession`(适配 DSH 0.1.2-rc.1 slots 契约)。
> 提示音播放依赖浏览器 AudioContext:页面从未被点击/敲键时浏览器会把它静音(卡片、后台标签页同理),
> 所以新版在首次点击/敲键时解锁,并在解锁失败时提示一次;解锁成功之前一声都不排,那段时间该响的会在解锁后补响一次。

- 通过 `dsh.client` 声明(见 `package.json`)注册为浏览器端插件。
- **主路径:全局监听**。`apply` 里用 `ctx.inject(["sessions", "uiSession"], function (scope) { … })` 等两个客户端服务都就绪后再装(不把它们写进插件级 `inject` —— 那是"全有才 apply"的硬门,列进来会把兜底路径一起挡掉);监听用 `scope.effect(...)` 挂在该作用域上,依赖被替换或卸载时随作用域一起拆掉重装:
  - `sessions.list`:会话摘要表快照(`byId[id]` 含 `origin` / `parentId` / `running`,`phase` 表示列表是否就绪);
  - `uiSession.sessionStatus`:每会话一行 `{ running, pendingInteraction, completionUnread }`。
  两个 store 的 `subscribe` 各挂一次求值;每次求值对每个会话跑一遍判定状态机,任一会话该响就在这一轮播一声。子代理行(v0.5.3)与摘要表里**没有行**的会话(只在 `uiSession.sessionStatus` 里出现)都只判待介入、不判收尾:前者收尾由所属父会话的补响覆盖,后者无法判断是不是子代理会话(详见下条)。
  订阅是**页面级**的:主机把待介入与状态广播给所有客户端,客户端按需建会话作用域 —— 所以**本页从未打开过**的会话,它的提问/审批/计划待审也会响(这条链路已逐跳核对官方源码)。
- **兜底路径:座位**。仍在 `conversation.composer.dock`(scope 为 `session`)注册一个不渲染 UI 的监听组件,用标准 props `useSession` / `useSessions` / `useSessionStatus` 只盯绑定会话(v0.4.x 行为)。全局监听装不上时才指望它。
- 活跃子代理数 = 摘要表里 `origin === 'subagent' && running === true`、且沿 `parentId` 上溯能命中该会话 id 的行数(上溯规则与官方 `dsh-client-ui-subagent` 页头谱系的 `indexSubagentDescendants` 一致,只取 running 口径;`dsh-client-ui-workspace` 会话树也用这份摘要)。带环保护;`inactive`/`ready` 的子代理不计入。v0.5.5 起计算方式改为"每轮循环外**只建一次**父→子索引(`indexSubagentRowsByParent`,摘要表只遍历一次、把子代理行按 `String(parentId)` 归组)再逐个根在索引上向下 BFS(`countRunningDescendantsInIndex`)" —— 旧写法每问一个会话都把摘要表从头扫一遍,`stepAll` 一轮就是 O(用户会话数 × 总行数);`countRunningDescendants(summaries, rootSessionId)` 保留为"建一次索引 + 查一次"的薄包装,对外签名与语义不变。
- 待介入标识 `pendingKeyOf(status)` = `pendingInteraction` 的 `key`(审批是 `approval:<n>`,问题是卡片 key),缺 `key` 时退回 `callId`、再退回 `kind`;`undefined` 表示没人等你。判定只看标识变没变、不看具体 `kind`。
- 判定状态机 `stepChime(state, running, activeSubagents, pendingKey)`(纯函数,单会话):
  - 有待介入且这个标识还没为它响过 → 响,并标记该轮已响(注意依据是"标识 ≠ 上次响过的标识",不是"从无到有的边沿" —— 边沿判定会在组件重挂时整条漏响,实测过);
  - `running` 由 `true` 变 `false`:本轮已因待介入响过 → 不响并清标记;否则无子代理在跑 → 响;仍有子代理在跑 → 挂起;
  - 挂起后"该会话空闲且子代理归零" → 补响一次;
  - "本轮已响过"的标记(v0.5.4,M1):判不出收尾边沿**且该会话已空闲**(`running === false`)时作废 —— 那时它属于**已经结束的那一轮**,留着会吞掉下一轮真正的收尾边沿;判得出收尾边沿时由边沿那一支消费(同一轮最多响一次);`pending` 挂起还欠一声时保留(补响时正靠它抑制同一轮响第二次 —— `pending` 为真时**不作废**这枚标记的取舍与代价见《特性》里的已知边界 B1)。摘要表缺行/子代理行那一轮**不复位任何标记**:它留到"摘要行回来的那一轮"按**已知**的 `running` 决定 —— v0.5.3 在缺行轮次就复位,于是"缺行期响过待介入、那一轮仍在跑"的收尾又多响一声。
- 全局求值 `stepAll(states, byId, status, prune)`(纯函数,多会话):逐会话推进状态机,返回新状态表与"这一轮是否有会话该响";列表未就绪(`phase !== 'ready'`)时不丢弃未知会话的状态,避免把基线当没建过。判定状态存在模块级 `Map<sessionId, state>`,两条路径共用。没有摘要行的会话**与子代理行**都以 `runningKnown = false` 走状态机:只让待介入分支生效,并保留上一轮的 `lastRunning` 基线 —— 不能拿一个假的 `false` 伪造出"回复结束"边沿(那会和父会话的"子代理归零补响"叠成一轮两声)。状态保留口径统一由 `stateWorthKeeping(state)` 判定(v0.5.3):有内容的(已响过的待介入标识 / 未消费的"本轮已响过"标记 / 挂起)才留,空基线状态照旧丢弃,`prune` 也不再丢这类状态 —— 否则子代理行消失一轮再出现时,同一条待介入会被当成"本页第一次见到"、二次响。另外(v0.5.4,M2):`prune` 补回这类状态时清掉"本轮已响过"的标记 —— 那枚标记属于消失前的那一轮,留着会把"消失期间新起的那一轮"的收尾响吞掉(仿真:该响 2 声响 1 声);"已响过的待介入标识"与挂起照旧保留(前者仍拦同一条标识二次响,后者的补回正是 D4 要修的"子代理归零后漏补响")。v0.5.5(性能)把这里的活跃子代理数换成循环外**只建一次**的父→子索引(`indexSubagentRowsByParent` + `countRunningDescendantsInIndex`,旧写法逐会话重扫全表),并把 id 去重的 `ids.indexOf` 线性查找换成 `Set` 成员判定;判定逻辑与 id 处理顺序(摘要表自有键序在前、状态表新增键序在后)一字未动。
- 双音由 `AudioContext` 实时合成(C6 1046.5Hz → G6 1568Hz);合成/播放失败只 `console.error` 一条,不影响使用。
- **音频解锁(v0.5.2;v0.5.3 补齐两层)**:浏览器要求 `AudioContext` 在用户手势之后才能创建/恢复;页面从未被点击/敲键时它会停在 `suspended`,排进去的声音一律听不见(控制台只留一条 `The AudioContext was not allowed to start …`,插件侧原来零日志)。现在 `apply` 挂一次性的 `pointerdown` / `keydown`(捕获阶段)监听:首次手势时创建/恢复上下文并播一个无声缓冲解锁,随后摘掉监听(挂在 `ctx.effect` 上,插件 HMR 重载时一并清理);`resume()` 失败或恢复后仍非 `running` 时 `console.warn` 一条并提示"先在页面里点一下或敲一下",不再静默吞掉。**不**在页面加载时创建上下文(**例外**:页面已被用户激活过时 —— 见本段末 M3)—— v0.5.3 起这一条才真正成立:解锁之前 `playChime` 直接早退(不建上下文、不排振荡器、不产生浏览器警告),只记下"有一声被吞掉了",首次手势解锁成功后补响一次;解锁**只在真正成功之后**才算完成(v0.5.3):拿不到上下文、或无声缓冲抛错都不置位、保留监听待下一次手势重试,重试仍失败 `warnAudioOnce` 一条(旧版在这里永久静音)。v0.5.4(M3)另修一处 HMR 副作用:解锁状态是**模块级**变量,插件原地重载后会复位成"未解锁",而浏览器对本 document 的解锁是**粘性**的(不因重载重新上锁)⇒ 旧写法把重载后的响压成"补响"、要等下一次手势才出声;现在拿只读信号 `navigator.userActivation.hasBeenActive` 初始化它(`navigator` / `userActivation` 缺失时一律按"没激活"处理 —— 那正是 D3 的正常场景,**没有**用户激活的页面加载期依然 0 上下文 / 0 振荡器 / 0 浏览器警告),已被激活过的页面当场出声。
- **等不到服务(v0.5.2)**:`ctx.inject` 的回调在依赖就绪前根本不跑,两个服务永远不到达时原来是**零日志**;现在 `apply` 起一个 15 s 计时器,到点回调仍未跑过就 `console.warn` 一条(计时器随插件卸载清掉)。另外,安装全局监听时的**首轮求值**若抛错,会当场退订两个订阅并返回"装不上",退回座位兜底 —— 不留"半装"状态(否则那两个订阅会随注入 fiber 一起泄漏)。

### 全局监听为什么曾经没装上(v0.5.1 修复)

v0.5.0 拿 `ctx.get("sessions")` / `ctx.get("uiSession")` 取服务后立即装监听,结果**一次都没装上**,只剩座位兜底 —— 现象是"看会话 A 时会话 B 不响,切回 B 才响"。三条原因叠加:① `ctx.get` 默认 strict,服务提供者 fiber 不是 ACTIVE 就返回 `undefined`(`cordis/src/reflect.ts:233-243`);② 插件级 `inject` 只有 `slots`,而 `slots` 由渲染层很早就提供,`apply` 跑得极早,那时两个服务都还没注册;③ `apply` 只在 fiber 首次激活时跑一次,服务后到**不会**重跑 —— 而 `sessions` 要等 `dsh-api-session-controller` 的 `apply` 里才 `provide`,`uiSession` 更在其后,注册链长到永远赶不上。

v0.5.1 改用 `ctx.inject(["sessions", "uiSession"], function (scope) { … })`:`scope` 是 cordis 新建的子 fiber,两个依赖都 ACTIVE 才跑回调,依赖被替换或卸载时自动卸载重跑(`cordis/src/registry.ts:167-176`、`:300-301`);监听以 `scope.effect(...)` 挂在该作用域上,随它一起拆。**插件级 `inject` 仍保持 `["slots"]`** —— 它是"全有才 apply"的硬门,把那两个服务列进去会连座位兜底一起挡掉。

### v0.5.3 修的五处缺陷(D1–D5)

| # | 症状 | 修法 |
|---|---|---|
| D1 | 摘要表缺行的会话在缺行期间出现待介入后,"本 turn 已响过"的标记会一直留到**下一次真正的收尾边沿**,把那一轮的提示音吞掉(仿真:该响 2 声只响 1 声) | 拿不到可信 `running`、且**没有尚未观察到的收尾边沿**(`lastRunning !== true`)时复位该标记;`lastRunning === true` 时保留 —— 否则摘要行回来判出边沿会重复响(2 声变 3 声)。**v0.5.4 起这条修法的复位时机已改到"摘要行回来的那一轮"、按已知 `running` 判定**(旧时机 = 缺行轮次就复位,会让"缺行期响过待介入、那一轮仍在跑"的收尾多响一声,见 M1) |
| D2 | 子代理会话的待答/待批被整条跳过,而那时父会话 `running` 仍是 `true`、没有收尾边沿 ⇒ 整段时间完全静默 | 子代理行也判 `pendingInteraction`(传 `runningKnown = false`),但不判 `running` 边沿 —— "子代理会话的收尾不单独响"这条既有设计保持不变 |
| D3 | 安装期首轮求值遇到已有待介入就创建 `AudioContext`:那时还没有任何用户手势,上下文被浏览器拦成 `suspended`,排进去的振荡器全部静音(控制台只留若干条 `The AudioContext was not allowed to start` 警告) | 未解锁时既不创建上下文也不排振荡器,只记下"有一声被吞掉了";首次手势**真正解锁成功后补响一次** |
| D4 | 子代理行"出现→消失→再出现"时它的判定状态被 `prune` 丢掉 ⇒ 同一条待介入标识二次响 | 子代理行与 `prune` 都只为"确实有东西要记"的状态保留条目(已响过的标识 / 未消费的标记 / 挂起),空基线状态照旧丢弃(内存有界) |
| D5 | `primeAudio` 抛错后照样置"已解锁"并摘掉手势监听 ⇒ 永久静音 | 只有真正成功才算解锁:失败不置位、保留监听,下一次手势重试;重试仍失败 `warnAudioOnce` 一条 |

测试同步补了两条盲区:假 `window.removeEventListener` 现在**校验 capture 标志**(注册与摘除都必须是 `true`,否则真实 DOM 里根本摘不掉),并补上 D3 的两条行为断言(安装期求值不建上下文;未解锁期间被吞掉的响在解锁后恰好补响一次)。

v0.5.4 又补四条回归用例(M1 时序恰好 1 声、M2 整条消失后新起那一轮的收尾照响、M3 已激活页面加载期即出声而未激活仍是 0 上下文 / 0 振荡器、B1 挂起欠响期间又出现待介入时同一轮恰好 1 声 —— 钉住 `stepChime` 里 `!pending` 那枚守卫,去掉它该用例即 FAIL),并把 D1 用例里那条"缺行轮次复位标记"的白盒断言按新时机改到"摘要行回来的那一轮"(行为契约 2 声不变)。

### v0.5.4 修的三处缺陷(M1–M3)

第二轮独立对抗性复核对 v0.5.3 的五处修法本身做"变异/镜像"检查,又查出三条**修法自身的开口**:

| # | 症状 | 修法 |
|---|---|---|
| M1 | **同一轮多响一声**:摘要在缺行期间响过待介入、而那一轮**仍在跑**时,D1 那行"缺行轮次复位标记"当场把标记清掉了 ⇒ 该轮收尾时按"无标记的边沿"又响一声(仿真:`[0,1,0,1]` 共 2 声,正确是 1 声) | 复位时机从"缺行轮次"挪到"摘要行回来的那一轮、按**已知** `running` 决定":判不出收尾边沿(`lastRunning === true && running === false` 不成立)且 `running === false` ⇒ 标记属于已经结束的那一轮,作废;`running === true` ⇒ 保留(该轮收尾正要靠它抑制重复响)。缺行/子代理行那一轮不再动这枚标记 |
| M2 | **漏响一声**:v0.5.3 让"还有东西要记"的状态跨"整条消失"存活,于是带 `chimedForTurn` 的状态回来时吞掉"消失期间新起那一轮"的收尾响(仿真:该响 2 声只响 1 声) | `prune` 补回"本轮完全没出现的会话"时**只清** `chimedForTurn`;`lastChimedPendingKey` 与 `pending` 照旧保留(前者仍拦同一条待介入标识二次响,后者的补回正是 D4 要修的"子代理归零后漏补响") |
| M3 | **HMR 副作用(低)**:`audioUnlocked` 是模块级变量,插件原地热重载后复位为 `false`,而浏览器对本 document 的解锁其实是**粘性**的 ⇒ 重载后该响的一声被压成"补响"、要等下一次手势才出声(v0.5.2 在已激活页面里是当场出声的) | 用只读信号 `navigator.userActivation.hasBeenActive` 初始化 `audioUnlocked`(`navigator` / `userActivation` 都可能不存在,一律防御性读取、缺失按"没激活"处理)。**没有**用户激活的页面(D3 的正常场景)加载期依然 0 上下文 / 0 振荡器 / 0 浏览器警告 |

三条各配一条回归用例,并用"回退修法 ⇒ 对应用例 FAIL"的变异自证逐条验过。

### v0.5.5 性能修复:子代理计数从"每会话全表扫描"改成"每轮一次索引"

**现象**:消息列表与会话行数增长到千级规模时(会话摘要表上千行、其中用户会话数百个),点击按钮、切换会话发涩,长会话滚动卡顿。

**根因**:两个 store(`sessions.list` 与 `uiSession.sessionStatus`)订阅的是同一个 `evaluate`,任一变通知都会跑 `stepAll`,而 `stepAll` 对**每个用户会话**各调一次 `countRunningDescendants`;那个函数每次都 `Object.keys(summaries)` 再遍历全部行 ⇒ 单次求值的开销随"用户会话数 × 会话行数"增长。页面内实测:单次 `evaluate` 在 0.1 s 量级,通知频率 6–10 次/秒 ⇒ 本插件独占渲染器主线程约 60–70%。

**改动(只动实现,判定语义与对外签名不变)**:

| 改动 | 说明 |
|---|---|
| 拆函数 | `countRunningDescendants(summaries, rootSessionId)` 拆成 `indexSubagentRowsByParent(summaries)`(遍历摘要表一次,把 `origin === "subagent"` 且 `parentId !== undefined` 的行按 `String(parentId)` 归组)与 `countRunningDescendantsInIndex(index, rootSessionId)`(在索引上从根向下 BFS,按行键去重、环不会死循环);原函数保留为薄包装,`__test` 里原有导出照旧 |
| 每轮只建一次 | `stepAll` 在循环外建一次索引、循环内改用索引;`ids.indexOf(id) < 0` 换成 `Set` 成员判定(`ids` 数组与其顺序不变) |
| 清临时探针 | 删除定位"收尾不响"用的临时诊断探针整块与全部调用点(含模块求值时的 boot 上报)。它每次求值都会再拼一遍全表字符串并往一个诊断端点 `POST` —— 该端点是**另一个插件(`dsh-llm-auto`)的正式功能,保留不动**,只是不再由本插件打点 |

**量化**(离线复刻上述数据形状:总行数上千、用户会话数百,直接调 `__test.stepAll`):单次 92–101 ms(中位 94.7 ms)→ 0.6 ms 量级(验收线 ≤2 ms)。

**语义**:12 万组随机差分(origin 混合、`parentId` 指向其它行 / `null` / 缺省 / 不存在的 id、多根、含环、空行)与改动前的逐行上溯实现**零不一致**;新增用例把这条不变量钉住(随机差分、索引建一次复用、`stepAll` 与"逐会话朴素计数"等价且键序不变、client.js 无残留探针)。

**生效与回滚**:纯客户端产物,dsh-client-hmr 每 500 ms 轮询,写入后约 0.3–1.3 s 推 `rebuilt` 帧、页面就地替换本插件,**不需要重启 DSH**;回滚 = 用改前另存的原文**原地写回** `lib/client.js`(硬链接两侧同步),HMR 自动推回旧代码。

### 生效方式(开发时)

- 本包以 `file:` 形态装进 profile:源码在 `plugins/dsh-client-ui-turn-chime/`,运行时加载的是
  `node_modules/dsh-client-ui-turn-chime/` 那份,两者是**硬链接同一 inode**(Windows 下用
  `fsutil hardlink list` 可验证两侧互列;`lib/`、`package.json`、`README.md`、`cordis.patch.yml`
  全部如此),所以改一处即改两处 —— 但**必须原地写入**(Node `fs.writeFileSync`
  或 `[System.IO.File]::WriteAllText`),`write`/`edit` 那类"换文件"式写入会当场断链、只剩一侧生效。
  `tests/` 不进运行时副本(包内 `files` 白名单不含),从源码目录跑。
- 本插件是**纯客户端**插件(宿主半身 `lib/index.js` 为空),改 `lib/client.js` 后由
  DSH 的 `@deepseek-ai/dsh-client-hmr`(500 ms stat 轮询图内 bundle)推送重建帧,
  运行中的页面**原地重载本插件**,无需重启 DSH、无需刷新页面;控制台可见
  `[turn-chime] v0.5.5 已加载:盯所有会话 …` 确认。
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
