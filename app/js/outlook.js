// 見込みと説明（v5。docs/見込みと説明の案.md）の数え方。画面には触らない。node からも使う。
// 5-1：その日に出られる人・あと何人休めるか（日ごとの余裕）・きつい期間・新しくできた 0 人の日ときつい期間。
import { monthDays, cellOf, shiftById, needRows, needOn } from './model.js?v=5.2';

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

// ---------- 5-2 人手の余り・不足の表（最大流） ----------

// 月に働ける日数の上限 W_p（案の 1 章）：その月の日数 − 人数に数えるシフトに入れない決まった日（休み・半休・明け・空き・研修 など）
//   − 明けになる日 − まだ決まっていない公休の予定 − まだ決まっていない有給の予定（切り上げ）
export function workCap(data, p) {
  const N = monthDays(data);
  let blocked = 0;
  let fixedOff = 0;
  let fixedPaid = 0;
  for (let day = 1; day <= N; day += 1) {
    const f = fixedValue(data, p.id, day);
    if (f?.kind === 'off') fixedOff += 1;
    if (f?.kind === 'paid') fixedPaid += 1;
    if (!openShifts(data, p, day).length && (f !== undefined || p.shifts.some((sid) => countedShift(shiftById(data, sid))))) blocked += 1;
  }
  const extraOff = Math.max(0, p.offDays - fixedOff);
  const extraPaid = Math.max(0, Math.ceil(p.paidDays) - fixedPaid);
  return Math.max(0, N - blocked - extraOff - extraPaid);
}

// 最大流（Dinic 法）
class Flow {
  constructor(n) {
    this.n = n;
    this.head = new Array(n).fill(-1);
    this.next = [];
    this.to = [];
    this.cap = [];
  }

  add(u, v, c) {
    for (const [a, b, cc] of [[u, v, c], [v, u, 0]]) {
      this.to.push(b);
      this.cap.push(cc);
      this.next.push(this.head[a]);
      this.head[a] = this.to.length - 1;
    }
  }

  max(s, t) {
    let flow = 0;
    const level = new Array(this.n);
    const it = new Array(this.n);
    const bfs = () => {
      level.fill(-1);
      level[s] = 0;
      const q = [s];
      for (let i = 0; i < q.length; i += 1) {
        for (let e = this.head[q[i]]; e !== -1; e = this.next[e]) {
          if (this.cap[e] > 0 && level[this.to[e]] < 0) {
            level[this.to[e]] = level[q[i]] + 1;
            q.push(this.to[e]);
          }
        }
      }
      return level[t] >= 0;
    };
    const dfs = (u, f) => {
      if (u === t) return f;
      for (; it[u] !== -1; it[u] = this.next[it[u]]) {
        const e = it[u];
        const v = this.to[e];
        if (this.cap[e] > 0 && level[v] === level[u] + 1) {
          const got = dfs(v, Math.min(f, this.cap[e]));
          if (got > 0) {
            this.cap[e] -= got;
            this.cap[e ^ 1] += got;
            return got;
          }
        }
      }
      return 0;
    };
    while (bfs()) {
      for (let i = 0; i < this.n; i += 1) it[i] = this.head[i];
      for (let f = dfs(s, Infinity); f > 0; f = dfs(s, Infinity)) flow += f;
    }
    return flow;
  }
}

// 人手の表の行：{ key, label, slots: [{ accepts(p, open) → 入れるか, need(day) → 人数 }] }
export function staffingRows(data) {
  const names = data.settings.groupNames;
  const rows = needRows(data).filter((r) => countedShift(shiftById(data, r.shiftId)));
  const slot = (r) => ({
    accepts: (p, open) => open.some((s) => s.id === r.shiftId) && (r.emp === 'all' || p.employment === r.emp),
    need: (day) => needOn(data, r.shiftId, r.emp, day).value,
  });
  const out = [{ key: 'all', label: '全体', slots: rows.map(slot) }];
  for (const g of GROUPS) {
    const rs = rows.filter((r) => groupOf(shiftById(data, r.shiftId)) === g);
    if (rs.length) out.push({ key: `group:${g}`, label: names[g], slots: rs.map(slot) });
  }
  for (const s of data.settings.shifts.filter((x) => countedShift(x) && x.onePerDay)) {
    out.push({ key: `one:${s.id}`, label: `${s.name || s.symbol}（1日1人の役）`, slots: rows.filter((r) => r.shiftId === s.id).map(slot) });
  }
  for (const k of data.settings.skills) {
    for (const g of GROUPS) {
      const min = k.min?.[g] ?? 0;
      if (!min) continue;
      out.push({
        key: `skill:${k.id}:${g}`,
        label: `${k.name}（${names[g]}）`,
        slots: [{ accepts: (p, open) => p.skills.includes(k.id) && open.some((s) => groupOf(s) === g), need: () => min }],
      });
    }
  }
  return out;
}

