// 自動で作るの速さと、決まりの式の試しを測る道具（作り物のデータだけ）。
// 使い方:
//   node tools/solve-bench.mjs --sizes [--time 60] [--cold | --warm] [--run 1]
//       8・15・25・50人 × 28・30・31日 の作り物の月を、画面と同じ1分の区切りで作り、段ごとの秒と結果を出す
//   node tools/solve-bench.mjs --leader [--nodes 30] [--weight 0.3]
//       責任者の順位を近づける軽い式の試し：見本3つ × 種1・2・3 を、式あり・なしで作り、件数を比べる
//   node tools/solve-bench.mjs --exact [--months 20] [--nodes 20]
//       作り物の月（希望あり）を作り、段の量と check.js の量を比べる（同じになるはずのもの・近い形のもの）
//   node tools/solve-bench.mjs --presolve [--months 80] [--nodes 2000]
//       HiGHS の前処理の設定ごとに、乱数の月（solve-stress と同じ）の段1〜5 を解き、段ごとの「解ききった」量を比べる。
//       正しく解ききったなら、どの設定でも量は同じになるはず。前の段までが同じ設定のうち、いちばん小さい量より大きいものを「まちがい」と数える
// 結果は tools/out/bench-*.json にも残す。
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeSample } from './make-sample.mjs';
import { solveFile } from './solve.mjs';
import { buildSample } from '../app/js/samples.js';
import { isImproved, compareResults, checkTable } from '../app/js/check.js';
import { stressData } from './solve-stress.mjs';
import { solveStaged } from '../app/js/solver/stages.js';
import { clone } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

const has = (n) => process.argv.includes(`--${n}`);
const arg = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? Number(process.argv[i + 1]) : f;
};
mkdirSync('tools/out', { recursive: true });

if (has('sizes')) {
  const time = arg('time', 60);
  const warmStart = has('cold') ? false : has('warm') ? true : undefined;
  const tag = has('cold') ? '-cold' : has('warm') ? '-warm' : '';
  const run = arg('run', 1);
  const rows = [];
  for (const staff of [8, 15, 25, 50]) {
    for (const [year, month] of [[2027, 2], [2026, 11], [2026, 12]]) {
      const d = await makeSample({ seed: staff * 100 + month, staff, year, month });
      d.month.requests = {};
      const r = await solveFile(d, { time, warmStart });
      const row = {
        staff,
        days: month === 2 ? 28 : month === 11 ? 30 : 31,
        ok: r.solved.ok,
        size: r.solved.size,
        stages: r.solved.stages.map((s) => `${s.name}:${s.status}:${s.seconds}s${s.retried ? ':前処理なしで解き直し' : ''}`),
        totals: r.counted?.totals ?? null,
        hardByRule: r.counted ? Object.fromEntries(Object.entries(r.counted.byRule).filter(([, v]) => v.strength === 'hard' || v.strength === 'always').map(([k, v]) => [k, v.count])) : null,
        same: r.compare ? Object.entries(r.compare.exact).every(([, v]) => v.same) : null,
        seconds: r.solved.seconds,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  writeFileSync(`tools/out/bench-sizes${tag}-${run}.json`, JSON.stringify(rows, null, 2));
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

if (has('presolve')) {
  const months = arg('months', 80);
  const nodes = arg('nodes', 2000);
  const configs = {
    はじめの答えあり: { warmStart: true },
    はじめの答えなし: { warmStart: false },
    前処理そのまま・答えなし: { presolveRuleOff: 0, warmStart: false },
  };
  const tally = Object.fromEntries(Object.keys(configs).map((k) => [k, { まちがい: 0, 解き直し: 0, 前の段のまま: 0, まずい表: 0, 秒: 0 }]));
  const wrongs = [];
  let solvedMonths = 0;
  for (let seed = 1; seed <= months; seed += 1) {
    const d = await stressData(seed);
    const res = {};
    for (const [k, c] of Object.entries(configs)) {
      const t = Date.now();
      res[k] = await solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: nodes, seed: 1, maxStages: 5, ...c });
      tally[k].秒 += (Date.now() - t) / 1000;
    }
    if (!res.はじめの答えあり.ok) continue;
    solvedMonths += 1;
    let track = Object.keys(configs).filter((k) => res[k].ok);
    for (let i = 0; i < res.はじめの答えあり.stages.length; i += 1) {
      const solved = track.filter((k) => res[k].stages[i]?.status === 'solved');
      if (!solved.length) break;
      const ref = Math.min(...solved.map((k) => res[k].stages[i].value));
      for (const k of solved) {
        const s = res[k].stages[i];
        if (s.value > ref + 1e-4) {
          tally[k].まちがい += 1;
          wrongs.push({ seed, config: k, stage: s.key, value: s.value, best: ref });
        }
      }
      track = solved.filter((k) => res[k].stages[i].value <= ref + 1e-4);
    }
    for (const [k, r] of Object.entries(res)) {
      if (!r.ok) {
        tally[k].まずい表 += 1;
        continue;
      }
      if (r.stages.some((s) => s.retried)) tally[k].解き直し += 1;
      if (r.stages.some((s) => s.suspect)) tally[k].前の段より悪いのに解ききった = (tally[k].前の段より悪いのに解ききった ?? 0) + 1;
      if (r.stages.some((s) => s.status === 'kept')) tally[k].前の段のまま += 1;
      const a = clone(d);
      a.month.table = r.table;
      const c = checkTable(a);
      if (['notAssigned', 'requestDiff', 'dailySkill', 'nightNext'].some((x) => c.byRule[x].count)) tally[k].まずい表 += 1;
    }
  }
  for (const t of Object.values(tally)) t.秒 = Math.round(t.秒 * 10) / 10;
  writeFileSync('tools/out/bench-presolve.json', JSON.stringify({ solvedMonths, tally, wrongs }, null, 2));
  for (const w of wrongs) console.log(JSON.stringify(w));
  console.log(JSON.stringify({ 解けた月: solvedMonths, tally }));
}
