# dsh-client-ui-turn-chime

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-8A2BE2.svg)](https://github.com/topics/dsh-plugin)

DSH(DeepSeek Harness)Web 客户端插件:每次 AI 回复完成时在浏览器播放一声双音"叮咚"提示音,无需盯着屏幕等待回复结束。

## 特性

- 双音提示音(C6→G6)由 Web Audio 实时合成,不依赖任何音频文件
- 通过标准 props 的 `useSession` 订阅会话快照,监听 `running` 由 `true` 变 `false` 的瞬间,仅在回复完成时响一次
- 不渲染任何可见 UI,无侵入
- 页面卸载时自动释放音频上下文

## 使用

安装并注册后,AI 回复完成即自动播放提示音,无其他配置。

## 安装

在 DSH profile 目录(例如 `~/.dsh/profiles/web/`)下:

1. 添加依赖:

   ```jsonc
   // package.json
   {
     "dependencies": {
       "dsh-client-ui-turn-chime": "github:liuyun847/dsh-client-ui-turn-chime"
     }
   }
   ```

   然后 `pnpm install`(或 `npm install`)。

2. 在 `cordis.patch.yml` 中注册插件行:

   ```yaml
   - insert:
       - id: turn-chime
         name: 'dsh-client-ui-turn-chime'
   ```

3. 重启 `dsh web`,刷新页面后生效。

## 工作原理

> v0.2.0 起使用标准 props 的 `useSession`(适配 DSH 0.1.2-rc.1 slots 契约)。
> 提示音播放依赖浏览器 AudioContext,需用户交互后解锁。
> (v0.3.2 验证:跨行变量写盘场景)

- 通过 `dsh.client` 声明(见 `package.json`)注册为浏览器端插件。
- 在 `conversation.composer.dock` 座位注册一个不渲染 UI 的监听组件,通过会话标准 props `useSession` 实时订阅 `running` 字段检测回复完成。
- 适配 DSH 0.1.2-rc.1 起的 slots 契约:旧版依赖座位 owner 注入的 `session` 快照(`InputZone` 时代)已移除,新版组件直接使用标准 hook,会话切换时随绑定自动重挂、不会误报。
- 双音由 `AudioContext` 实时合成(C6 1046.5Hz → G6 1568Hz),失败时静默降级,不影响使用。

## License

MIT