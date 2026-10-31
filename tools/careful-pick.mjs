// 測り D（docs/じっくり作る案.md の 5 章）：careful-bench.mjs で保存した全部の答えから、候補の組み合わせを変えて選び直す。走らせ直さない。
// 使い方: node tools/careful-pick.mjs [--dir tools/out/careful-bench] [--conf W4]
//   組み合わせ（あ はいつも入れる）ごとに、選んだ答えが、全部の候補で選んだ答えより並べる順で悪くなった回の数を出す。
//   あわせて、候補ごとに「ほかのどの候補より並べる順で良い答えを出した回」の数（1割＝54回中 6回以上なら残す）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseData } from '../app/js/storage.js';
import { checkTable, compareResults } from '../app/js/check.js';
import { CANDIDATES } from '../app/js/solver/careful.js';
import { ROOT } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const DIR = argOf('dir', join(ROOT, 'tools', 'out', 'careful-bench'));
const CONF = argOf('conf', 'W4');

const others = CANDIDATES.map((c) => c.id).filter((id) => id !== 'a');
const subsets = [];
for (let mask = 0; mask < 1 << others.length; mask += 1) subsets.push(['a', ...others.filter((_, i) => mask & (1 << i))]);

const tally = Object.fromEntries(subsets.map((s) => [s.join('+'), { worse: 0, same: 0 }]));
const wins = {};
let runs = 0;
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'summary.json')) {
  const id = f.replace(/\.json$/, '');
  const data = parseData(readFileSync(join(DIR, f), 'utf8')).data;
  const resOf = (table) => checkTable({ ...data, month: { ...data.month, table } });
  for (const r of [1, 2, 3]) {
    const ans = join(DIR, id, `${CONF}-r${r}`, 'answers.json');
    if (!existsSync(ans)) continue;
    runs += 1;
    const answers = JSON.parse(readFileSync(ans, 'utf8')).map((a) => ({ ...a, res: resOf(a.table) }));
    const pickFrom = (roles) => answers.filter((a) => roles.includes(a.role)).reduce((b, a) => (!b || compareResults(a.res, b.res) < 0 ? a : b), null);
    const full = pickFrom(CANDIDATES.map((c) => c.id));
    for (const s of subsets) {
      const p = pickFrom(s);
      const k = p && full ? compareResults(p.res, full.res) : 1;
      if (k > 0) tally[s.join('+')].worse += 1;
      else tally[s.join('+')].same += 1;
    }
    const bestOf = {};
    for (const a of answers) if (!bestOf[a.role] || compareResults(a.res, bestOf[a.role].res) < 0) bestOf[a.role] = a;
    for (const role of Object.keys(bestOf)) if (Object.keys(bestOf).every((o) => o === role || compareResults(bestOf[role].res, bestOf[o].res) < 0)) wins[role] = (wins[role] ?? 0) + 1;
  }
}
console.log(`回 ${runs}`);
console.log(`ほかのどの候補より良い答えを出した回：${CANDIDATES.map((c) => `${c.id} ${wins[c.id] ?? 0}`).join('・')}（残すのは ${Math.ceil(runs / 10)}回以上）`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k}：全部の候補より悪くなった回 ${v.worse}・同じ ${v.same}`);
