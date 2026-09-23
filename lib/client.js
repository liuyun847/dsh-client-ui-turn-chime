// 浏览器端插件主体:AI 回复完成后播放一声双音提示音,但只在本轮工作真正结束
// ——即当前会话没有任何仍在运行(running)的后代子代理——时才响。
// 协调者类预设里主模型会先派发后台子代理再停止生成,那种"暂停等待子代理"不再
// 误响:提示音挂起,等子代理全部结束、主会话空闲时补响一次。组件不渲染可见 UI。
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
//
// 适配 DSH 0.1.2-rc.1(客户端 slots 契约升级):
//  - 旧版依赖座位 owner props 的 session 快照(InputZone 时代,
//    composer.dock 渲染时注入 { session, input }),该契约已移除;
//  - 新版 conversation.composer.dock 是 scope:"session" 的 list 座位,
//    条目组件只收到标准 props:会话标准注入提供 useSession(selector
//    hook,订阅当前绑定会话快照)、useSessions(全局会话列表快照,含每个
//    会话的 parentId / origin / running)与 useProjection(keyed hook)等。
//  - v0.3.0 起判定改为"回复完成 + 无 running 子代理":useSession 取 running 与
//    sessionId,useSessions 的 byId 沿 parentId 上溯统计当前会话下 running 的
//    后代子代理(任意深度);缺少 useSessions 时退化为 v0.2.0 行为。
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

    // ── 活跃子代理统计 ──────────────────────────────────────────
    // 沿 parentId 上溯统计 rootSessionId 名下仍在 running 的后代子代理数。
    // 上溯规则与 DSH 官方 dsh-client-ui-subagent 的 indexSubagentDescendants 一致
    // (逐级上溯、带环保护),差异只在本插件只取 running 口径 —— 官方同时产出总数
    // 与 runningCount 两个量。因此孙代理等任意深度后代都覆盖。
    // 计数只算 running:inactive/ready 的子代理在 DSH 语义里是"本轮已结束、可在
    // 存储中续接",不是活跃工作,不该拦住提示音。
    // 已评估的边界(非缺陷,勿误读):
    //  · 子代理会话不在摘要表里(缺行)时计 0,等价于退回旧行为:running 落下的那
    //    一瞬照响 —— 表现是"可能提前响",不是"不响";
    //  · 挂起(pending)期间组件被重挂(切换会话/刷新页面)会丢弃未决状态,本轮不再
    //    补响;这是挂起状态按会话实例隔离的代价,需求未要求跨重挂保持;
    //  · "父会话已停、子代理行仍是 running=false"的乱序窗口实际不可达:子代理行在
    //    工具调用返回前就已建立,其状态帧早于父会话的 turn 结束帧,两者走同一条
    //    连接按序到达。
    // 遍历用 Object.keys(只枚举自有键),与官方 Object.values 口径一致。
    function countRunningDescendants(summaries, rootSessionId) {
      if (summaries === undefined || summaries === null || rootSessionId === undefined) return 0;
      var count = 0;
      var keys = Object.keys(summaries);
      for (var i = 0; i < keys.length; i++) {
        var row = summaries[keys[i]];
        if (row === undefined || row === null) continue;
        if (row.origin !== "subagent" || row.running !== true) continue;
        var seen = Object.create(null);
        var current = row;
        while (current !== undefined && current !== null
          && current.origin === "subagent" && current.parentId !== undefined
          && seen[current.id] !== true) {
          seen[current.id] = true;
          if (current.parentId === rootSessionId) { count += 1; break; }
          current = summaries[current.parentId];
        }
      }
      return count;
    }

    // ── 判定状态机(纯函数) ─────────────────────────────────────
    // 一步演进:输入上一次的 running 与本轮快照(running、活跃子代理数),
    // 返回是否该响 + 新的 pending 标记。抽成纯函数便于单测覆盖三条路径。
    //   · 回复刚结束(running true→false)且无子代理在跑 → 响;
    //   · 回复刚结束但仍有子代理在跑 → 挂起(pending),不响;
    //   · 已挂起,主会话空闲且子代理归零 → 补响一次,并清掉挂起。
    // 挂起只在"确认该响"时清除,因此同一轮工作最多响一次。
    function stepChime(state, running, activeSubagents) {
      var lastRunning = state === undefined || state === null ? running : state.lastRunning;
      var pending = state === undefined || state === null ? false : state.pending === true;
      var idle = activeSubagents === 0;
      var chime = false;
      if (lastRunning === true && running === false) {
        if (idle) {
          pending = false;
          chime = true;
        } else {
          pending = true;
        }
      } else if (pending && running === false && idle) {
        pending = false;
        chime = true;
      }
      return { lastRunning: running, pending: pending, chime: chime };
    }

    // ── 会话结束监听组件 ────────────────────────────────────────
    // 注册于 conversation.composer.dock(ComposerBar 下方的 ambient 座位):
    // 该座位 scope 为 session,组件通过标准 props 的 useSession 选择器订阅
    // 当前绑定会话快照,因此 running 变化(含回复完成 true→false)都会触发
    // 重渲。会话切换时 StrictSessionEntry 以会话 id 为 key 强制重挂,本组
    // 件的初始 ref 总是当前会话的值,不会把上一会话的完成误报给新会话。
    //
    // v0.3.0 判定:回复结束(running true→false)且当前会话没有 running 子代理
    // 才响;仍有子代理在跑则挂起(pending),等"主会话空闲 + 子代理归零"时补响
    // 一次 —— 覆盖两条路径:子代理结束唤醒父会话(父处理完再停时),以及父会话
    // 未被唤醒而子代理直接结束(计数归零时)。状态机由 stepChime 承担(纯函数,
    // 单测覆盖挂起/补响/不重复响),挂起只在确认该响时清除,同一轮工作最多响一次。
    function IdleAwareWatcher(props) {
      var useSession = props.useSession;
      var useSessions = props.useSessions;
      var sessionId = useSession(function (s) { return s === undefined ? undefined : s.sessionId; });
      var running = useSession(function (s) { return s === undefined ? undefined : s.running; });
      var activeSubagents = useSessions(function (state) {
        return state === undefined || state === null ? 0 : countRunningDescendants(state.byId, sessionId);
      });
      var lastRunning = react.useRef(running);
      var pending = react.useRef(false);
      var audioRef = react.useRef(null);

      react.useEffect(function () {
        var step = stepChime(
          { lastRunning: lastRunning.current, pending: pending.current },
          running,
          activeSubagents
        );
        if (step.chime) playChime(audioRef);
        lastRunning.current = step.lastRunning;
        pending.current = step.pending;
      }, [running, activeSubagents]);

      // 卸载时释放音频上下文。
      react.useEffect(function () {
        return function () {
          if (audioRef.current) audioRef.current.close().catch(function () {});
        };
      }, []);

      return null;
    }

    // ── 退化实现 ────────────────────────────────────────────────
    // 标准 props 未提供 useSessions(客户端契约变化)时保持 v0.2.0 行为:
    // 每次回复完成即响,不静默失效。
    function LegacyWatcher(props) {
      var useSession = props.useSession;
      var running = useSession(function (s) { return s === undefined ? undefined : s.running; });
      var lastRunning = react.useRef(running);
      var audioRef = react.useRef(null);

      react.useEffect(function () {
        if (lastRunning.current === true && running === false) {
          playChime(audioRef);
        }
        lastRunning.current = running;
      }, [running]);

      react.useEffect(function () {
        return function () {
          if (audioRef.current) audioRef.current.close().catch(function () {});
        };
      }, []);

      return null;
    }

    /** 退化/停用告警只报一次,避免每轮渲染刷屏(HMR 重载会重置)。 */
    var warned = false;
    function warnOnce(message) {
      if (warned) return;
      warned = true;
      console.warn("[turn-chime] " + message);
    }

    // 座位入口:自身不调用任何 hook,只按稳定的标准 props 选择实现,
    // 让两个子组件各自无条件调用自己的 hooks(不违反 Hooks 规则)。
    // 兜底比对:两个标准 hook 任一缺失都不再保证正确判定 —— 与其抛错后被座位
    // 错误边界静默换成错误占位,不如显式降级并留一条控制台告警:
    //   · 缺 useSession → 完全无法工作,停止渲染;
    //   · 缺 useSessions → 退回 v0.2.0 的"回复完成即响"。
    function TurnChimeWatcher(props) {
      if (typeof props.useSession !== "function") {
        warnOnce("标准 props 缺少 useSession,提示音已停用");
        return null;
      }
      if (typeof props.useSessions !== "function") {
        warnOnce("标准 props 缺少 useSessions,退化为每次回复完成即响");
        return react.createElement(LegacyWatcher, props);
      }
      return react.createElement(IdleAwareWatcher, props);
    }

    // 插件依赖的服务(slots 由 client-runtime 提供)。
    var inject = ["slots"];

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) return;
      console.info("[turn-chime] v0.3.0 已加载:回复结束且当前会话无运行中子代理时才响");
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
    // 测试钩子:纯函数(浏览器侧不消费)。
    exports.__test = {
      countRunningDescendants: countRunningDescendants,
      stepChime: stepChime,
    };
    return module.exports;
  },
});
