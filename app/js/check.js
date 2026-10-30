// 決まりの検査と、良し悪しの比べ方（docs/数え方の表.md の 2 章・3 章）。
// 画面には触らない。ブラウザでも node（tools/count.mjs）でも同じものを使う。
import { RULES, strengthOf, cellTraits, isRestKind } from './rules.js?v=2.3.1';
import { monthDays, shiftById, rankOrder, needOn, cellOf, cellName } from './model.js?v=2.3.1';
import { weekdayOf } from './calendar.js?v=2.3.1';

const GROUP_IDS = ['early', 'late', 'night'];

// シフト表を検査する。返す形は docs/数え方の表.md の 4 章のとおり
export function checkTable(data) {
  const nDays = monthDays(data);
  const { year, month } = data.month;
  const staff = data.staff;
  const shifts = data.settings.shifts;
  const work = data.settings.work;
  const groupNames = data.settings.groupNames;
  const at = (pid, day) => cellOf(data, pid, day);
  const md = (d) => `${month}月${d}日`;
  const who = (p) => `${p.name || '名前なし'}さん`;
  const sym = (id) => shiftById(data, id)?.symbol ?? '?';
  const ord = (p) => {
    const i = p.rank ? rankOrder(data, p.rank) : -1;
    return i >= 0 ? i : Infinity;
  };

  let filled = 0;
  let spare = 0;
  for (const days of Object.values(data.month.table)) {
    for (const v of Object.values(days)) {
      filled += 1;
      if (v.kind === 'spare') spare += 1;
    }
  }
  const tableEmpty = filled === 0;
  const raw = [];
  const add = (rule, fields) => raw.push({ rule, ...fields });

  if (!tableEmpty) {
    // ---------- 人数を見る決まり（日ごと） ----------
    for (let d = 1; d <= nDays; d += 1) {
      const present = [];
      for (const p of staff) {
        const v = at(p.id, d);
        if (v?.kind !== 'shift') continue;
        const s = shiftById(data, v.shift);
        if (s) present.push({ p, s, t: cellTraits(data, v) });
      }
      for (const s of shifts) {
        const inS = present.filter((x) => x.s.id === s.id);
        if (s.counts && !s.training) {
          let short = 0;
          let over = 0;
          const parts = [];
          for (const emp of s.combine ? ['all'] : ['full', 'part']) {
            const need = needOn(data, s.id, emp, d).value;
            const got = emp === 'all' ? inS.length : inS.filter((x) => x.p.employment === emp).length;
            short += Math.max(0, need - got);
            over += Math.max(0, got - need);
            parts.push({ emp, need, got });
          }
          const detail = parts.map((x) => `${x.emp === 'all' ? '' : data.settings.employmentNames[x.emp]}${x.got}人（必要${x.need}人）`).join('、');
          if (short > 0) add('shortage', { day: d, shift: s.id, amount: short, text: `${md(d)}「${s.symbol}」が${short}人足りません（${detail}）` });
          if (over > 0) add('overstaff', { day: d, shift: s.id, amount: over, text: `${md(d)}「${s.symbol}」が${over}人多いです（${detail}）` });
        }
        if (s.onePerDay && inS.length > 1) {
          add('onePerDayDup', { day: d, shift: s.id, amount: inS.length - 1, text: `${md(d)}「${s.symbol}」は1日1人の役ですが、${inS.length}人入っています` });
        }
      }
      for (const g of GROUP_IDS) {
        const inG = present.filter((x) => x.t.counts && x.s.group === g);
        for (const k of data.settings.skills) {
          const have = inG.filter((x) => x.p.skills.includes(k.id)).length;
          if (k.min[g] > 0 && have < k.min[g]) {
            add('skillShort', { day: d, group: g, skill: k.id, amount: k.min[g] - have, text: `${md(d)} ${groupNames[g]}の「${k.name}」ができる人が${have}人（最低${k.min[g]}人）` });
          } else if (k.target[g] > 0 && have < k.target[g]) {
            add('skillTarget', { day: d, group: g, skill: k.id, amount: k.target[g] - have, text: `${md(d)} ${groupNames[g]}の「${k.name}」ができる人が${have}人（目標${k.target[g]}人）` });
          }
        }
        const inRole = inG.filter((x) => x.s.onePerDay);
        if (inRole.length) {
          const best = Math.min(...inG.map((x) => ord(x.p)));
          if (Math.min(...inRole.map((x) => ord(x.p))) > best) {
            add('leaderRank', { day: d, group: g, text: `${md(d)} ${groupNames[g]}の1日1人の役に、いちばん順位が上の人が入っていません` });
          }
        }
      }
      for (const sd of data.month.special.filter((x) => x.day === d)) {
        for (const rn of sd.rankNeeds) {
          const limit = rankOrder(data, rn.rank);
          const have = present.filter((x) => x.t.counts && ord(x.p) <= limit).length;
          if (have < rn.count) {
            const rname = data.settings.ranks[limit]?.name ?? '?';
            add('specialRank', { day: d, special: sd.id, rank: rn.rank, amount: rn.count - have, text: `${md(d)}（${sd.name}）は「${rname}」以上の人が${have}人（決めた人数は${rn.count}人）` });
          }
        }
      }
      for (const [sid, days] of Object.entries(data.month.dailySkill)) {
        const list = days[d];
        if (!list?.length) continue;
        for (const x of present.filter((y) => y.s.id === sid)) {
          if (!list.some((k) => x.p.skills.includes(k))) {
            add('dailySkill', { day: d, staff: x.p.id, shift: sid, text: `${md(d)} ${who(x.p)}は、この日の「${sym(sid)}」に要るスキルを持っていません` });
          }
        }
      }
    }

    // ---------- 人ごとの決まり ----------
    for (const p of staff) {
      const v = (d) => at(p.id, d);
      const tr = (d) => cellTraits(data, v(d));
      const prevShift = p.prevLastShift && p.prevLastShift !== 'off' ? shiftById(data, p.prevLastShift) : null;
      const prevKnown = p.prevConsecutive > 0 || p.prevLastShift !== null;
      const prevClass = !prevKnown ? 'U' : p.prevConsecutive > 0 || prevShift ? 'W' : 'R';
      const prevGroup = prevShift ? (prevShift.night ? 'night' : prevShift.group) : null;
      const cls = (d) => (d === 0 ? prevClass : tr(d).single);
      const groupAt = (d) => (d === 0 ? prevGroup : tr(d).group);

      // 連勤
      const streaks = [];
      let from = null;
      let len = 0;
      for (let d = 1; d <= nDays; d += 1) {
        if (tr(d).streakWork) {
          if (len === 0) {
            from = d;
            if (d === 1 && p.prevConsecutive > 0) {
              from = 1 - p.prevConsecutive;
              len = p.prevConsecutive;
            }
          }
          len += 1;
        } else if (len) {
          streaks.push({ from, to: d - 1, len });
          len = 0;
        }
      }
      if (len) streaks.push({ from, to: nDays, len });
      const limit = p.maxConsecutive ?? work.maxConsecutive;
      for (const st of streaks) {
        const span = `${st.from < 1 ? '前の月' : md(st.from)}〜${md(st.to)}`;
        if (st.len > limit) add('overStreak', { staff: p.id, from: st.from, to: st.to, amount: st.len - limit, text: `${who(p)}の${span}が${st.len}連勤（上限${limit}日）` });
        if (st.len >= 6) add('sixPlus', { staff: p.id, from: st.from, to: st.to, amount: st.len, text: `${who(p)}の${span}が${st.len}連勤です（6連勤以上は働きすぎの目安）` });
        let last = null;
        for (let d = Math.max(1, st.from); d <= st.to; d += 1) {
          const g = tr(d).switchGroup;
          if (!g) continue;
          if (last && g !== last) add('switchInStreak', { staff: p.id, day: d, text: `${who(p)}の${md(d)}、続けて出勤している途中で${groupNames[last]}から${groupNames[g]}に変わります` });
          last = g;
        }
      }

      // 時間帯
      let changes = 0;
      let lastG = null;
      let early = 0;
      let late = 0;
      for (let d = 1; d <= nDays; d += 1) {
        const g = tr(d).switchGroup;
        if (g) {
          if (lastG && g !== lastG) changes += 1;
          lastG = g;
        }
        const grp = tr(d).group;
        if (grp === 'early') early += 1;
        if (grp === 'late') late += 1;
        if (groupAt(d - 1) === 'late' && grp === 'early') {
          add('lateToEarly', { staff: p.id, day: d, text: `${who(p)}の${md(d)}、遅い時間帯の次の日に早い時間帯です` });
        }
        if (d < nDays && isRestKind(v(d)) && groupAt(d - 1) === 'late' && tr(d + 1).group === 'early') {
          if (p.twoOffAfterLateEarly) {
            add('twoOffLateEarly', { staff: p.id, day: d, text: `${who(p)}の${md(d)}、遅い→早いの間の休みが1日だけです（この人は2連休にする設定）` });
          } else {
            add('lateOffEarly', { staff: p.id, day: d, text: `${who(p)}の${md(d)}、1日だけ休んで遅い時間帯から早い時間帯に変わります` });
          }
        }
        if ((p.groupPref === 'early' && (grp === 'late' || grp === 'night')) || (p.groupPref === 'late' && grp === 'early')) {
          add('groupPref', { staff: p.id, day: d, text: `${who(p)}の${md(d)}は「${sym(v(d).shift)}」ですが、時間帯の希望は${p.groupPref === 'early' ? '早い時間帯だけ' : '遅い時間帯だけ'}です` });
        }
      }
      if (changes > work.maxSwitches) {
        add('switchCount', { staff: p.id, amount: changes - work.maxSwitches, text: `${who(p)}は時間帯の切り替えが${changes}回（上限${work.maxSwitches}回）` });
      }
      if (p.groupPref === 'any') {
        const over = p.biasPref === 'even' ? Math.abs(early - late) - work.biasAllowance
          : p.biasPref === 'early' ? late - early - work.biasAllowance
            : early - late - work.biasAllowance;
        if (over > 0) add('bias', { staff: p.id, amount: over, text: `${who(p)}は早い時間帯${early}日・遅い時間帯${late}日で、偏りが許す日数（${work.biasAllowance}日）を${over}日超えています` });
      }

      // 休みの並び
      for (let d = 1; d < nDays; d += 1) {
        const a = cls(d - 1);
        const b = cls(d + 1);
        if (cls(d) === 'W' && !tr(d).night && a === 'R' && b === 'R') {
          add('singleWork', { staff: p.id, day: d, text: `${who(p)}の${md(d)}は、前後が休みの1日だけの出勤です` });
        }
        if (isRestKind(v(d)) && a === 'W' && b === 'W') {
          add('singleOff', { staff: p.id, day: d, text: `${who(p)}の${md(d)}は、前後が出勤の1日だけの休みです` });
          if (p.restStyle === 'together') add('restStyle', { staff: p.id, day: d, text: `${who(p)}の${md(d)}は1日だけの休みですが、休み方の希望は「連休にしたい」です` });
        }
      }
      const runs = [];
      let rs = null;
      for (let d = 1; d <= nDays + 1; d += 1) {
        if (d <= nDays && isRestKind(v(d))) {
          if (rs === null) rs = d;
        } else if (rs !== null) {
          runs.push({ from: rs, to: d - 1, len: d - rs });
          rs = null;
        }
      }
      const long = work.restRun + 2;
      for (const r of runs) {
        if (r.len > long) add('longRest', { staff: p.id, from: r.from, to: r.to, amount: r.len - long, text: `${who(p)}の${md(r.from)}〜${md(r.to)}は${r.len}連休です（連休の目安${work.restRun}日より3日以上長い）` });
        if (p.restStyle === 'spread' && r.len >= 3) add('restStyle', { staff: p.id, from: r.from, to: r.to, text: `${who(p)}の${md(r.from)}〜${md(r.to)}は${r.len}連休ですが、休み方の希望は「ばらしたい」です` });
      }
      if (p.offDays >= work.restRun) {
        const need = p.restStyle === 'together' ? 2 : 1;
        const have = runs.filter((r) => r.len >= work.restRun).length;
        if (have < need) add('fewRestRuns', { staff: p.id, amount: need - have, text: `${who(p)}は${work.restRun}日以上の連休が${have}回です（${need}回ほしい）` });
      }
      for (let d = 1; d <= nDays; d += 1) {
        const wd = weekdayOf(year, month, d);
        if (wd !== 0 && wd !== 6) continue;
        if (p.weekendPref === 'off' && tr(d).workDay === 1) add('weekend', { staff: p.id, day: d, text: `${who(p)}の${md(d)}（土日）は出勤ですが、土日は休みたい人です` });
        if (p.weekendPref === 'work' && isRestKind(v(d))) add('weekend', { staff: p.id, day: d, text: `${who(p)}の${md(d)}（土日）は休みですが、土日に出たい人です` });
      }

      // 人ごとの日数
      let off = 0;
      let paid = 0;
      for (let d = 1; d <= nDays; d += 1) {
        const k = v(d)?.kind;
        if (k === 'off') off += 1;
        if (k === 'paid') paid += 1;
        if (k === 'half') paid += 0.5;
      }
      if (off < p.offDays) add('offShort', { staff: p.id, amount: p.offDays - off, text: `${who(p)}の公休が${off}日（予定${p.offDays}日。${p.offDays - off}日足りません）` });
      if (paid !== p.paidDays) add('paidDiff', { staff: p.id, amount: Math.abs(paid - p.paidDays), diff: paid - p.paidDays, text: `${who(p)}の有給が${paid}日（設定${p.paidDays}日）` });

      // 1マス
      for (let d = 1; d <= nDays; d += 1) {
        const c = v(d);
        if (c?.kind === 'shift' && !p.shifts.includes(c.shift)) add('notAssigned', { staff: p.id, day: d, shift: c.shift, text: `${who(p)}の${md(d)}の「${sym(c.shift)}」は、担当できるシフトではありません` });
        const restNext = (x) => Boolean(x && (x.kind === 'ake' || isRestKind(x)));
        if (d === 1 && prevShift?.night && !restNext(c)) add('nightNext', { staff: p.id, day: 1, text: `${who(p)}は前の月の最後が夜勤ですが、${md(1)}が休みではありません` });
        if (d < nDays && tr(d).night && !restNext(v(d + 1))) add('nightNext', { staff: p.id, day: d + 1, text: `${who(p)}の${md(d)}は夜勤ですが、次の日が休みではありません` });
      }
      for (const [day, r] of Object.entries(data.month.requests[p.id] ?? {})) {
        const c = v(Number(day));
        // 空きのマスは、まだ作っていないだけなので数えない
        const same = c && c.kind === r.kind && (r.kind !== 'shift' || c.shift === r.shift);
        if (c && !same) add('requestDiff', { staff: p.id, day: Number(day), text: `${who(p)}の${md(Number(day))}は、希望が「${cellName(data, r)}」ですが、表は「${cellName(data, c)}」です` });
      }
    }
  }

  // 強さを付け、なしの決まりを外し、決まった順に並べる
  const ruleIndex = Object.fromEntries(RULES.map((r, i) => [r.id, i]));
  const staffIndex = Object.fromEntries(staff.map((p, i) => [p.id, i]));
  const shiftIndex = Object.fromEntries(shifts.map((s, i) => [s.id, i]));
  const items = raw
    .map((it) => ({ ...it, strength: strengthOf(data, it.rule) }))
    .filter((it) => it.strength !== 'off')
    .map((it) => ({
      rule: it.rule,
      strength: it.strength,
      staff: it.staff ?? null,
      ...Object.fromEntries(Object.entries(it).filter(([k]) => !['rule', 'strength', 'staff', 'text'].includes(k))),
      text: it.text,
    }))
    .sort((a, b) =>
      ruleIndex[a.rule] - ruleIndex[b.rule]
      || (a.day ?? a.from ?? 0) - (b.day ?? b.from ?? 0)
      || (staffIndex[a.staff] ?? -1) - (staffIndex[b.staff] ?? -1)
      || (shiftIndex[a.shift] ?? -1) - (shiftIndex[b.shift] ?? -1)
      || (a.group ?? '').localeCompare(b.group ?? '')
      || (a.skill ?? '').localeCompare(b.skill ?? ''));

  const byRule = {};
  for (const r of RULES) {
    const mine = items.filter((it) => it.rule === r.id);
    byRule[r.id] = { strength: strengthOf(data, r.id), count: mine.length, amount: mine.reduce((sum, it) => sum + (it.amount ?? 0), 0) };
  }
  const sumBy = (strength) => RULES.filter((r) => r.id !== 'sixPlus' && byRule[r.id].strength === strength).reduce((s, r) => s + byRule[r.id].count, 0);
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    tableEmpty,
    totals: {
      sixPlus: byRule.sixPlus.count,
      hard: sumBy('hard'),
      soft: sumBy('soft'),
      spare,
      shortSlots: byRule.shortage.strength === 'off' ? 0 : byRule.shortage.amount,
      empty: staff.length * nDays - filled,
    },
    byRule,
    items,
  };
}

