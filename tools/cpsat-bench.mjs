// HiGHS の「1分で作る」と CP-SAT を比べる道具（docs/OR-Tools の試し.md の 4 章）。作り物のデータだけ。
// 使い方: node tools/cpsat-bench.mjs [--only H,C8,C4,C1,C8-600,finish,summary] [--months 0-17]
//   18か月（見本3つ × 2026年11月・2027年2月・5月・8月 ＋ 作り物 6通り）を作り、次を回す。答えは全部 tools/out/cpsat-bench/ に残す。
//     H      ：HiGHS の1分で作る（tools/solve.mjs --time 60）× 3回。1つずつ、ほかに何も動かさない
//     C8     ：CP-SAT Worker 8・60秒 × 種 1・2・3。1つずつ、ほかに何も動かさない（決め方に使う）
//     C4     ：Worker 4・60秒 × 種 1・2・3（2つずつ）。C1：Worker 1・60秒 × 1回（8つずつ）。C8-600：Worker 8・600秒 × 1回（1つずつ）
//     finish ：H と C8 の答えに 6-1 の仕上げ（tools/finish.mjs --seconds 25。8つずつ）
//     summary：比べの表（summary.json）。もうある答えは作り直さない（消してから回すと作り直す）
// 決め方（確かめ役が決めた。測る前）：
//   - 月ごとに C8 の3回 × H の3回 の9組（18か月で 162組）。並べる順の、できれば より前の全部（6連勤以上・人員不足・絶対の合計・連勤の超過・公休の不足）で、C8 が悪い組が 0。
//   - できれば：C8 の54回の平均 ≦ H の54回の平均 × 0.8。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildSample } from '../app/js/samples.js';
import { canonicalJSON } from '../app/js/model.js';
import { checkTable, rankKey, compareResults } from '../app/js/check.js';
import { parseData } from '../app/js/storage.js';
import { makeSample } from './make-sample.mjs';
import { ROOT } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const only = argOf('only', 'H,C8,C4,C1,C8-600,finish,summary').split(',');
const OUT = join(ROOT, 'tools', 'out', 'cpsat-bench');
mkdirSync(OUT, { recursive: true });

// 18か月
export async function months18() {
  const list = [];
  for (const kind of ['restaurant', 'retail', 'care']) for (const [y, m] of [[2026, 11], [2027, 2], [2027, 5], [2027, 8]]) list.push({ id: `${kind}-${y}-${m}`, group: kind, data: buildSample(kind, y, m) });
  const made = async (staff, y, m, keepRequests, id) => {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    if (!keepRequests) d.month.requests = {};
    list.push({ id, group: 'made', data: d });
  };
  await made(8, 2027, 2, false, 'made-8-2027-2');
  await made(15, 2026, 11, false, 'made-15-2026-11');
  await made(25, 2026, 12, false, 'made-25-2026-12');
  await made(50, 2026, 12, false, 'made-50-2026-12');
  await made(8, 2026, 11, false, 'short-8-2026-11');
  await made(20, 2027, 5, true, 'request-20-2027-5');
  return list;
}

const range = argOf('months', '0-17').split('-').map(Number);
const all = await months18();
const items = all.slice(range[0], range[1] + 1);
for (const it of all) {
  it.file = join(OUT, `${it.id}.json`);
  writeFileSync(it.file, canonicalJSON(it.data));
}

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'ignore', env: process.env });
  p.on('close', resolve);
});

async function pool(tasks, jobs, fn, label) {
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next];
      next += 1;
      await fn(t);
      done += 1;
      console.log(`${label} ${done}/${tasks.length}（${Math.round((Date.now() - t0) / 1000)}秒）`);
    }
  }));
}

const dirOf = (it, conf, r) => join(OUT, it.id, `${conf}-r${r}`);
const CONFIGS = {
  H: { runs: [1, 2, 3], jobs: 1, args: () => ['--time', '60'], tool: 'solve.mjs' },
  C8: { runs: [1, 2, 3], jobs: 1, args: (r) => ['--workers', '8', '--time', '60', '--seed', String(r)], tool: 'cpsat.mjs' },
  C4: { runs: [1, 2, 3], jobs: 2, args: (r) => ['--workers', '4', '--time', '60', '--seed', String(r)], tool: 'cpsat.mjs' },
  C1: { runs: [1], jobs: 8, args: (r) => ['--workers', '1', '--time', '60', '--seed', String(r)], tool: 'cpsat.mjs' },
  'C8-600': { runs: [1], jobs: 1, args: (r) => ['--workers', '8', '--time', '600', '--seed', String(r)], tool: 'cpsat.mjs' },
};
for (const [conf, c] of Object.entries(CONFIGS)) {
  if (!only.includes(conf)) continue;
  const tasks = items.flatMap((it) => c.runs.map((r) => ({ it, r }))).filter(({ it, r }) => !existsSync(join(dirOf(it, conf, r), 'stages.json')));
  await pool(tasks, c.jobs, ({ it, r }) => runNode([join(ROOT, 'tools', c.tool), it.file, ...c.args(r), '--out', dirOf(it, conf, r)]), conf);
}
if (only.includes('finish')) {
  const tasks = items.flatMap((it) => ['H', 'C8'].flatMap((conf) => [1, 2, 3].map((r) => dirOf(it, conf, r)))).filter((d) => existsSync(join(d, 'result.json')) && !existsSync(join(d, 'finish', 'finished.json')));
  await pool(tasks, 8, (d) => runNode([join(ROOT, 'tools', 'finish.mjs'), join(d, 'result.json'), '--seconds', '25', '--out', join(d, 'finish')]), '仕上げ');
}

