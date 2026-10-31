// 1分で作るの設定を比べる道具（3-3。決め方は CLAUDE.md の「1分の設定」）。作り物のデータだけ。
// 使い方: node tools/compare-settings.mjs [--jobs 8] [--runs 3]
//   A：いま（stages.js の決めたとおり）
//   C：「できれば」の段だけはじめの答えを渡す＋HiGHS の解の探し方 1（--soft-warm on --soft-effort 1）
// 動かすもの（tools/solve.mjs を別のプロセスで、A と C を交互に）:
//   見本3つ × 2026年11月〜2027年10月 × 60秒を --runs 回／作り物の月 12通り（solve-bench --sizes と同じ）× 60秒を --runs 回／
//   見本3つ × 12か月 × 20秒を1回（段1〜5 が解ききるか）
// 結果は tools/out/cmp/summary.json。決め方の (1)(2)(3) と 20秒の段を、合う・合わないで出す。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildSample } from '../app/js/samples.js';
import { canonicalJSON } from '../app/js/model.js';
import { makeSample } from './make-sample.mjs';
import { ROOT } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const jobs = Number(argOf('jobs', 8));
const runs = Number(argOf('runs', 3));
const OUT = join(ROOT, 'tools', 'out', 'cmp');
mkdirSync(OUT, { recursive: true });
const CONFIGS = { A: [], C: ['--soft-warm', 'on', '--soft-effort', '1'] };
const KINDS = ['restaurant', 'retail', 'care'];
const MONTHS = Array.from({ length: 12 }, (_, i) => [2026 + Math.floor((10 + i) / 12), ((10 + i) % 12) + 1]);

const items = [];
for (const kind of KINDS) {
  for (const [y, m] of MONTHS) {
    const file = join(OUT, `sample-${kind}-${y}-${m}.json`);
    writeFileSync(file, canonicalJSON(buildSample(kind, y, m)));
    items.push({ group: 'sample', id: `${kind} ${y}-${m}`, file });
  }
}
for (const staff of [8, 15, 25, 50]) {
  for (const [y, m] of [[2027, 2], [2026, 11], [2026, 12]]) {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    d.month.requests = {};
    const file = join(OUT, `made-${staff}-${y}-${m}.json`);
    writeFileSync(file, canonicalJSON(d));
    items.push({ group: 'made', id: `${staff}人 ${y}-${m}`, file });
  }
}

const tasks = [];
for (const it of items) {
  for (let r = 1; r <= runs; r += 1) {
    for (const c of Object.keys(CONFIGS)) tasks.push({ ...it, config: c, run: r, time: 60 });
  }
}
for (const it of items.filter((x) => x.group === 'sample')) {
  for (const c of Object.keys(CONFIGS)) tasks.push({ ...it, config: c, run: 1, time: 20 });
}

function runTask(t) {
  const out = join(OUT, 'runs', `${t.config}-${t.time}-${t.run}-${t.id.replace(/[^\w-]/g, '_')}`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'tools', 'solve.mjs'), t.file, '--time', String(t.time), ...CONFIGS[t.config], '--out', out], { stdio: 'ignore' });
    p.on('close', () => {
      const cf = join(out, 'count.json');
      const c = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8')) : null;
      const st = JSON.parse(readFileSync(join(out, 'stages.json'), 'utf8'));
      const hard = {};
      if (c) for (const [k, v] of Object.entries(c.byRule)) if (v.strength === 'hard' || v.strength === 'always') hard[k] = { count: v.count, amount: v.amount };
      resolve({ ...t, totals: c?.totals ?? null, hard, stages: st.stages.map((s) => ({ key: s.key, status: s.status })) });
    });
  });
}

const results = [];
let next = 0;
let done = 0;
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
  while (next < tasks.length) {
    const t = tasks[next];
    next += 1;
    results.push(await runTask(t));
    done += 1;
    if (done % 24 === 0) console.log(`${done}/${tasks.length}`);
  }
}));

const find = (config, it, run, time) => results.find((r) => r.config === config && r.id === it.id && r.run === run && r.time === time);
const report = { rule1: [], rule2: [], rule2CountsDiffer: [], soft: { A: 0, C: 0 }, time20NotSolved: [], noAnswer: [] };
for (const it of items) {
  for (let r = 1; r <= runs; r += 1) {
    const a = find('A', it, r, 60);
    const c = find('C', it, r, 60);
    if (!a.totals || !c.totals) {
      report.noAnswer.push(`${it.id} ${r}回目`);
      continue;
    }
    report.soft.A += a.totals.soft / runs;
    report.soft.C += c.totals.soft / runs;
    if (c.totals.sixPlus > a.totals.sixPlus) (it.group === 'sample' ? report.rule1 : report.rule2).push(`${it.id} ${r}回目 6連勤以上 ${a.totals.sixPlus}→${c.totals.sixPlus}`);
    for (const k of Object.keys(a.hard)) {
      if (k === 'sixPlus') continue;
      if (it.group === 'sample' && c.hard[k].count > a.hard[k].count) report.rule1.push(`${it.id} ${r}回目 ${k} 件数 ${a.hard[k].count}→${c.hard[k].count}`);
      if (it.group === 'made') {
        if (c.hard[k].amount > a.hard[k].amount + 1e-9) report.rule2.push(`${it.id} ${r}回目 ${k} 量 ${a.hard[k].amount}→${c.hard[k].amount}`);
        else if (c.hard[k].count !== a.hard[k].count) report.rule2CountsDiffer.push(`${it.id} ${r}回目 ${k} 件数 ${a.hard[k].count}→${c.hard[k].count}（量 ${a.hard[k].amount}→${c.hard[k].amount}）`);
      }
    }
  }
}
for (const r of results.filter((x) => x.time === 20)) {
  const bad = r.stages.filter((s) => s.key !== 'soft' && s.status !== 'solved');
  if (bad.length) report.time20NotSolved.push(`${r.config} ${r.id} ${bad.map((s) => `${s.key}:${s.status}`).join(',')}`);
}
report.soft.A = Math.round(report.soft.A * 10) / 10;
report.soft.C = Math.round(report.soft.C * 10) / 10;
const pass = !report.rule1.length && !report.rule2.length && report.soft.C < report.soft.A && !report.time20NotSolved.some((x) => x.startsWith('C '));
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ jobs, runs, report, pass, results }, null, 2));
console.log(JSON.stringify({ ...report, rule2CountsDiffer: report.rule2CountsDiffer.length, 'C を採る': pass }, null, 2));
if (report.rule2CountsDiffer.length) for (const x of report.rule2CountsDiffer.slice(0, 20)) console.log(`  件数だけ違う：${x}`);
