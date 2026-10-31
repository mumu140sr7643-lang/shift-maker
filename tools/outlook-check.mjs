// 最低◯件の見込み（5-3）が、作った表の件数を超えないことの確かめ（docs/見込みと説明の案.md の 4-1）。作り物のデータだけ。
// 使い方: node tools/outlook-check.mjs [--stress 200] [--nodes 20]
//   作り物の月 12通り（solve-bench --sizes と同じ）・solve-stress の乱数の月・見本3つ × 2026年11月〜2027年10月 で、
//   見込み（lowerBound）を数え、同じ月を自動で作った表（段1〜5、調べる数 20。希望と固定を守る表）の件数と、決まりごとに比べる。
//   見込み ＞ 作った表の件数 が1つでもあれば、その数え方はまちがい。見込みと同じになった割合も出す。
import { makeSample } from './make-sample.mjs';
import { stressData } from './solve-stress.mjs';
import { buildSample } from '../app/js/samples.js';
import { solveStaged } from '../app/js/solver/stages.js';
import { checkTable } from '../app/js/check.js';
import { lowerBound } from '../app/js/outlook.js';
import { clone } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const nodes = arg('nodes', 20);
const months = [];
for (const staff of [8, 15, 25, 50]) {
  for (const [y, m] of [[2027, 2], [2026, 11], [2026, 12]]) {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    months.push({ id: `作り物 ${staff}人 ${y}-${m}`, data: d });
  }
}
for (let seed = 1; seed <= arg('stress', 200); seed += 1) months.push({ id: `乱数の月 種${seed}`, data: await stressData(seed) });
for (const kind of ['restaurant', 'retail', 'care']) {
  for (let i = 0; i < 12; i += 1) {
    const y = 2026 + Math.floor((10 + i) / 12);
    const m = ((10 + i) % 12) + 1;
    months.push({ id: `見本 ${kind} ${y}-${m}`, data: buildSample(kind, y, m) });
  }
}

const tally = { months: 0, solved: 0, stopped: 0, over: 0, rules: {} };
for (const { id, data } of months) {
  tally.months += 1;
  const res = await solveStaged(data, { loadHighs: () => highsLoader(), nodeLimit: nodes, seed: 1, maxStages: 5 });
  if (!res.ok) {
    tally.stopped += 1;
    continue;
  }
  tally.solved += 1;
  const after = clone(data);
  after.month.table = res.table;
  const got = checkTable(after);
  const lb = lowerBound(data);
  for (const [rule, n] of Object.entries(lb.byRule)) {
    const t = (tally.rules[rule] ??= { months: 0, exact: 0, over: 0 });
    t.months += 1;
    const actual = got.byRule[rule].count;
    if (n === actual) t.exact += 1;
    if (n > actual) {
      t.over += 1;
      tally.over += 1;
      console.log(`${id} ${rule}：見込み ${n} ＞ 作った表 ${actual}`);
    }
  }
}
console.log(JSON.stringify(tally));
process.exit(tally.over ? 1 : 0);
