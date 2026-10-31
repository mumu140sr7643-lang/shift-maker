// 段階的に解く（docs/自動で作る案.md の 4・5 章）。HiGHS を読み込む関数を渡せば、ブラウザでも node でも同じに動く。
import { buildModel } from './build.js?v=4.2';
import { solveConflicts } from '../check.js?v=4.2';

// HiGHS の答えの状態の番号
const OPTIMAL = 7;
const INFEASIBLE = new Set([8, 9]);
// HiGHS 1.15.4 の前処理のうち「2つの変数だけの等式を片方に置きかえる」（DoubletonEquation、番号 9）を止める。
// これが入っていると、この式（明け＝前の日の夜勤 など）で、答えのある段を「答えが無い」と言ったり、
// いちばん良くない答えを「いちばん良い（解ききった）」と返したりすることがあった（2026-10-31、作り物の 68 か月で確かめた）
const PRESOLVE_RULE_OFF = 1 << 9;
// 前の段の答えを、次の段の「はじめの答え」として HiGHS に渡さない。渡すと、まだ良くできる段を「解ききった」と返すことがあった
// （2026-10-31、tools/solve-bench.mjs --presolve の乱数の 120 か月で、渡すと まちがい 1、渡さないと 0）
const WARM_START = false;
// 「できれば」の段（いちばん最後の段）だけは、はじめの答えを渡し、HiGHS に答えを強めに探させる（mip_heuristic_effort 1。はじめの値は 0.05）。
// 渡したときの「解ききった」は確かめられないので、「時間切れ」（limit）と同じに扱う。
// 2026-10-31（3-3）確かめ役の決め方で測って採った：見本3つ × 12か月 × 60秒 3回・作り物 12通り × 3回で、絶対の件数（見本）と量（作り物）は増えず、
// できれば の合計（3回の平均）が 7979 → 3732。20秒でも段1〜5 は解ききった（tools/compare-settings.mjs）
const SOFT_WARM_START = true;
const SOFT_OPTIONS = { mip_heuristic_effort: 1 };

// 時間で区切るときの配分：段1 は合計の 1/6、段2〜5 は合わせて 1/2、残りを最後の段に
function budgetFor(i, count, total, used) {
  const left = Math.max(1, total - used);
  if (count === 1 || i === count - 1) return left;
  if (i === 0) return Math.min(left, total / 6);
  const midCount = Math.max(1, count - 2);
  return Math.max(1, Math.min(left - 1, total / 2 / midCount));
}

// 式（Lin）の値を、変数の値（名前 → 値）で計算する。定数も入れる
function valueOf(lin, values) {
  let v = lin.c;
  for (const [name, k] of lin.t) v += k * (values.get(name) ?? 0);
  return v;
}

// LP の文を1回解く。start（変数の名前 → 値）があれば、そこから始める。
// 返す：{ code, objective, values: Map（変数の名前 → 値）| null }
// 調べる数の上限で止まったときも途中の答えを受け取れるよう、HiGHS の「モデル」の使い方で解く。
function runLp(highs, text, options, start) {
  const model = highs.createModel({ format: 'lp', data: text });
  try {
    for (const [k, v] of Object.entries(options)) model.raw.setOptionValue(k, v);
    const n = model.getDimensions().numCols;
    const names = [];
    for (let i = 0; i < n; i += 1) names.push(model.getColName(i));
    if (start) model.setSolution({ colValue: names.map((nm) => start.get(nm) ?? 0) });
    model.run();
    const code = model.getModelStatus();
    const objective = model.getObjectiveValue();
    let values = null;
    if (!INFEASIBLE.has(code) && Number.isFinite(objective) && Math.abs(objective) < 1e20) {
      const col = model.getSolution().colValue;
      values = new Map(names.map((nm, i) => [nm, col[i]]));
    }
    return { code, objective, values };
  } finally {
    model.dispose();
  }
}

