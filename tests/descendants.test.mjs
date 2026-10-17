/**
 * 纯函数单测:活跃子代理计数 countRunningDescendants、待介入标识 pendingKeyOf、
 * 单会话判定状态机 stepChime、多会话全局求值 stepAll、状态保留口径 stateWorthKeeping。
 * v0.5.3 增补用例:D1 缺行期间标记泄漏吞掉下一轮收尾、D2 子代理会话的待介入、
 * D4 子代理状态被 prune 丢掉导致二次响、D3 安装期建 AudioContext 与"未解锁期间被吞掉的响补响
 * 一次"、D5 primeAudio 抛错后的重试;并让假 window 校验 removeEventListener 的 capture 标志。
 * v0.5.4 增补用例(M1/M2/M3、B1):缺行期响过待介入的那一轮收尾不再多响一声(M1)、整条消失一轮的
 * 会话回来时陈旧标记不再吞掉新起那一轮的收尾响(M2)、页面已被用户激活过时加载期即出声而未激活仍
 * 不建上下文(M3)、挂起欠响期间又出现待介入时该轮收尾只响一声(B1,钉住 stepChime 里 `!pending` 那枚
 * 守卫 —— 去掉它时该场景同一轮响 2 声);D1 用例里那条白盒断言按新的复位时机改到"摘要行回来的那一轮"(行为契约不变)。
 * v0.5.5 增补用例:索引化子代理计数的随机差分(与改动前逐行上溯的朴素实现在 3000 张随机图上零不一致)、
 * 索引建一次复用一致、stepAll 与"逐会话调朴素计数"的等价(含 id 处理顺序不变)、client.js 已无临时诊断探针。
 *
 * client.js 是浏览器 bundle(顶层调用 window.__ModuleLoader__.load),
 * 这里先注入 window 桩与 react 桩,再动态 import 取 factory 的返回值,
 * 通过 __test 导出直接测纯逻辑(不渲染任何组件)。
 *
 * 运行:node tests/descendants.test.mjs
 */
import { readFileSync } from "node:fs";

const CLIENT_PATH = new URL("../lib/client.js", import.meta.url);

// ── 加载 bundle 定义 ────────────────────────────────────────────────
let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { definition = def; },
  },
};
await import(CLIENT_PATH.href);

const reactStub = {
  useEffect() {},
  useRef(value) { return { current: value }; },
  createElement() { return null; },
};

function loadModule() {
  if (definition === undefined) throw new Error("client.js 未通过 window.__ModuleLoader__.load 注册定义");
  return definition.factory((spec) => {
    if (spec === "react") return reactStub;
    throw new Error("未预期的 require: " + spec);
  });
}

// ── 断言辅助 ────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}
function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label ?? "值") + " 期望 " + String(expected) + ",实际 " + String(actual));
  }
}

// ── 用例 ────────────────────────────────────────────────────────────
const mod = loadModule();
const count = mod.__test?.countRunningDescendants;
if (typeof count !== "function") throw new Error("缺少 __test.countRunningDescendants 导出");

const ROOT = "session-root";
/** 造一行会话摘要:subagent 行必须显式给 origin/parentId。 */
function row(id, parentId, running, origin = "subagent") {
  return { id, parentId, running, origin, displayTitle: id, blank: false, updatedAt: 0 };
}

test("无任何会话摘要 → 0", () => {
  equal(count({}, ROOT), 0);
});

test("summaries 为 undefined/null → 0", () => {
  equal(count(undefined, ROOT), 0);
  equal(count(null, ROOT), 0);
});

test("rootSessionId 为 undefined → 0", () => {
  equal(count({ a: row("a", ROOT, true) }, undefined), 0);
});

test("单个 running 直接子代理 → 1", () => {
  equal(count({ a: row("a", ROOT, true) }, ROOT), 1);
});

test("多个 running 直接子代理累加 → 2", () => {
  const summaries = { a: row("a", ROOT, true), b: row("b", ROOT, true) };
  equal(count(summaries, ROOT), 2);
});

test("inactive/ready 子代理不计数 → 0", () => {
  const summaries = { a: row("a", ROOT, false), b: row("b", ROOT, false) };
  equal(count(summaries, ROOT), 0);
});

test("running 与 inactive 混合只计 running → 1", () => {
  const summaries = { a: row("a", ROOT, true), b: row("b", ROOT, false) };
  equal(count(summaries, ROOT), 1);
});

test("孙代理 running(中间父 idle)也计入 → 1", () => {
  const summaries = {
    child: row("child", ROOT, false),
    grand: row("grand", "child", true),
  };
  equal(count(summaries, ROOT), 1);
});

test("深层后代 running 逐级上溯命中 → 1", () => {
  const summaries = {
    c1: row("c1", ROOT, false),
    c2: row("c2", "c1", false),
    c3: row("c3", "c2", true),
  };
  equal(count(summaries, ROOT), 1);
});

test("其它根下的 running 子代理不计入 → 0", () => {
  const summaries = { other: row("other", "session-other", true) };
  equal(count(summaries, ROOT), 0);
});

test("非 subagent 的 running 会话不计入 → 0", () => {
  // 注意不能借 row() 的默认参数传 undefined(会回落到 'subagent'),这里显式构造。
  const summaries = { plain: { id: "plain", parentId: ROOT, running: true, origin: undefined } };
  equal(count(summaries, ROOT), 0);
  const other = { plain: { id: "plain", parentId: ROOT, running: true, origin: "user" } };
  equal(count(other, ROOT), 0);
});

test("parentId 缺失的 subagent 行不计入 → 0", () => {
  const summaries = { orphan: { id: "orphan", origin: "subagent", running: true } };
  equal(count(summaries, ROOT), 0);
});

test("父子互为 parent 的环不会死循环", () => {
  const summaries = {
    a: { id: "a", parentId: "b", origin: "subagent", running: true },
    b: { id: "b", parentId: "a", origin: "subagent", running: false },
  };
  equal(count(summaries, ROOT), 0, "环上无 root 命中");
  const hit = {
    a: { id: "a", parentId: ROOT, origin: "subagent", running: true },
    b: { id: "b", parentId: "a", origin: "subagent", running: true },
  };
  equal(count(hit, ROOT), 2, "环外命中仍正常计数");
});

test("摘要行值为 undefined/null 时跳过不抛错", () => {
  const summaries = { a: undefined, b: null, c: row("c", ROOT, true) };
  equal(count(summaries, ROOT), 1);
});

test("原型链上的键不被误当成会话行 → 只计自有键", () => {
  const summaries = Object.create({ inherited: row("inherited", ROOT, true) });
  summaries.real = row("real", ROOT, true);
  equal(count(summaries, ROOT), 1, "只剩自有键被计入");
  equal(count(Object.create({ only: row("only", ROOT, true) }), ROOT), 0, "纯继承对象计 0");
});

// ── 待介入标识(pendingKeyOf)用例 ───────────────────────────────────
const pendingKeyOf = mod.__test?.pendingKeyOf;
if (typeof pendingKeyOf !== "function") throw new Error("缺少 __test.pendingKeyOf 导出");

test("没有会话状态 / 没有待介入 → undefined", () => {
  equal(pendingKeyOf(undefined), undefined);
  equal(pendingKeyOf(null), undefined);
  equal(pendingKeyOf({ running: true }), undefined);
  equal(pendingKeyOf({ running: true, pendingInteraction: undefined }), undefined);
  equal(pendingKeyOf({ running: true, pendingInteraction: null }), undefined);
});

test("待答卡片取 key(问题卡自带稳定 key)", () => {
  equal(pendingKeyOf({ running: true, pendingInteraction: { kind: "question", key: "q:1" } }), "q:1");
});

test("待批对象取 key(approval:<n>)", () => {
  equal(pendingKeyOf({ running: true, pendingInteraction: { kind: "approval", key: "approval:3" } }), "approval:3");
});

test("无 key 时退回 callId,再退回 kind", () => {
  equal(pendingKeyOf({ pendingInteraction: { kind: "question", callId: "call-7" } }), "call-7");
  equal(pendingKeyOf({ pendingInteraction: { kind: "plan-review" } }), "plan-review");
});

test("形状完全陌生时也会给一个非空标识(不退化成永不响)", () => {
  equal(pendingKeyOf({ pendingInteraction: {} }), "pending");
  equal(pendingKeyOf({ pendingInteraction: { key: null, callId: null, kind: null } }), "pending");
});

