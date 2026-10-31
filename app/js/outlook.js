// 見込みと説明（v5。docs/見込みと説明の案.md）の数え方。画面には触らない。node からも使う。
// 5-1：その日に出られる人・あと何人休めるか（日ごとの余裕）・きつい期間・新しくできた 0 人の日ときつい期間。
import { monthDays, cellOf, shiftById, needRows, needOn } from './model.js?v=5.1';

export const GROUPS = ['early', 'late', 'night'];

// 人数に数えるシフト（研修でない）
export const countedShift = (s) => Boolean(s?.counts) && !s.training;
export const groupOf = (s) => (s.night ? 'night' : s.group);

const asCell = (r) => (r.kind === 'shift' ? { kind: 'shift', shift: r.shift } : { kind: r.kind });

// 決まっている値（固定 → 希望 の順）。undefined は決まっていない、null は空きのまま固定
export function fixedValue(data, pid, day) {
  if (data.month.marks[pid]?.[day]?.locked) return cellOf(data, pid, day);
  const r = data.month.requests[pid]?.[day];
  return r ? asCell(r) : undefined;
}

function skillOk(data, p, sid, day) {
  const need = data.month.dailySkill[sid]?.[day];
  return !(need?.length && !need.some((k) => p.skills.includes(k)));
}

// 人 p が日 d に入れる「人数に数えるシフト」の一覧（出られないなら空）。数え方は案の 1 章（v3 の式と同じ見方）
export function openShifts(data, p, day) {
  const f = fixedValue(data, p.id, day);
  if (f === null) return [];
  if (f) {
    if (f.kind !== 'shift') return [];
    const s = shiftById(data, f.shift);
    return s && countedShift(s) ? [s] : [];
  }
  // 決まっていない日：前の日が決まった夜勤なら、明けになるので出られない
  const prev = day === 1 ? (p.prevLastShift ? { kind: 'shift', shift: p.prevLastShift } : null) : fixedValue(data, p.id, day - 1);
  if (prev?.kind === 'shift' && shiftById(data, prev.shift)?.night) return [];
  return data.settings.shifts.filter((s) => countedShift(s) && p.shifts.includes(s.id) && skillOk(data, p, s.id, day));
}

// その日の、人数に数えるシフトの必要人数（区分の行を合わせた数）。group を渡すと、その時間帯だけ
export function needOfDay(data, day, group = null) {
  let n = 0;
  for (const row of needRows(data)) {
    const s = shiftById(data, row.shiftId);
    if (!countedShift(s) || (group && groupOf(s) !== group)) continue;
    n += needOn(data, row.shiftId, row.emp, day).value;
  }
  return n;
}

// 日ごとの余裕。返す：[{ day, available（出られる人の数）, need, margin, people（出られる人の番号） }]
//   group を渡すと、その時間帯のシフトに入れる人と、その時間帯の必要人数で数える
export function dayMargins(data, { group = null } = {}) {
  const N = monthDays(data);
  const out = [];
  for (let day = 1; day <= N; day += 1) {
    const people = data.staff.filter((p) => openShifts(data, p, day).some((s) => !group || groupOf(s) === group)).map((p) => p.id);
    const need = needOfDay(data, day, group);
    out.push({ day, available: people.length, need, margin: people.length - need, people });
  }
  return out;
}

// スキルの日ごとの余裕：そのスキルを持ち、その時間帯の人数に数えるシフトに入れる人 − 最低人数（最低人数が 0 の時間帯は出さない）
export function skillMargins(data) {
  const N = monthDays(data);
  const out = [];
  for (const k of data.settings.skills) {
    for (const g of GROUPS) {
      const min = k.min?.[g] ?? 0;
      if (!min) continue;
      const days = [];
      for (let day = 1; day <= N; day += 1) {
        const people = data.staff.filter((p) => p.skills.includes(k.id) && openShifts(data, p, day).some((s) => groupOf(s) === g)).map((p) => p.id);
        days.push({ day, available: people.length, need: min, margin: people.length - min, people });
      }
      out.push({ skill: k.id, group: g, days });
    }
  }
  return out;
}

// きつい期間：あと何人休めるかが 1 以下の日が 2日以上続く所。返す：[{ from, to }]
export function tightRanges(margins) {
  const out = [];
  let from = null;
  margins.forEach((m, i) => {
    if (m.margin <= 1 && from === null) from = m.day;
    const ends = m.margin > 1 || i === margins.length - 1;
    if (!ends || from === null) return;
    const to = m.margin <= 1 ? m.day : m.day - 1;
    if (to > from) out.push({ from, to });
    from = null;
  });
  return out;
}

// 変える前と後を比べて、新しくできた 0 人以下の日と、新しくできた（前のどの期間にも入っていない）きつい期間
export function newTightness(before, after) {
  if (before.length !== after.length) return { zeroDays: [], ranges: [] };
  const zeroDays = after.filter((m) => m.margin <= 0 && before[m.day - 1].margin > 0).map((m) => m.day);
  const rb = tightRanges(before);
  const ranges = tightRanges(after).filter((r) => !rb.some((b) => b.from <= r.from && r.to <= b.to));
  return { zeroDays, ranges };
}
