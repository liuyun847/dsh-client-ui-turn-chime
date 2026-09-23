/**
 * 纯函数单测:活跃子代理计数 countRunningDescendants。
 *
 * client.js 是浏览器 bundle(顶层调用 window.__ModuleLoader__.load),
 * 这里先注入 window 桩与 react 桩,再动态 import 取 factory 的返回值,
 * 通过 __test 导出直接测计数逻辑(不渲染任何组件)。
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

// ── 判定状态机(stepChime)用例 ──────────────────────────────────────
const step = mod.__test?.stepChime;
if (typeof step !== "function") throw new Error("缺少 __test.stepChime 导出");

/** 按 [running, activeSubagents] 序列推进状态机,返回响铃次数与末态。 */
function simulate(initial, steps) {
  let state = initial;
  let chimes = 0;
  for (const [running, active] of steps) {
    const next = step(state, running, active);
    if (next.chime) chimes += 1;
    state = { lastRunning: next.lastRunning, pending: next.pending };
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

test("client.js 已按 v0.3.0 声明版本注释", () => {
  const source = readFileSync(CLIENT_PATH, "utf8");
  if (!source.includes("countRunningDescendants")) throw new Error("缺少 countRunningDescendants 实现");
  if (!source.includes("stepChime")) throw new Error("缺少 stepChime 状态机");
  if (!source.includes("[turn-chime] v0.3.0 已加载")) throw new Error("缺少 v0.3.0 加载日志");
});

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "\n      " + String(r.error?.message ?? r.error)));
}
console.log("\n" + results.length + " 个用例," + failed.length + " 个失败");
if (failed.length > 0) process.exit(1);
