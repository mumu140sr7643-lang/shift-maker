// OR-Tools の CP-SAT で自動で作る（docs/OR-Tools の試し.md）。測るためだけ。アプリには入れない。作り物のデータだけ。
// 使い方: node tools/cpsat.mjs 保存したファイル.json [--workers 8] [--time 60] [--seed 1] [--ub-times 1] [--hybrid] [--out フォルダ]
//   --hybrid（HC8）：6連勤以上〜ほかの絶対の段は HiGHS で解き（時間の配分も1分で作ると同じ。stages.js の solveStaged をそのまま使う）、
//   「できれば」の段だけを CP-SAT で解く。HiGHS の段の量を上限として足し、HiGHS の表をヒントに渡す。時間は 60秒の残り全部。
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
import { solveStaged } from '../app/js/solver/stages.js';
import highsLoader from '../vendor/highs/highs.mjs';
import { canonicalJSON, clone, monthDays } from '../app/js/model.js';
import { compareAmounts } from './solve.mjs';
import { ROOT } from './lib.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export const PYTHON = process.env.SHIFT_MAKER_PYTHON || 'python';

export function runPython(input) {
  return new Promise((resolve) => {
    const p = spawn(PYTHON, ['-B', join(ROOT, 'tools', 'cpsat_run.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
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

const linJson = (l) => ({ c: l.c, t: [...l.t] });

// 表から、マスの 2択の変数の値（ヒント）を作る。名前は build.js と同じ（x_人_日_シフト・off_人_日 など）
export function hintOf(data, table) {
  const hint = {};
  const N = monthDays(data);
  for (const p of data.staff) {
    for (let d = 1; d <= N; d += 1) {
      const v = table[p.id]?.[d];
      for (const s of data.settings.shifts) hint[`x_${p.id}_${d}_${s.id}`] = v?.kind === 'shift' && v.shift === s.id ? 1 : 0;
      for (const k of ['off', 'paid', 'spare', 'ake']) hint[`${k}_${p.id}_${d}`] = v?.kind === k ? 1 : 0;
    }
  }
  return hint;
}

// HC8：HiGHS で「できれば」より前の段を解き、「できれば」の段だけを CP-SAT で解く
export async function hybridFile(data, { workers = 8, time = 60, seed = 1 } = {}) {
  const t0 = Date.now();
  const model = buildModel(data);
  const last = model.stages[model.stages.length - 1];
  const softAt = last?.key === 'soft' ? model.stages.length - 1 : model.stages.length;
  const h = await solveStaged(data, { loadHighs: () => highsLoader(), timeLimit: time, seed: 1, maxStages: softAt });
  if (!h.ok) return { solved: { ...h, hybrid: true } };
  let table = h.table;
  const stages = [...h.stages];
  let info = {};
  if (softAt < model.stages.length) {
    const bounds = h.stages.map((rec, i) => ({ objective: linJson(model.stages[i].objective), max: rec.value }));
    const left = Math.max(1, time - (Date.now() - t0) / 1000);
    const res = await runPython({ lp: model.lp(last.objective, []), stages: [{ key: last.key, name: last.name, objective: linJson(last.objective) }], bounds, hint: hintOf(data, h.table), time: left, workers, seed, ub: monthDays(data) * Math.max(1, data.staff.length) });
    info = { ortools: res.ortools, peak: res.peak, loadSeconds: res.loadSeconds, importSeconds: res.importSeconds, workers, seed, ubHits: res.ubHits ?? [], softTime: Math.round(left * 100) / 100, error: res.error };
    if (res.ok) {
      table = model.readTable(new Map(Object.entries(res.values)));
      stages.push({ ...res.stages[0], rules: last.rules });
    } else stages.push({ key: last.key, name: last.name, rules: last.rules, status: 'kept', code: res.reason, seconds: res.seconds ?? null, value: null });
  }
  const solved = { ok: true, hybrid: true, table, stages, size: model.size, seconds: Math.round((Date.now() - t0) / 10) / 100, ...info };
  const out = clone(data);
  out.month.table = table;
  const counted = checkTable(out);
  return { solved, data: out, counted, compare: { exact: {}, approx: {} } };
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
  const opts = { workers: Number(arg('workers', 8)), time: Number(arg('time', 60)), seed: Number(arg('seed', 1)), ubTimes: Number(arg('ub-times', 1)) };
  const res = process.argv.includes('--hybrid') ? await hybridFile(r.data, opts) : await cpsatFile(r.data, opts);
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
  for (const st of s.stages) console.log(`  段 ${st.name}: ${st.status}（状態 ${st.code}） ${st.seconds}秒 量=${st.value}`);
  if (s.ubHits?.length) console.log(`× 量の変数が上限にぴったり当たった：${s.ubHits.slice(0, 5).join(' ')}（上限を広げて測り直す）`);
  if (s.conflicts) for (const c of s.conflicts.slice(0, 10)) console.log(`  ぶつかり: ${c.text}`);
  if (res.counted) console.log(`検査: ${JSON.stringify(res.counted.totals)}`);
  if (res.compare) {
    const bad = Object.entries(res.compare.exact).filter(([, v]) => !v.same);
    console.log(bad.length ? `段の量と検査の量が違う: ${JSON.stringify(Object.fromEntries(bad))}` : '段の量と検査の量は同じ（同じになるはずのもの）');
  }
  process.exit(s.ok && !s.ubHits?.length ? 0 : 1);
}