if (only.includes('summary')) {
  const load = (file) => {
    if (!existsSync(file)) return null;
    const r = parseData(readFileSync(file, 'utf8'));
    return r.error ? null : checkTable(r.data);
  };
  const resOf = (it, conf, r, finished = false) => load(finished ? join(dirOf(it, conf, r), 'finish', 'finished.json') : join(dirOf(it, conf, r), 'result.json'));
  const info = (it, conf, r) => {
    const f = join(dirOf(it, conf, r), 'stages.json');
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  };
  const heavy = (a, b) => {
    const ka = rankKey(a).slice(0, 5);
    const kb = rankKey(b).slice(0, 5);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };
  const totals = (res) => (res ? `${res.totals.sixPlus}/${res.totals.hard}/${res.totals.soft}` : '作れない');
  const compareSet = (cConf, finished) => {
    const out = { pairs: 0, heavyWorse: 0, better: 0, same: 0, worse: 0, missing: 0, softC: [], softH: [], months: [] };
    for (const it of items) {
      const hs = [1, 2, 3].map((r) => resOf(it, 'H', r, finished));
      const cs = [1, 2, 3].map((r) => resOf(it, cConf, r, finished));
      for (const c of cs) {
        if (!c) out.missing += 1;
        else out.softC.push(c.totals.soft);
      }
      for (const h of hs) if (h) out.softH.push(h.totals.soft);
      for (const c of cs) {
        for (const h of hs) {
          if (!c || !h) continue;
          out.pairs += 1;
          if (heavy(c, h) > 0) out.heavyWorse += 1;
          const k = compareResults(c, h);
          if (k < 0) out.better += 1;
          else if (k > 0) out.worse += 1;
          else out.same += 1;
        }
      }
      const okC = cs.filter(Boolean).sort(compareResults);
      const okH = hs.filter(Boolean).sort(compareResults);
      out.months.push({
        id: it.id,
        H: hs.map(totals),
        C: cs.map(totals),
        cWorstVsHBest: okC.length && okH.length ? Math.sign(compareResults(okC[okC.length - 1], okH[0])) : null,
      });
    }
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    out.softAvgC = avg(out.softC);
    out.softAvgH = avg(out.softH);
    out.adopt = out.missing === 0 && out.heavyWorse === 0 && out.softAvgC !== null && out.softAvgC <= out.softAvgH * 0.8;
    delete out.softC;
    delete out.softH;
    return out;
  };
  const extra = {};
  for (const conf of ['C4', 'C1', 'C8-600']) {
    extra[conf] = items.map((it) => ({ id: it.id, runs: CONFIGS[conf].runs.map((r) => totals(resOf(it, conf, r))) }));
  }
  const runInfo = {};
  for (const conf of Object.keys(CONFIGS)) {
    const xs = items.flatMap((it) => CONFIGS[conf].runs.map((r) => info(it, conf, r))).filter(Boolean);
    runInfo[conf] = {
      runs: xs.length,
      noAnswer: xs.filter((x) => !x.ok).length,
      peakMB: Math.max(0, ...xs.map((x) => Math.round((x.peak ?? 0) / 2 ** 20))),
      ortools: [...new Set(xs.map((x) => x.ortools).filter(Boolean))],
      ubHits: xs.filter((x) => x.ubHits?.length).length,
    };
  }
  const summary = { cpus: (await import('node:os')).cpus().length, C8: compareSet('C8', false), C8finished: compareSet('C8', true), C4: compareSet('C4', false), extra, runInfo };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const [name, s] of Object.entries({ 'C8 と H': summary.C8, 'C8＋仕上げ と H＋仕上げ': summary.C8finished, 'C4 と H（報告だけ）': summary.C4 })) {
    console.log(`${name}：組 ${s.pairs}（足りない答え ${s.missing}）・重い所で悪い組 ${s.heavyWorse}・良い ${s.better}・同じ ${s.same}・悪い ${s.worse}・できれば平均 ${s.softAvgC?.toFixed(1)} と ${s.softAvgH?.toFixed(1)}${name.startsWith('C8 と') ? ` → ${s.adopt ? '採る' : '採らない'}` : ''}`);
  }
  for (const [conf, x] of Object.entries(runInfo)) console.log(`${conf}：${x.runs}回・答えが出なかった ${x.noAnswer}・メモリ最大 ${x.peakMB}MB・上限に当たった ${x.ubHits}・ortools ${x.ortools.join(',')}`);
}
