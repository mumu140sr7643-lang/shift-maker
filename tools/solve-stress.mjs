// 「答えが無い」にならないことの確かめ（docs/自動で作る案.md の 6 章 E）。作り物のデータだけ。
// 使い方: node tools/solve-stress.mjs [--months 100] [--from 1] [--nodes 20]
// 作り物の月に、希望と固定を乱数でたくさん入れ（休み・有給・半休・シフト・空きの固定・明けの固定・夜勤の次の日の休み・
// 前の月の最後の夜勤・日ごとに要るスキル）、はじめの段（6連勤以上）だけを解く。
//   答えが無いとき → そのときは必ず solveConflicts が1件以上あること
//   答えが出たとき → 担当外のシフト・希望と違う・日ごとに要るスキル・夜勤の次の日が 0件で、固定したマスが変わっていないこと
import { pathToFileURL } from 'node:url';
import { makeSample, rng } from './make-sample.mjs';
import { solveStaged } from '../app/js/solver/stages.js';
import { checkTable, solveConflicts } from '../app/js/check.js';
import { clone, monthDays } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

export async function stressData(seed) {
  const d = await makeSample({ seed, staff: 6 + (seed % 15), withTable: true });
  const r = rng(seed + 7777);
  const N = monthDays(d);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const night = d.settings.shifts.find((s) => s.night);
  d.month.marks = {};
  for (const p of d.staff) {
    if (night && p.shifts.includes(night.id) && r() < 0.3) p.prevLastShift = night.id;
    for (let day = 1; day <= N; day += 1) {
      const x = r();
      const req = d.month.requests[p.id]?.[day];
      if (req && x < 0.1) {
        // 希望のある日を固定するときは、希望と同じ値で固定する（違う値はぶつかりになるため）
        (d.month.table[p.id] ??= {})[day] = req.kind === 'shift' ? { kind: 'shift', shift: req.shift } : { kind: req.kind };
        (d.month.marks[p.id] ??= {})[day] = { locked: true };
      } else if (req) {
        // 固定しない
      } else if (x < 0.03) (d.month.marks[p.id] ??= {})[day] = { locked: true }; // いまの値のまま固定
      else if (x < 0.05) {
        delete d.month.table[p.id]?.[day];
        (d.month.marks[p.id] ??= {})[day] = { locked: true }; // 空きのまま固定
      } else if (x < 0.07) {
        (d.month.table[p.id] ??= {})[day] = { kind: 'ake' };
        (d.month.marks[p.id] ??= {})[day] = { locked: true }; // 明けを手で入れて固定
      }
      // 夜勤の希望の次の日に休みの希望
      if (night && d.month.requests[p.id]?.[day]?.shift === night.id && day < N && r() < 0.5) {
        d.month.requests[p.id][day + 1] = { kind: pick(['off', 'paid']) };
      }
      // 半休の希望（固定したマスには入れない。違う値はぶつかりになるため）
      if (r() < 0.02 && !d.month.marks[p.id]?.[day]) (d.month.requests[p.id] ??= {})[day] = { kind: 'half' };
    }
  }
  if (d.settings.skills.length && r() < 0.5) {
    const s = pick(d.settings.shifts);
    d.month.dailySkill[s.id] = { [1 + Math.floor(r() * N)]: [pick(d.settings.skills).id] };
  }
  return d;
}

export async function stressMonth(seed, nodes = 20) {
  const d = await stressData(seed);
  const N = monthDays(d);
  const conflicts = solveConflicts(d);
  const res = await solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: nodes, seed: 1, maxStages: 1 });
  const out = { seed, staff: d.staff.length, days: N, conflicts: conflicts.length, conflictRules: conflicts.map((c) => c.rule), ok: res.ok, reason: res.reason ?? null, retried: res.stages.some((x) => x.retried), problems: [] };
  if (!res.ok) {
    if ((res.reason === 'infeasible' || res.reason === 'no-answer') && conflicts.length === 0) out.problems.push(`答えが無い（${res.reason}）のに、ぶつかりの知らせが0件`);
    return out;
  }
  const after = clone(d);
  after.month.table = res.table;
  const c = checkTable(after);
  for (const rule of ['notAssigned', 'requestDiff', 'dailySkill', 'nightNext']) {
    if (c.byRule[rule].count) out.problems.push(`${rule} が ${c.byRule[rule].count}件`);
  }
  for (const [pid, days] of Object.entries(d.month.marks)) {
    for (const [day, m] of Object.entries(days)) {
      if (!m.locked) continue;
      const a = JSON.stringify(d.month.table[pid]?.[day] ?? null);
      const b = JSON.stringify(after.month.table[pid]?.[day] ?? null);
      if (a !== b) out.problems.push(`固定したマスが変わった（${pid} ${day}日 ${a} → ${b}）`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const months = arg('months', 100);
  const from = arg('from', 1);
  const nodes = arg('nodes', 20);
  const tally = { months: 0, solved: 0, stoppedByConflict: 0, noAnswerWithConflict: 0, presolveRetried: 0, problems: 0, conflictRules: {} };
  for (let seed = from; seed < from + months; seed += 1) {
    const o = await stressMonth(seed, nodes);
    tally.months += 1;
    for (const rule of o.conflictRules) tally.conflictRules[rule] = (tally.conflictRules[rule] ?? 0) + 1;
    if (o.retried) tally.presolveRetried += 1;
    if (o.ok) tally.solved += 1;
    else if (o.reason === 'conflict') tally.stoppedByConflict += 1;
    else tally.noAnswerWithConflict += 1;
    if (o.problems.length) {
      tally.problems += 1;
      console.log(`種 ${seed}（${o.staff}人・${o.days}日）: ${o.problems.join(' / ')}`);
    }
  }
  console.log(JSON.stringify(tally));
  process.exit(tally.problems ? 1 : 0);
}
