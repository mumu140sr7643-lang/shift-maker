// 見込みと説明（v5。docs/見込みと説明の案.md）の数え方。画面には触らない。node からも使う。
// 5-1：その日に出られる人・あと何人休めるか（日ごとの余裕）・きつい期間・新しくできた 0 人の日ときつい期間。
import { monthDays, cellOf, shiftById, needRows, needOn, clone, setRequest, setLock, setCellByHand, cellName } from './model.js?v=6.3';
import { unavoidableErrors, checkTable } from './check.js?v=6.3';
import { strengthOf, RULE_BY_ID } from './rules.js?v=6.3';

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
        // スキルの時間帯は、検査（スキル不足）と同じく、シフトの時間帯のグループの設定で見る（夜勤を「夜」に読みかえない）
        const people = data.staff.filter((p) => p.skills.includes(k.id) && openShifts(data, p, day).some((s) => s.group === g)).map((p) => p.id);
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
        slots: [{ accepts: (p, open) => p.skills.includes(k.id) && open.some((s) => s.group === g), need: () => min }],
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

// ---------- 5-3 どう作っても最低◯件の見込み ----------
// 希望と固定を守る表（自動で作る・直す表）が、どう作っても持つ 6連勤以上と「絶対」の件数の、少なめの数（案の 4-1）。
// 決まっているマスだけで必ず起きるものだけを数える。
// 返す：{ items: [{ rule, count, text, refs: [{ pid, day }] }], byRule: { rule: 件数 }, six, hard }
//   refs は、直し方のボタンの候補になる「決まっているマス」（希望・固定）

const restLike = new Set(['off', 'paid', 'half', 'spare', 'ake']);

function fixedRefs(data, pid, days) {
  return days.filter((day) => fixedValue(data, pid, day) !== undefined).map((day) => ({ pid, day }));
}

// 決まっていない日のうち、前の日が決まった夜勤で明けになる日か
function forcedAke(data, p, day) {
  if (fixedValue(data, p.id, day) !== undefined) return false;
  const prev = day === 1 ? (p.prevLastShift ? { kind: 'shift', shift: p.prevLastShift } : null) : fixedValue(data, p.id, day - 1);
  return prev?.kind === 'shift' && Boolean(shiftById(data, prev.shift)?.night);
}