// ── 单会话判定状态机(stepChime)用例 ────────────────────────────────
const step = mod.__test?.stepChime;
if (typeof step !== "function") throw new Error("缺少 __test.stepChime 导出");

/** 造一个"上一轮状态"对象,未给字段取默认值。 */
function S(overrides) {
  return {
    lastRunning: false,
    lastChimedPendingKey: undefined,
    pending: false,
    chimedForTurn: false,
    ...overrides,
  };
}

/**
 * 按步推进状态机,返回响铃次数与末态。
 * @param initial 初始状态(四字段);undefined = 本页第一次见到该会话
 * @param steps [running, activeSubagents] 序列
 * @param pendingKeys 待介入标识序列(缺省 = 全程没有人等你)
 */
function simulate(initial, steps, pendingKeys) {
  let state = initial;
  let chimes = 0;
  for (let i = 0; i < steps.length; i++) {
    const [running, active] = steps[i];
    const key = pendingKeys === undefined ? undefined : pendingKeys[i];
    const next = step(state, running, active, key);
    if (next.chime) chimes += 1;
    state = {
      lastRunning: next.lastRunning,
      lastChimedPendingKey: next.lastChimedPendingKey,
      pending: next.pending,
      chimedForTurn: next.chimedForTurn,
    };
  }
  return { chimes, state };
}

test("首渲染(state 未知)不响", () => {
  equal(step(undefined, false, 0).chime, false);
  equal(step(undefined, true, 3).chime, false);
});

test("普通会话(无子代理):回复完成响一次", () => {
  equal(simulate({ lastRunning: true, pending: false }, [[false, 0]]).chimes, 1);
});

test("协调者:派发 2 个子代理后暂停不响,最后一个结束且父空闲才响", () => {
  const steps = [[true, 2], [false, 2], [false, 2], [false, 1], [false, 0]];
  const { chimes, state } = simulate({ lastRunning: false, pending: false }, steps);
  equal(chimes, 1, "响铃次数");
  equal(state.pending, false, "末态 pending");
});

test("协调者:子代理结束唤醒父会话,父处理完再停时才响", () => {
  const steps = [[true, 1], [false, 1], [true, 1], [false, 0]];
  equal(simulate({ lastRunning: false, pending: false }, steps).chimes, 1);
});

test("挂起期间又派发新子代理:仍等全部结束才响", () => {
  const steps = [[true, 2], [false, 2], [true, 1], [false, 1], [false, 0]];
  equal(simulate({ lastRunning: false, pending: false }, steps).chimes, 1);
});

test("响过之后不再重复响", () => {
  const steps = [[true, 0], [false, 0], [false, 0], [false, 0]];
  equal(simulate({ lastRunning: false, pending: false }, steps).chimes, 1);
});

test("子代理始终在跑时不响", () => {
  const steps = [[true, 1], [false, 1], [false, 1]];
  equal(simulate({ lastRunning: false, pending: false }, steps).chimes, 0);
});

test("挂起后父会话被唤醒(pending 不被误清)", () => {
  const first = step({ lastRunning: true, pending: false }, false, 2);
  equal(first.chime, false);
  equal(first.pending, true, "挂起");
  const awake = step(first, true, 2);
  equal(awake.chime, false);
  equal(awake.pending, true, "唤醒期间保持挂起");
});

test("锁行为:父停时子行尚未计入会提前响一次(时序上不可达,仅固定预期)", () => {
  // 依据:子代理行在工具调用返回前就已建立,其状态帧早于父会话的 turn 结束帧,
  // 两者走同一条连接按序到达,故 [父已停 + 子行仍计 0] 的乱序窗口实际不可达。
  // 这条用例只把"万一乱序会发生什么"钉死:提前响一次,不会漏响也不会连响。
  const steps = [[true, 0], [false, 0], [false, 1], [false, 0]];
  equal(simulate({ lastRunning: false, pending: false }, steps).chimes, 1);
});

// ── 待介入(待答/待批/计划待审)路径 ────────────────────────────────
test("待答出现立刻响:running 仍为 true 也响", () => {
  const { chimes } = simulate(
    { lastRunning: true, pending: false },
    [[true, 0], [true, 0], [true, 0]],
    [undefined, "q:1", "q:1"]
  );
  equal(chimes, 1, "出现那次响一次,标识不变不重复响");
});

test("ask 阻塞的真实时序:问→答→收尾,全程只响一次(收尾静音)", () => {
  const { chimes, state } = simulate(
    { lastRunning: true, pending: false },
    [[true, 0], [true, 0], [true, 0], [true, 0], [false, 0], [false, 0]],
    [undefined, "q:1", "q:1", undefined, undefined, undefined]
  );
  equal(chimes, 1, "只在提问那一刻响");
  equal(state.chimedForTurn, false, "收尾时标记已清");
});

test("同一轮里第二次提问会再响一次 → 共 2 次", () => {
  const { chimes } = simulate(
    { lastRunning: true, pending: false },
    [[true, 0], [true, 0], [true, 0], [true, 0], [true, 0], [false, 0]],
    [undefined, "q:1", undefined, "q:2", undefined, undefined]
  );
  equal(chimes, 2);
});

test("待批(approval)与计划待审(plan-review)同样触发", () => {
  equal(
    simulate({ lastRunning: true, pending: false }, [[true, 0], [true, 0]], [undefined, "approval:1"]).chimes,
    1
  );
  equal(
    simulate({ lastRunning: true, pending: false }, [[true, 0], [true, 0]], [undefined, "plan-review"]).chimes,
    1
  );
});

test("待介入不受子代理门控:后台还有 3 个子代理在跑也照样响", () => {
  const { chimes } = simulate(
    { lastRunning: true, pending: false },
    [[true, 3], [true, 3], [false, 3], [false, 0]],
    [undefined, "q:1", undefined, undefined]
  );
  equal(chimes, 1, "提问时响;该轮收尾即便子代理后来归零也不再补响");
});

test("待介入未出现时,收尾仍然照旧响一次(回归)", () => {
  const { chimes } = simulate(
    { lastRunning: true, pending: false },
    [[true, 0], [true, 0], [false, 0]],
    [undefined, undefined, undefined]
  );
  equal(chimes, 1);
});

test("组件被重挂(state 保留在模块级)时不丢判定:同一标识仍只响一次", () => {
  const first = step(undefined, true, 0, "q:1");
  equal(first.chime, true, "state 缺省 = 本页第一次见到它 → 响");
  equal(step(first, true, 0, "q:1").chime, false);
  equal(step(step(first, true, 0, "q:1"), true, 0, "q:1").chime, false);
});

test("本页第一次见到某会话:带着未答问题(刷新页面)也响一次", () => {
  equal(step(undefined, true, 0, "q:1").chime, true);
  equal(step(undefined, false, 0, "approval:2").chime, true);
});

test("第一次见到的会话没有待介入则不响(基线)", () => {
  const base = step(undefined, false, 0, undefined);
  equal(base.chime, false);
  equal(base.lastChimedPendingKey, undefined);
});

test("待介入标识换了另一个(连问两题不经过 undefined)也响一次", () => {
  const { chimes } = simulate(
    { lastRunning: true, pending: false },
    [[true, 0], [true, 0], [true, 0]],
    [undefined, "q:1", "q:2"]
  );
  equal(chimes, 2);
});

// ── 全局多会话求值(stepAll)用例 ───────────────────────────────────
const stepAll = mod.__test?.stepAll;
if (typeof stepAll !== "function") throw new Error("缺少 __test.stepAll 导出");

/** 造 uiSession.sessionStatus 快照(Map<sessionId, {running, pendingInteraction}>) */
function statusMap(entries) {
  const map = new Map();
  for (const id of Object.keys(entries)) map.set(id, entries[id]);
  return map;
}
/** 造一行会话摘要(用户会话或子代理)。 */
function sessionRow(id, origin, running, parentId) {
  const row = { id, origin, running, displayTitle: id, blank: false, updatedAt: 0 };
  if (parentId !== undefined) row.parentId = parentId;
  return row;
}

test("全局:后台会话(非 subagent)收尾也响", () => {
  const byId = { a: sessionRow("a", "user", false) };
  const states = new Map([["a", S({ lastRunning: true })]]);
  const result = stepAll(states, byId, statusMap({ a: { running: false } }), true);
  equal(result.chime, true, "后台会话收尾要响");
  equal(result.states.get("a").lastRunning, false);
});

