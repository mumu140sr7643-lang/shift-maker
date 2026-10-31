// 見込みと説明（v5）の数え方を、とても小さな月の総当たりで確かめる道具。作り物のデータだけ。
// 使い方: node tools/outlook-brute.mjs [--cases 200] [--from 1]（flow と min の両方を確かめる）
//   flow：人手の表の「埋められる数」（最大流）が、人と日を枠に1人1日1つずつ割り当てる全部の組み合わせを調べた最大と同じか
//         （W_p の上限ありとなし。全体・時間帯・1日1人の役・スキルの行）
//   min：最低◯件の見込み（lowerBound）が、式で縛る決まりを守る表を全部つくったときの、決まりごとの「いちばん少ない件数」以下か（案の A）
// 小さな月：2〜3人、出られる日は 1〜3日だけ（ほかの日は全員が休みの希望）。シフト 2〜3種類、必要人数・担当・区分・スキル・
//   希望（休み・半休・シフト）・固定を乱数で入れる。
import { pathToFileURL } from 'node:url';
import { rng } from './make-sample.mjs';
import * as M from '../app/js/model.js';
import { staffingRows, openShifts, workCap, rowFillable, lowerBound, fixedValue } from '../app/js/outlook.js';
import { checkTable } from '../app/js/check.js';

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

// ---------- 最低件数（5-3）の総当たり（案の A） ----------
// とても小さな月：2〜3人・出られるのは 1〜5日（6日目からは全員が休みの希望）・シフト 2種類（夜勤なし）。
// 希望・固定・前の月の連勤・連勤の上限・公休の予定・必要人数・スキルを乱数で入れる。
export function tinyErrorMonth(seed) {
  const r = rng(seed * 104729 + 7);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const d = M.emptyData(2027, 2, 'blank');
  const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', combine: true, need: { full: 0, part: 0, all: Math.floor(r() * 3) } });
  const L = M.newShift(d, { symbol: '遅', name: '遅', group: 'late', combine: true, need: { full: 0, part: 0, all: Math.floor(r() * 2) } });
  d.settings.shifts = [E, L];
  const k = M.newSkill(d, { name: 'K' });
  k.min = { early: Math.floor(r() * 2), late: 0, night: 0 };
  d.settings.skills = [k];
  d.settings.work.maxConsecutive = 2 + Math.floor(r() * 3);
  const nStaff = 2 + Math.floor(r() * 2);
  const N = M.monthDays(d);
  const active = 5;
  d.staff = Array.from({ length: nStaff }, (_, i) => {
    const prev = Math.floor(r() * 5);
    return M.newStaff(d, {
      name: String.fromCharCode(65 + i),
      shifts: [E.id, L.id].filter(() => r() < 0.75),
      skills: r() < 0.5 ? [k.id] : [],
      offDays: N - active + Math.floor(r() * 3),
      paidDays: 0,
      prevConsecutive: prev,
      prevLastShift: prev ? pick([E.id, L.id]) : null,
      twoOffAfterLateEarly: r() < 0.3,
    });
  });
  // 6日目からは、必要人数も 0（出られる日だけで比べるため）
  for (const row of M.needRows(d)) for (let day = active + 1; day <= N; day += 1) M.setNeedOverride(d, row.shiftId, row.emp, day, 0);
  for (const p of d.staff) {
    for (let day = active + 1; day <= N; day += 1) M.setRequest(d, p.id, day, { kind: 'off' });
    for (let day = 1; day <= active; day += 1) {
      const x = r();
      if (x < 0.12) M.setRequest(d, p.id, day, { kind: 'off' });
      else if (x < 0.32) M.setRequest(d, p.id, day, { kind: 'shift', shift: pick([E.id, L.id]) });
      else if (x < 0.37) M.setRequest(d, p.id, day, { kind: 'half' });
      else if (x < 0.45) {
        d.month.table[p.id] = { ...(d.month.table[p.id] ?? {}), [day]: pick([{ kind: 'shift', shift: E.id }, { kind: 'paid' }, { kind: 'spare' }]) };
        d.month.marks[p.id] = { ...(d.month.marks[p.id] ?? {}), [day]: { locked: true } };
      }
    }
  }
  return d;
}