// ---------- 希望だけで必ずエラーになるもの（手順4の知らせ。v3 の解く前の確かめにも使う） ----------

// 希望の表だけでシフト表を作ったつもりで検査し、どう作ってもなくならない「絶対」と6連勤以上だけを返す。
// 希望の無い日は空き（連勤も組も切る）なので、希望どうしでできる続き・組だけが残る。
const INEVITABLE = new Set(['notAssigned', 'dailySkill', 'sixPlus', 'overStreak', 'lateToEarly', 'twoOffLateEarly', 'nightNext']);

export function requestConflicts(data) {
  const table = {};
  for (const [pid, days] of Object.entries(data.month.requests)) {
    for (const [day, r] of Object.entries(days)) {
      (table[pid] ??= {})[day] = r.kind === 'shift' ? { kind: 'shift', shift: r.shift } : { kind: r.kind };
    }
  }
  const res = checkTable({ ...data, month: { ...data.month, table, marks: {} } });
  if (res.tableEmpty) return [];
  const reqAt = (pid, day) => data.month.requests[pid]?.[day];
  return res.items.filter((it) => {
    if (!INEVITABLE.has(it.rule) || (it.strength !== 'hard' && it.strength !== 'always')) return false;
    if (it.rule !== 'nightNext') return true;
    // 夜勤の次の日は、出勤の希望が入っているときだけ（空いていれば明けにできる）
    const r = reqAt(it.staff, it.day);
    return Boolean(r && r.kind !== 'off' && r.kind !== 'paid');
  });
}