test("全局:同一轮多个会话收尾只算一声(调用方只播一次)", () => {
  const byId = { a: sessionRow("a", "user", false), b: sessionRow("b", "user", false) };
  const states = new Map([["a", S({ lastRunning: true })], ["b", S({ lastRunning: true })]]);
  const first = stepAll(states, byId, statusMap({ a: { running: false }, b: { running: false } }), true);
  equal(first.chime, true, "合并成一声");
  const again = stepAll(first.states, byId, statusMap({ a: { running: false }, b: { running: false } }), true);
  equal(again.chime, false, "两个会话的状态都已推进,不会连响");
});

test("全局:子代理会话自己不算(它的收尾由父会话补响覆盖)", () => {
  const byId = { child: sessionRow("child", "subagent", false, "root") };
  const states = new Map([["child", S({ lastRunning: true })]]);
  const result = stepAll(states, byId, statusMap({ child: { running: false } }), true);
  equal(result.chime, false);
  equal(result.states.has("child"), false, "没有东西要记的子代理行不留在判定状态里");
});

test("全局:父会话收尾时子代理仍在跑不响,子代理结束才补响", () => {
  const running = {
    p: sessionRow("p", "user", false),
    c: sessionRow("c", "subagent", true, "p"),
  };
  const first = stepAll(
    new Map([["p", S({ lastRunning: true })]]),
    running,
    statusMap({ p: { running: false }, c: { running: true } }),
    true
  );
  equal(first.chime, false, "还有子代理在跑 → 挂起");
  equal(first.states.get("p").pending, true);

  const settled = {
    p: sessionRow("p", "user", false),
    c: sessionRow("c", "subagent", false, "p"),
  };
  const after = stepAll(first.states, settled, statusMap({ p: { running: false }, c: { running: false } }), true);
  equal(after.chime, true, "子代理归零后补响");
});

test("全局:后台会话出现待答即响(running 仍为 true)", () => {
  const byId = { a: sessionRow("a", "user", true) };
  const result = stepAll(
    new Map(),
    byId,
    statusMap({ a: { running: true, pendingInteraction: { kind: "question", key: "q:9" } } }),
    true
  );
  equal(result.chime, true);
});

test("全局:后台会话待答不受该会话子代理门控", () => {
  const byId = {
    a: sessionRow("a", "user", true),
    a1: sessionRow("a1", "subagent", true, "a"),
  };
  const result = stepAll(
    new Map(),
    byId,
    statusMap({
      a: { running: true, pendingInteraction: { kind: "approval", key: "approval:1" } },
      a1: { running: true },
    }),
    true
  );
  equal(result.chime, true);
});

test("全局:只有状态表里存在的会话只判待介入,不判收尾(v0.5.2)", () => {
  // 摘要表里没有它的行 ⇒ 无法判断它是不是子代理会话:判收尾会与父会话的"子代理归零
  // 补响"叠成一轮两声,所以这里不响、只保留基线;但"有人在等你"照响(不能漏)。
  const states = new Map([["z", S({ lastRunning: true })]]);
  const noChime = stepAll(states, {}, statusMap({ z: { running: false } }), true);
  equal(noChime.chime, false, "缺摘要行时不判收尾");
  equal(noChime.states.get("z").lastRunning, true, "保留上一轮 running 基线");
  const pending = stepAll(
    states,
    {},
    statusMap({ z: { running: undefined, pendingInteraction: { kind: "question", key: "q:z" } } }),
    true
  );
  equal(pending.chime, true, "缺摘要行也照判待介入");
  const back = stepAll(noChime.states, { z: sessionRow("z", "user", false) }, statusMap({ z: { running: false } }), true);
  equal(back.chime, true, "摘要行回来后照常判出收尾(基线没丢)");
});

test("全局:列表未就绪(prune=false)时不丢未知会话的状态", () => {
  const states = new Map([["gone", S({ lastRunning: true })]]);
  const result = stepAll(states, {}, statusMap({}), false);
  equal(result.states.has("gone"), true, "保留基线");
  equal(result.chime, false, "没有可判定的会话就不响");
});

test("全局:列表已就绪(prune=true)时丢掉消失会话的状态", () => {
  const states = new Map([["gone", S({ lastRunning: true })]]);
  const result = stepAll(
    states,
    { keep: sessionRow("keep", "user", false) },
    statusMap({ keep: { running: false } }),
    true
  );
  equal(result.states.has("gone"), false);
  equal(result.states.has("keep"), true);
});

test("全局:两边都拿不到 running 的会话跳过、不建状态", () => {
  const result = stepAll(new Map(), { x: { id: "x", origin: "user" } }, statusMap({}), true);
  equal(result.states.has("x"), false);
  equal(result.chime, false);
});

