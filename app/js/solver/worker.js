// 自動で作るの裏方（Web Worker）。画面が固まらないように、ここで HiGHS を動かす。
// 受け取る：{ data, timeLimit, seed }
// 送る：{ type: 'progress', stage, count, name, phase, seconds, totals? } … 段の始まりと終わり（終わりには、その時点の表を check.js で数えた件数）
//       { type: 'done', result }                                         … 作り終えた（作れなかったときも）
//       { type: 'error', message }                                       … 計算の部品が動かなかった
import highsLoader from '../../../vendor/highs/highs.mjs?v=3.3';
import { solveStaged } from './stages.js?v=3.3';
import { checkTable } from '../check.js?v=3.3';

const WASM_URL = new URL('../../../vendor/highs/highs.wasm?v=3.3', import.meta.url).href;
const loadHighs = () => highsLoader({ locateFile: () => WASM_URL });

self.onmessage = async (e) => {
  const { data, timeLimit, seed } = e.data;
  const totalsOf = (table) => {
    const res = checkTable({ ...data, month: { ...data.month, table } });
    return res.tableEmpty ? null : res.totals;
  };
  try {
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
