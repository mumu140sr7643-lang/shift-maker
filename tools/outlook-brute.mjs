// 見込みと説明（v5）の数え方を、とても小さな月の総当たりで確かめる道具。作り物のデータだけ。
// 使い方: node tools/outlook-brute.mjs [--cases 200] [--from 1]
//   flow：人手の表の「埋められる数」（最大流）が、人と日を枠に1人1日1つずつ割り当てる全部の組み合わせを調べた最大と同じか
//         （W_p の上限ありとなし。全体・時間帯・1日1人の役・スキルの行）
// 小さな月：2〜3人、出られる日は 1〜3日だけ（ほかの日は全員が休みの希望）。シフト 2〜3種類、必要人数・担当・区分・スキル・
//   希望（休み・半休・シフト）・固定を乱数で入れる。
import { pathToFileURL } from 'node:url';
import { rng } from './make-sample.mjs';
import * as M from '../app/js/model.js';
import { staffingRows, openShifts, workCap, rowFillable } from '../app/js/outlook.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

// 乱数の小さな月（2027年2月。4日目からは全員が休みの希望）
export function tinyMonth(seed) {
  const r = rng(seed * 7919 + 13);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const d = M.emptyData(2027, 2, 'blank');
  const groups = ['early', 'late', 'night'];
  const nShifts = 2 + Math.floor(r() * 2);
  d.settings.shifts = Array.from({ length: nShifts }, (_, i) => {
    const combine = r() < 0.5;
    const n = () => Math.floor(r() * 3);
    return M.newShift(d, { symbol: `S${i}`, name: `S${i}`, group: pick(groups.slice(0, 2)), combine, onePerDay: r() < 0.25, need: combine ? { full: 0, part: 0, all: n() } : { full: n(), part: n(), all: 0 } });
  });
  const k = M.newSkill(d, { name: 'K' });
  k.min = { early: Math.floor(r() * 2), late: Math.floor(r() * 2), night: 0 };
  d.settings.skills = [k];
  const nStaff = 2 + Math.floor(r() * 2);
  d.staff = Array.from({ length: nStaff }, (_, i) => M.newStaff(d, {
    name: String.fromCharCode(65 + i),
    employment: pick(['full', 'part']),
    shifts: d.settings.shifts.filter(() => r() < 0.7).map((s) => s.id),
    skills: r() < 0.5 ? [k.id] : [],
    offDays: 25 + Math.floor(r() * 3),
    paidDays: 0,
  }));
  const N = M.monthDays(d);
  for (const p of d.staff) {
    for (let day = 4; day <= N; day += 1) M.setRequest(d, p.id, day, { kind: 'off' });
    for (let day = 1; day <= 3; day += 1) {
      const x = r();
      if (x < 0.15) M.setRequest(d, p.id, day, { kind: 'off' });
      else if (x < 0.22) M.setRequest(d, p.id, day, { kind: 'half' });
      else if (x < 0.32) M.setRequest(d, p.id, day, { kind: 'shift', shift: pick(d.settings.shifts).id });
      else if (x < 0.38) {
        d.month.table[p.id] = { ...(d.month.table[p.id] ?? {}), [day]: { kind: 'paid' } };
        d.month.marks[p.id] = { ...(d.month.marks[p.id] ?? {}), [day]: { locked: true } };
      }
    }
  }
  return d;
}

// 全部の組み合わせを調べて、いちばん多く埋まる数（人と日ごとに、入れる枠のどれか1つ か 入れない）
export function bruteFillable(data, row, caps) {
  const N = M.monthDays(data);
  const items = [];
  data.staff.forEach((p, i) => {
    for (let day = 1; day <= N; day += 1) {
      const open = openShifts(data, p, day);
      const opts = row.slots.map((s, j) => (s.accepts(p, open) ? j : -1)).filter((j) => j >= 0);
      if (opts.length) items.push({ i, day, opts });
    }
  });
  const used = new Map(); // `${day}|${j}` → 人数
  const count = data.staff.map(() => 0);
  let best = 0;
  const rec = (k, filled) => {
    if (filled + (items.length - k) <= best) return;
    if (k === items.length) {
      best = Math.max(best, filled);
      return;
    }
    const it = items[k];
    if (!caps || count[it.i] < caps[it.i]) {
      for (const j of it.opts) {
        const key = `${it.day}|${j}`;
        const u = used.get(key) ?? 0;
        if (u >= row.slots[j].need(it.day)) continue;
        used.set(key, u + 1);
        count[it.i] += 1;
        rec(k + 1, filled + 1);
        count[it.i] -= 1;
        used.set(key, u);
      }
    }
    rec(k + 1, filled);
  };
  rec(0, 0);
  return best;
}

export function checkFlow(seed) {
  const d = tinyMonth(seed);
  const caps = d.staff.map((p) => workCap(d, p));
  const problems = [];
  for (const row of staffingRows(d)) {
    for (const capped of [true, false]) {
      const flow = rowFillable(d, row.key, { capped });
      const brute = bruteFillable(d, row, capped ? caps : null);
      if (flow !== brute) problems.push(`種 ${seed} ${row.label} ${capped ? '上限あり' : '上限なし'}：最大流 ${flow}・総当たり ${brute}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cases = arg('cases', 200);
  const from = arg('from', 1);
  let bad = 0;
  for (let seed = from; seed < from + cases; seed += 1) {
    const problems = checkFlow(seed);
    if (problems.length) {
      bad += 1;
      for (const x of problems) console.log(x);
    }
  }
  console.log(JSON.stringify({ cases, flowMismatch: bad }));
  process.exit(bad ? 1 : 0);
}