test("全局(D1 回归):缺行期间的待介入不会吞掉下一次真正的收尾(该响 2 声就响 2 声)", () => {
  // 缺行 fresh 时 lastRunning 取调用方传入的假 false;缺行轮次整块跳过、不复位"本 turn 已响过"的
  // 标记 —— v0.5.4 的 M1 把复位挪到"摘要行回来的那一轮"(该会话已空闲 ⇒ 陈旧标记作废)。D1 修复前:
  // 标记一路留到下一次真正的收尾边沿,把那一响吞掉(仿真 2 声变 1 声)。
  const pending = statusMap({ a: { running: false, pendingInteraction: { kind: "approval", key: "approval:1" } } });
  const r1 = stepAll(new Map(), {}, pending, true);
  const r2 = stepAll(r1.states, {}, pending, true);
  const r3 = stepAll(r2.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const up = stepAll(r3.states, { a: sessionRow("a", "user", true) }, statusMap({ a: { running: true } }), true);
  const down = stepAll(up.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const chimes = [r1, r2, r3, up, down].filter((r) => r.chime).length;
  equal(chimes, 2, "整段共 2 声(缺行期一次 + 下一轮真收尾一次),实际 " + String(chimes));
  equal(r1.chime, true, "缺行 + 待介入 → 响一次");
  equal(r2.chime, false, "同一标识的后续缺行轮次不再响(待介入基线保留)");
  equal(r2.states.get("a").chimedForTurn, true, "M1:缺行轮次不再复位标记(留到摘要行回来的那一轮判)");
  equal(r3.chime, false, "摘要行回来 running=false,与基线一致 ⇒ 本来就没有边沿");
  equal(r3.states.get("a").chimedForTurn, false, "该会话已空闲 ⇒ 陈旧标记在这一轮作废(它属于已经结束的那一轮)");
  equal(up.chime, false, "跑起来不响");
  equal(down.chime, true, "下一轮真正的收尾必须响(不能被上一轮的标记吞掉)");
});

test("全局(D1 对照):缺行时基线为 true 的情形仍恰好 2 声(不可在 lastRunning === true 时清标记)", () => {
  // 这条是 D1 修法的**上界**:只在"没有尚未观察到的收尾边沿"时复位。改成无条件复位的话,
  // 摘要行回来后判出的那个收尾边沿会因标记已被清而再响一声 ⇒ 2 声变 3 声。
  const up = stepAll(new Map(), { a: sessionRow("a", "user", true) }, statusMap({ a: { running: true } }), true);
  const miss = stepAll(
    up.states,
    {},
    statusMap({ a: { running: false, pendingInteraction: { kind: "approval", key: "approval:1" } } }),
    true
  );
  const back = stepAll(miss.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const up2 = stepAll(back.states, { a: sessionRow("a", "user", true) }, statusMap({ a: { running: true } }), true);
  const down2 = stepAll(up2.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const chimes = [up, miss, back, up2, down2].filter((r) => r.chime).length;
  equal(chimes, 2, "整段恰好 2 声(待介入一次 + 下一轮收尾一次),实际 " + String(chimes));
  equal(up.chime, false, "跑起来不响");
  equal(miss.chime, true, "缺行 + 待介入 → 响一次");
  equal(miss.states.get("a").lastRunning, true, "缺行不伪造收尾:基线仍是 true");
  equal(miss.states.get("a").chimedForTurn, true, "有尚未观察到的收尾边沿 ⇒ 标记必须保留");
  equal(back.chime, false, "这一轮的收尾已因待介入响过 ⇒ 静音");
  equal(back.states.get("a").chimedForTurn, false, "收尾边沿消费掉标记");
  equal(down2.chime, true, "下一轮收尾照响");
});

test("全局(D2):子代理行出现待介入照样响(父会话 running 仍为 true 时不再整段静默)", () => {
  const byId = {
    p: sessionRow("p", "user", true),
    c: sessionRow("c", "subagent", true, "p"),
  };
  const result = stepAll(
    new Map(),
    byId,
    statusMap({
      p: { running: true },
      c: { running: true, pendingInteraction: { kind: "approval", key: "approval:1" } },
    }),
    true
  );
  equal(result.chime, true, "子代理会话的待批也要响");
});

test("全局(D2):子代理行的 running 边沿仍不单独响(收尾由父会话的补响覆盖)", () => {
  const states = new Map([["c", S({ lastRunning: true, lastChimedPendingKey: "approval:1" })]]);
  const byId = { c: sessionRow("c", "subagent", false, "p") };
  const result = stepAll(states, byId, statusMap({ c: { running: false } }), true);
  equal(result.chime, false, "子代理行的收尾不单独响");
  equal(result.states.get("c").lastRunning, true, "子代理行的 running 不作数(状态原样保留)");
});

test("全局(D4):子代理行的同一待介入标识在「出现→消失→再出现」里只响一次", () => {
  const withRow = { c: sessionRow("c", "subagent", true, "p") };
  const pending = statusMap({ c: { running: true, pendingInteraction: { kind: "approval", key: "approval:1" } } });
  const first = stepAll(new Map(), withRow, pending, true);
  equal(first.chime, true, "第一次出现 → 响一次");
  const noRow = stepAll(first.states, {}, pending, true);
  equal(noRow.chime, false, "摘要行消失(状态表里还有它)那一轮不响");
  const again = stepAll(noRow.states, withRow, pending, true);
  equal(again.chime, false, "再出现:同一标识不该二次响");
  const gone = stepAll(again.states, {}, statusMap({}), true);
  equal(gone.chime, false, "整条消失(连状态表也没有)那一轮不响");
  const back = stepAll(gone.states, withRow, pending, true);
  equal(back.chime, false, "整条消失一轮后再出现:同一标识仍不该二次响");
  const other = stepAll(
    back.states,
    withRow,
    statusMap({ c: { running: true, pendingInteraction: { kind: "approval", key: "approval:2" } } }),
    true
  );
  equal(other.chime, true, "换了标识(第二次审批)照响");
});

test("全局(D4):没有东西要记的子代理行不建判定状态(内存有界)", () => {
  const byId = { c: sessionRow("c", "subagent", false, "p") };
  const empty = new Map([["c", S({ lastRunning: false })]]);
  const dropped = stepAll(empty, byId, statusMap({ c: { running: false } }), true);
  equal(dropped.chime, false);
  equal(dropped.states.has("c"), false, "只有 running 基线的空状态不留条目");
  const keep = new Map([["c", S({ lastChimedPendingKey: "approval:1" })]]);
  equal(stepAll(keep, byId, statusMap({ c: { running: false } }), true).states.has("c"), true, "有内容的状态必须留");
});

test("stateWorthKeeping:只认有内容的状态(已响过的标识 / 未消费标记 / 挂起)", () => {
  const worth = mod.__test?.stateWorthKeeping;
  if (typeof worth !== "function") throw new Error("缺少 __test.stateWorthKeeping 导出");
  equal(worth(undefined), false);
  equal(worth(null), false);
  equal(worth(S({ lastRunning: true })), false, "只有 running 基线");
  equal(worth(S({ lastChimedPendingKey: "approval:1" })), true);
  equal(worth(S({ chimedForTurn: true })), true);
  equal(worth(S({ pending: true })), true);
});

test("全局(M1):缺行期响过待介入、那一轮仍在跑 ⇒ 该轮收尾不再多响一声(恰好 1 声)", () => {
  // 时序(第二轮复核实测):轮1 会话空闲(摘要行里 running=false);轮2 摘要行缺行 + 出现待介入 q:1
  // ⇒ 响一次;轮3 摘要行回来、该轮仍在跑(running=true);轮4 该轮收尾(running=false)。
  // 修复前(v0.5.3):D1 那行复位在**缺行轮次**当场就把"本 turn 已响过"的标记清掉了(那一刻基线为
  // false),轮4 于是判出"无标记的收尾边沿"、又响一声 ⇒ [0,1,0,1] 共 2 声。正确行为:同一轮已经
  // 为待介入响过 ⇒ 只 1 声。
  const idle = stepAll(new Map(), { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const miss = stepAll(
    idle.states,
    {},
    statusMap({ a: { running: true, pendingInteraction: { kind: "question", key: "q:1" } } }),
    true
  );
  const back = stepAll(miss.states, { a: sessionRow("a", "user", true) }, statusMap({ a: { running: true } }), true);
  const down = stepAll(back.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const chimes = [idle, miss, back, down].filter((r) => r.chime).length;
  // 先钉**行为**(响几声),再钉判定状态里的白盒字段:回退 M1 时这里先炸成"该响 1 声却响了 2 声"。
  equal(idle.chime, false, "轮1 空闲基线不响");
  equal(miss.chime, true, "轮2 缺行 + 待介入 → 响一次");
  equal(back.chime, false, "轮3 该轮仍在跑 → 不响");
  equal(down.chime, false, "轮4 该轮收尾静音(标记仍有效)");
  equal(chimes, 1, "整段恰好 1 声(同一轮已为待介入响过),实际 " + String(chimes));
  equal(miss.states.get("a").chimedForTurn, true, "轮2 的标记必须留下(M1:缺行轮次不再复位)");
  equal(back.states.get("a").chimedForTurn, true, "轮3 仍在跑 ⇒ 标记保留(该轮收尾正靠它抑制重复响)");
});

test("全局(M2):整条消失一轮的会话回来时不再带陈旧标记(消失期间新起那一轮的收尾照响)", () => {
  // 修复前(v0.5.3):prune 把带 chimedForTurn 的状态原样补回 ⇒ 回来时新起那一轮的收尾被这枚陈旧
  // 标记吞掉(仿真:该响 2 声只响 1 声)。但也不能整条丢掉那枚"已响过的待介入标识" —— 否则同一条
  // 待介入会二次响(D4 的契约),所以 M2 只清 chimedForTurn。
  const first = stepAll(
    new Map(),
    { a: sessionRow("a", "user", true) },
    statusMap({ a: { running: true, pendingInteraction: { kind: "question", key: "q:1" } } }),
    true
  );
  const gone = stepAll(first.states, {}, statusMap({}), true);
  const again = stepAll(
    gone.states,
    { a: sessionRow("a", "user", true) },
    statusMap({ a: { running: true, pendingInteraction: { kind: "question", key: "q:1" } } }),
    true
  );
  const down = stepAll(again.states, { a: sessionRow("a", "user", false) }, statusMap({ a: { running: false } }), true);
  const chimes = [first, gone, again, down].filter((r) => r.chime).length;
  // 先钉**行为**(响几声),再钉白盒字段:回退 M2 时这里先炸成"新起那一轮的收尾被吞掉、只响 1 声"。
  equal(first.chime, true, "待介入出现 → 响一次");
  equal(gone.chime, false, "整条消失那一轮不响");
  equal(again.chime, false, "同一条待介入标识不该二次响(清理没引入二次响)");
  equal(down.chime, true, "消失期间新起那一轮的收尾必须响,不能被陈旧标记吞掉");
  equal(chimes, 2, "整段恰好 2 声(待介入一次 + 消失后新起那一轮的收尾一次),实际 " + String(chimes));
  equal(gone.states.has("a"), true, "还有东西要记(已响过的待介入标识)⇒ 状态补回");
  equal(gone.states.get("a").chimedForTurn, false, "M2:补回时清掉'本 turn 已响过'的标记");
  equal(gone.states.get("a").lastChimedPendingKey, "q:1", "已响过的待介入标识必须保留(否则同一条会二次响)");
});

test("全局(B1):挂起欠响期间又出现待介入 ⇒ 该轮收尾不再多响一声(恰好 1 声)", () => {
  // 时序(独立复核实测):轮1 父会话正常跑(子代理在跑);轮2 父会话 turn 结束、子代理仍在跑 ⇒ 判不出
  // 可响的收尾,挂起(pending=true)欠一声;轮3 **同一会话**出现待介入 q:1(彼时父会话 running 已是
  // false)⇒ 当场响一次,并置上"本 turn 已响过";轮4 该轮收尾(子代理归零)。
  // stepChime 第 4 条里那枚 !pending 守卫(判不出收尾边沿、该会话已空闲 ⇒ 作废本 turn 标记)在 pending
  // 为真时**不作废**,正是为了让轮4 的挂起补响看见它、由它抑制同一轮的第二次响。去掉 `!pending` 后
  // 轮3 会当场把标记清掉 ⇒ 轮4 的补响成了同一轮的第二次响(仿真:该响 1 声响 2 声)。
  const start = stepAll(
    new Map(),
    { a: sessionRow("a", "user", true), c: sessionRow("c", "subagent", true, "a") },
    statusMap({ a: { running: true }, c: { running: true } }),
    true
  );
  const suspended = stepAll(
    start.states,
    { a: sessionRow("a", "user", false), c: sessionRow("c", "subagent", true, "a") },
    statusMap({ a: { running: false }, c: { running: true } }),
    true
  );
  const asked = stepAll(
    suspended.states,
    { a: sessionRow("a", "user", false), c: sessionRow("c", "subagent", true, "a") },
    statusMap({ a: { running: false, pendingInteraction: { kind: "question", key: "q:1" } }, c: { running: true } }),
    true
  );
  const settled = stepAll(
    asked.states,
    { a: sessionRow("a", "user", false), c: sessionRow("c", "subagent", false, "a") },
    statusMap({ a: { running: false }, c: { running: false } }),
    true
  );
  const chimes = [start, suspended, asked, settled].filter((r) => r.chime).length;
  // 先钉**行为**(响几声),再钉判定状态里的白盒字段:去掉 !pending 守卫时这里先炸成"该响 1 声却响了 2 声"。
  equal(start.chime, false, "轮1 正常跑着不响");
  equal(suspended.chime, false, "轮2 挂起等子代理,不响(这一轮还欠一声)");
  equal(asked.chime, true, "轮3 出现待介入 → 响一次");
  equal(settled.chime, false, '轮4 收尾的补响被"本 turn 已响过"抑制(同一轮最多一声)');
  equal(chimes, 1, "整段恰好 1 声(挂起欠的那声由同一轮的待介入覆盖),实际 " + String(chimes));
  equal(suspended.states.get("a").pending, true, "轮2 的挂起必须记下(那一轮确实还欠一声)");
  equal(asked.states.get("a").chimedForTurn, true, "轮3 置上的标记在挂起期间必须留着(这枚 !pending 守卫的用意)");
  equal(settled.states.get("a").pending, false, "轮4 挂起与补响在同一支里被消费");
});

test("client.js 已按 v0.5.5 声明版本与实现关键词", () => {
  const source = readFileSync(CLIENT_PATH, "utf8");
  if (!source.includes("countRunningDescendants")) throw new Error("缺少 countRunningDescendants 实现");
  if (!source.includes("stepChime")) throw new Error("缺少 stepChime 状态机");
  if (!source.includes("stepAll")) throw new Error("缺少 stepAll 全局求值");
  if (!source.includes("pendingKeyOf")) throw new Error("缺少 pendingKeyOf 待介入标识");
  if (!source.includes("stateWorthKeeping")) throw new Error("缺少 stateWorthKeeping 状态保留口径");
  if (!source.includes("flushSuppressedChime")) throw new Error("缺少 flushSuppressedChime 补响");
  if (!source.includes("useSessionStatus")) throw new Error("缺少 useSessionStatus 订阅");
  if (!source.includes("sessionStatus")) throw new Error("缺少 uiSession.sessionStatus 全局订阅");
  if (!source.includes("chimeStates")) throw new Error("缺少模块级判定状态 chimeStates");
  // 版本串用正则:容忍空格/引号形态差异,不对语义等价的改写误报。
  if (!/\[turn-chime\]\s*v0\.5\.5\s*已加载/.test(source)) throw new Error("缺少 v0.5.5 加载日志");
  // v0.5.5:临时诊断探针已整块删除(端点 /api/llm-auto/diag 属 dsh-llm-auto 的正式功能,与本插件无关)。
  if (source.includes("/api/llm-auto/diag") || /diagPost|diagEval|diagBool|diagSeq|diagLastKey/.test(source)) {
    throw new Error("client.js 仍残留临时诊断探针");
  }
});

// ── 行为断言:apply 的实际接线 ──────────────────────────────────────
// 复核(2026-10-16,变异测试)证明:下面原先那两条"关键词存在性"断言拦不住回退 ——
// 整块全局监听删成注释(关键词留在注释里)、或另加旧式 ctx.get 重复安装(会响两声),
// 52 个用例照样全过;而语义等价改写(箭头函数 + 形参改名)反而误报失败。
// 现在改为喂假 ctx / 假 window 直接调 apply,观察真实调用序列:inject 等服务就绪、
// 两个 store 各订阅与退订一次、座位兜底照旧注册、AudioContext 只在用户手势之后创建。

/**
 * 造一次 apply 的假环境;调用方必须在 finally 里 teardown(内部会还原全局桩)。
 * @param options.userActivation 给了就挂成假 window 的 navigator.userActivation(测粘性用户激活,M3)。
 */
function runApply(options) {
  const opts = options ?? {};
  const log = {
    injects: [], effects: [], gets: [], slotInjects: [], registered: [],
    timers: [], cleared: [], warns: [], errors: [], removals: [],
  };
  const listeners = new Map();
  const contexts = [];
  const primes = [];
  const oscillators = [];   // 每次"响一声"会创建 2 个振荡器(双音),用它数响了几次
  let primeImpl = null;     // 非 null 时替换"解锁缓冲"的行为(用来让 primeAudio 抛错)
  let resumeImpl = function () { this.state = "running"; return Promise.resolve(); };

  class FakeAudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      contexts.push(this);
    }
    resume() { return resumeImpl.call(this); }
    close() { return Promise.resolve(); }
    createOscillator() {
      oscillators.push(1);
      return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createBuffer() { return {}; }
    createBufferSource() { primes.push(1); if (primeImpl !== null) primeImpl(); return { buffer: null, connect() {}, start() {} }; }
  }

  const fakeWindow = {
    AudioContext: FakeAudioContext,
    addEventListener(type, handler, capture) { listeners.set(type, { handler, capture }); },
    // 摘除时**校验 capture 标志**:真实 DOM 里 capture 不匹配的 removeEventListener 不生效,
    // 假实现若忽略它,"注册时传 true、摘除时忘了传"这类错误就永远测不出来(v0.5.3 补盲区)。
    removeEventListener(type, handler, capture) {
      log.removals.push({ type, capture });
      const entry = listeners.get(type);
      if (entry === undefined || entry.handler !== handler) return;
      if (capture !== true || entry.capture !== true) return;
      listeners.delete(type);
    },
  };
  if (opts.userActivation !== undefined) {
    // 只在显式要求时挂桩:默认的假 window 没有 navigator ⇒ 走"环境里没有 userActivation"那条防御
    // 分支(那正是 D3 的正常场景,必须仍然 0 上下文 / 0 振荡器 / 0 告警)。
    fakeWindow.navigator = { userActivation: opts.userActivation };
  }

  /** 假 store:记录 subscribe/unsubscribe 次数,getSnapshot 返回可改写的 snapshot,emit 手动触发。 */
  const makeStore = (snapshot) => ({
    subscribeCount: 0,
    unsubscribeCount: 0,
    snapshot,
    emit: undefined,
    subscribe(callback) {
      this.subscribeCount += 1;
      this.emit = callback;
      return () => { this.unsubscribeCount += 1; };
    },
    getSnapshot() { return this.snapshot; },
  });
  const list = makeStore({ phase: "ready", byId: {} });
  const statusStore = makeStore(new Map());

  const scopeDisposers = [];
  const ctxDisposers = [];
  const scope = {
    sessions: { list },
    uiSession: { sessionStatus: statusStore },
    effect(callback, label) {
      log.effects.push(label);
      const dispose = callback();
      if (typeof dispose === "function") scopeDisposers.push(dispose);
    },
  };
  const slots = {
    inject(seat, factory) { log.slotInjects.push(seat); log.seatFactory = factory; },
    register(entry, component) { log.registered.push({ entry, component }); return () => {}; },
  };
  const ctx = {
    get(name) { log.gets.push(name); return name === "slots" ? slots : undefined; },
    inject(deps, callback) { log.injects.push({ deps, callback }); },
    effect(callback, label) {
      log.effects.push(label);
      const dispose = callback();
      if (typeof dispose === "function") ctxDisposers.push(dispose);
    },
  };

  const previousWindow = globalThis.window;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realWarn = console.warn;
  const realError = console.error;
  globalThis.window = fakeWindow;
  globalThis.setTimeout = (fn, ms) => { const id = { fn, ms }; log.timers.push(id); return id; };
  globalThis.clearTimeout = (id) => { log.cleared.push(id); };
  console.warn = (...args) => { log.warns.push(args.join(" ")); };
  console.error = (...args) => { log.errors.push(args.join(" ")); };

  loadModule().apply(ctx);

  return {
    log, listeners, contexts, primes, oscillators, list, statusStore,
    runInjectCallback() {
      if (log.injects.length === 0) throw new Error("apply 没有调用 ctx.inject");
      log.injects[0].callback(scope);
      return log.injects[0];
    },
    seatDispose() {
      if (typeof log.seatFactory !== "function") throw new Error("apply 没有注册座位兜底(slots.inject 未被调用)");
      return log.seatFactory();
    },
    setResumeImpl(fn) { resumeImpl = fn; },
    setPrimeImpl(fn) { primeImpl = fn; },
    disposeAll() {
      for (const dispose of scopeDisposers.concat(ctxDisposers)) dispose();
    },
    teardown() {
      try { this.disposeAll(); } finally {
        globalThis.window = previousWindow;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        console.warn = realWarn;
        console.error = realError;
      }
    },
  };
}

test("不变量(行为):apply 用 ctx.inject 等 sessions/uiSession 就绪后各订阅一次", () => {
  const h = runApply();
  try {
    equal(h.log.injects.length, 1, "ctx.inject 调用次数");
    equal(JSON.stringify(h.log.injects[0].deps), JSON.stringify(["sessions", "uiSession"]), "inject 的依赖");
    equal(typeof h.log.injects[0].callback, "function", "inject 回调");
    equal(h.list.subscribeCount, 0, "回调跑之前不该订阅(要等服务就绪)");
    equal(h.statusStore.subscribeCount, 0, "同上");
    equal(h.contexts.length, 0, "apply 阶段不该创建 AudioContext(必须等用户手势)");
    h.runInjectCallback();
    equal(h.list.subscribeCount, 1, "sessions.list 订阅次数");
    equal(h.statusStore.subscribeCount, 1, "uiSession.sessionStatus 订阅次数");
    equal(h.log.timers.length, 1, "等待服务的计时器数");
    equal(h.log.timers[0].ms, 15000, "等待服务时长(ms)");
    equal(h.log.cleared.indexOf(h.log.timers[0]) >= 0, true, "服务就绪后应清掉等待计时器");
  } finally {
    h.teardown();
  }
});

test("不变量(行为):作用域拆掉后两个订阅各退订一次;座位兜底照旧注册", () => {
  const h = runApply();
  try {
    h.runInjectCallback();
    equal(h.log.slotInjects.indexOf("conversation.composer.dock") >= 0, true, "座位兜底注册:" + h.log.slotInjects.join(","));
    const seatDispose = h.seatDispose();
    equal(h.log.registered.length, 1, "座位条目数");
    equal(h.log.registered[0].entry.id, "turn-chime", "座位条目 id");
    equal(typeof seatDispose, "function", "座位 register 的 disposer");
    h.disposeAll();
    equal(h.list.unsubscribeCount, 1, "sessions.list 退订次数");
    equal(h.statusStore.unsubscribeCount, 1, "uiSession.sessionStatus 退订次数");
  } finally {
    h.teardown();
  }
});

test("不变量(行为):安装期首轮求值抛错时当场退订并退回座位兜底(不留半装)", () => {
  const h = runApply();
  try {
    // 让首轮求值必抛:sessionStatus 快照的 forEach 抛错(stepAll 里第一个碰它的地方)。
    h.statusStore.snapshot = { forEach() { throw new Error("boom"); } };
    let escaped;
    try {
      h.runInjectCallback(); // 模拟 cordis 触发注入回调
    } catch (error) {
      escaped = error;
    }
    equal(h.list.unsubscribeCount, 1, "sessions.list 应被当场退订");
    equal(h.statusStore.unsubscribeCount, 1, "uiSession.sessionStatus 应被当场退订");
    equal(h.log.effects.indexOf("turn-chime: global watcher") < 0, true, "不该留下半装的作用域 effect");
    equal(h.log.errors.length, 1, "应 console.error 一次:" + h.log.errors.join("|"));
    equal(h.log.warns.length, 1, "应 warnOnce 退回座位兜底:" + h.log.warns.join("|"));
    equal(h.log.slotInjects.indexOf("conversation.composer.dock") >= 0, true, "座位兜底照旧注册");
    // 放在最后:异常若外溢,前面几条"当场退订/告警"会一起失败,一眼看出是"半装 + 泄漏"。
    equal(escaped, undefined, "异常不该穿出 apply:" + String(escaped && escaped.message));
  } finally {
    h.teardown();
  }
});

test("不变量(行为):首次用户手势才解锁音频,解锁后摘掉监听(一次性)", () => {
  const h = runApply();
  try {
    equal(h.contexts.length, 0, "apply 阶段不该创建 AudioContext");
    const down = h.listeners.get("pointerdown");
    const key = h.listeners.get("keydown");
    equal(down !== undefined, true, "缺 pointerdown 解锁监听");
    equal(key !== undefined, true, "缺 keydown 解锁监听");
    equal(down.capture, true, "解锁监听应挂捕获阶段");
    down.handler();
    equal(h.contexts.length, 1, "手势后创建的上下文数");
    equal(h.contexts[0].state, "running", "手势后上下文状态");
    equal(h.primes.length, 1, "无声缓冲解锁次数");
    equal(h.listeners.size, 0, "解锁后两个监听都应摘掉");
    equal(h.log.removals.length, 2, "摘除调用次数:" + String(h.log.removals.length));
    equal(h.log.removals.every((r) => r.capture === true), true, "摘除必须带捕获标志 true(否则真实 DOM 里摘不掉)");
    key.handler();
    equal(h.contexts.length, 1, "已解锁则不再重复创建上下文");
    equal(h.log.warns.length, 0, "正常解锁不该告警:" + h.log.warns.join("|"));
  } finally {
    h.teardown();
  }
});

test("不变量(行为):resume 失败时 warn 一条且只报一次(不再静默吞掉)", () => {
  const h = runApply();
  try {
    h.runInjectCallback();
    // 用"同步 thenable"表示 reject,好让告警在同一个 tick 里被断言到。
    h.setResumeImpl(function () { return { then(_ok, fail) { fail(new Error("not allowed")); } }; });
    h.listeners.get("pointerdown").handler();
    equal(h.log.warns.length, 1, "解锁失败的告警数:" + h.log.warns.join("|"));
    equal(h.log.warns[0].indexOf("提示音可能听不到") >= 0, true, "告警文案:" + h.log.warns[0]);
    equal(h.log.warns[0].indexOf("[turn-chime]") === 0, true, "告警前缀:" + h.log.warns[0]);
    // 再让全局监听判出一条该响的待介入 → 播放路径又 resume 一次,仍只报一次
    h.list.snapshot = { phase: "ready", byId: { a: { id: "a", origin: "user", running: true } } };
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }]]);
    h.list.emit();
    equal(h.log.warns.length, 1, "只报一次:" + h.log.warns.join("|"));
    equal(h.log.errors.length, 0, "不该抛错:" + h.log.errors.join("|"));
  } finally {
    h.teardown();
  }
});

test("不变量(行为):apply 不再用 ctx.get 取 sessions/uiSession(旧写法必然漏装)", () => {
  const h = runApply();
  try {
    const bad = h.log.gets.filter((name) => name === "sessions" || name === "uiSession");
    equal(bad.length, 0, "ctx.get 取服务的次数:" + bad.join(","));
    equal(h.log.gets.indexOf("slots") >= 0, true, "座位兜底仍要取 slots");
  } finally {
    h.teardown();
  }
});

test("不变量(行为):等不到 sessions/uiSession 时 15 s 报一次警,卸载清掉计时器", () => {
  const h = runApply();
  try {
    equal(h.log.timers.length, 1, "等待服务的计时器数");
    equal(h.log.timers[0].ms, 15000, "等待服务时长(ms)");
    equal(h.log.warns.length, 0, "到点前不该告警");
    h.log.timers[0].fn();
    equal(h.log.warns.length, 1, "超时告警数:" + h.log.warns.join("|"));
    equal(h.log.warns[0].indexOf("sessions") >= 0, true, "告警应提到 sessions:" + h.log.warns[0]);
    h.log.timers[0].fn();
    equal(h.log.warns.length, 1, "只报一次,不刷屏");
    h.disposeAll();
    equal(h.log.cleared.indexOf(h.log.timers[0]) >= 0, true, "卸载时清掉计时器");
  } finally {
    h.teardown();
  }
});

test("不变量(行为,D3):安装期首轮求值遇到已有待介入也不创建 AudioContext、不排振荡器", () => {
  const h = runApply();
  try {
    h.list.snapshot = { phase: "ready", byId: { a: { id: "a", origin: "user", running: true } } };
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }]]);
    h.runInjectCallback();
    equal(h.contexts.length, 0, "安装期求值不得创建 AudioContext(那时还没有任何用户手势)");
    equal(h.oscillators.length, 0, "也不得排振荡器(排了只会被浏览器静音)");
    equal(h.primes.length, 0, "也不得播解锁缓冲");
    equal(h.log.warns.length, 0, "静默期不该告警:" + h.log.warns.join("|"));
    equal(h.log.errors.length, 0, "不该抛错:" + h.log.errors.join("|"));
  } finally {
    h.teardown();
  }
});

