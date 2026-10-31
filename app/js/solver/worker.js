// 自動で作るの裏方（Web Worker）。画面が固まらないように、ここで HiGHS を動かす。
// 受け取る：{ kind: 'generate', data, timeLimit, seed }（自動で作る・途中から作り直す。途中からは、写しに固定の印を付けたデータ）
//         { kind: 'repair', data, secondsEach, seed }（エラーを自動で直す。上限ごとの案を作る）
// 送る：{ type: 'progress', stage, count, name, phase, seconds, totals? } … 段の始まりと終わり（終わりには、その時点の表を check.js で数えた件数）
//       { type: 'done', result }                                         … 作り終えた（作れなかったときも）
//       { type: 'error', message }                                       … 計算の部品が動かなかった
import highsLoader from '../../../vendor/highs/highs.mjs?v=5.3';
import { solveStaged } from './stages.js?v=5.3';
import { solveRepair } from './repair.js?v=5.3';
import { checkTable } from '../check.js?v=5.3';

const WASM_URL = new URL('../../../vendor/highs/highs.wasm?v=5.3', import.meta.url).href;
const loadHighs = () => highsLoader({ locateFile: () => WASM_URL });

self.onmessage = async (e) => {
  const { kind = 'generate', data, timeLimit, secondsEach, seed } = e.data;
  const totalsOf = (table) => {
    const res = checkTable({ ...data, month: { ...data.month, table } });
    return res.tableEmpty ? null : res.totals;
  };
  try {
    if (kind === 'repair') {
      const result = await solveRepair(data, {
        loadHighs,
        secondsEach,
        seed,
        onProgress: (p) => {
          self.postMessage({ type: 'progress', stage: p.stage, count: p.count, name: p.name, phase: p.phase, seconds: p.seconds, budget: p.budget, budgetIndex: p.budgetIndex, budgetCount: p.budgetCount, totals: p.table ? totalsOf(p.table) : null });
        },
      });
      self.postMessage({ type: 'done', result });
      return;
    }
    const res = await solveStaged(data, {
      loadHighs,
      timeLimit,
      seed,
      onProgress: (p) => {
        self.postMessage({ type: 'progress', stage: p.stage, count: p.count, name: p.name, phase: p.phase, seconds: p.seconds, totals: p.table ? totalsOf(p.table) : null });
      },
    });
    self.postMessage({
      type: 'done',
      result: { ok: res.ok, reason: res.reason ?? null, conflicts: res.conflicts ?? [], table: res.table ?? null, stages: res.stages ?? [], seconds: res.seconds ?? null },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message ?? err) });
  }
};
