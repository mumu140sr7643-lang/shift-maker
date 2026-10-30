// 自動で作るの速さと、決まりの式の試しを測る道具（作り物のデータだけ）。
// 使い方:
//   node tools/solve-bench.mjs --sizes [--time 60]
//       8・15・25・50人 × 28・30・31日 の作り物の月を、画面と同じ1分の区切りで作り、段ごとの秒と結果を出す
//   node tools/solve-bench.mjs --leader [--nodes 30] [--weight 0.3]
//       責任者の順位を近づける軽い式の試し：見本3つ × 種1・2・3 を、式あり・なしで作り、件数を比べる
//   node tools/solve-bench.mjs --exact [--months 20] [--nodes 20]
//       作り物の月（希望あり）を作り、段の量と check.js の量を比べる（同じになるはずのもの・近い形のもの）
// 結果は tools/out/bench-*.json にも残す。
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeSample } from './make-sample.mjs';
import { solveFile } from './solve.mjs';
import { buildSample } from '../app/js/samples.js';
import { isImproved, compareResults } from '../app/js/check.js';

const has = (n) => process.argv.includes(`--${n}`);
const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : f;
};
mkdirSync('tools/out', { recursive: true });

if (has('sizes')) {
  const time = arg('time', 60);
  const rows = [];
  for (const staff of [8, 15, 25, 50]) {
    for (const [year, month] of [[2027, 2], [2026, 11], [2026, 12]]) {
      const d = await makeSample({ seed: staff * 100 + month, staff, year, month });
      d.month.requests = {};
      const r = await solveFile(d, { time });
      const row = {
        staff,
        days: month === 2 ? 28 : month === 11 ? 30 : 31,
        ok: r.solved.ok,
        size: r.solved.size,
        stages: r.solved.stages.map((s) => `${s.name}:${s.status}:${s.seconds}s${s.retried ? ':前処理なしで解き直し' : ''}`),
        totals: r.counted?.totals ?? null,
        same: r.compare ? Object.entries(r.compare.exact).every(([, v]) => v.same) : null,
        seconds: r.solved.seconds,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  writeFileSync('tools/out/bench-sizes.json', JSON.stringify(rows, null, 2));
}

if (has('leader')) {
  const nodes = arg('nodes', 30);
  const weight = arg('weight', 0.3);
  const rows = [];
  for (const kind of ['restaurant', 'retail', 'care']) {
    for (const seed of [1, 2, 3]) {
      const d = buildSample(kind, 2026, 11);
      const a = await solveFile(d, { nodes, seed });
      const b = await solveFile(d, { nodes, seed, leaderWeight: weight });
      const row = {
        kind,
        seed,
        without: { leaderRank: a.counted.byRule.leaderRank.count, hard: a.counted.totals.hard, soft: a.counted.totals.soft, six: a.counted.totals.sixPlus },
        with: { leaderRank: b.counted.byRule.leaderRank.count, hard: b.counted.totals.hard, soft: b.counted.totals.soft, six: b.counted.totals.sixPlus },
        improved: isImproved(a.counted, b.counted),
        betterOrSame: compareResults(b.counted, a.counted) <= 0,
        switchApprox: { without: a.compare.approx, with: b.compare.approx },
      };
      rows.push(row);
      console.log(JSON.stringify({ kind, seed, without: row.without, with: row.with, improved: row.improved, betterOrSame: row.betterOrSame }));
    }
  }
  writeFileSync('tools/out/bench-leader.json', JSON.stringify(rows, null, 2));
}

if (has('exact')) {
  const months = arg('months', 20);
  const nodes = arg('nodes', 20);
  const rows = [];
  const tally = { months: 0, solved: 0, exactDiff: {}, approx: {} };
  for (let seed = 1; seed <= months; seed += 1) {
    const d = await makeSample({ seed, staff: 6 + (seed % 20) });
    const r = await solveFile(d, { nodes });
    tally.months += 1;
    if (!r.solved.ok) {
      rows.push({ seed, ok: false, reason: r.solved.reason });
      continue;
    }
    tally.solved += 1;
    for (const [k, v] of Object.entries(r.compare.exact)) if (!v.same) tally.exactDiff[k] = (tally.exactDiff[k] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.compare.approx)) {
      if (v.solver === null) continue;
      const t = (tally.approx[k] ??= { months: 0, solver: 0, check: 0, differentMonths: 0 });
      t.months += 1;
      t.solver += v.solver;
      t.check += v.check;
      if (v.solver !== v.check) t.differentMonths += 1;
    }
    rows.push({ seed, ok: true, staff: d.staff.length, exact: r.compare.exact, approx: r.compare.approx });
  }
  writeFileSync('tools/out/bench-exact.json', JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(tally));
}
