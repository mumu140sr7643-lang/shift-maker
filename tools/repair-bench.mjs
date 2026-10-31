// エラーを自動で直すを測る道具（docs/自動で直す案.md の 3 章）。作り物のデータだけ。
// 使い方: node tools/repair-bench.mjs [--jobs 8] [--time 60] [--each 15]
//   見本3つ × 2026年11月〜2027年10月 と、作り物の月 12通り（solve-bench --sizes と同じ）を、1分で作り（tools/solve.mjs --time 60）、
//   できた表に「エラーを自動で直す」を当てる（tools/repair.mjs --time 15）。上限ごとに、案が出た割合（改善した案）・件数の減り方・秒を数える。
// 結果は tools/out/repair-bench/summary.json。
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
const time = argOf('time', '60');
const each = argOf('each', '15');
const OUT = join(ROOT, 'tools', 'out', 'repair-bench');
mkdirSync(OUT, { recursive: true });

const items = [];
for (const kind of ['restaurant', 'retail', 'care']) {
  for (let i = 0; i < 12; i += 1) {
    const y = 2026 + Math.floor((10 + i) / 12);
    const m = ((10 + i) % 12) + 1;
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

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'ignore' });
  p.on('close', resolve);
});

async function one(it) {
  const dir = join(OUT, it.id.replace(/[^\w-]/g, '_'));
  await runNode([join(ROOT, 'tools', 'solve.mjs'), it.file, '--time', time, '--out', dir]);
  const made = join(dir, 'result.json');
  if (!existsSync(made)) return { ...it, made: false };
  await runNode([join(ROOT, 'tools', 'repair.mjs'), made, '--time', each, '--out', dir]);
  const rf = join(dir, 'repair.json');
  return { ...it, made: true, repair: existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null };
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
  while (next < items.length) {
    const it = items[next];
    next += 1;
    results.push(await one(it));
    if (results.length % 8 === 0) console.log(`${results.length}/${items.length}`);
  }
}));

const name = (b) => (b === null ? '全部' : `${b}マスまで`);
const tally = {};
for (const r of results) {
  if (!r.repair?.ok) continue;
  for (const pr of r.repair.proposals) {
    const k = `${r.group}|${name(pr.budget)}`;
    const t = (tally[k] ??= { months: 0, ok: 0, improved: 0, tooMany: 0, noAnswer: 0, changes: 0, hardFrom: 0, hardTo: 0, softFrom: 0, softTo: 0, seconds: 0, timed: 0 });
    t.months += 1;
    if (pr.status === 'too-many') t.tooMany += 1;
    if (pr.status === 'no-answer') t.noAnswer += 1;
    if (pr.status !== 'ok') continue;
    t.ok += 1;
    if (pr.seconds !== undefined) {
      t.seconds += pr.seconds;
      t.timed += 1;
    }
    if (!pr.improved) continue;
    t.improved += 1;
    t.changes += pr.changes.length;
    t.hardFrom += r.repair.before.hard;
    t.hardTo += pr.totals.hard;
    t.softFrom += r.repair.before.soft;
    t.softTo += pr.totals.soft;
  }
}
const rows = Object.entries(tally).map(([k, t]) => {
  const [group, budget] = k.split('|');
  const avg = (x) => (t.improved ? Math.round((x / t.improved) * 10) / 10 : null);
  return {
    group,
    budget,
    months: t.months,
    improved: t.improved,
    tooMany: t.tooMany,
    noAnswer: t.noAnswer,
    avgChanges: avg(t.changes),
    hard: `${avg(t.hardFrom)} → ${avg(t.hardTo)}`,
    soft: `${avg(t.softFrom)} → ${avg(t.softTo)}`,
    avgSeconds: t.timed ? Math.round((t.seconds / t.timed) * 10) / 10 : null,
  };
});
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ jobs, time, each, rows, failed: results.filter((r) => !r.made || !r.repair?.ok).map((r) => r.id) }, null, 2));
for (const r of rows) console.log(JSON.stringify(r));
console.log(`作れなかった・直せなかった月: ${results.filter((r) => !r.made || !r.repair?.ok).length}`);
