// 測り D（docs/じっくり作る案.md の 5 章）：careful-bench.mjs で保存した全部の答えから、候補の組み合わせを変えて選び直す。走らせ直さない。
// 使い方: node tools/careful-pick.mjs [--dir tools/out/careful-bench] [--conf W4] [--memory 16]
//   組み合わせ（あ はいつも入れる）ごとに、選んだ答えが、全部の候補で選んだ答えより並べる順で悪くなった回の数を出す。
//   あわせて、候補ごとに「ほかのどの候補より並べる順で良い答えを出した回」の数（1割＝54回中 6回以上なら残す）。
//   使う人の動き（2026-10-31 確かめ役と決めた報告の順）：1本（あ だけ）・2本（あ＋い）・あ＋（ほかのどの候補より良い回がいちばん多い候補）・4本 で選び直し、
//   その回の1分の答えとの比べ・何も動かしていないときの1分（careful-bench の H。月ごとに3回）との比べ・6連勤以上/絶対/できれば の平均・4本との差 を出す。
//   このパソコンで決まる本数（careful.js の workerCount。CPU の数はこのパソコン、deviceMemory は --memory。このパソコンのブラウザは 16 と言う）が
//   4本より少ない月は、画面と同じく上から順の候補（CANDIDATES の先頭からその本数）だけで選び直し、4本との差を月ごとに出す
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { parseData } from '../app/js/storage.js';
import { checkTable, compareResults } from '../app/js/check.js';
import { monthDays } from '../app/js/model.js';
import { CANDIDATES, workerCount } from '../app/js/solver/careful.js';
import { ROOT } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const DIR = argOf('dir', join(ROOT, 'tools', 'out', 'careful-bench'));
const CONF = argOf('conf', 'W4');
const MEMORY = Number(argOf('memory', 16));
const ALL = CANDIDATES.map((c) => c.id);

// 保存した答えを読む：回ごとに、全部の答え（件数つき）・その回の1分の答え・同じ月の何も動かしていないときの1分（3回）
const runs = [];
const months = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'summary.json' && !x.startsWith('meta-'))) {
  const id = f.replace(/\.json$/, '');
  const data = parseData(readFileSync(join(DIR, f), 'utf8')).data;
  const resOf = (table) => checkTable({ ...data, month: { ...data.month, table } });
  const H = [1, 2, 3].map((q) => join(DIR, id, `H-r${q}`, 'result.json')).filter(existsSync).map((p) => checkTable(parseData(readFileSync(p, 'utf8')).data));
  const n = workerCount({ cpus: cpus().length, memory: MEMORY, touchOnly: false, cells: data.staff.length * monthDays(data) });
  months.push({ id, workers: n });
  for (const r of [1, 2, 3]) {
    const ans = join(DIR, id, `${CONF}-r${r}`, 'answers.json');
    if (!existsSync(ans)) continue;
    const answers = JSON.parse(readFileSync(ans, 'utf8')).map((a) => ({ ...a, res: resOf(a.table) }));
    runs.push({ id, r, answers, quick: answers.find((a) => a.label === 'quick')?.res ?? null, H, workers: n });
  }
}
const pickFrom = (run, roles) => run.answers.filter((a) => roles.includes(a.role)).reduce((b, a) => (!b || compareResults(a.res, b.res) < 0 ? a : b), null);

// D：ほかのどの候補より良い答えを出した回
const wins = {};
for (const run of runs) {
  const bestOf = {};
  for (const a of run.answers) if (!bestOf[a.role] || compareResults(a.res, bestOf[a.role].res) < 0) bestOf[a.role] = a;
  for (const role of Object.keys(bestOf)) if (Object.keys(bestOf).every((o) => o === role || compareResults(bestOf[role].res, bestOf[o].res) < 0)) wins[role] = (wins[role] ?? 0) + 1;
}
console.log(`回 ${runs.length}`);
console.log(`ほかのどの候補より良い答えを出した回：${CANDIDATES.map((c) => `${c.id} ${wins[c.id] ?? 0}`).join('・')}（残すのは ${Math.ceil(runs.length / 10)}回以上）`);

// 組み合わせごとに、全部の候補で選んだ答えより悪くなった回
const others = ALL.filter((id) => id !== 'a');
for (let mask = 0; mask < 1 << others.length; mask += 1) {
  const s = ['a', ...others.filter((_, i) => mask & (1 << i))];
  let worse = 0;
  for (const run of runs) {
    const p = pickFrom(run, s);
    const full = pickFrom(run, ALL);
    if (!p || !full || compareResults(p.res, full.res) > 0) worse += 1;
  }
  console.log(`  ${s.join('+')}：全部の候補より悪くなった回 ${worse}・同じ ${runs.length - worse}`);
}