export function lowerBound(data) {
  const N = monthDays(data);
  const md = (d) => `${data.month.month}月${d}日`;
  const who = (pid) => `${data.staff.find((p) => p.id === pid)?.name || '名前なし'}さん`;
  const items = [];
  const S = (id) => strengthOf(data, id);
  const un = unavoidableErrors(data);
  // 6連勤以上・連勤超過：あいだが全部「決まっていないマス」の続きどうしは、作った表でつながって1件になりうるので、1つにまとめる
  for (const rule of ['sixPlus', 'overStreak']) {
    if (S(rule) === 'off') continue;
    const byStaff = new Map();
    for (const it of un.filter((x) => x.rule === rule)) {
      if (!byStaff.has(it.staff)) byStaff.set(it.staff, []);
      byStaff.get(it.staff).push(it);
    }
    for (const [pid, list] of byStaff) {
      list.sort((a, b) => a.from - b.from);
      let group = [list[0]];
      const flush = () => {
        const from = group[0].from;
        const to = group[group.length - 1].to;
        const days = [];
        for (let d = Math.max(1, from - 1); d <= to; d += 1) days.push(d);
        items.push({ rule, count: 1, staff: pid, text: `${who(pid)}の${from < 1 ? '前の月' : md(from)}〜${md(to)}は、希望・固定・前の月の続きだけで${RULE_BY_ID[rule].name}になります`, refs: fixedRefs(data, pid, days) });
      };
      for (let i = 1; i < list.length; i += 1) {
        const prev = group[group.length - 1];
        let free = true;
        for (let d = prev.to + 1; d < list[i].from; d += 1) if (fixedValue(data, pid, d) !== undefined) free = false;
        if (free) group.push(list[i]);
        else {
          flush();
          group = [list[i]];
        }
      }
      flush();
    }
  }
  // 遅い→早い・2連休が足りない：決まっている2日（3日）でできるもの
  for (const it of un.filter((x) => x.rule === 'lateToEarly' || x.rule === 'twoOffLateEarly')) {
    if (S(it.rule) === 'off') continue;
    const days = it.rule === 'lateToEarly' ? [it.day - 1, it.day] : [it.day - 1, it.day, it.day + 1];
    items.push({ rule: it.rule, count: 1, staff: it.staff, day: it.day, text: it.text, refs: fixedRefs(data, it.staff, days.filter((d) => d >= 1 && d <= N)) });
  }
  const allDays = Array.from({ length: N }, (_, i) => i + 1);
  const open = data.staff.map((p) => allDays.map((day) => openShifts(data, p, day)));
  // 人員不足：日ごとに「そのシフトだけで足りないシフトの数」と「その日の最大流が届かなければ 1」の大きいほう
  if (S('shortage') !== 'off') {
    const rowAll = staffingRows(data).find((r) => r.key === 'all');
    const nrows = needRows(data).filter((r) => countedShift(shiftById(data, r.shiftId)));
    for (const day of allDays) {
      const shortShifts = new Set();
      for (const r of nrows) {
        const need = needOn(data, r.shiftId, r.emp, day).value;
        if (!need) continue;
        const can = data.staff.filter((p, i) => open[i][day - 1].some((s) => s.id === r.shiftId) && (r.emp === 'all' || p.employment === r.emp)).length;
        if (can < need) shortShifts.add(r.shiftId);
      }
      const f = rowAll ? rowFlow(data, rowAll, open, null, [day]) : { flow: 0, need: 0 };
      const count = Math.max(shortShifts.size, f.flow < f.need ? 1 : 0);
      if (!count) continue;
      // 直し方の候補：その日に休み・別のシフト・空きに決まっている、人数に数えるシフトを担当する人のマス
      const refs = data.staff.filter((p) => p.shifts.some((sid) => countedShift(shiftById(data, sid)))).flatMap((p) => {
        const v = fixedValue(data, p.id, day);
        return v !== undefined && (v === null || restLike.has(v.kind) || (v.kind === 'shift' && !shortShifts.has(v.shift))) ? [{ pid: p.id, day }] : [];
      });
      const names = [...shortShifts].map((sid) => shiftById(data, sid)?.symbol).join('・');
      items.push({ rule: 'shortage', count, day, text: `${md(day)}は、出られる人だけでは${names ? `「${names}」が` : '必要人数が'}埋まりません（埋められるのは ${f.flow}人ぶん・必要 ${f.need}人）`, refs });
    }
  }
  // スキル不足：日と時間帯ごとに、そのスキルを持ち出られる人が最低人数より少ない（時間帯は検査と同じくシフトの設定で見る）
  if (S('skillShort') !== 'off') {
    for (const k of data.settings.skills) {
      for (const g of GROUPS) {
        const min = k.min?.[g] ?? 0;
        if (!min) continue;
        for (const day of allDays) {
          const have = data.staff.filter((p, i) => p.skills.includes(k.id) && open[i][day - 1].some((s) => s.group === g)).length;
          if (have >= min) continue;
          const refs = data.staff.filter((p) => p.skills.includes(k.id)).flatMap((p) => (fixedValue(data, p.id, day) !== undefined ? [{ pid: p.id, day }] : []));
          items.push({ rule: 'skillShort', count: 1, day, text: `${md(day)}の${data.settings.groupNames[g]}は、「${k.name}」ができて出られる人が${have}人です（最低${min}人）`, refs });
        }
      }
    }
  }
  // 公休が足りない：公休にできる日（決まっていない日・公休に決まっている日。明けになる日は除く）が、公休の予定より少ない
  if (S('offShort') !== 'off') {
    for (const p of data.staff) {
      let can = 0;
      for (const day of allDays) {
        const v = fixedValue(data, p.id, day);
        if (v?.kind === 'off' || (v === undefined && !forcedAke(data, p, day))) can += 1;
      }
      if (can >= p.offDays) continue;
      const refs = allDays.flatMap((day) => {
        const v = fixedValue(data, p.id, day);
        return v !== undefined && v?.kind !== 'off' ? [{ pid: p.id, day }] : [];
      });
      items.push({ rule: 'offShort', count: 1, staff: p.id, text: `${who(p.id)}は、希望・固定のとおりだと公休を${can}日しか取れません（予定${p.offDays}日）`, refs });
    }
  }
  const byRule = {};
  for (const it of items) byRule[it.rule] = (byRule[it.rule] ?? 0) + it.count;
  const six = byRule.sixPlus ?? 0;
  const hard = Object.entries(byRule).filter(([r]) => r !== 'sixPlus' && S(r) === 'hard').reduce((a, [, n]) => a + n, 0);
  return { items, byRule, six, hard };
}

