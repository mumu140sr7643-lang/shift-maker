// 仕上げの入れ替え（6-1。docs/じっくり作る案.md の 3 章）の確かめ。作り物のデータだけ。
// 使い方: node tools/finish-stress.mjs [--months 60] [--solved 12] [--checks 3000] [--nodes 20]
//   乱数の月（表あり）に乱数の手直しをした表（tools/repair-stress.mjs の messyMonth）を --months 個と、
//   作り物の月を自動で作った表（調べる数 --nodes）を --solved 個、仕上げる（数える回数の上限 --checks。時間では区切らない）。
//   どれも tools/finish.mjs の verifyFinish（変えないもの・動かさないマス・担当とスキル・1つずつの「改善」と並べる順・
//   6連勤以上を作らない／長くしない／つなげない）を通ること、もう一度仕上げても1文字も同じこと、もとのデータを変えないことを確かめる。
import { pathToFileURL } from 'node:url';
import { makeSample } from './make-sample.mjs';
import { messyMonth } from './repair-stress.mjs';
import { verifyFinish } from './finish.mjs';
import { finishTable } from '../app/js/solver/finish.js';
import { solveStaged } from '../app/js/solver/stages.js';
import { canonicalJSON } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

// 1つの表を仕上げて確かめる。返す：{ moves, soft: [前, 後], hard: [前, 後], end, problems }
export function stressOne(data, maxChecks) {
  const text = canonicalJSON(data);
  const r1 = finishTable(data, { seconds: null, maxChecks });
  const problems = verifyFinish(data, r1);
  if (canonicalJSON(data) !== text) problems.push('仕上げで、もとのデータが変わった');
  const r2 = finishTable(data, { seconds: null, maxChecks });
  if (canonicalJSON(r2.table) !== canonicalJSON(r1.table) || JSON.stringify(r2.moves) !== JSON.stringify(r1.moves)) problems.push('同じ表をもう一度仕上げたら、答えが違った');
  return { moves: r1.moves.length, soft: [r1.before.soft, r1.after.soft], hard: [r1.before.hard, r1.after.hard], six: [r1.before.sixPlus, r1.after.sixPlus], end: r1.end, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const months = arg('months', 60);
  const solved = arg('solved', 12);
  const maxChecks = arg('checks', 3000);
  const nodes = arg('nodes', 20);
  const rows = [];
  for (let seed = 1; seed <= months; seed += 1) rows.push({ id: `手直しの月 ${seed}`, ...stressOne(await messyMonth(seed), maxChecks) });
  for (let seed = 1; seed <= solved; seed += 1) {
    const d = await makeSample({ seed: 500 + seed, staff: 6 + ((seed * 7) % 30) });
    const res = await solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: nodes, seed: 1 });
    if (!res.ok) {
      rows.push({ id: `作った月 ${seed}`, skipped: res.reason, problems: [] });
      continue;
    }
    d.month.table = res.table;
    rows.push({ id: `作った月 ${seed}`, ...stressOne(d, maxChecks) });
  }
  const done = rows.filter((r) => !r.skipped);
  const sum = (f) => done.reduce((a, r) => a + f(r), 0);
  console.log(`仕上げた表 ${done.length}（作れなかった月 ${rows.length - done.length}）・入れた入れ替え ${sum((r) => r.moves)}`);
  console.log(`6連勤以上 ${sum((r) => r.six[0])} → ${sum((r) => r.six[1])}・絶対 ${sum((r) => r.hard[0])} → ${sum((r) => r.hard[1])}・できれば ${sum((r) => r.soft[0])} → ${sum((r) => r.soft[1])}`);
  console.log(`止まった理由：${Object.entries(done.reduce((a, r) => ({ ...a, [r.end]: (a[r.end] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join('・')}`);
  const bad = rows.filter((r) => r.problems.length);
  for (const r of bad) console.log(`× ${r.id}：${r.problems.slice(0, 3).join(' / ')}`);
  console.log(bad.length ? `問題のあった表 ${bad.length}` : '問題 0');
  process.exit(bad.length ? 1 : 0);
}
