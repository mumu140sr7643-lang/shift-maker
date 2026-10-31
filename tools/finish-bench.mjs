// 仕上げの入れ替えを測る道具（docs/じっくり作る案.md の 5 章 B）。作り物のデータだけ。
// 使い方: node tools/finish-bench.mjs [--jobs 8] [--runs 3] [--time 60] [--seconds 25] [--reuse]
//   見本3つ × 2026年11月〜2027年10月 と、作り物の月 12通り（solve-bench --sizes と同じ）を、1分で作り（tools/solve.mjs --time 60）、
//   できた表を保存して、仕上げる（tools/finish.mjs --seconds 25）。--reuse なら、保存した1分の答えを使い直す（仕上げだけやり直す）。
// 決め方（測る前に決めた）：確かめ（verifyFinish）の問題 0 が必須。できれば が平均1件以上減り、かつ半分以上の表で減れば、じっくり作るで使う。
// 結果は tools/out/finish-bench/summary.json。
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
const time = argOf('time', '60');
const seconds = argOf('seconds', '25');
const reuse = process.argv.includes('--reuse');
const OUT = join(ROOT, 'tools', 'out', 'finish-bench');
mkdirSync(OUT, { recursive: true });

const items = [];
for (const kind of ['restaurant', 'retail', 'care']) {
  for (let i = 0; i < 12; i += 1) {
    const y = 2026 + Math.floor((10 + i) / 12);
    const m = ((10 + i) % 12) + 1;
    const file = join(OUT, `sample-${kind}-${y}-${m}.json`);
    writeFileSync(file, canonicalJSON(buildSample(kind, y, m)));
    items.push({ group: 'sample', kind, id: `${kind}-${y}-${m}`, file });
  }
}
for (const staff of [8, 15, 25, 50]) {
  for (const [y, m] of [[2027, 2], [2026, 11], [2026, 12]]) {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    d.month.requests = {};
    const file = join(OUT, `made-${staff}-${y}-${m}.json`);
    writeFileSync(file, canonicalJSON(d));
    items.push({ group: 'made', kind: `${staff}人`, id: `made-${staff}-${y}-${m}`, file });
  }
}
const tasks = items.flatMap((it) => Array.from({ length: runs }, (_, r) => ({ ...it, run: r + 1 })));

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'ignore' });
  p.on('close', resolve);
});

async function one(t) {
  const dir = join(OUT, `${t.id}-run${t.run}`);
  const made = join(dir, 'result.json');
  if (!reuse || !existsSync(made)) await runNode([join(ROOT, 'tools', 'solve.mjs'), t.file, '--time', time, '--out', dir]);
  if (!existsSync(made)) return { ...t, made: false };
  await runNode([join(ROOT, 'tools', 'finish.mjs'), made, '--seconds', seconds, '--out', dir]);
  const f = join(dir, 'finish.json');
  return { ...t, made: true, finish: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null };
}

const results = [];
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
  while (next < tasks.length) {
    const t = tasks[next];
    next += 1;
    results.push(await one(t));
    if (results.length % 12 === 0) console.log(`${results.length}/${tasks.length}（${Math.round((Date.now() - t0) / 1000)}秒）`);
  }
}));

const done = results.filter((r) => r.finish);
const groupOf = (r) => r.kind;
const rows = {};
for (const r of done) {
  const g = (rows[groupOf(r)] ??= { tables: 0, softBefore: 0, softAfter: 0, less: 0, moves: 0, hardUp: 0, sixUp: 0, problems: 0, maxSeconds: 0, ends: {} });
  const f = r.finish;
  g.tables += 1;
  g.softBefore += f.before.soft;
  g.softAfter += f.after.soft;
  if (f.after.soft < f.before.soft) g.less += 1;
  g.moves += f.moves.length;
  if (f.after.hard > f.before.hard) g.hardUp += 1;
  if (f.after.sixPlus > f.before.sixPlus) g.sixUp += 1;
  g.problems += f.problems.length;
  g.maxSeconds = Math.max(g.maxSeconds, f.seconds);
  g.ends[f.end] = (g.ends[f.end] ?? 0) + 1;
}
const total = Object.values(rows).reduce((a, g) => ({ tables: a.tables + g.tables, softBefore: a.softBefore + g.softBefore, softAfter: a.softAfter + g.softAfter, less: a.less + g.less, problems: a.problems + g.problems }), { tables: 0, softBefore: 0, softAfter: 0, less: 0, problems: 0 });
const avgDrop = total.tables ? (total.softBefore - total.softAfter) / total.tables : 0;
const adopt = total.problems === 0 && avgDrop >= 1 && total.less * 2 > total.tables;
const summary = {
  jobs, runs, time, seconds,
  rows: Object.entries(rows).map(([k, g]) => ({ group: k, ...g, softAvg: `${(g.softBefore / g.tables).toFixed(1)} → ${(g.softAfter / g.tables).toFixed(1)}` })),
  total: { ...total, avgDrop: Math.round(avgDrop * 10) / 10 },
  adopt,
  failed: results.filter((r) => !r.finish).map((r) => `${r.id} run${r.run}`),
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
for (const r of summary.rows) console.log(`${r.group}: 表 ${r.tables}・できれば ${r.softAvg}（減った表 ${r.less}）・入れ替え ${r.moves}・絶対が増えた表 ${r.hardUp}・6連勤以上が増えた表 ${r.sixUp}・問題 ${r.problems}・いちばん長い ${r.maxSeconds}秒・止まった理由 ${JSON.stringify(r.ends)}`);
console.log(`全部：表 ${total.tables}・できれば 平均 ${avgDrop.toFixed(1)}件減・減った表 ${total.less}・問題 ${total.problems} → ${adopt ? '使う' : '使わない（相談）'}`);
console.log(`作れなかった・仕上げられなかった: ${summary.failed.length}`);