// 作った表の件数（checkTable の結果）が、見込みの最低件数に届いているか（6連勤以上の件数と絶対の件数の合計が、見込みと同じ）。
// 画面の「見込みの最低件数に届いています」と、測る道具（tools/careful-bench.mjs）で同じものを使う
export function reachedLowerBound(res, lb) {
  return !res.tableEmpty && res.totals.sixPlus === lb.six && res.totals.hard === lb.hard;
}

// 直し方のボタン（案の 4-2）：理由のマスの希望・固定を、写しで外して見込みを数え直し、最低件数が減るものだけ（1つの理由に3つまで）。
// 返す：[{ pid, day, kind: 'request' | 'lock', label, before: { six, hard }, after: { six, hard } }]
export function fixesFor(data, item, base = lowerBound(data)) {
  const out = [];
  const md = (d) => `${data.month.month}月${d}日`;
  for (const ref of item.refs) {
    if (out.length >= 3) break;
    const p = data.staff.find((x) => x.id === ref.pid);
    const locked = Boolean(data.month.marks[ref.pid]?.[ref.day]?.locked);
    const r = data.month.requests[ref.pid]?.[ref.day];
    if (!locked && !r) continue;
    const fix = { pid: ref.pid, day: ref.day, kind: locked ? 'lock' : 'request' };
    const copy = clone(data);
    applyFix(copy, fix);
    const after = lowerBound(copy);
    if (after.six + after.hard >= base.six + base.hard) continue;
    fix.label = locked
      ? `${p?.name || '名前なし'}さんの${md(ref.day)}の固定（${cellName(data, cellOf(data, ref.pid, ref.day))}）を外す`
      : `${p?.name || '名前なし'}さんの${md(ref.day)}の希望（${cellName(data, r)}）を外す`;
    fix.before = { six: base.six, hard: base.hard };
    fix.after = { six: after.six, hard: after.hard };
    out.push(fix);
  }
  return out;
}

// 直し方のボタンを当てる
export function applyFix(data, fix) {
  if (fix.kind === 'lock') setLock(data, fix.pid, fix.day, false);
  else setRequest(data, fix.pid, fix.day, null);
}