test("不变量(行为,D3):未解锁期间被吞掉的响在首次手势解锁后恰好补响一次", () => {
  const h = runApply();
  try {
    h.list.snapshot = {
      phase: "ready",
      byId: { a: { id: "a", origin: "user", running: true }, b: { id: "b", origin: "user", running: true } },
    };
    h.statusStore.snapshot = new Map([
      ["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }],
      ["b", { running: true, pendingInteraction: { kind: "approval", key: "approval:1" } }],
    ]);
    h.runInjectCallback();
    equal(h.oscillators.length, 0, "未解锁:一声都不排");
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:2" } }]]);
    h.list.emit();
    equal(h.oscillators.length, 0, "未解锁期间来多少次事件都不排振荡器(只记下'有一声被吞掉了')");
    h.listeners.get("pointerdown").handler();
    equal(h.contexts.length, 1, "解锁时创建 1 个上下文");
    equal(h.oscillators.length, 2, "恰好补响一次(每个双音 = 2 个振荡器),实际:" + String(h.oscillators.length));
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:3" } }]]);
    h.list.emit();
    equal(h.oscillators.length, 4, "解锁之后照常即响,实际:" + String(h.oscillators.length));
  } finally {
    h.teardown();
  }
});

test("不变量(行为,D5):primeAudio 抛错不算解锁、保留监听,下次手势重试成功后完成解锁", () => {
  const h = runApply();
  try {
    h.runInjectCallback();
    const down = h.listeners.get("pointerdown");
    const key = h.listeners.get("keydown");
    h.setPrimeImpl(() => { throw new Error("prime boom"); });
    down.handler();
    equal(h.contexts.length, 1, "手势里创建了上下文");
    equal(h.primes.length, 1, "尝试过一次解锁缓冲");
    equal(h.listeners.size, 2, "解锁失败必须保留两个手势监听(留待重试)");
    equal(h.log.errors.length, 1, "应 console.error 一条:" + h.log.errors.join("|"));
    equal(h.log.warns.length, 0, "第一次失败不刷告警:" + h.log.warns.join("|"));
    h.list.snapshot = { phase: "ready", byId: { a: { id: "a", origin: "user", running: true } } };
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }]]);
    h.list.emit();
    equal(h.oscillators.length, 0, "仍算未解锁 ⇒ 不排振荡器(只记下来)");
    h.setPrimeImpl(null);
    key.handler();
    equal(h.primes.length, 2, "重试过一次解锁缓冲");
    equal(h.listeners.size, 0, "解锁成功后摘掉两个监听");
    equal(h.oscillators.length, 2, "补响一次,实际:" + String(h.oscillators.length));
    equal(h.log.warns.length, 0, "重试成功不该告警:" + h.log.warns.join("|"));
  } finally {
    h.teardown();
  }
});

