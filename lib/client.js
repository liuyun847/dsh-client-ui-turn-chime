// 浏览器端插件主体:每次 AI 回复完成(会话 running 由 true 变 false)时
// 播放一声双音提示音。组件本身不渲染任何可见 UI。
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
//
// 适配 DSH 0.1.2-rc.1(客户端 slots 契约升级):
//  - 旧版依赖座位 owner props 的 session 快照(InputZone 时代,
//    composer.dock 渲染时注入 { session, input }),该契约已移除;
//  - 新版 conversation.composer.dock 是 scope:"session" 的 list 座位,
//    条目组件只收到标准 props:会话标准注入提供 useSession(selector
//    hook,订阅当前绑定会话快照)与 useProjection(keyed hook)等;
//  - 改用标准 useSession hook 自选 running,组件挂在 dock 即随当前会话
//    running 变化即时重渲,无需 owner 透传。
window.__ModuleLoader__.load({
  id: "dsh-client-ui-turn-chime",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // ── 提示音:Web Audio 合成的双音"叮咚"(C6→G6,约 0.7 秒)────────
    function playChime(audioRef) {
      try {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        if (!audioRef.current) audioRef.current = new Ctor();
        var ac = audioRef.current;
        if (ac.state === "suspended") ac.resume().catch(function () {});
        var now = ac.currentTime;
        var notes = [
          { freq: 1046.5, start: 0, dur: 0.55, vol: 0.22 },
          { freq: 1568, start: 0.12, dur: 0.75, vol: 0.18 },
        ];
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          var osc = ac.createOscillator();
          var gain = ac.createGain();
          osc.type = "sine";
          osc.frequency.value = n.freq;
          var t0 = now + n.start;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(n.vol, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
          osc.connect(gain);
          gain.connect(ac.destination);
          osc.start(t0);
          osc.stop(t0 + n.dur + 0.05);
        }
      } catch (err) {
        console.error("[turn-chime] 提示音播放失败", err);
      }
    }

    // ── 会话结束监听组件 ────────────────────────────────────────
    // 注册于 conversation.composer.dock(ComposerBar 下方的 ambient 座位):
    // 该座位 scope 为 session,组件通过标准 props 的 useSession 选择器订阅
    // 当前绑定会话快照,因此 running 变化(含回复完成 true→false)都会触发
    // 重渲。会话切换时 StrictSessionEntry 以会话 id 为 key 强制重挂,本组
    // 件的初始 ref 总是当前会话的值,不会把上一会话的完成误报给新会话。
    function TurnChimeWatcher(props) {
      var useSession = props.useSession;
      // 回复完成前该座位可能先以 running=true 渲染过(上一轮与新一轮之间
      // running 恒为 false 不触发)。初始值直接取当前快照,避免把"挂载时
      // 正在跑"的会话误判为完成(挂载瞬间 running 为 true 时不会响)。
      var running = useSession === undefined
        ? undefined
        : useSession(function (s) { return s === undefined ? undefined : s.running; });
      var lastRunning = react.useRef(running);
      var audioRef = react.useRef(null);

      // 仅在 running true→false 转变(AI 回复完成)时响一次。
      react.useEffect(function () {
        if (lastRunning.current === true && running === false) {
          playChime(audioRef);
        }
        lastRunning.current = running;
      }, [running]);

      // 卸载时释放音频上下文。
      react.useEffect(function () {
        return function () {
          if (audioRef.current) audioRef.current.close().catch(function () {});
        };
      }, []);

      return null;
    }

    // 插件依赖的服务(slots 由 client-runtime 提供)。
    var inject = ["slots"];

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("conversation.composer.dock", function () {
        return slots.register(
          {
            name: "conversation.composer.dock",
            id: "turn-chime",
          },
          TurnChimeWatcher
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