// ---------- 5-3 不足の理由（理由を見る） ----------
// 足りないマス（日・シフト）について、人ごとに、なぜ入っていないか（案の 4-3）。決まっていない人は写しの表に入れて検査し、
// いまの表より増える 6連勤以上・絶対の決まりを理由にする（本物の表は変えない）。
// 返す：[{ pid, name, status: 'can' | 'add' | 'blocked', text }]（入れられる人から並べる）
export function reasonsFor(data, day, shiftId) {
  const s = shiftById(data, shiftId);
  const severe = (res) => {
    const m = {};
    for (const [rule, v] of Object.entries(res.byRule)) if (v.strength === 'hard' || v.strength === 'always') m[rule] = v.count;
    return m;
  };
  const baseRes = checkTable(data);
  const before = severe(baseRes);
  const shortOf = (res) => res.items.find((it) => it.rule === 'shortage' && it.day === day && it.shift === shiftId)?.amount ?? 0;
  const baseShort = shortOf(baseRes);
  // 写しで入れてみる。返す：{ more: 増える決まりの名前, fills: 足りない分が減るか }
  const added = (p) => {
    const copy = clone(data);
    setCellByHand(copy, p.id, day, { kind: 'shift', shift: shiftId });
    const res = checkTable(copy);
    const after = severe(res);
    const more = Object.entries(after).filter(([rule, n]) => rule !== 'notAssigned' && rule !== 'shortage' && n > (before[rule] ?? 0)).map(([rule]) => RULE_BY_ID[rule].name);
    // 人員不足は、この枠が埋まってもほかの日・シフトで増えることがあるので、全部の足りない人数で比べる
    const shortAll = (r) => r.items.filter((it) => it.rule === 'shortage').reduce((a2, it) => a2 + it.amount, 0);
    if (shortAll(res) >= shortAll(baseRes) && shortOf(res) < baseShort) more.push(RULE_BY_ID.shortage.name);
    return { more, fills: shortOf(res) < baseShort };
  };
  // この日このシフトで足りない区分（区分を分けて数えるシフトのとき）
  const shortEmps = needRows(data).filter((r) => r.shiftId === shiftId && r.emp !== 'all').filter((r) => {
    const got = data.staff.filter((q) => q.employment === r.emp && cellOf(data, q.id, day)?.kind === 'shift' && cellOf(data, q.id, day).shift === shiftId).length;
    return got < needOn(data, shiftId, r.emp, day).value;
  }).map((r) => r.emp);
  const out = [];
  for (const p of data.staff) {
    const name = `${p.name || '名前なし'}さん`;
    const cur = cellOf(data, p.id, day);
    if (cur?.kind === 'shift' && cur.shift === shiftId) continue;
    const f = fixedValue(data, p.id, day);
    const locked = Boolean(data.month.marks[p.id]?.[day]?.locked);
    let text = null;
    if (f === null) text = '空きのまま固定しています';
    else if (f) text = locked ? `${cellName(data, f)}に固定しています` : `${cellName(data, f)}の希望があります`;
    else if (forcedAke(data, p, day) || (cur?.kind === 'ake' && day > 1 && cellOf(data, p.id, day - 1)?.kind === 'shift' && shiftById(data, cellOf(data, p.id, day - 1).shift)?.night)) text = '前の日が夜勤なので、明けです';
    else {
      const need = data.month.dailySkill[shiftId]?.[day];
      if (need?.length && !need.some((k) => p.skills.includes(k))) text = `この日の「${s?.symbol}」に要るスキルを持っていません`;
    }
    if (text) {
      out.push({ pid: p.id, name, status: 'blocked', text });
      continue;
    }
    const { more, fills } = added(p);
    const now = cur ? `いまは${cellName(data, cur)}` : 'いまは空き';
    if (!fills) {
      const empText = shortEmps.length && !shortEmps.includes(p.employment)
        ? `足りないのは${shortEmps.map((e) => data.settings.employmentNames[e]).join('・')}の枠なので、入れても埋まりません`
        : '入れても、この日の足りない分は埋まりません';
      out.push({ pid: p.id, name, status: 'blocked', text: `${empText}（${now}）` });
      continue;
    }
    if (!p.shifts.includes(shiftId)) {
      out.push({ pid: p.id, name, status: more.length ? 'blocked' : 'add', text: more.length ? `担当していません（担当を足しても、入れると${more.join('・')}が増えます）` : `担当していません。担当を足せば入れられます（${now}）` });
    } else {
      out.push({ pid: p.id, name, status: more.length ? 'blocked' : 'can', text: more.length ? `入れると、${more.join('・')}が増えます（${now}）` : `入れられます（${now}）` });
    }
  }
  const order = { can: 0, add: 1, blocked: 2 };
  return out.sort((a, b) => order[a.status] - order[b.status]);
}