test("不变量(行为,D5):重试仍失败时按 warnAudioOnce 报一次(不再静默退化)", () => {
  const h = runApply();
  try {
    h.runInjectCallback();
    const down = h.listeners.get("pointerdown");
    const key = h.listeners.get("keydown");
    h.setPrimeImpl(() => { throw new Error("prime boom"); });
    down.handler();
    equal(h.log.warns.length, 0, "首次失败只留 console.error");
    key.handler();
    equal(h.log.warns.length, 1, "重试仍失败要告警:" + h.log.warns.join("|"));
    equal(h.log.warns[0].indexOf("音频解锁失败") >= 0, true, "告警文案:" + h.log.warns[0]);
    equal(h.log.warns[0].indexOf("[turn-chime]") === 0, true, "告警前缀:" + h.log.warns[0]);
    down.handler();
    equal(h.log.warns.length, 1, "只报一次,不刷屏");
    equal(h.listeners.size, 2, "一直失败就一直保留监听");
  } finally {
    h.teardown();
  }
});

// ── M3 粘性用户激活:加载期能不能出声 ───────────────────────────────
test("不变量(行为,M3):页面已被用户激活过 ⇒ 加载期遇到已有待介入就当场出声(1 个上下文 + 2 个振荡器)", () => {
  // HMR 原地重载后 audioUnlocked 会复位,而浏览器对本 document 的解锁是粘性的 ⇒ 用
  // navigator.userActivation.hasBeenActive 初始化它:已激活的页面不该被压成静音。
  const h = runApply({ userActivation: { hasBeenActive: true } });
  try {
    h.list.snapshot = { phase: "ready", byId: { a: { id: "a", origin: "user", running: true } } };
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }]]);
    h.runInjectCallback();
    equal(h.contexts.length, 1, "已激活的页面:加载期应建 1 个上下文");
    equal(h.oscillators.length, 2, "应排 2 个振荡器(双音),实际:" + String(h.oscillators.length));
    equal(h.primes.length, 0, "没走手势路径 ⇒ 不该播解锁缓冲");
    equal(h.log.warns.length, 0, "已激活页面当场出声,不该告警:" + h.log.warns.join("|"));
    equal(h.log.errors.length, 0, "不该抛错:" + h.log.errors.join("|"));
  } finally {
    h.teardown();
  }
});

