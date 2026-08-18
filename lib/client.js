// 浏览器端插件主体:每次 AI 回复完成(会话快照 running 由 true 变 false)时
// 播放一声双音提示音。组件本身不渲染任何可见 UI。
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
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
    // 注册于 conversation.composer.dock(InputZone):owner props 提供
    // session: ConversationSnapshot 点时快照,store 变化时骨架重渲染本条目,
    // 因此 props.session.running 始终为最新值。
    function TurnChimeWatcher(props) {
      var session = props.session;
      var lastRunning = react.useRef(session.running);
      var audioRef = react.useRef(null);

      // 仅在 running true→false 转变(AI 回复完成)时响一次。
      react.useEffect(function () {
        if (lastRunning.current === true && session.running === false) {
          playChime(audioRef);
        }
        lastRunning.current = session.running;
      }, [session.running]);

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