// 返す：{ ok, reason?, conflicts?, table?, stages: [{ key, name, status, seconds, value, code }], amounts, size, seconds }
//   status: 'solved'（差0で最適）| 'limit'（時間・調べる数の上限で途中の答え）| 'kept'（答えが無い・前の段の答えより悪いので、前の段の答えのまま）| 'none'
//   reason: 'conflict'（解く前のぶつかり）| 'infeasible'（答えが無い）| 'no-answer'（段1で上限までに答えが無い）| 'stopped'（中止）
export async function solveStaged(data, opts) {
  // maxStages・presolve・presolveRuleOff・warmStart は確かめの道具だけが変える（はじめの段だけ解く・前処理の不具合を調べる）
  // keepCurrent・changeLimit はエラーを自動で直す（repair.js）だけが使う
  const { loadHighs, timeLimit = null, nodeLimit = null, seed = 1, leaderWeight = 0, onProgress = () => {}, shouldStop = () => false, maxStages = Infinity, presolve = 'on', presolveRuleOff = PRESOLVE_RULE_OFF, warmStart = WARM_START, softWarmStart = SOFT_WARM_START, softOptions = SOFT_OPTIONS, keepCurrent = false, changeLimit = null } = opts;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const conflicts = solveConflicts(data);
  if (conflicts.length) return { ok: false, reason: 'conflict', conflicts, stages: [] };
  const model = buildModel(data, { leaderWeight, keepCurrent, changeLimit });
  const records = [];
  const bounds = [];
  let last = null;
  const t0 = now();
  for (let i = 0; i < Math.min(model.stages.length, maxStages); i += 1) {
    if (shouldStop()) return { ok: false, reason: 'stopped', stages: records, size: model.size };
    const st = model.stages[i];
    const options = { output_flag: false, mip_rel_gap: 0, random_seed: seed, threads: 1, presolve };
    if (presolveRuleOff) options.presolve_rule_off = presolveRuleOff;
    if (timeLimit) options.time_limit = budgetFor(i, model.stages.length, timeLimit, (now() - t0) / 1000);
    if (nodeLimit) options.mip_max_nodes = nodeLimit;
    if (st.key === 'soft') Object.assign(options, softOptions);
    onProgress({ stage: i + 1, count: model.stages.length, name: st.name, phase: 'start', seconds: (now() - t0) / 1000 });
    const s0 = now();
    let res;
    let retried = false;
    const warm = warmStart || (softWarmStart && st.key === 'soft');
    try {
      const text = model.lp(st.objective, bounds);
      res = runLp(await loadHighs(), text, options, warm ? last : null);
      // それでも「答えが無い」と出たときは、念のため前処理を止めて解き直して確かめる（上の PRESOLVE_RULE_OFF を見よ）
      if (INFEASIBLE.has(res.code) && options.presolve !== 'off') {
        retried = true;
        const again = { ...options, presolve: 'off' };
        if (timeLimit) again.time_limit = Math.max(1, timeLimit - (now() - t0) / 1000);
        res = runLp(await loadHighs(), text, again, warm ? last : null);
      }
    } catch (e) {
      res = { code: -1, objective: Infinity, values: null, error: String(e?.message ?? e) };
    }
    const seconds = Math.round((now() - s0) / 10) / 100;
    // 前の段の答えも、この段の式を全部満たす（前の段の上限を満たすため）。
    // この段の答えが無いとき・前の段の答えより悪いときは、前の段の答えのままにする。
    // 「解ききった」と言ったのに前の段の答えより悪いのは HiGHS のまちがいなので、suspect に残す
    const before = last ? valueOf(st.objective, last) : null;
    const after = res.values ? valueOf(st.objective, res.values) : null;
    let status;
    let value;
    if (after !== null && (before === null || after <= before + 1e-6)) {
      last = res.values;
      value = after;
      status = res.code === OPTIMAL && !(warm && !warmStart) ? 'solved' : 'limit';
    } else if (last) {
      value = before;
      status = 'kept';
    } else {
      records.push({ key: st.key, name: st.name, status: 'none', seconds, value: null, code: res.code, retried });
      return { ok: false, reason: INFEASIBLE.has(res.code) ? 'infeasible' : 'no-answer', stages: records, size: model.size };
    }
    bounds.push({ objective: st.objective, max: value });
    const suspect = after !== null && before !== null && after > before + 1e-6 && res.code === OPTIMAL;
    records.push({ key: st.key, name: st.name, rules: st.rules, status, seconds, value: Math.round(value * 1000) / 1000, code: res.code, retried, ...(suspect ? { suspect } : {}) });
    onProgress({ stage: i + 1, count: model.stages.length, name: st.name, phase: 'done', seconds: (now() - t0) / 1000, table: model.readTable(last) });
  }
  const amounts = {};
  for (const st of model.stages.slice(0, maxStages)) for (const r of st.rules) amounts[r] = model.amountOf(r, last);
  return { ok: true, table: model.readTable(last), stages: records, amounts, size: model.size, seconds: Math.round((now() - t0) / 10) / 100 };
}
