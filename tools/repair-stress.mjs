// 「エラーを自動で直す」が、手で直した表でもエラーで止まらないことの確かめ（docs/自動で直す案.md の D）。作り物のデータだけ。
// 使い方: node tools/repair-stress.mjs [--months 30] [--from 1] [--nodes 20]
// 作り物の月（表あり）に、乱数の手直しをする（担当外のシフト・夜勤の次の日の出勤・夜勤の無い日の次の明け・希望と違うマス・
// 半休・空き・余り日・公休 など）。そのうえで、上限 10・25・50・全部 で直す案を作り、
//   エラー（例外）で止まらない／出た案は、上限より多く変わらない・固定は変わらない・希望のマスは希望の値・空きと半休は変わらない
// ことを確かめる。改善した案（画面に出る案）は isImproved を満たす（repair.js で数える）。
import { pathToFileURL } from 'node:url';
import { makeSample, rng } from './make-sample.mjs';
import { solveRepair } from '../app/js/solver/repair.js';
import { solveConflicts } from '../app/js/check.js';
import { monthDays } from '../app/js/model.js';
import { checkProposal } from './repair.mjs';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

export async function messyMonth(seed) {
  const d = await makeSample({ seed, staff: 6 + (seed % 12), withTable: true });
  const r = rng(seed + 4242);
  const N = monthDays(d);
  const pick = (list) => list[Math.floor(r() * list.length)];
  // 希望とぶつかる固定は外す（作る前に止まるため。止まることは 3-2 で確かめている）
  for (const it of solveConflicts(d)) {
    if (it.rule === 'requestDiff' && d.month.marks[it.staff]?.[it.day]) delete d.month.marks[it.staff][it.day];
  }
  const shifts = d.settings.shifts;
  const night = shifts.find((x) => x.night);
  const edits = 8 + Math.floor(r() * 12);
  for (let i = 0; i < edits; i += 1) {
    const p = pick(d.staff);
    const day = 1 + Math.floor(r() * N);
    if (d.month.marks[p.id]?.[day]?.locked) continue;
    const t = d.month.table;
    t[p.id] ??= {};
    const kind = pick(['assigned', 'outside', 'off', 'paid', 'spare', 'ake', 'half', 'empty', 'afterNight', 'request']);
    if (kind === 'assigned' && p.shifts.length) t[p.id][day] = { kind: 'shift', shift: pick(p.shifts) };
    else if (kind === 'outside') {
      const o = shifts.filter((x) => !p.shifts.includes(x.id));
      if (o.length) t[p.id][day] = { kind: 'shift', shift: pick(o).id };
    } else if (['off', 'paid', 'spare', 'ake', 'half'].includes(kind)) t[p.id][day] = { kind };
    else if (kind === 'empty') delete t[p.id][day];
    else if (kind === 'afterNight' && night && day < N && p.shifts.length) {
      t[p.id][day] = { kind: 'shift', shift: night.id };
      t[p.id][day + 1] = { kind: 'shift', shift: pick(p.shifts) };
    } else if (kind === 'request') {
      const req = d.month.requests[p.id]?.[day];
      if (req) t[p.id][day] = req.kind === 'off' ? { kind: 'paid' } : { kind: 'off' };
    }
  }
  return d;
}

export async function stressRepair(seed, nodes) {
  const d = await messyMonth(seed);
  const out = { seed, staff: d.staff.length, statuses: [], improved: 0, problems: [] };
  let res;
  try {
    res = await solveRepair(d, { loadHighs: () => highsLoader(), nodeLimit: nodes, secondsEach: null });
  } catch (e) {
    out.problems.push(`エラーで止まった：${e?.message ?? e}`);
    return out;
  }
  if (!res.ok) {
    out.statuses.push(res.reason);
    if (res.reason !== 'conflict') out.problems.push(`案を作れない（${res.reason}）`);
    return out;
  }
  for (const pr of res.proposals) {
    out.statuses.push(pr.status);
    if (pr.status !== 'ok') continue;
    if (pr.improved) out.improved += 1;
    const bad = checkProposal(d, pr);
    if (bad.length) out.problems.push(`上限 ${pr.budget ?? '全部'}：${bad.slice(0, 2).join(' / ')}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const months = arg('months', 30);
  const from = arg('from', 1);
  const nodes = arg('nodes', 20);
  const tally = { months: 0, conflict: 0, ok: 0, tooMany: 0, noAnswer: 0, improved: 0, problems: 0 };
  for (let seed = from; seed < from + months; seed += 1) {
    const o = await stressRepair(seed, nodes);
    tally.months += 1;
    tally.improved += o.improved;
    for (const st of o.statuses) {
      if (st === 'conflict') tally.conflict += 1;
      if (st === 'ok') tally.ok += 1;
      if (st === 'too-many') tally.tooMany += 1;
      if (st === 'no-answer') tally.noAnswer += 1;
    }
    if (o.problems.length) {
      tally.problems += 1;
      console.log(`種 ${seed}（${o.staff}人）: ${o.problems.join(' / ')}`);
    }
  }
  console.log(JSON.stringify(tally));
  process.exit(tally.problems ? 1 : 0);
}
