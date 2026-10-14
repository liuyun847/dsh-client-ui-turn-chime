// 浏览器端插件主体:AI 回复真正结束、或者轮到你在某个会话里介入(提问/审批/计划
// 待审)时,播放一声双音提示音。组件不渲染可见 UI。
//
// v0.5.0 起**同时盯所有会话**,不再只盯"当前正在看的那个":
//   · 旧版挂在 conversation.composer.dock 座位(scope 为 session),只订阅绑定会话;
//     你正在看别的会话时,后台会话的提问/收尾根本没人观察 —— 2026-10-14 真机实测:
//     后台会话的提问卡片出现时不响,切回该会话才响(座位那才挂载),与"无需盯着屏幕"
//     的用途相反。
//   · 现在直接订阅两个客户端服务:sessions.list(会话摘要表,含 origin/parentId/
//     running)与 uiSession.sessionStatus(每个会话的 running / pendingInteraction),
//     对每个"用户会话"(origin !== "subagent")各跑一遍判定状态机,任一会话该响就响
//     (同一轮求值里多个会话同时该响只响一声)。
//   · 座位路径**保留作兜底**:两个服务形状变化时退回 v0.4.x 的"只盯绑定会话"。
//     两条路径共用同一份判定状态(chimeStates,按会话 id 存),所以同一会话不会被
//     判成两次、也不会连着响两声。
//
// 判定:
//   1. 某会话出现待介入(pendingInteraction,待答/待批/计划待审)且这个标识还没为它
//      响过 → 立刻响,不等收尾。DSH 默认的 `ask_user_question` 是阻塞式:工具体内
//      一直 await 你的回答,那一轮 turn 没有结束、running 始终为 true,收尾边沿根本
//      不发生 —— 只订阅 running 永远听不到;审批、计划待审同理。
//   2. 某会话回复刚结束(running true→false):
//      · 本 turn 已因待介入响过 → 不响(同一轮最多响一次);
//      · 无 running 后代子代理 → 响;
//      · 还有子代理在跑 → 挂起,等它名下的子代理全部结束、该会话空闲时补响一次。
//   3. 判定状态挂在模块级 Map(按会话 id),不放组件 ref:座位在"提问卡片让位/回来"
//      时会重挂本组件,ref 每次从当前值重新起算,待介入判定会被整条吃掉(探针证据:
//      `tc-seenpending` 与 `tc-mount` 同毫秒成对出现、且始终没有 `tc-fired`)。
//      代价是"带着未答问题刷新页面会响一次",视为可接受(那本来就是有人在等你)。
//
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
//
// 兼容性:
//  - 座位契约适配 DSH 0.1.2-rc.1(conversation.composer.dock 是 scope:"session" 的
//    list 座位,条目只收标准 props:useSession / useSessions / useSessionStatus 等);
//    旧版依赖 InputZone 时代 owner props 注入 { session, input } 的写法已移除。
//  - v0.3.0 起加"无 running 子代理"门控;v0.4.x 起加待介入判定;v0.5.0 起改为
//    全局监听 + 座位兜底。
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

    // 全局监听用的音频上下文(座位兜底各用自己的,互不干扰:座位卸载时会
    // close 掉自己的那个)。
    var globalAudio = { current: null };

    // ── 待介入标识 ──────────────────────────────────────────────
    // sessionStatus 快照里每个会话一行 { running, pendingInteraction,
    // completionUnread };pendingInteraction 是各业务域(用户提问 / 审批 /
    // 计划审阅)贡献的交互对象,自带稳定 key(审批是 `approval:<n>`,问题是卡片
    // key)。这里只抽出"标识字符串":undefined = 没人等你;字符串 = 有人在等你。
    // 判定只看标识变没变、不看具体 kind —— 任何要你回一句的交互(待答 question /
    // 待批 approval / 计划待审 plan-review)都该响,新增 kind 也不必改这里。
    // 兜底顺序 key → callId → kind:形状变了也不会退化成"永远不响"。
    function pendingKeyOf(status) {
      if (status === undefined || status === null) return undefined;
      var interaction = status.pendingInteraction;
      if (interaction === undefined || interaction === null) return undefined;
      if (interaction.key !== undefined && interaction.key !== null) return interaction.key;
      if (interaction.callId !== undefined && interaction.callId !== null) return interaction.callId;
      if (interaction.kind !== undefined && interaction.kind !== null) return interaction.kind;
      return "pending";
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

    // ── 判定状态机(纯函数,单会话) ─────────────────────────────
    // 一步演进:输入上一次的状态与本轮快照(running、活跃子代理数、待介入标识),
    // 返回是否该响 + 新状态。抽成纯函数便于单测覆盖全部路径。
    //   state           上一次的 { lastRunning, lastChimedPendingKey, pending,
    //                   chimedForTurn };缺省 = 本页第一次见到这个会话
    //   running         本轮会话 running
    //   activeSubagents 本轮 running 后代子代理数
    //   pendingKey      本轮待介入标识(undefined = 没人等你)
    // 规则(按此顺序):
    //   1. 有待介入、且这个标识还没为它响过 → 响,并记下"本 turn 已响过":
    //      "现在轮到你了",不该等收尾。标识没变不重复响;换了另一个(同一轮里的
    //      第二次提问、或问题换成审批)再响一次。注意判定依据是"标识 ≠ 上次响过的
    //      标识",不是"从无到有的边沿" —— 边沿判定会在组件被重挂时整条漏响(真机
    //      实测),所以本页第一次见到某会话时,state 缺省即视为"还没为它响过"。
    //   2. 回复刚结束(running true→false):
    //      · 本 turn 已因待介入响过 → 不响,清掉标记(同一轮最多响一次);
    //      · 无子代理在跑 → 响;
    //      · 仍有子代理在跑 → 挂起(pending),不响;
    //   3. 已挂起,主会话空闲且子代理归零 → 补响一次,并清掉挂起。
    // 挂起只在"确认该响"时清除,因此同一轮工作最多响一次。
    function stepChime(state, running, activeSubagents, pendingKey) {
      var fresh = state === undefined || state === null;
      var lastRunning = fresh ? running : state.lastRunning;
      var lastChimedPendingKey = fresh ? undefined : state.lastChimedPendingKey;
      var pending = fresh ? false : state.pending === true;
      var chimedForTurn = fresh ? false : state.chimedForTurn === true;
      var idle = activeSubagents === 0;
      var chime = false;

      if (pendingKey !== undefined && pendingKey !== null && pendingKey !== lastChimedPendingKey) {
        chime = true;
        chimedForTurn = true;
        lastChimedPendingKey = pendingKey;
      }

      if (lastRunning === true && running === false) {
        if (chimedForTurn) {
          pending = false;
          chimedForTurn = false;
        } else if (idle) {
          pending = false;
          chime = true;
        } else {
          pending = true;
        }
      } else if (pending && running === false && idle) {
        pending = false;
        if (!chimedForTurn) chime = true;
        chimedForTurn = false;
      }

      return {
        lastRunning: running,
        lastChimedPendingKey: lastChimedPendingKey,
        pending: pending,
        chimedForTurn: chimedForTurn,
        chime: chime,
      };
    }

    // ── 全局一轮求值(纯函数,多会话) ───────────────────────────
    // 对每个"用户会话"(摘要表里有、且 origin !== "subagent")推进一次状态机。
    //   states  上一轮的 Map<sessionId, state>
    //   byId    会话摘要表(sessions.list 快照的 byId:origin/parentId/running)
    //   status  Map<sessionId, { running, pendingInteraction }>(uiSession.sessionStatus)
    //   prune   摘要表已就绪(list.phase === "ready")时,把这一轮没出现的会话状态
    //           丢掉;未就绪时保留(列表还在加载,不能把基线当没建过)
    // 返回 { states: 新 Map, chime: 这一轮是否有会话该响 } —— 同一轮里多个会话同时
    // 该响只算一次,调用方只播一声。
    // 子代理会话自己不算:它的收尾由所属父会话的"子代理全部结束"补响覆盖,否则一个
    // 协调者轮次会连响好几声。
    function stepAll(states, byId, status, prune) {
      var next = new Map();
      if (!prune && states) states.forEach(function (value, key) { next.set(key, value); });
      var chime = false;
      var ids = Object.keys(byId || {});
      if (status && typeof status.forEach === "function") {
        status.forEach(function (_value, id) { if (ids.indexOf(id) < 0) ids.push(id); });
      }
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var row = byId === undefined || byId === null ? undefined : byId[id];
        if (row !== undefined && row !== null && row.origin === "subagent") continue;
        var statusRow = status === undefined || status === null ? undefined : status.get(id);
        var running;
        if (statusRow !== undefined && statusRow !== null && statusRow.running !== undefined) running = statusRow.running;
        else if (row !== undefined && row !== null) running = row.running;
        if (running === undefined || running === null) continue;
        var step = stepChime(
          states === undefined || states === null ? undefined : states.get(id),
          running,
          countRunningDescendants(byId, id),
          pendingKeyOf(statusRow)
        );
        next.set(id, step);
        if (step.chime) chime = true;
      }
      return { states: next, chime: chime };
    }

    // ── 判定状态按会话存模块级 ──────────────────────────────────
    // 不放组件 ref:座位在"提问卡片让位/回来"时会重挂本组件,ref 每次都从当前值
    // 重新起算,待介入的判定会被整条吃掉。模块级 Map 在页面内跨重挂保持,插件重载
    // 或刷新页面即清空(清空后第一个待介入会被当作"还没为它响过",响一次)。
    // 全局监听与座位兜底共用这一份状态,所以同一会话不会被判成两次。
    var chimeStates = new Map();

    // ── 全局监听:装上就直接订阅两个客户端服务 ──────────────────
    // 不依赖任何座位:座位只在"该会话正在显示"时存在,后台会话的收尾/提问会整条漏掉。
    // 返回 disposer;两个服务形状不符时返回 null(调用方退回座位兜底)。
    function installGlobalWatcher(sessions, uiSession) {
      var list = sessions === undefined || sessions === null ? undefined : sessions.list;
      if (list === undefined || list === null || typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return null;
      var status = uiSession === undefined || uiSession === null ? undefined : uiSession.sessionStatus;
      if (status === undefined || status === null || typeof status.subscribe !== "function" || typeof status.getSnapshot !== "function") return null;

      var evaluate = function () {
        var snapshot;
        try { snapshot = list.getSnapshot(); } catch (err) { console.error("[turn-chime] 读会话摘要失败", err); return; }
        var byId = snapshot === undefined || snapshot === null ? undefined : snapshot.byId;
        var ready = snapshot !== undefined && snapshot !== null && snapshot.phase === "ready";
        var result = stepAll(chimeStates, byId, status.getSnapshot(), ready);
        chimeStates.clear();
        result.states.forEach(function (value, key) { chimeStates.set(key, value); });
        if (result.chime) playChime(globalAudio);
      };

      var disposers = [list.subscribe(evaluate), status.subscribe(evaluate)];
      evaluate();
      return function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i](); } catch (err) { console.error("[turn-chime] 退订失败", err); }
        }
      };
    }

    // ── 座位兜底:标准 props 齐备时只盯绑定会话(v0.4.x 行为) ────
    // 全局监听装上后这条路径判出来的结果与全局一致(共用 chimeStates),
    // 因此不会重复响;它只在服务形状变化、全局监听装不上时兜底。
    function InteractionAwareWatcher(props) {
      var useSession = props.useSession;
      var useSessions = props.useSessions;
      var useSessionStatus = props.useSessionStatus;
      var sessionId = useSession(function (s) { return s === undefined ? undefined : s.sessionId; });
      var running = useSession(function (s) { return s === undefined ? undefined : s.running; });
      var activeSubagents = useSessions(function (state) {
        return state === undefined || state === null ? 0 : countRunningDescendants(state.byId, sessionId);
      });
      // 选择器只吐一个字符串:状态快照每次发布都会重建 Map,但标识没变时不触发
      // 重渲,effect 也就不会因无谓的重渲重复求值。
      var pendingKey = useSessionStatus(function (snapshot) {
        if (snapshot === undefined || snapshot === null || sessionId === undefined) return undefined;
        return pendingKeyOf(snapshot.get(sessionId));
      });
      var audioRef = react.useRef(null);

      react.useEffect(function () {
        if (sessionId === undefined) return;
        var step = stepChime(chimeStates.get(sessionId), running, activeSubagents, pendingKey);
        if (step.chime) playChime(audioRef);
        chimeStates.set(sessionId, step);
      }, [running, activeSubagents, pendingKey]);

      // 卸载时释放音频上下文。
      react.useEffect(function () {
        return function () {
          if (audioRef.current) audioRef.current.close().catch(function () {});
        };
      }, []);

      return null;
    }

    // 降级实现一:标准 props 没有 useSessionStatus → 退回 v0.3.0"只看回复完成"。
    function IdleAwareWatcher(props) {
      var useSession = props.useSession;
      var useSessions = props.useSessions;
      var sessionId = useSession(function (s) { return s === undefined ? undefined : s.sessionId; });
      var running = useSession(function (s) { return s === undefined ? undefined : s.running; });
      var activeSubagents = useSessions(function (state) {
        return state === undefined || state === null ? 0 : countRunningDescendants(state.byId, sessionId);
      });
      var audioRef = react.useRef(null);

      react.useEffect(function () {
        if (sessionId === undefined) return;
        var step = stepChime(chimeStates.get(sessionId), running, activeSubagents, undefined);
        if (step.chime) playChime(audioRef);
        chimeStates.set(sessionId, step);
      }, [running, activeSubagents]);

      // 卸载时释放音频上下文。
      react.useEffect(function () {
        return function () {
          if (audioRef.current) audioRef.current.close().catch(function () {});
        };
      }, []);

      return null;
    }

    // 降级实现二:标准 props 也没有 useSessions → 回到 v0.2.0"回复完成即响"。
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

      // 卸载时释放音频上下文。
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
    // 让各子组件各自无条件调用自己的 hooks(不违反 Hooks 规则)。
    //   · 缺 useSession → 完全无法工作,停止渲染;
    //   · 缺 useSessions → 退回 v0.2.0 的"回复完成即响";
    //   · 缺 useSessionStatus → 退回 v0.3.0 的"只看回复完成"(待答/待批不提示)。
    function TurnChimeWatcher(props) {
      if (typeof props.useSession !== "function") {
        warnOnce("标准 props 缺少 useSession,座位兜底已停用");
        return null;
      }
      if (typeof props.useSessions !== "function") {
        warnOnce("标准 props 缺少 useSessions,座位兜底退化为每次回复完成即响");
        return react.createElement(LegacyWatcher, props);
      }
      if (typeof props.useSessionStatus !== "function") {
        warnOnce("标准 props 缺少 useSessionStatus,座位兜底不再提示待答/待批(回复完成照响)");
        return react.createElement(IdleAwareWatcher, props);
      }
      return react.createElement(InteractionAwareWatcher, props);
    }

    // 插件依赖的服务:slots 用于座位兜底与临时诊断;sessions / uiSession 是全局
    // 监听要用的两个服务,用可选读取(ctx.get)而不是 inject —— inject 是"全有才
    // apply"的硬门,列进来会连带把座位兜底一起挡掉。
    var inject = ["slots"];

    function apply(ctx) {
      var slots = ctx.get("slots");
      // 全局监听(主路径):订阅会话摘要表 + 会话状态表,覆盖所有会话(含后台)。
      var disposeGlobal = installGlobalWatcher(ctx.get("sessions"), ctx.get("uiSession"));
      if (disposeGlobal === null) {
        warnOnce("拿不到 sessions.list / uiSession.sessionStatus,只能退回座位兜底(仅当前会话)");
      }
      if (disposeGlobal !== null) {
        ctx.effect(function () { return disposeGlobal; }, "turn-chime: global watcher");
        console.info("[turn-chime] v0.5.0 已加载:盯所有会话 —— 回复结束且无运行中子代理时响,待答/待批/计划待审出现时也响(同一轮只响一次)");
      } else {
        console.info("[turn-chime] v0.5.0 已加载:全局监听不可用,退回座位兜底(仅当前会话)");
      }
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
    // 测试钩子:纯函数(浏览器侧不消费)。
    exports.__test = {
      countRunningDescendants: countRunningDescendants,
      pendingKeyOf: pendingKeyOf,
      stepAll: stepAll,
      stepChime: stepChime,
    };
    return module.exports;
  },
});