// 使う人の動き：組み合わせで選び直した答えを、1分の答え・何も動かしていないときの1分と比べる
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const avgOf = (list) => ({ six: avg(list.map((x) => x.totals.sixPlus)), hard: avg(list.map((x) => x.totals.hard)), soft: avg(list.map((x) => x.totals.soft)) });
function evaluate(roles) {
  const o = { roles: roles.join('+'), runs: 0, vsQuick: { better: 0, same: 0, worse: 0 }, vsH: { pairs: 0, better: 0, same: 0, worse: 0 }, worseThanFull: 0 };
  const picked = [];
  const quick = [];
  const hs = [];
  for (const run of runs) {
    const p = pickFrom(run, roles);
    if (!p) continue;
    o.runs += 1;
    picked.push(p.res);
    if (run.quick) {
      quick.push(run.quick);
      const k = compareResults(p.res, run.quick);
      o.vsQuick[k < 0 ? 'better' : k > 0 ? 'worse' : 'same'] += 1;
    }
    for (const h of run.H) {
      o.vsH.pairs += 1;
      const k = compareResults(p.res, h);
      o.vsH[k < 0 ? 'better' : k > 0 ? 'worse' : 'same'] += 1;
    }
    const full = pickFrom(run, ALL);
    if (full && compareResults(p.res, full.res) > 0) o.worseThanFull += 1;
  }
  for (const run of runs) hs.push(...run.H);
  o.avg = { picked: avgOf(picked), quick: avgOf(quick), H: avgOf(hs) };
  return o;
}
const topOther = others.reduce((b, id) => ((wins[id] ?? 0) > (wins[b] ?? 0) ? id : b), others[0]);
const sets = [['a'], ['a', 'i'], ...(topOther !== 'i' ? [['a', topOther]] : []), ALL];
const full = evaluate(ALL);
const label = { [`a+${topOther}`]: `あ＋${topOther}（ほかより良い回がいちばん多い候補）`, a: '1本（あ だけ）', 'a+i': `2本（あ＋い${topOther === 'i' ? '。ほかより良い回がいちばん多い候補も い' : ''}）`, [ALL.join('+')]: '4本' };
console.log(`使う人の動き（選び直し。何も動かしていないときの1分は 1か月 3回 × 回）：`);
for (const s of sets) {
  const e = evaluate(s);
  const diff = (k) => (e.avg.picked[k] !== null && full.avg.picked[k] !== null ? Math.round((full.avg.picked[k] - e.avg.picked[k]) * 10) / 10 : null);
  console.log(`  ${label[e.roles] ?? e.roles}：回 ${e.runs}・1分の答えより 良い ${e.vsQuick.better}・同じ ${e.vsQuick.same}・悪い ${e.vsQuick.worse}・何も動かしていないときの1分より 良い ${e.vsH.better}・同じ ${e.vsH.same}・悪い ${e.vsH.worse}（組 ${e.vsH.pairs}）・4本より悪い ${e.worseThanFull}`);
  console.log(`    平均（6連勤以上/絶対/できれば）：選んだ答え ${e.avg.picked.six}/${e.avg.picked.hard}/${e.avg.picked.soft}・1分の答え ${e.avg.quick.six}/${e.avg.quick.hard}/${e.avg.quick.soft}・何も動かしていないときの1分 ${e.avg.H.six}/${e.avg.H.hard}/${e.avg.H.soft}・4本との差（4本 − これ）${diff('six')}/${diff('hard')}/${diff('soft')}`);
}

// このパソコンで決まる本数で選び直す
const fewer = months.filter((x) => x.workers < CANDIDATES.length);
console.log(`このパソコン（CPU ${cpus().length}・deviceMemory ${MEMORY}）で決まる本数が4本より少ない月：${fewer.length}／${months.length}`);
let worseSum = 0;
let sameSum = 0;
for (const m of fewer) {
  const mine = runs.filter((run) => run.id === m.id);
  const worse = mine.filter((run) => {
    const p = pickFrom(run, ALL.slice(0, m.workers));
    const f = pickFrom(run, ALL);
    return !p || !f || compareResults(p.res, f.res) > 0;
  }).length;
  worseSum += worse;
  sameSum += mine.length - worse;
  console.log(`  ${m.id}：${m.workers}本（${ALL.slice(0, m.workers).join('+')}）・4本より悪くなった回 ${worse}・同じ ${mine.length - worse}`);
}
console.log(`  合わせて 4本より悪くなった回 ${worseSum}・同じ ${sameSum}`);