test("不变量(行为,M3):hasBeenActive=false ⇒ 与没有该信号一样(0 上下文 / 0 振荡器,首次手势后补响一次)", () => {
  const h = runApply({ userActivation: { hasBeenActive: false } });
  try {
    h.list.snapshot = { phase: "ready", byId: { a: { id: "a", origin: "user", running: true } } };
    h.statusStore.snapshot = new Map([["a", { running: true, pendingInteraction: { kind: "question", key: "q:1" } }]]);
    h.runInjectCallback();
    equal(h.contexts.length, 0, "未激活的页面:加载期不得创建 AudioContext(D3)");
    equal(h.oscillators.length, 0, "也不得排振荡器");
    equal(h.primes.length, 0, "也不得播解锁缓冲");
    equal(h.log.warns.length, 0, "静默期不该告警:" + h.log.warns.join("|"));
    h.listeners.get("pointerdown").handler();
    equal(h.contexts.length, 1, "手势后创建 1 个上下文");
    equal(h.oscillators.length, 2, "补响一次,实际:" + String(h.oscillators.length));
  } finally {
    h.teardown();
  }
});

// ── v0.5.5:索引化子代理计数的不变量 ─────────────────────────────────
// v0.5.5 把"每个用户会话各扫一遍全表"的子代理计数换成"每轮建一次父→子索引 + 索引上向下 BFS",
// 判定语义必须逐字不变。下面用确定性 PRNG(同一 seed 复现同一张图)造随机会话图做差分:
// origin 混合(subagent / user / 其它 / undefined)、parentId 指向其它行 / null / 缺省 / 不存在的 id、
// 多个根、含环、值为 undefined 的空行。
const indexSubagentRowsByParent = mod.__test?.indexSubagentRowsByParent;
const countInIndex = mod.__test?.countRunningDescendantsInIndex;
const worthKeeping = mod.__test?.stateWorthKeeping;
if (typeof indexSubagentRowsByParent !== "function" || typeof countInIndex !== "function") {
  throw new Error("缺少 __test.indexSubagentRowsByParent / __test.countRunningDescendantsInIndex 导出");
}
if (typeof worthKeeping !== "function") throw new Error("缺少 __test.stateWorthKeeping 导出");