// ---------- 良し悪しの比べ方（数え方の表の 3 章） ----------

const hardRules = (res) => RULES.filter((r) => r.id !== 'sixPlus' && res.byRule[r.id].strength === 'hard').map((r) => r.id);
const amountIfOn = (res, id) => (res.byRule[id].strength === 'off' ? 0 : res.byRule[id].amount);
const sixRuns = (res) => res.items.filter((it) => it.rule === 'sixPlus');

// before から after に変えて「改善した」と言えるか
export function isImproved(before, after) {
  const hard = hardRules(after);
  const cnt = (res, id) => res.byRule[id].count;
  if (hard.some((id) => cnt(after, id) > cnt(before, id))) return false;
  if (amountIfOn(after, 'overStreak') > amountIfOn(before, 'overStreak')) return false;
  const b6 = sixRuns(before);
  const a6 = sixRuns(after);
  if (a6.length > b6.length) return false;
  if (!a6.every((a) => b6.some((b) => b.staff === a.staff && a.from >= b.from && a.to <= b.to))) return false;
  if (amountIfOn(after, 'offShort') > amountIfOn(before, 'offShort')) return false;
  const hardSame = hard.every((id) => cnt(after, id) === cnt(before, id));
  return (
    hard.some((id) => cnt(after, id) < cnt(before, id))
    || amountIfOn(after, 'overStreak') < amountIfOn(before, 'overStreak')
    || a6.length < b6.length
    || amountIfOn(after, 'offShort') < amountIfOn(before, 'offShort')
    || (hardSame && after.totals.soft < before.totals.soft)
  );
}

// 並べる順（小さいほうが良い）
export function rankKey(res) {
  return [
    res.totals.sixPlus,
    res.byRule.shortage.strength === 'off' ? 0 : res.byRule.shortage.count,
    res.totals.hard,
    amountIfOn(res, 'overStreak'),
    amountIfOn(res, 'offShort'),
    res.totals.soft,
  ];
}

export function compareResults(a, b) {
  const ka = rankKey(a);
  const kb = rankKey(b);
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}
