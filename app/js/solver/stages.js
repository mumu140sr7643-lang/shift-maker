// 段階的に解く（docs/自動で作る案.md の 4・5 章）。HiGHS を読み込む関数を渡せば、ブラウザでも node でも同じに動く。
import { buildModel } from './build.js?v=3.1';
import { solveConflicts } from '../check.js?v=3.1';

// HiGHS の答えの状態の番号
const OPTIMAL = 7;
const INFEASIBLE = new Set([8, 9]);

// 時間で区切るときの配分：段1 は合計の 1/6、段2〜5 は合わせて 1/2、残りを最後の段に
function budgetFor(i, count, total, used) {
  const left = Math.max(1, total - used);
  if (count === 1 || i === count - 1) return left;
  if (i === 0) return Math.min(left, total / 6);
  const midCount = Math.max(1, count - 2);
  return Math.max(1, Math.min(left - 1, total / 2 / midCount));
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
//   status: 'solved'（差0で最適）| 'limit'（時間・調べる数の上限で途中の答え）| 'kept'（答えが無く、前の段の答えのまま）| 'none'
//   reason: 'conflict'（解く前のぶつかり）| 'infeasible'（答えが無い）| 'no-answer'（段1で上限までに答えが無い）| 'stopped'（中止）
export async function solveStaged(data, opts) {
  // maxStages は確かめの道具だけが使う（はじめの段だけ解いて、式で縛ったことを確かめるため）
  const { loadHighs, timeLimit = null, nodeLimit = null, seed = 1, leaderWeight = 0, onProgress = () => {}, shouldStop = () => false, maxStages = Infinity, presolve = 'on' } = opts;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const conflicts = solveConflicts(data);
  if (conflicts.length) return { ok: false, reason: 'conflict', conflicts, stages: [] };
  const model = buildModel(data, { leaderWeight });
  const records = [];
  const bounds = [];
  let last = null;
  const t0 = now();
  for (let i = 0; i < Math.min(model.stages.length, maxStages); i += 1) {
    if (shouldStop()) return { ok: false, reason: 'stopped', stages: records, size: model.size };
    const st = model.stages[i];
    const options = { output_flag: false, mip_rel_gap: 0, random_seed: seed, threads: 1, presolve };
    if (timeLimit) options.time_limit = budgetFor(i, model.stages.length, timeLimit, (now() - t0) / 1000);
    if (nodeLimit) options.mip_max_nodes = nodeLimit;
    onProgress({ stage: i + 1, count: model.stages.length, name: st.name, phase: 'start', seconds: (now() - t0) / 1000 });
    const s0 = now();
    let res;
    let retried = false;
    try {
      const text = model.lp(st.objective, bounds);
      res = runLp(await loadHighs(), text, options, last);
      // HiGHS の前処理（presolve）が、答えのある式を「答えが無い」とまちがえることがある（2026-10-31 に見つけた）。
      // 「答えが無い」と出たときは、前処理を止めて解き直して確かめる
      if (INFEASIBLE.has(res.code) && options.presolve !== 'off') {
        retried = true;
        const again = { ...options, presolve: 'off' };
        if (timeLimit) again.time_limit = Math.max(1, timeLimit - (now() - t0) / 1000);
        res = runLp(await loadHighs(), text, again, last);
      }
    } catch (e) {
      res = { code: -1, objective: Infinity, values: null, error: String(e?.message ?? e) };
    }
    const seconds = Math.round((now() - s0) / 10) / 100;
    if (!res.values) {
      if (!last) {
        records.push({ key: st.key, name: st.name, status: 'none', seconds, value: null, code: res.code, retried });
        return { ok: false, reason: INFEASIBLE.has(res.code) ? 'infeasible' : 'no-answer', stages: records, size: model.size };
      }
      records.push({ key: st.key, name: st.name, status: 'kept', seconds, value: null, code: res.code, retried });
    } else {
      last = res.values;
      // HiGHS の答えの量には、式の定数（どう作っても変わらない量）が入っていないので足す
      const value = res.objective + st.objective.c;
      bounds.push({ objective: st.objective, max: value });
      records.push({ key: st.key, name: st.name, status: res.code === OPTIMAL ? 'solved' : 'limit', seconds, value: Math.round(value * 1000) / 1000, code: res.code, retried });
    }
    onProgress({ stage: i + 1, count: model.stages.length, name: st.name, phase: 'done', seconds: (now() - t0) / 1000, table: model.readTable(last) });
  }
  const amounts = {};
  for (const st of model.stages.slice(0, maxStages)) for (const r of st.rules) amounts[r] = model.amountOf(r, last);
  return { ok: true, table: model.readTable(last), stages: records, amounts, size: model.size, seconds: Math.round((now() - t0) / 10) / 100 };
}
