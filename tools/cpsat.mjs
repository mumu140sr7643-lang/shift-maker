// OR-Tools の CP-SAT で自動で作る（docs/OR-Tools の試し.md）。測るためだけ。アプリには入れない。作り物のデータだけ。
// 使い方: node tools/cpsat.mjs 保存したファイル.json [--workers 8] [--time 60] [--seed 1] [--ub-times 1] [--out フォルダ]
//   式は build.js が HiGHS に渡すものと同じ（LP の文）。6段の流れは tools/cpsat_run.py（Python の ortools）が全部回す。
//   この道具は、式を作って渡し、返ってきた答えを build.js の readTable で表にし、check.js で数える。
//   Python は SHIFT_MAKER_PYTHON（ふだんの Python を変えないよう、別の箱 venv の python.exe）。無ければ python。
//   --ub-times：量の変数の上限を「日数 × 人数」の何倍にするか（確かめ用。広げても同じ最小値になるか）
// --out に出すもの：stages.json（段ごとの結果・ortools の版・メモリ）・result.json（できた表を入れたデータ）・count.json・compare.json
//   （tools/solve.mjs と同じ形。tools/finish.mjs で仕上げられる）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parseData } from '../app/js/storage.js';
import { checkTable, solveConflicts } from '../app/js/check.js';
import { buildModel } from '../app/js/solver/build.js';
import { canonicalJSON, clone, monthDays } from '../app/js/model.js';
import { compareAmounts } from './solve.mjs';
import { ROOT } from './lib.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export const PYTHON = process.env.SHIFT_MAKER_PYTHON || 'python';

function runPython(input) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, [join(ROOT, 'tools', 'cpsat_run.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (b) => out.push(b));
    p.stderr.on('data', (b) => err.push(b));
    p.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ ok: false, reason: 'error', error: `Python が答えを返さなかった（終わりの番号 ${code}）：${Buffer.concat(err).toString('utf8').slice(-600)}` });
      }
    });
    p.stdin.end(Buffer.from(JSON.stringify(input), 'utf8'));
  });
}

// 返す：{ solved（stages.js の solveStaged と同じ形に近いもの）, data（表を入れたデータ）, counted, compare }
export async function cpsatFile(data, { workers = 8, time = 60, seed = 1, ubTimes = 1 } = {}) {
  const conflicts = solveConflicts(data);
  if (conflicts.length) return { solved: { ok: false, reason: 'conflict', conflicts, stages: [] } };
  const model = buildModel(data);
  const ub = monthDays(data) * Math.max(1, data.staff.length) * ubTimes;
  const stages = model.stages.map((st) => ({ key: st.key, name: st.name, objective: { c: st.objective.c, t: [...st.objective.t] } }));
  const res = await runPython({ lp: model.lp(model.stages[0].objective, []), stages, time, workers, seed, ub });
  const solved = { ...res, size: model.size, stages: (res.stages ?? []).map((r, i) => ({ ...r, rules: model.stages[i]?.rules ?? [] })) };
  delete solved.values;
  if (!res.ok) return { solved };
  const values = new Map(Object.entries(res.values));
  solved.table = model.readTable(values);
  solved.amounts = {};
  for (const st of model.stages) for (const r of st.rules) solved.amounts[r] = model.amountOf(r, values);
  const out = clone(data);
  out.month.table = solved.table;
  const counted = checkTable(out);
  return { solved, data: out, counted, compare: compareAmounts(solved, counted, data) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node tools/cpsat.mjs 保存したファイル.json [--workers 8] [--time 60] [--seed 1] [--ub-times 1] [--out フォルダ]');
    process.exit(2);
  }
  const r = parseData(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (r.error) {
    console.error(`読めませんでした: ${r.error.join(' / ')}`);
    process.exit(1);
  }
  const res = await cpsatFile(r.data, { workers: Number(arg('workers', 8)), time: Number(arg('time', 60)), seed: Number(arg('seed', 1)), ubTimes: Number(arg('ub-times', 1)) });
  const out = arg('out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stages.json'), JSON.stringify(res.solved, (k, v) => (k === 'table' ? undefined : v), 2));
    if (res.data) {
      writeFileSync(join(out, 'result.json'), canonicalJSON(res.data));
      writeFileSync(join(out, 'count.json'), JSON.stringify(res.counted, null, 2));
      writeFileSync(join(out, 'compare.json'), JSON.stringify(res.compare, null, 2));
    }
  }
  const s = res.solved;
  console.log(`結果: ${s.ok ? 'できた' : `できなかった（${s.reason}${s.error ? `：${s.error}` : ''}）`}  ortools ${s.ortools ?? '?'}・Worker ${s.workers ?? '?'}・式を読む ${s.loadSeconds ?? '?'}秒・メモリ ${s.peak ? Math.round(s.peak / 2 ** 20) : '?'}MB`);
  for (const st of s.stages) console.log(`  段 ${st.name}: ${st.status}（CP-SAT の状態 ${st.code}） ${st.seconds}秒 量=${st.value}`);
  if (s.ubHits?.length) console.log(`× 量の変数が上限にぴったり当たった：${s.ubHits.slice(0, 5).join(' ')}（上限を広げて測り直す）`);
  if (s.conflicts) for (const c of s.conflicts.slice(0, 10)) console.log(`  ぶつかり: ${c.text}`);
  if (res.counted) console.log(`検査: ${JSON.stringify(res.counted.totals)}`);
  if (res.compare) {
    const bad = Object.entries(res.compare.exact).filter(([, v]) => !v.same);
    console.log(bad.length ? `段の量と検査の量が違う: ${JSON.stringify(Object.fromEntries(bad))}` : '段の量と検査の量は同じ（同じになるはずのもの）');
  }
  process.exit(s.ok && !s.ubHits?.length ? 0 : 1);
}