const MIN_RULES = ['sixPlus', 'overStreak', 'lateToEarly', 'twoOffLateEarly', 'shortage', 'skillShort', 'offShort'];

// 式で縛る決まり（1人1日1つ・担当外なし・日ごとに要るスキル・希望と固定はそのまま・公休と有給の上限）を守る表を全部つくり、
// 決まりごとに「いちばん少ない件数」を出す。返す：{ min: { rule: 件数 }, tables: 数 }
export function bruteMinimum(data) {
  const N = M.monthDays(data);
  const free = [];
  const base = {};
  const offCap = {};
  const paidCap = {};
  for (const p of data.staff) {
    base[p.id] = {};
    let fixedOff = 0;
    let fixedPaid = 0;
    for (let day = 1; day <= N; day += 1) {
      const f = fixedValue(data, p.id, day);
      if (f === undefined) {
        const opts = [...p.shifts.map((sid) => ({ kind: 'shift', shift: sid })), { kind: 'off' }, { kind: 'paid' }, { kind: 'spare' }];
        free.push({ pid: p.id, day, opts });
      } else if (f) {
        base[p.id][day] = f;
        if (f.kind === 'off') fixedOff += 1;
        if (f.kind === 'paid') fixedPaid += 1;
      }
    }
    offCap[p.id] = Math.max(p.offDays, fixedOff) - fixedOff;
    paidCap[p.id] = Math.max(Math.ceil(p.paidDays), fixedPaid) - fixedPaid;
  }
  const min = Object.fromEntries(MIN_RULES.map((x) => [x, Infinity]));
  const table = JSON.parse(JSON.stringify(base));
  const used = Object.fromEntries(data.staff.map((p) => [p.id, { off: 0, paid: 0 }]));
  let tables = 0;
  const rec = (i) => {
    if (i === free.length) {
      tables += 1;
      const res = checkTable({ ...data, month: { ...data.month, table } });
      for (const rule of MIN_RULES) min[rule] = Math.min(min[rule], res.byRule[rule].count);
      return;
    }
    const c = free[i];
    for (const o of c.opts) {
      if (o.kind === 'off' && used[c.pid].off >= offCap[c.pid]) continue;
      if (o.kind === 'paid' && used[c.pid].paid >= paidCap[c.pid]) continue;
      if (o.kind === 'off' || o.kind === 'paid') used[c.pid][o.kind] += 1;
      table[c.pid][c.day] = o;
      rec(i + 1);
      delete table[c.pid][c.day];
      if (o.kind === 'off' || o.kind === 'paid') used[c.pid][o.kind] -= 1;
    }
  };
  rec(0);
  return { min, tables, free: free.length };
}

export function checkMinimum(seed) {
  const d = tinyErrorMonth(seed);
  const lb = lowerBound(d);
  const { min, tables, free } = bruteMinimum(d);
  const problems = [];
  if (!tables) return { problems, tables, free, lb, min };
  for (const rule of MIN_RULES) {
    const got = lb.byRule[rule] ?? 0;
    if (got > min[rule]) problems.push(`種 ${seed} ${rule}：見込み ${got} ＞ いちばん少ない件数 ${min[rule]}`);
  }
  return { problems, tables, free, lb, min };
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
  let over = 0;
  let exact = 0;
  let positive = 0;
  let tables = 0;
  for (let seed = from; seed < from + cases; seed += 1) {
    const r = checkMinimum(seed);
    tables += r.tables;
    if (r.problems.length) {
      over += 1;
      for (const x of r.problems) console.log(x);
    }
    for (const [rule, n] of Object.entries(r.min)) {
      if (!Number.isFinite(n) || !n) continue;
      positive += 1;
      if ((r.lb.byRule[rule] ?? 0) === n) exact += 1;
    }
  }
  console.log(JSON.stringify({ cases, flowMismatch: bad, minOver: over, tables, rulesWithErrors: positive, lowerBoundExact: exact }));
  process.exit(bad || over ? 1 : 0);
}
