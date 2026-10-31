// 集計表（4-3。説明書 2 節 手順6）：人ごとの各シフトの回数・公休・有給・出勤日数・労働時間。画面には触らない。node からも使う。
// 数え方は docs/数え方の表.md の 1 章：半休は出勤 1 日・労働時間は「半休の日の労働時間」・有給 0.5 日。
// 明けは出勤日数 0・労働時間 0。研修のシフトも出勤（シフトの時間）。余り日・公休・有給は出勤 0。空きは数えない。
import { monthDays, cellOf, shiftById } from './model.js?v=6.2';

const round1 = (x) => Math.round(x * 10) / 10;

export function summarize(data) {
  const N = monthDays(data);
  const halfHours = data.settings.work.halfDayHours;
  const rows = data.staff.map((p) => {
    const shiftCounts = Object.fromEntries(data.settings.shifts.map((s) => [s.id, 0]));
    const r = { pid: p.id, name: p.name, plannedOff: p.offDays, shiftCounts, off: 0, paidDays: 0, half: 0, ake: 0, spare: 0, empty: 0, workDays: 0, hours: 0 };
    for (let day = 1; day <= N; day += 1) {
      const v = cellOf(data, p.id, day);
      if (!v) {
        r.empty += 1;
        continue;
      }
      if (v.kind === 'shift') {
        const s = shiftById(data, v.shift);
        if (!s) continue;
        shiftCounts[s.id] += 1;
        r.workDays += 1;
        r.hours += s.hours;
      } else if (v.kind === 'half') {
        r.half += 1;
        r.workDays += 1;
        r.hours += halfHours;
      } else if (v.kind === 'off') r.off += 1;
      else if (v.kind === 'paid') r.paidDays += 1;
      else if (v.kind === 'ake') r.ake += 1;
      else if (v.kind === 'spare') r.spare += 1;
    }
    r.paid = r.paidDays + r.half * 0.5;
    r.hours = round1(r.hours);
    return r;
  });
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const totals = {
    shiftCounts: Object.fromEntries(data.settings.shifts.map((s) => [s.id, sum((r) => r.shiftCounts[s.id])])),
    plannedOff: sum((r) => r.plannedOff),
    off: sum((r) => r.off),
    paid: round1(sum((r) => r.paid)),
    half: sum((r) => r.half),
    ake: sum((r) => r.ake),
    spare: sum((r) => r.spare),
    empty: sum((r) => r.empty),
    workDays: sum((r) => r.workDays),
    hours: round1(sum((r) => r.hours)),
  };
  return { rows, totals };
}

// 集計表の列（画面・Excel・CSV で同じ名前と並び）。value(行) は数
export function summaryColumns(data) {
  return [
    ...data.settings.shifts.map((s) => ({ key: `shift:${s.id}`, label: `${s.symbol}（回）`, value: (r) => r.shiftCounts[s.id] })),
    { key: 'off', label: '公休（日）', value: (r) => r.off },
    { key: 'plannedOff', label: '公休の予定（日）', value: (r) => r.plannedOff },
    { key: 'paid', label: '有給（日。半休は0.5）', value: (r) => r.paid },
    { key: 'half', label: '半休（回）', value: (r) => r.half },
    { key: 'ake', label: '明け（日）', value: (r) => r.ake },
    { key: 'spare', label: '余り日（日）', value: (r) => r.spare },
    { key: 'workDays', label: '出勤日数（日）', value: (r) => r.workDays },
    { key: 'hours', label: '労働時間（時間）', value: (r) => r.hours },
  ];
}
