// 浏览器端插件主体:AI 回复真正结束、或者轮到你在某个会话里介入(提问/审批/计划
// 待审)时,播放一声双音提示音。组件不渲染可见 UI。
//
// v0.5.0 起**同时盯所有会话**,不再只盯"当前正在看的那个":
//   · 旧版挂在 conversation.composer.dock 座位(scope 为 session),只订阅绑定会话;
//     你正在看别的会话时,后台会话的提问/收尾根本没人观察,现象是:
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
// v0.5.2 起两处修正:
//   · 音频解锁:浏览器要求 AudioContext 在用户手势之后才能启动,页面从未被点击/敲键
//     时它停在 suspended,那一声音是**静音**的(控制台只留一条 "The AudioContext was
//     not allowed to start …",插件侧零日志)。现在 apply 挂一次性 pointerdown/keydown,
//     首次手势时创建/恢复上下文并播一个无声缓冲解锁,resume 失败改为 warn 一条。
//   · 摘要表缺行的会话(只在 uiSession.sessionStatus 有行、sessions.list 里没有):
//     无法判断它是不是子代理 ⇒ 不判它的收尾边沿(否则会与父会话的"子代理归零补响"
//     叠成一轮两声),但待介入照判 —— 有人在等你与有没有摘要行无关。
//
// v0.5.3 起五处修正(独立对抗性复核查出,逐条见下):
//   · D1 静默漏响:拿不到可信 running 的那一轮(摘要表缺行)不再让"本 turn 已因待介入响过"
//     的标记无限期留着 —— 它会吞掉下一次真正的收尾边沿(仿真:该响 2 声只响 1 声)。这条修法本身
//     有副作用(缺行期响过待介入、而那一轮仍在跑时,该轮收尾会又多响一声),v0.5.4 的 M1 把复位
//     时机挪到了"摘要行回来的那一轮",见下。
//   · D2 漏响待介入:子代理会话的审批/提问原来被整条跳过,而那时父会话 running 仍是 true、
//     没有收尾边沿 ⇒ 整段完全静默。现在子代理行也判待介入,只是不判 running 边沿
//     (收尾仍由父会话的"子代理归零补响"覆盖,不单独响)。
//   · D3 加载期无声退化:安装期首轮求值若发现待介入,原来会当场建 AudioContext —— 那时还没有
//     任何用户手势,上下文被浏览器拦成 suspended,排进去的振荡器全部静音(只多出一条浏览器警告)。
//     现在未解锁时既不建上下文也不排振荡器,只记下"有一声被吞掉了",首次手势解锁成功后补响一次。
//   · D4 多响:子代理行"出现→消失→再出现"时它的判定状态被 prune 丢掉 ⇒ 同一条待介入标识
//     二次响。现在子代理行的状态按"确实有东西要记"保留,prune 也不再丢这类状态。
//   · D5 无声退化:primeAudio 抛错后原来照样置"已解锁"并摘掉手势监听 ⇒ 永久静音。现在只有
//     真正成功才算解锁(失败就保留监听,下次手势重试;重试仍失败 warn 一条,不静默)。
//
// v0.5.4 起三处修正(第二轮独立对抗性复核查出的"修法镜像/副作用"开口):
//   · M1 同一轮多响一声:v0.5.3 的 D1 修法把"本 turn 已因待介入响过"的标记在**缺行轮次**当场清掉,
//     于是"缺行期间响过待介入、而那一轮仍在跑"的会话在收尾时又按"无标记的边沿"响一声(仿真:该响
//     1 声响 2 声)。现在复位挪到"摘要行回来的那一轮、按已知 running 决定":判不出收尾边沿且该会话
//     已空闲 ⇒ 这枚标记属于**已经结束的那一轮**,作废;仍在跑 ⇒ **保留**(该轮收尾正靠它抑制重复响)。
//   · M2 漏响一声:prune 补回的"整条消失一轮"的状态带着陈旧的"本 turn 已响过"标记回来,把消失期间
//     新起那一轮的收尾响吞掉(仿真:该响 2 声响 1 声)。现在补回时只清这枚标记,保留"已响过的待介入
//     标识"与挂起 —— 前者仍负责拦"同一标识重复响",后者的补回正是 D4 要修的"子代理归零后漏补响"。
//   · M3 HMR 副作用(低):audioUnlocked 是模块级变量,插件原地重载后复位为 false,而浏览器对本
//     document 的解锁其实是**粘性**的(早已激活)⇒ 重载后该响的一声被压成"补响",要等下一次手势
//     才出声(v0.5.2 在已激活页面里是当场出声的)。现在用只读信号 navigator.userActivation.
//     hasBeenActive(防御性读取)初始化它:已激活页面当场出声,没激活过的页面照旧一声不排等手势。
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
//    全局监听 + 座位兜底;v0.5.1 起等服务就绪后再装全局监听;v0.5.2 起加音频手势解锁,
//    并让"没有会话摘要行的会话"只判待介入;v0.5.3 起修静默漏响、子代理会话的待介入漏响、
//    加载期建 AudioContext、子代理状态被 prune 丢掉、解锁失败后永久静音这五处;v0.5.4 起修
//    "缺行期响过待介入的那一轮收尾又多响一声"、"整条消失一轮的会话回来时吞掉消失期间新起那一轮的
//    收尾响"、"HMR 原地重载后音频被重新锁上"这三处;v0.5.5 起只改性能 —— 子代理计数从"每个
//    用户会话各扫一遍全表"改成"每轮建一次父→子索引 + 索引上向下 BFS"(会话行数与用户会话数
//    到千级时,单次 stepAll 的开销随「用户会话数 × 会话行数」增长;改为每轮建一次索引后,同一量级
//    下开销降到毫秒以下),判定语义与对外签名不变;同时删掉定位「收尾不响」用的临时诊断探针。
window.__ModuleLoader__.load({
  id: "dsh-client-ui-turn-chime",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // ── 音频:合成双音"叮咚"(C6→G6,约 0.7 秒)、用户手势解锁 ────────
    // 两路音频(全局监听的 globalAudio、座位兜底组件自己的 ref)共用同一套"取上下文 +
    // resume + 失败告警"口径。浏览器要求 AudioContext 必须在**用户手势之后**才能启动:
    // 页面从未被点击/敲键时它会停在 suspended,排进去的振荡器一声不响(控制台只留一条
    // "The AudioContext was not allowed to start …")—— 这正是旧版"完全不响且无日志"的
    // 根因,见下方 resumeAudio 与 installAudioUnlock。
    var globalAudio = { current: null };

    /** 取 AudioContext 构造器(含 webkit 前缀兜底);浏览器不支持时返回 undefined。 */
    function audioContextCtor() {
      if (typeof window === "undefined" || window === null) return undefined;
      return window.AudioContext || window.webkitAudioContext;
    }

    /**
     * 取(必要时创建)某路音频的上下文;不支持或创建失败时返回 undefined。
     * allowCreate 只在**用户手势里**传 true:没有手势时浏览器会把新建的上下文拦成
     * suspended,排进去的振荡器一声不响,还要白搭一条 "The AudioContext was not allowed
     * to start …" 警告(见 playChime 的未解锁分支与 installAudioUnlock)。
     */
    function acquireAudio(audioRef, allowCreate) {
      var Ctor = audioContextCtor();
      if (!Ctor) return undefined;
      if (audioRef.current) return audioRef.current;
      if (allowCreate !== true) return undefined;
      try {
        audioRef.current = new Ctor();
      } catch (err) {
        console.error("[turn-chime] 创建 AudioContext 失败", err);
        return undefined;
      }
      return audioRef.current;
    }

    /** 音频类告警也只报一次;与 warnOnce 分开,免得两者把对方的提示吞掉。 */
    var warnedAudio = false;
    function warnAudioOnce(message) {
      if (warnedAudio) return;
      warnedAudio = true;
      console.warn("[turn-chime] " + message);
    }

    /** 错误对象转一行文案。 */
    function describeError(err) {
      if (err === undefined || err === null) return "未知错误";
      return err.message ? String(err.message) : String(err);
    }

    /**
     * 把音频上下文推进到 running。
     * 浏览器规定 AudioContext 必须在用户手势之后才能创建/恢复;没恢复成功时它停在
     * suspended,那一声是**静音**的 —— 旧版在这里 .catch(function () {}) 把失败吞掉,
     * 于是"不响也没日志"。现在:恢复失败、或恢复后仍非 running,都 warnAudioOnce 一次。
     * @returns 当前是否已 running(resume 是异步的,同一次调用里多半仍是 false)
     */
    function resumeAudio(ac) {
      if (ac.state === "running") return true;
      if (typeof ac.resume !== "function") {
        warnAudioOnce("音频上下文没有 resume 方法,提示音可能听不到 —— 请先在页面里点一下或敲一下");
        return false;
      }
      var stillSuspended = function () {
        if (ac.state !== "running") {
          warnAudioOnce("音频上下文仍停在 " + ac.state + ",提示音可能听不到 —— 请先在页面里点一下或敲一下");
        }
      };
      try {
        var pending = ac.resume();
        if (pending && typeof pending.then === "function") {
          pending.then(stillSuspended, function (err) {
            warnAudioOnce("音频上下文 resume 失败(" + describeError(err) + "),提示音可能听不到 —— 请先在页面里点一下或敲一下");
          });
        } else {
          stillSuspended();
        }
      } catch (err) {
        warnAudioOnce("音频上下文 resume 抛错(" + describeError(err) + "),提示音可能听不到 —— 请先在页面里点一下或敲一下");
      }
      return ac.state === "running";
    }

    /**
     * 播一个极短的无声缓冲:手势之后真正把音频通道打开(部分浏览器 resume 后仍不出声)。
     * @returns 是否算解锁成功 —— 抛错时返回 false,调用方据此**不置解锁**、保留手势监听,
     *   下一次手势再试一遍(v0.5.3,D5;旧版在这里吞掉异常照样摘监听 ⇒ 永久静音)。
     *   浏览器没有 createBuffer/createBufferSource 时无从解锁,按"没得可做"算成功。
     */
    function primeAudio(ac) {
      try {
        if (typeof ac.createBuffer !== "function" || typeof ac.createBufferSource !== "function") return true;
        var source = ac.createBufferSource();
        source.buffer = ac.createBuffer(1, 1, 22050);
        source.connect(ac.destination);
        source.start(0);
        return true;
      } catch (err) {
        console.error("[turn-chime] 音频解锁失败", err);
        return false;
      }
    }

    // ── 音频解锁状态(v0.5.3,D3) ────────────────────────────────
    // 未解锁(页面还没被点过/敲过)时**不创建上下文、也不排振荡器**:那时上下文只会被浏览器
    // 拦成 suspended,振荡器排进去也一声不响,却要白挨一条 "The AudioContext was not allowed
    // to start …" 警告。现在只记下"有一声被吞掉了",等首次手势**真正解锁成功后补响一次** —— 这
    // 正是本插件"带着未答问题刷新页面会响一次"的设计意图(改动前那一声根本听不见)。
    // v0.5.4(M3):audioUnlocked 是**模块级**变量,插件被 HMR 原地重载后新建模块作用域、它复位成
    // false —— 而浏览器对本 document 的解锁是**粘性**的(hasBeenActive 一旦为 true 就不再变),重载
    // 并没有重新上锁。旧写法于是把重载后的响压成"补响",要等下一次用户手势才出声(v0.5.2 在已激活
    // 页面里是当场出声的)。现在用只读信号 navigator.userActivation.hasBeenActive 初始化它:
    // navigator / userActivation 都可能不存在(旧浏览器、非浏览器宿主、测试桩),一律防御性读取,
    // 缺失就按"没激活"处理 —— 那种页面本来也不允许出声[D3],照旧一声不排、等手势解锁。
    /**
     * 读"本 document 是否已被用户激活过"(粘性用户激活,只读信号)。
     * window.navigator 优先(浏览器里它与全局 navigator 是同一个对象),再退回全局 navigator;
     * 任何一步缺失或抛错都按"没激活过"算。只返回布尔,不产生任何副作用。
     */
    function detectStickyUserActivation() {
      var candidates = [];
      try {
        if (typeof window !== "undefined" && window !== null) candidates.push(window.navigator);
      } catch (err) { /* 读不到就当没有这个信号 */ }
      try {
        if (typeof navigator !== "undefined" && navigator !== null) candidates.push(navigator);
      } catch (err) { /* 同上 */ }
      for (var i = 0; i < candidates.length; i++) {
        var nav = candidates[i];
        if (nav === undefined || nav === null) continue;
        var activation;
        try { activation = nav.userActivation; } catch (err) { continue; }
        if (activation === undefined || activation === null) continue;
        var hasBeenActive;
        try { hasBeenActive = activation.hasBeenActive; } catch (err) { continue; }
        if (hasBeenActive === true) return true;
      }
      return false;
    }

    var audioUnlocked = detectStickyUserActivation();
    var suppressedChime = false;

    /** 解锁成功后把"未解锁期间被吞掉的那一声"补响一次(只补一次,不是每来一次事件补一次)。 */
    function flushSuppressedChime() {
      if (suppressedChime !== true) return;
      suppressedChime = false;
      playChime(globalAudio);
    }

    function playChime(audioRef) {
      if (audioUnlocked !== true) {
        suppressedChime = true; // 记下来,等解锁成功后补响(见 installAudioUnlock)
        return;
      }
      try {
        var ac = acquireAudio(audioRef, true);
        if (!ac) return;
        resumeAudio(ac);
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

    // ── 一次性音频解锁(用户手势) ────────────────────────────────
    // 页面从未被点击/敲键时浏览器不让 AudioContext 启动,提示音必然是静音的。所以 apply
    // 里挂一次性的 pointerdown / keydown(捕获阶段)监听:首次手势时创建/恢复上下文、
    // 播一个无声缓冲真正解锁,随即摘掉两个监听,并补响一次未解锁期间被吞掉的那声。监听本身
    // 挂在 ctx.effect 上,插件被 HMR 原地重载时随作用域一起清掉,不留悬挂监听。
    // **不**在页面加载时就创建上下文:那只会白挨一条浏览器警告,照样是 suspended —— 这一条
    // 现在由 playChime 的未解锁分支真正落实(安装期首轮求值不再建上下文)。
    // 解锁**只在真正成功之后**才算完成(v0.5.3,D5):拿不到上下文、或无声缓冲抛错时都不置
    // unlocked、保留监听,下一次手势再试一遍;重试仍失败就 warnAudioOnce 一条(不静默退化)。
    function installAudioUnlock(ctx) {
      if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") return;
      var events = ["pointerdown", "keydown"];
      var unlocked = false;
      var attempts = 0;
      var remove = function () {
        for (var i = 0; i < events.length; i++) {
          try { window.removeEventListener(events[i], unlock, true); } catch (err) { /* 清理尽力而为 */ }
        }
      };
      /** 真正完成解锁:停掉手势监听,并补响一次未解锁期间被吞掉的响。 */
      var finish = function () {
        if (unlocked) return;
        unlocked = true;
        audioUnlocked = true;
        remove();
        flushSuppressedChime();
      };
      var unlock = function () {
        if (unlocked) return; // 一次性:两个事件谁先来都只解锁一次(失败不算解锁,留给下一次手势重试)
        attempts += 1;
        var ac = acquireAudio(globalAudio, true);
        if (!ac) {
          // 上下文建不出来(不支持 / 构造抛错):不当解锁,保留监听等下一次手势;重试仍失败才报一条。
          if (attempts > 1) warnAudioOnce("音频解锁失败:拿不到 AudioContext,提示音可能听不到 —— 请先在页面里点一下或敲一下");
          return;
        }
        resumeAudio(ac);
        if (primeAudio(ac)) { finish(); return; }
        // 无声缓冲抛错:不算解锁,保留监听等下一次手势再试;重试仍失败就报一条(不再静默)。
        if (attempts > 1) warnAudioOnce("音频解锁失败,提示音可能听不到 —— 请先在页面里点一下或敲一下");
      };
      for (var i = 0; i < events.length; i++) {
        window.addEventListener(events[i], unlock, true);
      }
      ctx.effect(function () { return remove; }, "turn-chime: audio unlock");
    }

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
    // v0.5.5(性能):下面这套"每个根各扫一遍全表"的算法复杂度是 O(用户会话数 × 总行数),
    // 子代理计数(对每个用户会话各扫一遍全表)是单次求值里开销最大的那部分。现在拆成两个函数:
    // indexSubagentRowsByParent 把摘要表遍历**一次**、按 parentId 归组成"父 → 子代理行"索引,
    // countRunningDescendantsInIndex 在该索引上从根向下 BFS;countRunningDescendants 保留为
    // "建一次索引 + 查一次"的薄包装,对外签名与语义不变(座位兜底与单测照旧用它)。
    /**
     * 建"父会话 → 子代理行"索引:摘要表只遍历**一次**。
     * 只收 `origin === "subagent"` 且 `parentId !== undefined` 的行 —— 与旧实现 while 条件同一口径;
     * 收行时**不看 running**(非 running 的中间行也要能用来下推,计数时再筛 running)。
     * 桶键取 `String(parentId)`:旧实现 `summaries[row.parentId]` 的属性键本来就会被强制转成
     * 字符串,同口径才推得下去(null 归到 "null" 桶)。
     * @returns Map<属性键, Array<{row, key}>>;`key` 是该行在 summaries 里的自有键(下推时用它找子行)
     */
    function indexSubagentRowsByParent(summaries) {
      var index = new Map();
      if (summaries === undefined || summaries === null) return index;
      var keys = Object.keys(summaries);
      for (var i = 0; i < keys.length; i++) {
        var row = summaries[keys[i]];
        if (row === undefined || row === null) continue;
        if (row.origin !== "subagent" || row.parentId === undefined) continue;
        var bucketKey = String(row.parentId);
        var bucket = index.get(bucketKey);
        if (bucket === undefined) {
          bucket = [];
          index.set(bucketKey, bucket);
        }
        bucket.push({ row: row, key: keys[i] });
      }
      return index;
    }

    /**
     * 在索引上从根向下 BFS,数出"沿 parentId 上溯能命中该根"的 running 子代理数。
     * 起点(parentId **严格等于** rootSessionId 的行)再筛一遍严格相等:旧实现那句
     * `current.parentId === rootSessionId` 用的就是严格相等,而索引键是字符串化的 parentId,
     * 单靠 Map.get 会把 5 与 "5" 混为一谈。之后沿"当前行的自有键"下推 —— 与旧实现的
     * `current = summaries[current.parentId]` 取到的正是同一个节点。
     * visited 按自有键去重:环不会死循环(旧实现是每行带一份 seen 上溯,这里从根向下每个节点只走一次)。
     * 等价性:某行被计入 ⟺ 它的上溯路径能到达某个"parentId === 根"的节点,而可达性与路径无关
     * ⇒ 与逐行上溯的实现同结果,只是不再为每个根重扫全表。
     */
    function countRunningDescendantsInIndex(index, rootSessionId) {
      if (index === undefined || index === null || rootSessionId === undefined) return 0;
      var seed = index.get(String(rootSessionId));
      if (seed === undefined) return 0;
      var count = 0;
      var visited = new Set();
      var frontier = [];
      for (var s = 0; s < seed.length; s++) {
        if (seed[s].row.parentId === rootSessionId) frontier.push(seed[s]);
      }
      while (frontier.length > 0) {
        var entry = frontier.pop();
        if (visited.has(entry.key)) continue;
        visited.add(entry.key);
        if (entry.row.running === true) count += 1; // origin === "subagent" 由索引保证
        var children = index.get(entry.key);
        if (children === undefined) continue;
        for (var c = 0; c < children.length; c++) frontier.push(children[c]);
      }
      return count;
    }

    /**
     * 单个根的子代理计数(薄包装,座位兜底与单测照旧用它):建一次索引 + 查一次。
     * 语义与 v0.5.4 完全相同;一轮里要查多个根时复用索引,别再逐根建(见 stepAll)。
     */
    function countRunningDescendants(summaries, rootSessionId) {
      if (summaries === undefined || summaries === null || rootSessionId === undefined) return 0;
      return countRunningDescendantsInIndex(indexSubagentRowsByParent(summaries), rootSessionId);
    }

    // ── 判定状态机(纯函数,单会话) ─────────────────────────────
    // 一步演进:输入上一次的状态与本轮快照(running、活跃子代理数、待介入标识),
    // 返回是否该响 + 新状态。抽成纯函数便于单测覆盖全部路径。
    //   state           上一次的 { lastRunning, lastChimedPendingKey, pending,
    //                   chimedForTurn };缺省 = 本页第一次见到这个会话
    //   running         本轮会话 running(不可判定时由调用方按 runningKnown=false 传 false)
    //   activeSubagents 本轮 running 后代子代理数
    //   pendingKey      本轮待介入标识(undefined = 没人等你)
    //   runningKnown    false = 本轮拿不到该会话可信的 running(摘要表里没有它的行,见
    //                   stepAll):"回复结束"的边沿与"等子代理归零"的挂起都**不判**,只走
    //                   待介入分支,并原样保留上一轮的 lastRunning 基线 —— 不能拿一个假的
    //                   false 去伪造出"true→false"收尾边沿(那会和父会话的"子代理归零
    //                   补响"叠成一轮两声),也不能把真基线抹掉。
    // 规则(按此顺序):
    //   1. 有待介入、且这个标识还没为它响过 → 响,并记下"本 turn 已响过":
    //      "现在轮到你了",不该等收尾。标识没变不重复响;换了另一个(同一轮里的
    //      第二次提问、或问题换成审批)再响一次。注意判定依据是"标识 ≠ 上次响过的
    //      标识",不是"从无到有的边沿" —— 边沿判定会在组件被重挂时整条漏响,所以本页
    //      第一次见到某会话时,state 缺省即视为"还没为它响过"。
    //   2. running 可判定,且回复刚结束(running true→false):
    //      · 本 turn 已因待介入响过 → 不响,清掉标记(同一轮最多响一次);
    //      · 无子代理在跑 → 响;
    //      · 仍有子代理在跑 → 挂起(pending),不响;
    //   3. running 可判定,已挂起,主会话空闲且子代理归零 → 补响一次,并清掉挂起。
    // 挂起只在"确认该响"时清除,因此同一轮工作最多响一次。
    // 4. M1(v0.5.4):"本 turn 已因待介入响过"的标记在**判不出收尾边沿、且该会话已空闲**时作废
    //    (它属于已经结束的那一轮);判得出边沿时由边沿那一支消费。缺行/子代理行那一轮**不动**它 ——
    //    复位挪到"摘要行回来的那一轮",否则"缺行期响过待介入、那一轮仍在跑"的收尾会多响一声。
    function stepChime(state, running, activeSubagents, pendingKey, runningKnown) {
      var fresh = state === undefined || state === null;
      var canJudgeRunning = runningKnown !== false;
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

      if (canJudgeRunning) {
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
        } else if (chimedForTurn && running === false && !pending) {
          // M1(v0.5.4):本轮判不出收尾边沿(lastRunning === true && running === false 不成立)、而该会话
          // **已经空闲** ⇒ 这枚"本 turn 已因待介入响过"的标记属于**已经结束的那一轮**,留着只会吞掉
          // 下一轮真正的收尾边沿,当场作废。缺行期间置上的标记就靠这一步在"摘要行回来的那一轮"被清
          // 掉 —— v0.5.3 把复位放在缺行轮次,于是"缺行期响过待介入、那一轮仍在跑"的会话在收尾时又
          // 因标记已清而多响一声(仿真:该响 1 声响 2 声)。
          // pending 为真时**不在这里清**:那枚挂起还欠一声,补响时正靠它抑制同一轮响第二次。
          chimedForTurn = false;
        }
      }
      // 缺行/子代理行(canJudgeRunning === false)这一轮不复位任何标记:它留到"摘要行回来的那一轮"
      // 按**已知**的 running 决定(M1,v0.5.4)—— 缺行期间置上的标记在那里才判得出它属于哪一轮。

      return {
        lastRunning: canJudgeRunning ? running : lastRunning,
        lastChimedPendingKey: lastChimedPendingKey,
        pending: pending,
        chimedForTurn: chimedForTurn,
        chime: chime,
      };
    }

    // ── 全局一轮求值(纯函数,多会话) ───────────────────────────
    // 对每个可能该响的会话推进一次状态机。
    //   states  上一轮的 Map<sessionId, state>
    //   byId    会话摘要表(sessions.list 快照的 byId:origin/parentId/running)
    //   status  Map<sessionId, { running, pendingInteraction }>(uiSession.sessionStatus)
    //   prune   摘要表已就绪(list.phase === "ready")时,把这一轮没出现的会话状态
    //           丢掉;未就绪时保留(列表还在加载,不能把基线当没建过)
    // 返回 { states: 新 Map, chime: 这一轮是否有会话该响 } —— 同一轮里多个会话同时
    // 该响只算一次,调用方只播一声。
    // 三类会话分别对待(v0.5.3 起):
    //   · 摘要行 origin === "subagent" → 只判待介入,不判 running 边沿:子代理自己的收尾由
    //     所属父会话的"子代理全部结束"补响覆盖(否则一个协调者轮次会连响好几声),但子代理
    //     会话里的审批/提问同样要提醒 —— 那时父会话 running 还是 true、没有收尾边沿,不判就
    //     整段静默(D2,与"有人在等你这件事与有没有摘要行无关"同一口径);
    //   · 摘要表里有行且不是子代理 → 正常判收尾与待介入;
    //   · 摘要表里**没有行**(id 只来自 uiSession.sessionStatus)⇒ 无法判断它是不是子代理
    //     会话,所以不判它的"收尾/running 边沿"(判了可能与父会话的"子代理归零补响"重叠,
    //     一轮响两声),只判待介入 —— 有人在等你这件事与有没有摘要行无关,不能漏响。
    //   上面两类"判不了 running"的情形,实现上都是给 stepChime 传 runningKnown=false,而不是
    //   整条 continue。
    // 状态保留(D4,v0.5.3):判定状态**不能因为行一时消失就丢** —— 丢了下一次出现时同一条
    // 待介入标识会被当成"本页第一次见到",又响一次。所以:①子代理行这一轮没带来待介入时,
    // 只保留"确实有东西要记"的旧状态(stateWorthKeeping);②摘要表已就绪(prune)时,这一轮
    // 完全没出现过的会话状态也按同一口径补回来。两条都只为有内容的状态建条目,内存有界。
    /**
     * 这个判定状态里还有"要记住的东西"吗(子代理行与 prune 时据此决定留不留条目)。
     * 有内容的三种:已响过的待介入标识 / 未消费的"本 turn 已响过"标记 / 还没补响的挂起。
     * 只有 running 基线的空状态不值得留 —— 否则会给每个见过的子代理会话都建一份。
     */
    function stateWorthKeeping(state) {
      if (state === undefined || state === null) return false;
      if (state.lastChimedPendingKey !== undefined && state.lastChimedPendingKey !== null) return true;
      if (state.chimedForTurn === true) return true;
      return state.pending === true;
    }

    /**
     * 全局一轮求值(纯函数,多会话;逐类会话的口径见本节头注)。
     * v0.5.5(性能):活跃子代理数取自**循环外只建一次**的父→子索引(旧写法对每个用户会话各调一次
     * countRunningDescendants,而它每次都重扫全表);id 去重改用 Set。判定逻辑一字未动。
     */
    function stepAll(states, byId, status, prune) {
      var next = new Map();
      if (!prune && states) states.forEach(function (value, key) { next.set(key, value); });
      var chime = false;
      // v0.5.5(性能):父→子索引在循环外**只建一次**(旧写法对每个用户会话各调一次
      // countRunningDescendants,而它每次都重扫全表 ⇒ 一轮 O(用户会话数 × 总行数));
      // id 去重也从 ids.indexOf 的线性查找换成 Set 成员判定,ids 数组本身与顺序不变
      // —— byId 的自有键序在前,status 里多出来的键按它的 forEach 顺序追加。
      var ids = Object.keys(byId || {});
      var knownIds = new Set(ids);
      if (status && typeof status.forEach === "function") {
        status.forEach(function (_value, id) {
          if (knownIds.has(id)) return;
          knownIds.add(id);
          ids.push(id);
        });
      }
      var subagentIndex = indexSubagentRowsByParent(byId);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var row = byId === undefined || byId === null ? undefined : byId[id];
        var hasRow = row !== undefined && row !== null;
        // 子代理行(D2,v0.5.3):不判它的 running 边沿(收尾由父会话的"子代理归零补响"覆盖,
        // 否则一个协调者轮次会连响好几声),但**待介入照判** —— 有人在等你这件事与有没有摘要行、
        // 是不是子代理都无关。实现上就是走 runningKnown=false 那一支。
        var isSubagent = hasRow && row.origin === "subagent";
        var statusRow = status === undefined || status === null ? undefined : status.get(id);
        // running 取 status 优先、摘要行兜底;摘要表缺行与子代理行时 running 不作数(见函数头)。
        var running = hasRow ? row.running : undefined;
        if (!isSubagent && hasRow && statusRow !== undefined && statusRow !== null && statusRow.running !== undefined) {
          running = statusRow.running;
        }
        var runningKnown = !isSubagent && hasRow && running !== undefined && running !== null;
        var pendingKey = pendingKeyOf(statusRow);
        if (!runningKnown && (pendingKey === undefined || pendingKey === null)) {
          // 既判不了 running、也没人等你 ⇒ 本轮无可判定。已有状态按情形保留:
          //  · 子代理行(D4):只为"确实有东西要记"的状态留条目(内存有界),否则行过一会儿
          //    再现时"这条待介入已经响过"的基线就没了 ⇒ 同一条待介入再响一次;
          //  · 其余(摘要表缺行):一律原样留着 —— 把"这条待介入已经响过"的基线丢掉的话,同一条
          //    待介入过一会儿会再响一次,把 running 基线丢掉则会伪造/吞掉收尾边沿。
          if (states !== undefined && states !== null && states.has(id)) {
            var kept = states.get(id);
            if (!isSubagent || stateWorthKeeping(kept)) next.set(id, kept);
          }
          continue;
        }
        var step = stepChime(
          states === undefined || states === null ? undefined : states.get(id),
          runningKnown ? running : false,
          runningKnown ? countRunningDescendantsInIndex(subagentIndex, id) : 0,
          pendingKey,
          runningKnown
        );
        next.set(id, step);
        if (step.chime) chime = true;
      }
      // prune(D4,v0.5.3):摘要表已就绪时这一轮**完全没出现过**的会话(连状态表里都没有)会被
      // 丢掉。但"还有东西要记"的状态不能丢 —— 子代理行中途消失(列表刷新/会话被回收)再出现时,
      // 状态没了就会把同一条待介入标识当成"本页第一次见到" ⇒ 二次响。空基线状态照旧丢弃。
      if (prune && states !== undefined && states !== null) {
        states.forEach(function (value, key) {
          if (next.has(key)) return;
          var revived = value;
          if (value !== undefined && value !== null && value.chimedForTurn === true) {
            // M2(v0.5.4):这一轮**完全没出现过**的会话,补回时清掉"本 turn 已响过"的标记 —— 它属于消失
            // 前的那一轮,留着会把"消失期间新起的那一轮"的收尾响吞掉(仿真:该响 2 声响 1 声)。
            // 只清这一枚:lastChimedPendingKey 仍要拦"同一条待介入标识二次响",pending 的补回正是 D4
            // 要修的"子代理归零后漏补响"。清完若再无内容(空基线)则照旧丢弃,内存有界。
            revived = {
              lastRunning: value.lastRunning,
              lastChimedPendingKey: value.lastChimedPendingKey,
              pending: value.pending === true,
              chimedForTurn: false,
              chime: false,
            };
          }
          if (stateWorthKeeping(revived)) next.set(key, revived);
        });
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
    // 订阅是**页面级**的:主机把待介入/状态广播给所有客户端,客户端按需建会话作用域 ——
    // 所以本页从未打开过的会话,它的提问/审批/计划待审照样会响(链路已逐跳核对官方源码)。
    // 返回 disposer;两个服务形状不符、或安装期首轮求值抛错时返回 null(调用方退回座位兜底)。
    function installGlobalWatcher(sessions, uiSession) {
      var list = sessions === undefined || sessions === null ? undefined : sessions.list;
      if (list === undefined || list === null || typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return null;
      var status = uiSession === undefined || uiSession === null ? undefined : uiSession.sessionStatus;
      if (status === undefined || status === null || typeof status.subscribe !== "function" || typeof status.getSnapshot !== "function") return null;

      var evaluate = function () {
        var snapshot;
        // 两个 getSnapshot 各自兜错。store 的 notifySubscribers 对每个 listener 独立
        // try/catch(dsh-client-store\lib\index.js:21-27),所以抛出去不会连累别的订阅者;
        // 这里兜住的价值是保住自己这条 listener、留下可读日志,并明确跳过本轮求值。
        try { snapshot = list.getSnapshot(); } catch (err) { console.error("[turn-chime] 读会话摘要失败", err); return; }
        var byId = snapshot === undefined || snapshot === null ? undefined : snapshot.byId;
        var ready = snapshot !== undefined && snapshot !== null && snapshot.phase === "ready";
        var statusSnapshot;
        try { statusSnapshot = status.getSnapshot(); } catch (err) { console.error("[turn-chime] 读会话状态失败", err); return; }
        var result = stepAll(chimeStates, byId, statusSnapshot, ready);
        chimeStates.clear();
        result.states.forEach(function (value, key) { chimeStates.set(key, value); });
        if (result.chime) playChime(globalAudio);
      };

      var disposers = [list.subscribe(evaluate), status.subscribe(evaluate)];
      var disposeAll = function () {
        for (var i = 0; i < disposers.length; i++) {
          try { disposers[i](); } catch (err) { console.error("[turn-chime] 退订失败", err); }
        }
      };
      // 安装期这一次求值也必须护住:它若抛错,异常会穿出 ctx.inject 回调 → cordis 把该 fiber
      // 置为 FAILED,而下面那句 scope.effect(...) 还没跑到 ⇒ 刚建好的两个订阅没人退订,泄漏到
      // fiber 卸载。所以当场退订、不留"半装"状态,并返回 null 让上层按老路 warnOnce + 座位兜底。
      try {
        evaluate();
      } catch (err) {
        console.error("[turn-chime] 安装全局监听时首轮求值失败,退回座位兜底", err);
        disposeAll();
        return null;
      }
      return disposeAll;
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

    // 插件依赖的服务:slots 只用于座位兜底;sessions / uiSession 是全局
    // 监听要用的两个服务 —— 不能列进这里(inject 是"全有才 apply"的硬门,列进来
    // 会连带把座位兜底一起挡掉),改为在 apply 里用 ctx.inject 等它们就绪后再装。
    var inject = ["slots"];

    // 提示音要用户手势之后才发得出来:apply 里先挂一次性的解锁监听(见 installAudioUnlock)。
    // 服务等待时长:ctx.inject 的回调在依赖就绪前根本不跑,两个服务永远不到达时这里是
    // **零日志**,用户只会觉得"不响" —— 超时一条告警兜底。
    var SERVICE_WAIT_MS = 15000;

    function apply(ctx) {
      installAudioUnlock(ctx);

      var arrived = false;
      var waitTimer;
      if (typeof setTimeout === "function") {
        waitTimer = setTimeout(function () {
          if (arrived) return;
          warnOnce("等了 " + (SERVICE_WAIT_MS / 1000) + " 秒仍等不到 sessions / uiSession 服务,后台会话的提示音可能不工作(只剩当前会话的座位兜底)");
        }, SERVICE_WAIT_MS);
      }
      if (typeof clearTimeout === "function") {
        ctx.effect(function () {
          return function () { clearTimeout(waitTimer); };
        }, "turn-chime: service wait timeout");
      }

      // 全局监听(主路径):订阅会话摘要表 + 会话状态表,覆盖所有会话(含后台)。
      // 用 ctx.inject 而不是直接 ctx.get:插件级 inject 只有 slots,apply 跑得极早,
      // 那时 sessions / uiSession 的提供者 fiber 还没 ACTIVE(strict 的 ctx.get 此时
      // 返回 undefined),而 apply 不会因服务后到重跑 ⇒ 旧写法必然漏装。ctx.inject
      // 等依赖齐备才跑回调,依赖被替换/卸载时自动卸载重跑;监听挂在该作用域
      // (scope)上,随它一起拆。
      ctx.inject(["sessions", "uiSession"], function (scope) {
        arrived = true;
        if (waitTimer !== undefined) clearTimeout(waitTimer);
        var disposeGlobal = installGlobalWatcher(scope.sessions, scope.uiSession);
        if (disposeGlobal === null) {
          warnOnce("拿不到可用的 sessions.list / uiSession.sessionStatus(缺失或首轮求值失败),只能退回座位兜底(仅当前会话)");
          console.info("[turn-chime] v0.5.5 已加载:全局监听不可用,退回座位兜底(仅当前会话)");
          return;
        }
        scope.effect(function () { return disposeGlobal; }, "turn-chime: global watcher");
        console.info("[turn-chime] v0.5.5 已加载:盯所有会话 —— 回复结束且无运行中子代理时响,待答/待批/计划待审出现时也响(同一轮只响一次)");
      });

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
    // 测试钩子:纯函数(浏览器侧不消费)。
    exports.__test = {
      countRunningDescendants: countRunningDescendants,
      countRunningDescendantsInIndex: countRunningDescendantsInIndex,
      indexSubagentRowsByParent: indexSubagentRowsByParent,
      pendingKeyOf: pendingKeyOf,
      stateWorthKeeping: stateWorthKeeping,
      stepAll: stepAll,
      stepChime: stepChime,
    };
    return module.exports;
  },
});
