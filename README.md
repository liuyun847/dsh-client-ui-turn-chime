# dsh-client-ui-turn-chime

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)Web 客户端插件:AI 回复**真正结束**时在浏览器播放一声双音"叮咚"提示音,无需盯着屏幕等待回复结束。

"真正结束"= 会话 `running` 由 `true` 变 `false`,**且该会话没有任何仍在运行的后代子代理**。
协调者类预设(如 `coordinator`)里主模型常先派发一批后台子代理、随即停止生成去等回报,这种"暂停等待"不再误响:提示音会挂起,等子代理全部结束、主会话空闲时补响一次。

## 特性

- 双音提示音(C6→G6)由 Web Audio 实时合成,不依赖任何音频文件
- 通过标准 props 的 `useSession` 订阅会话快照,监听 `running` 由 `true` 变 `false` 的瞬间
- **子代理门控(v0.3.0)**:回复完成时若当前会话仍有运行中的后代子代理,则不响并挂起;子代理全部结束且主会话空闲时补响一次(有子代理在跑就绝不响,不会响第二次)
- 子代理统计取标准 props 的 `useSessions`(`SessionListState.byId`:每个会话的 `parentId` / `origin` / `running`),沿 `parentId` 上溯,覆盖孙代理等任意深度;只计 `running`,已结束(inactive/ready)的子代理不拦截
- 无子代理的普通会话行为与 v0.2.0 完全一致
- 不渲染任何可见 UI,无侵入
- 页面卸载时自动释放音频上下文
- 退化安全(标准 props 契约变化时):缺 `useSession` → 停止渲染并告警一次(不抛错交给座位错误边界静默吞掉);缺 `useSessions` → 退回 v0.2.0 的"回复完成即响"
- 已知边界:子代理会话在摘要表里缺行时计 0,同样退回"回复完成即响"(表现是**可能提前响一次**,不是不响);挂起期间切换会话或刷新页面会丢弃未决状态,本轮不再补响(挂起状态按会话实例隔离,不跨重挂)

## 使用

安装并启用后(AI 回复结束即自动播放提示音),无其他配置。

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
  `^0.3.0`)时,同样只要包名在 `dsh.profile.bundles` 里,注册行由包内 `cordis.patch.yml` 提供。

## 工作原理

> v0.3.0 起判定为"回复完成 + 无运行中子代理";v0.2.0 起使用标准 props 的
> `useSession`(适配 DSH 0.1.2-rc.1 slots 契约)。
> 提示音播放依赖浏览器 AudioContext,需用户交互后解锁。

- 通过 `dsh.client` 声明(见 `package.json`)注册为浏览器端插件。
- 在 `conversation.composer.dock` 座位注册一个不渲染 UI 的监听组件:用会话标准 props `useSession` 订阅 `running` 与 `sessionId`,用全局 `useSessions` 读取会话列表快照 `byId`。
- 活跃子代理数 = `byId` 中 `origin === 'subagent' && running === true`、且沿 `parentId` 上溯能命中当前会话 id 的行数(上溯规则与官方 `dsh-client-ui-subagent` 页头谱系的 `indexSubagentDescendants` 一致,只取 running 口径;`dsh-client-ui-workspace` 会话树也用这份摘要)。带环保护;`inactive`/`ready` 的子代理不计入。
- 判定状态机(单个 effect,保证最多响一次):
  - `running` 由 `true` 变 `false` 且活跃子代理数为 0 → 立即响;
  - `running` 由 `true` 变 `false` 但仍有子代理在跑 → 挂起(`pending`),不响;
  - 挂起后,只要"主会话空闲(`running === false`)且活跃子代理数归零" → 补响一次(覆盖"子代理结束唤醒父会话"与"父会话未被唤醒、子代理直接结束"两条路径)。
- 适配 DSH 0.1.2-rc.1 起的 slots 契约:旧版依赖座位 owner 注入的 `session` 快照(`InputZone` 时代)已移除,新版组件直接使用标准 hook,会话切换时随绑定自动重挂、不会误报。
- 双音由 `AudioContext` 实时合成(C6 1046.5Hz → G6 1568Hz),失败时静默降级,不影响使用。

### 生效方式(开发时)

- 本包以 `plugins/dsh-client-ui-turn-chime/` 为**活源**,运行时加载
  `node_modules/dsh-client-ui-turn-chime/` 下的 **file: 拷贝**(二者独立),
  改活源后必须把 `lib/`、`package.json`、`cordis.patch.yml`、`README.md` 同步到副本;`tests/` 不进副本(白名单不含),从源码目录跑。
  (本包 8/8 共享文件 2026-09-26 实测**均为独立拷贝**,两侧 `fileId` 不同属正常 —— 不要去重建
  硬链接。全机机制见 `dsh-plugin-manager\README.md`「本地 `file:` 插件的落盘形态」。)
- DSH 默认挂载 `@deepseek-ai/dsh-client-hmr`(500 ms stat 轮询图内 bundle):
  写入副本的 `lib/client.js` 后,运行中的页面会**原地重载本插件**,无需重启
  `dsh web`、无需刷新页面;控制台可见 `[turn-chime] v0.3.0 已加载` 确认。
- 包内 `cordis.patch.yml` 属**包层 patch**,改它不需要重启 `dsh web`,但它**不会自己触发重组合**:
  dsh-hmr 只监视 profile 的 `cordis.patch.yml`、home 层 `cordis.patch.yml` 与 profile 的 `package.json`
  三个输入(`dsh-hmr/lib/index.js:353-376`),包内文件不在其中;重组合时会重读全部 bundle 层,所以改完
  要在插件页点一下本卡(或任意行级)开关、或保存 profile patch 的任意一处改动才会被读入。
  只有宿主侧接线(如 `package.json` 的 `dsh` 声明)改了才需要重新安装/重启。
- 若 HMR 未生效(未挂载或监听失败),再重启 `dsh web` 并刷新页面。

## 开发

```bash
# 纯函数单测(活跃子代理计数):注入 window/react 桩后加载 client.js 取 __test 导出
node tests/descendants.test.mjs

# 语法检查
node --check lib/client.js
```

## License

MIT
