// 乱数で作り物の月を作る（本物のデータは読まない）。同じ種（--seed）なら毎回同じデータになる。
// 使い方: node tools/make-sample.mjs --seed 3 [--staff 25] [--year 2026 --month 2] [--out ファイル]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// 決まった種から同じ乱数の並びを作る
export function rng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1000000) / 1000000;
  };
}

export async function makeSample({ seed, staff = null, year = null, month = null, root = ROOT }) {
  const M = await import(pathToFileURL(join(root, 'app/js/model.js')).href);
  const C = await import(pathToFileURL(join(root, 'app/js/calendar.js')).href);
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const y = year ?? int(2026, 2028);
  const m = month ?? int(1, 12);
  const d = M.emptyData(y, m, 'random');
  const nDays = C.daysInMonth(y, m);

  d.settings.ranks = ['上位', '中位', '一般'].slice(0, int(1, 3)).map((n) => M.newRank(d, n));
  d.settings.skills = Array.from({ length: int(0, 3) }, (_, i) =>
    M.newSkill(d, {
      name: `スキル${i + 1}`,
      min: { early: int(0, 1), late: int(0, 1), night: 0 },
      target: { early: int(0, 2), late: int(0, 2), night: 0 },
    }),
  );
  const symbols = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  const nShifts = int(2, 7);
  for (let i = 0; i < nShifts; i += 1) {
    const night = i === nShifts - 1 && r() < 0.3;
    const full = int(0, 2);
    const part = int(0, 3);
    d.settings.shifts.push(M.newShift(d, {
      symbol: symbols[i],
      name: `シフト${i + 1}`,
      group: night ? 'night' : pick(['early', 'late']),
      hours: pick([4, 6, 7.5, 8]),
      need: { full, part, all: full + part },
      combine: r() < 0.3,
      night,
      onePerDay: !night && r() < 0.15,
      training: r() < 0.1,
    }));
  }
  for (const s of d.settings.shifts) if (s.training) s.counts = false;
  if (r() < 0.5) {
    const s = pick(d.settings.shifts);
    d.settings.needRules.push({ id: M.newId(d, 'rule'), label: '週末の決まり', when: { weekdays: [0, 6] }, shift: s.id, emp: 'part', op: 'add', value: 1 });
  }
  const n = staff ?? int(5, 50);
  const shiftIds = d.settings.shifts.map((s) => s.id);
  for (let i = 0; i < n; i += 1) {
    const mine = shiftIds.filter(() => r() < 0.6);
    d.staff.push(M.newStaff(d, {
      name: i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`,
      employment: r() < 0.35 ? 'full' : 'part',
      rank: pick(d.settings.ranks).id,
      shifts: mine.length ? mine : [pick(shiftIds)],
      skills: d.settings.skills.filter(() => r() < 0.4).map((k) => k.id),
      offDays: int(8, 14),
      paidDays: int(0, 4) / 2,
      groupPref: pick(M.GROUP_PREFS),
      biasPref: pick(M.BIAS_PREFS),
      restStyle: pick(M.REST_STYLES),
      weekendPref: pick(M.WEEKEND_PREFS),
      maxConsecutive: r() < 0.2 ? int(3, 6) : null,
      prevConsecutive: int(0, 6),
      prevLastShift: r() < 0.5 ? pick(shiftIds) : 'off',
    }));
  }
  for (let k = int(0, 3); k > 0; k -= 1) {
    d.month.special.push(M.newSpecialDay(d, { day: int(1, nDays), name: '特別な日', rankNeeds: [{ rank: d.settings.ranks[0].id, count: 1 }] }));
  }
  for (let k = int(0, 8); k > 0; k -= 1) {
    const s = pick(d.settings.shifts);
    const emp = s.combine ? 'all' : pick(['full', 'part']);
    M.setNeedOverride(d, s.id, emp, int(1, nDays), int(0, 5));
  }
  for (const p of d.staff) {
    for (let day = 1; day <= nDays; day += 1) {
      const x = r();
      if (x < 0.08) (d.month.requests[p.id] ??= {})[day] = { kind: 'off' };
      else if (x < 0.1) (d.month.requests[p.id] ??= {})[day] = { kind: 'paid' };
      else if (x < 0.12) (d.month.requests[p.id] ??= {})[day] = { kind: 'shift', shift: pick(p.shifts) };
    }
  }
  return d;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const d = await makeSample({
    seed: Number(arg('seed', 1)),
    staff: arg('staff') ? Number(arg('staff')) : null,
    year: arg('year') ? Number(arg('year')) : null,
    month: arg('month') ? Number(arg('month')) : null,
  });
  const text = JSON.stringify(d, null, 2);
  const out = arg('out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text + '\n');
}