// 1つの行の最大流。caps：人ごとの上限（null なら上限なし）。days：数える日（null なら全部）
function rowFlow(data, row, open, caps, days) {
  const P = data.staff.length;
  const J = row.slots.length;
  const D = days.length;
  const S = 0;
  const T = 1;
  const pd = (i, k) => 2 + P + i * D + k;
  const sl = (k, j) => 2 + P + P * D + k * J + j;
  const f = new Flow(2 + P + P * D + D * J);
  let need = 0;
  days.forEach((day, k) => {
    row.slots.forEach((s, j) => {
      const n = s.need(day);
      need += n;
      if (n > 0) f.add(sl(k, j), T, n);
    });
  });
  data.staff.forEach((p, i) => {
    f.add(S, 2 + i, caps ? caps[i] : D);
    days.forEach((day, k) => {
      const o = open[i][day - 1];
      if (!o.length) return;
      let any = false;
      row.slots.forEach((s, j) => {
        if (s.accepts(p, o)) {
          f.add(pd(i, k), sl(k, j), 1);
          any = true;
        }
      });
      if (any) f.add(2 + i, pd(i, k), 1);
    });
  });
  return { flow: f.max(S, T), need };
}

// 確かめの道具のため：その行の、月全体の最大流（capped なら W_p の上限あり）
export function rowFillable(data, rowKey, { capped = true } = {}) {
  const N = monthDays(data);
  const allDays = Array.from({ length: N }, (_, i) => i + 1);
  const open = data.staff.map((p) => allDays.map((day) => openShifts(data, p, day)));
  const row = staffingRows(data).find((r) => r.key === rowKey);
  return row ? rowFlow(data, row, open, capped ? data.staff.map((p) => workCap(data, p)) : null, allDays).flow : null;
}

// 人手の余り・不足の表。返す：[{ key, label, need, available, fillable, short, spare, shortDays: [日], cutDays }]
//   fillable：W_p の上限を付けた最大流（埋められる）。shortDays：その日だけで流しても必要に届かない日。
//   cutDays：上限なしで流した数 − 上限ありで流した数（予定どおり休むと埋められない分）
export function staffingTable(data) {
  const N = monthDays(data);
  const allDays = Array.from({ length: N }, (_, i) => i + 1);
  const open = data.staff.map((p) => allDays.map((day) => openShifts(data, p, day)));
  const caps = data.staff.map((p) => workCap(data, p));
  return staffingRows(data).map((row) => {
    const capped = rowFlow(data, row, open, caps, allDays);
    let uncapped = 0;
    const shortDays = [];
    for (const day of allDays) {
      const r = rowFlow(data, row, open, null, [day]);
      uncapped += r.flow;
      if (r.flow < r.need) shortDays.push(day);
    }
    const available = data.staff.reduce((a, p, i) => {
      const can = allDays.filter((day) => row.slots.some((s) => s.accepts(p, open[i][day - 1]))).length;
      return a + Math.min(caps[i], can);
    }, 0);
    const short = Math.max(0, capped.need - capped.flow);
    return {
      key: row.key,
      label: row.label,
      need: capped.need,
      available,
      fillable: capped.flow,
      short,
      spare: short ? 0 : available - capped.need,
      shortDays,
      cutDays: Math.max(0, uncapped - capped.flow),
    };
  });
}

// 月の合計の人手（区分ごと）。返す：{ full, part, combined, total }。それぞれ { need（必要な人日）, available（出られる人日 ＝ W_p の合計。区分を合わせるシフトは null） }
export function monthTotals(data) {
  const N = monthDays(data);
  const need = { full: 0, part: 0, all: 0 };
  for (const r of needRows(data)) {
    if (!countedShift(shiftById(data, r.shiftId))) continue;
    for (let day = 1; day <= N; day += 1) need[r.emp] += needOn(data, r.shiftId, r.emp, day).value;
  }
  const avail = { full: 0, part: 0 };
  for (const p of data.staff) if (p.shifts.some((sid) => countedShift(shiftById(data, sid)))) avail[p.employment] += workCap(data, p);
  return {
    full: { need: need.full, available: avail.full },
    part: { need: need.part, available: avail.part },
    combined: { need: need.all, available: null },
    total: { need: need.full + need.part + need.all, available: avail.full + avail.part },
  };
}