/** 确定性 PRNG(mulberry32):同一 seed 每次跑出同一张图,失败可复现。 */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 造一张随机会话摘要表 + 一批查询根(含 null / undefined / 不存在的 id)。 */
function randomGraph(seed) {
  const rand = prng(seed);
  const n = 1 + Math.floor(rand() * 14);
  const ids = [];
  for (let i = 0; i < n; i++) ids.push("n" + i);
  const roots = ["root", "r2", "r3"];
  const summaries = {};
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const o = rand();
    const origin = o < 0.7 ? "subagent" : o < 0.85 ? "user" : o < 0.93 ? "other" : undefined;
    const p = rand();
    let parentId;
    if (p < 0.25) parentId = roots[Math.floor(rand() * roots.length)];
    else if (p < 0.7) parentId = ids[Math.floor(rand() * n)];
    else if (p < 0.8) parentId = null;
    else if (p < 0.9) parentId = undefined;
    else parentId = "missing-" + Math.floor(rand() * 3);
    summaries[id] = rand() < 0.06 ? undefined : { id, parentId, origin, running: rand() < 0.55 };
  }
  return { summaries, roots: roots.concat([null, undefined, "missing-0"]) };
}

/** 改动前的计数实现(逐行向上溯源,client.js v0.5.4 原文转写),作为差分基准。 */
function naiveCount(summaries, rootSessionId) {
  if (summaries === undefined || summaries === null || rootSessionId === undefined) return 0;
  let count = 0;
  const keys = Object.keys(summaries);
  for (let i = 0; i < keys.length; i++) {
    const row = summaries[keys[i]];
    if (row === undefined || row === null) continue;
    if (row.origin !== "subagent" || row.running !== true) continue;
    const seen = Object.create(null);
    let current = row;
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

test("不变量(随机差分,v0.5.5):索引化计数与逐行上溯的朴素实现在 3000 张随机图上零不一致", () => {
  let checks = 0;
  for (let c = 0; c < 3000; c++) {
    const graph = randomGraph(0x9E3779B9 ^ (c * 2654435761));
    for (const root of graph.roots) {
      const expected = naiveCount(graph.summaries, root);
      equal(count(graph.summaries, root), expected, "薄包装 case#" + c + " root=" + String(root));
      if (root !== undefined) {
        equal(countInIndex(indexSubagentRowsByParent(graph.summaries), root), expected,
          "索引 case#" + c + " root=" + String(root));
      }
      checks += 1;
    }
  }
  equal(checks, 18000, "差分次数(3000 图 × 6 个查询根)");
});

test("不变量(索引复用,v0.5.5):索引建一次、逐个根查询与薄包装逐次建索引结果一致", () => {
  for (let c = 0; c < 400; c++) {
    const graph = randomGraph(0x51ED2701 ^ (c * 40503));
    const index = indexSubagentRowsByParent(graph.summaries);
    for (const root of graph.roots) {
      equal(countInIndex(index, root), count(graph.summaries, root), "case#" + c + " root=" + String(root));
    }
  }
});

/**
 * stepAll 改动前语义的重述:唯一差别是活跃子代理数逐会话调用薄包装 countRunningDescendants
 * (旧实现对每个会话重扫全表)、id 去重用 ids.indexOf —— 把"每轮只建一次索引 + Set 去重"这次
 * 改写的语义等价钉死。
 */
function naiveStepAll(states, byId, status, prune) {
  const next = new Map();
  if (!prune && states) states.forEach((value, key) => { next.set(key, value); });
  let chime = false;
  const ids = Object.keys(byId || {});
  if (status && typeof status.forEach === "function") {
    status.forEach((_value, id) => { if (ids.indexOf(id) < 0) ids.push(id); });
  }
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const row = byId === undefined || byId === null ? undefined : byId[id];
    const hasRow = row !== undefined && row !== null;
    const isSubagent = hasRow && row.origin === "subagent";
    const statusRow = status === undefined || status === null ? undefined : status.get(id);
    let running = hasRow ? row.running : undefined;
    if (!isSubagent && hasRow && statusRow !== undefined && statusRow !== null && statusRow.running !== undefined) {
      running = statusRow.running;
    }
    const runningKnown = !isSubagent && hasRow && running !== undefined && running !== null;
    const pendingKey = pendingKeyOf(statusRow);
    if (!runningKnown && (pendingKey === undefined || pendingKey === null)) {
      if (states !== undefined && states !== null && states.has(id)) {
        const kept = states.get(id);
        if (!isSubagent || worthKeeping(kept)) next.set(id, kept);
      }
      continue;
    }
    const stepped = step(
      states === undefined || states === null ? undefined : states.get(id),
      runningKnown ? running : false,
      runningKnown ? count(byId, id) : 0,
      pendingKey,
      runningKnown
    );
    next.set(id, stepped);
    if (stepped.chime) chime = true;
  }
  if (prune && states !== undefined && states !== null) {
    states.forEach((value, key) => {
      if (next.has(key)) return;
      let revived = value;
      if (value !== undefined && value !== null && value.chimedForTurn === true) {
        revived = {
          lastRunning: value.lastRunning,
          lastChimedPendingKey: value.lastChimedPendingKey,
          pending: value.pending === true,
          chimedForTurn: false,
          chime: false,
        };
      }
      if (worthKeeping(revived)) next.set(key, revived);
    });
  }
  return { states: next, chime };
}

test("不变量(stepAll,v0.5.5):每轮只建一次索引后,chime / 状态字段 / 键序与逐会话朴素计数完全一致", () => {
  let runs = 0;
  for (let c = 0; c < 300; c++) {
    const rand = prng(0xC0FFEE ^ (c * 7919));
    const n = 1 + Math.floor(rand() * 10);
    const byId = {};
    const status = new Map();
    const states = new Map();
    for (let i = 0; i < n; i++) {
      const id = "s" + i;
      const o = rand();
      const origin = o < 0.25 ? "subagent" : o < 0.9 ? "user" : undefined;
      const p = rand();
      const parentId = p < 0.4 ? "s" + Math.floor(rand() * n) : p < 0.7 ? "root" : undefined;
      const running = rand() < 0.5;
      byId[id] = { id, parentId, origin, running };
      if (rand() < 0.8) {
        status.set(id, {
          running,
          pendingInteraction: rand() < 0.3 ? { kind: "question", key: "q:" + Math.floor(rand() * 3) } : undefined,
        });
      }
      if (rand() < 0.5) {
        states.set(id, S({
          lastRunning: rand() < 0.5,
          lastChimedPendingKey: rand() < 0.5 ? "q:1" : undefined,
          pending: rand() < 0.5,
          chimedForTurn: rand() < 0.5,
        }));
      }
    }
    // 摘要表与状态表里都没有的会话(prune 的补回路径)+ 只在状态表里的会话(判不了 running)
    if (rand() < 0.4) states.set("ghost", S({ lastRunning: true, pending: true, chimedForTurn: true }));
    if (rand() < 0.3) status.set("norow", { running: true, pendingInteraction: { kind: "approval", key: "approval:1" } });
    for (const prune of [false, true]) {
      const actual = stepAll(new Map(states), byId, status, prune);
      const expected = naiveStepAll(new Map(states), byId, status, prune);
      const label = "case#" + c + " prune=" + prune + " ";
      equal(actual.chime, expected.chime, label + "chime");
      equal(Array.from(actual.states.keys()).join(","), Array.from(expected.states.keys()).join(","), label + "键序");
      for (const key of expected.states.keys()) {
        const a = actual.states.get(key);
        const e = expected.states.get(key);
        equal(a !== undefined, true, label + "状态存在 " + key);
        equal(a.lastRunning, e.lastRunning, label + "lastRunning " + key);
        equal(a.lastChimedPendingKey, e.lastChimedPendingKey, label + "lastChimedPendingKey " + key);
        equal(a.pending, e.pending, label + "pending " + key);
        equal(a.chimedForTurn, e.chimedForTurn, label + "chimedForTurn " + key);
        equal(a.chime, e.chime, label + "step.chime " + key);
      }
      runs += 1;
    }
  }
  equal(runs, 600, "对比轮数(300 组 × prune 两态)");
});

test("不变量(v0.5.5):id 处理顺序仍是「摘要表自有键序 + 状态表新增键序」,Set 改写没动数组顺序", () => {
  const byId = { b: sessionRow("b", "user", true), a: sessionRow("a", "user", true) };
  const status = statusMap({
    z: { running: false, pendingInteraction: { kind: "question", key: "q:z" } },
    a: { running: true },
    y: { running: false, pendingInteraction: { kind: "question", key: "q:y" } },
  });
  const out = stepAll(new Map(), byId, status, true);
  equal(Array.from(out.states.keys()).join(","), "b,a,z,y", "键序");
});

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "\n      " + String(r.error?.message ?? r.error)));
}
console.log("\n" + results.length + " 个用例," + failed.length + " 个失败");
if (failed.length > 0) process.exit(1);
