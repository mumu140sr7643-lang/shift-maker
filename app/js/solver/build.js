// 自動で作るときの式を作る（docs/自動で作る案.md の 2〜4 章）。画面には触らない。ブラウザでも node でも使う。
// 式は HiGHS が読める「LP の文」の形で作る。どの答えを採るかは、できた表を check.js で数えて決める。
import { shiftById, monthDays, needOn, rankOrder, cellOf } from '../model.js?v=5.2';
import { strengthOf } from '../rules.js?v=5.2';
import { weekdayOf } from '../calendar.js?v=5.2';

// 段の順番。rules が '*hard' / '*soft' の段は、ほかの段に入らない決まりをまとめる
export const STAGES = [
  { key: 'sixPlus', name: '6連勤以上', rules: ['sixPlus'] },
  { key: 'shortage', name: '人員不足', rules: ['shortage'] },
  { key: 'offShort', name: '公休が足りない', rules: ['offShort'] },
  { key: 'overStreak', name: '連勤超過', rules: ['overStreak'] },
  { key: 'hard', name: 'ほかの「絶対」の決まり', rules: '*hard' },
  { key: 'soft', name: '「できれば」の決まり', rules: '*soft' },
];
const OWN_STAGE = new Set(['sixPlus', 'shortage', 'offShort', 'overStreak']);
// 式で縛るので段に入れない決まり／1分で作るの式に入れない決まり
const NOT_IN_STAGES = new Set(['notAssigned', 'dailySkill', 'nightNext', 'requestDiff', 'leaderRank']);
const SPARE_WEIGHT = 0.5;
const CHANGE_WEIGHT = 0.001;

// 1次の式：変数の名前 → 係数 と、定数
class Lin {
  constructor() {
    this.t = new Map();
    this.c = 0;
  }

  add(x, k = 1) {
    if (x === null || x === undefined || k === 0) return this;
    if (typeof x === 'number') this.c += x * k;
    else if (x instanceof Lin) {
      for (const [v, a] of x.t) this.t.set(v, (this.t.get(v) ?? 0) + a * k);
      this.c += x.c * k;
    } else this.t.set(x, (this.t.get(x) ?? 0) + k);
    return this;
  }

  get isConst() {
    for (const a of this.t.values()) if (a !== 0) return false;
    return true;
  }
}
const lin = (...xs) => {
  const l = new Lin();
  for (const x of xs) l.add(x);
  return l;
};

const fmt = (a) => {
  const r = Math.round(a * 1e6) / 1e6;
  return String(r);
};
function terms(l) {
  const parts = [];
  for (const [v, a] of l.t) {
    if (a === 0) continue;
    parts.push(`${a < 0 ? '-' : '+'} ${fmt(Math.abs(a))} ${v}`);
  }
  return parts.length ? parts.join(' ').replace(/^\+ /, '') : '0 zero';
}

// 手で固定したマス（錠）か希望で、値が決まっているマス。undefined なら決まっていない。null は空きのまま固定
function fixedCellOf(data, pid, day) {
  const m = data.month.marks[pid]?.[day];
  if (m?.locked) return cellOf(data, pid, day);
  const r = data.month.requests[pid]?.[day];
  if (r) return r.kind === 'shift' ? { kind: 'shift', shift: r.shift } : { kind: r.kind };
  return undefined;
}

// keepCurrent：エラーを自動で直す（4-2）ときだけ。いまの表の値から変わるマスを数え、「できれば」の段で少しだけ減らす
// changeLimit：そのとき、変わるマスの数の上限（null なら上限なし）
export function buildModel(data, { leaderWeight = 0, keepCurrent = false, changeLimit = null } = {}) {
  const N = monthDays(data);
  const { year, month } = data.month;
  const work = data.settings.work;
  const shifts = data.settings.shifts;
  const groupOf = (s) => (s.night ? 'night' : s.group); // 遅い→早い などで使う（夜勤は「夜」）
  const bin = new Set();
  const cont = new Set(['zero']);
  const cons = [];
  const pen = {}; // 決まり → Lin（違反の量）
  let nz = 0;
  const S = (id) => strengthOf(data, id);
  const on = (id) => S(id) !== 'off';
  const slack = (rule, k = 1) => {
    const v = `z${nz}`;
    nz += 1;
    cont.add(v);
    (pen[rule] ??= new Lin()).add(v, k);
    return v;
  };
  const addPen = (rule, l, k = 1) => (pen[rule] ??= new Lin()).add(l, k);
  // l op rhs を足す（定数は右へ）。変数の無い式は、満たしていれば足さない
  const con = (l, op, rhs) => {
    const r = rhs - l.c;
    if (l.isConst) {
      const ok = op === '<=' ? 0 <= r + 1e-9 : op === '>=' ? 0 >= r - 1e-9 : Math.abs(r) < 1e-9;
      if (ok) return;
    }
    cons.push(`${terms(l)} ${op} ${fmt(r)}`);
  };
  // 違反の量：l ≦ rhs ＋ z（z を決まりの量に足す）
  const softLe = (rule, l, rhs) => {
    if (l.isConst) {
      if (l.c > rhs) addPen(rule, l.c - rhs);
      return;
    }
    const z = slack(rule);
    con(lin(l).add(z, -1), '<=', rhs);
  };
  const softGe = (rule, l, rhs) => {
    if (l.isConst) {
      if (l.c < rhs) addPen(rule, rhs - l.c);
      return;
    }
    const z = slack(rule);
    con(lin(l).add(z), '>=', rhs);
  };

  // ---------- マスの状態 ----------
  const cells = new Map(); // `${pid}|${day}` → { fixed, x: Map(shiftId → var), off, paid, spare, ake }
  const key = (pid, d) => `${pid}|${d}`;
  const nightIds = new Set(shifts.filter((s) => s.night).map((s) => s.id));
  const restFixed = (v) => v && (v.kind === 'off' || v.kind === 'paid' || v.kind === 'spare' || v.kind === 'ake');

  for (const p of data.staff) {
    for (let d = 1; d <= N; d += 1) {
      const f = fixedCellOf(data, p.id, d);
      const c = { fixed: f, x: new Map() };
      if (f === undefined) {
        const one = new Lin();
        for (const s of shifts) {
          if (!p.shifts.includes(s.id)) continue;
          const need = data.month.dailySkill[s.id]?.[d];
          if (need?.length && !need.some((k) => p.skills.includes(k))) continue;
          const v = `x_${p.id}_${d}_${s.id}`;
          bin.add(v);
          c.x.set(s.id, v);
          one.add(v);
        }
        for (const k of ['off', 'paid', 'spare']) {
          c[k] = `${k}_${p.id}_${d}`;
          bin.add(c[k]);
          one.add(c[k]);
        }
        c.ake = `ake_${p.id}_${d}`;
        bin.add(c.ake);
        one.add(c.ake);
        con(one, '=', 1);
      }
      cells.set(key(p.id, d), c);
    }
  }

  // ---------- 変わるマスの数（4-2） ----------
  // 決まっていないマスのうち、いまの値のままのマスの数 ≧ 決まっていないマスの数 − 上限。
  // いまの値の変数が無いマス（担当外のシフト・日ごとに要るスキルの無い人のシフト・空き・半休）は、必ず変わる数に入る。
  // 変わるマスの数は「できれば」の段にとても小さい重みで足す（良くならない入れかえをしないため。できれば 1件 ＝ 1000 マス）
  if (keepCurrent) {
    const keep = new Lin();
    let free = 0;
    for (const p of data.staff) {
      for (let d = 1; d <= N; d += 1) {
        const c = cells.get(key(p.id, d));
        if (c.fixed !== undefined) continue;
        free += 1;
        const v = cellOf(data, p.id, d);
        if (v?.kind === 'shift') keep.add(c.x.get(v.shift) ?? null);
        else if (v && c[v.kind]) keep.add(c[v.kind]);
      }
    }
    if (changeLimit !== null) con(keep, '>=', free - changeLimit);
    addPen('_change', lin(free).add(keep, -1), CHANGE_WEIGHT);
  }

  // 状態の式（決まっているマスは定数）
  const shiftX = (p, d, pred) => {
    const c = cells.get(key(p.id, d));
    const l = new Lin();
    if (!c) return l;
    if (c.fixed === undefined) {
      for (const [sid, v] of c.x) if (pred(shiftById(data, sid))) l.add(v);
    } else if (c.fixed?.kind === 'shift') {
      const s = shiftById(data, c.fixed.shift);
      if (s && pred(s)) l.add(1);
    }
    return l;
  };
  const kindX = (p, d, kind) => {
    const c = cells.get(key(p.id, d));
    if (!c) return new Lin();
    if (c.fixed === undefined) return lin(c[kind] ?? null);
    return lin(c.fixed?.kind === kind ? 1 : 0);
  };
  const all = () => true;
  const night = (p, d) => shiftX(p, d, (s) => s.night);
  const early = (p, d) => shiftX(p, d, (s) => groupOf(s) === 'early');
  const late = (p, d) => shiftX(p, d, (s) => groupOf(s) === 'late');
  const rest3 = (p, d) => lin(kindX(p, d, 'off'), kindX(p, d, 'paid'), kindX(p, d, 'spare'));
  const workW = (p, d) => lin(shiftX(p, d, all), kindX(p, d, 'half')); // シフトか半休
  const workNonNight = (p, d) => lin(shiftX(p, d, (s) => !s.night), kindX(p, d, 'half'));
  const restS = (p, d) => lin(rest3(p, d), kindX(p, d, 'ake'));
  const streakWork = (p, d) => {
    if (d < 1) return lin(d >= 1 - p.prevConsecutive ? 1 : 0);
    return lin(workW(p, d), kindX(p, d, 'ake'));
  };
  const prevShift = (p) => (p.prevLastShift && p.prevLastShift !== 'off' ? shiftById(data, p.prevLastShift) : null);

  // ---------- 夜勤の次の日（A・B・C） ----------
  for (const p of data.staff) {
    for (let d = 1; d <= N; d += 1) {
      const c = cells.get(key(p.id, d));
      const before = d === 1 ? lin(prevShift(p)?.night ? 1 : 0) : night(p, d - 1);
      if (c.fixed === undefined) {
        // 決まっていない日：明けは、前の日の夜勤と同じ
        con(lin(c.ake).add(before, -1), '=', 0);
      } else if (!restFixed(c.fixed)) {
        // シフト・半休・空きに決まっている日の前の日は、夜勤にしない
        con(before, '=', 0);
      }
    }
  }

  // ---------- 公休・有給の上限（D） ----------
  for (const p of data.staff) {
    let off = new Lin();
    let paid = new Lin();
    let fixedOff = 0;
    let fixedPaid = 0;
    let half = 0;
    for (let d = 1; d <= N; d += 1) {
      off = off.add(kindX(p, d, 'off'));
      paid = paid.add(kindX(p, d, 'paid'));
      const f = cells.get(key(p.id, d)).fixed;
      if (f?.kind === 'off') fixedOff += 1;
      if (f?.kind === 'paid') fixedPaid += 1;
      if (f?.kind === 'half') half += 1;
    }
    con(off, '<=', Math.max(p.offDays, fixedOff));
    con(paid, '<=', Math.max(Math.ceil(p.paidDays), fixedPaid));
    if (on('offShort')) softGe('offShort', off, p.offDays);
    if (on('paidDiff')) {
      const units = lin(paid).add(half * 0.5);
      if (units.isConst) {
        if (units.c !== p.paidDays) addPen('paidDiff', Math.abs(units.c - p.paidDays));
      } else {
        const zp = slack('paidDiff');
        const zm = slack('paidDiff');
        con(lin(units).add(zp, -1).add(zm), '=', p.paidDays);
      }
    }
  }

  // ---------- 連勤 ----------
  for (const p of data.staff) {
    const limit = p.maxConsecutive ?? work.maxConsecutive;
    for (let a = -4; a <= N - 5; a += 1) {
      const l = new Lin();
      for (let d = a; d <= a + 5; d += 1) l.add(streakWork(p, d));
      softLe('sixPlus', l, 5);
    }
    if (on('overStreak')) {
      for (let a = 1 - limit; a <= N - limit; a += 1) {
        const l = new Lin();
        for (let d = a; d <= a + limit; d += 1) l.add(streakWork(p, d));
        softLe('overStreak', l, limit);
      }
    }
  }

  // ---------- 人数 ----------
  for (let d = 1; d <= N; d += 1) {
    for (const s of shifts) {
      const inS = (pred) => {
        const l = new Lin();
        for (const p of data.staff) if (pred(p)) l.add(shiftX(p, d, (x) => x.id === s.id));
        return l;
      };
      if (s.counts && !s.training) {
        for (const emp of s.combine ? ['all'] : ['full', 'part']) {
          const got = inS((p) => emp === 'all' || p.employment === emp);
          const need = needOn(data, s.id, emp, d).value;
          if (on('shortage')) softGe('shortage', got, need);
          if (on('overstaff')) softLe('overstaff', got, need);
        }
      }
      if (s.onePerDay && on('onePerDayDup')) softLe('onePerDayDup', inS(() => true), 1);
    }
    for (const g of ['early', 'late', 'night']) {
      for (const k of data.settings.skills) {
        const have = new Lin();
        for (const p of data.staff) if (p.skills.includes(k.id)) have.add(shiftX(p, d, (s) => s.counts && !s.training && s.group === g));
        if (k.min[g] > 0 && on('skillShort')) softGe('skillShort', have, k.min[g]);
        if (k.target[g] > 0 && on('skillTarget')) softGe('skillTarget', have, k.target[g]);
      }
    }
    if (on('specialRank')) {
      for (const sd of data.month.special.filter((x) => x.day === d)) {
        for (const rn of sd.rankNeeds) {
          const limitOrd = rankOrder(data, rn.rank);
          const have = new Lin();
          for (const p of data.staff) {
            const o = p.rank ? rankOrder(data, p.rank) : -1;
            if (o >= 0 && o <= limitOrd) have.add(shiftX(p, d, (s) => s.counts && !s.training));
          }
          softGe('specialRank', have, rn.count);
        }
      }
    }
  }

  // ---------- 人ごとの決まり ----------
  const nRanks = Math.max(1, data.settings.ranks.length);
  for (const p of data.staff) {
    const prev = prevShift(p);
    const prevGroup = prev ? groupOf(prev) : null;
    const lateAt = (d) => (d === 0 ? lin(prevGroup === 'late' ? 1 : 0) : late(p, d));
    const prevKnown = p.prevConsecutive > 0 || p.prevLastShift !== null;
    const prevW = p.prevConsecutive > 0 || Boolean(prev);
    // 時間帯
    for (let d = 1; d <= N; d += 1) {
      if (on('lateToEarly')) softLe('lateToEarly', lin(lateAt(d - 1), early(p, d)), 1);
      if (d < N) {
        const rule = p.twoOffAfterLateEarly ? 'twoOffLateEarly' : 'lateOffEarly';
        if (on(rule)) softLe(rule, lin(lateAt(d - 1), rest3(p, d), early(p, d + 1)), 2);
      }
    }
    if (on('switchInStreak') || on('switchCount')) {
      const changes = new Lin();
      for (let d = 1; d < N; d += 1) {
        const a = lin(early(p, d), late(p, d + 1));
        const b = lin(late(p, d), early(p, d + 1));
        if (on('switchInStreak')) {
          softLe('switchInStreak', a, 1);
          softLe('switchInStreak', b, 1);
        }
        if (on('switchCount') && a.isConst && b.isConst) {
          // 2日とも決まっているときは、入れかわりかどうかも決まっている
          if (a.c > 1 || b.c > 1) changes.add(1);
        } else if (on('switchCount')) {
          const c = `chg_${p.id}_${d}`;
          cont.add(c);
          con(lin(a).add(c, -1), '<=', 1);
          con(lin(b).add(c, -1), '<=', 1);
          changes.add(c);
        }
      }
      if (on('switchCount')) softLe('switchCount', changes, work.maxSwitches);
    }
    if (on('bias') && p.groupPref === 'any') {
      const e = new Lin();
      const l = new Lin();
      for (let d = 1; d <= N; d += 1) {
        e.add(early(p, d));
        l.add(late(p, d));
      }
      const eMinusL = lin(e).add(l, -1);
      const lMinusE = lin(l).add(e, -1);
      if (p.biasPref !== 'late') softLe('bias', lMinusE, work.biasAllowance);
      if (p.biasPref !== 'early') softLe('bias', eMinusL, work.biasAllowance);
    }
    if (on('groupPref')) {
      for (let d = 1; d <= N; d += 1) {
        if (p.groupPref === 'early') addPen('groupPref', lin(late(p, d), night(p, d)));
        if (p.groupPref === 'late') addPen('groupPref', early(p, d));
      }
    }
    // 休みの並び
    for (let d = 1; d < N; d += 1) {
      const leftR = d === 1 ? (prevKnown ? lin(prevW ? 0 : 1) : null) : restS(p, d - 1);
      const leftW = d === 1 ? (prevKnown ? lin(prevW ? 1 : 0) : null) : workW(p, d - 1);
      if (on('singleWork') && leftR) softLe('singleWork', lin(leftR, workNonNight(p, d), restS(p, d + 1)), 2);
      if (leftW) {
        const pattern = lin(leftW, rest3(p, d), workW(p, d + 1));
        if (on('singleOff')) softLe('singleOff', pattern, 2);
        if (on('restStyle') && p.restStyle === 'together') softLe('restStyle', pattern, 2);
      }
    }
    const R = work.restRun;
    if (on('longRest')) {
      for (let a = 1; a + R + 2 <= N; a += 1) {
        const l = new Lin();
        for (let d = a; d <= a + R + 2; d += 1) l.add(rest3(p, d));
        softLe('longRest', l, R + 2);
      }
    }
    if (on('restStyle') && p.restStyle === 'spread') {
      for (let a = 1; a + 2 <= N; a += 1) softLe('restStyle', lin(rest3(p, a), rest3(p, a + 1), rest3(p, a + 2)), 2);
    }
    if (on('fewRestRuns') && p.offDays >= R) {
      const starts = new Lin();
      for (let a = 1; a + R - 1 <= N; a += 1) {
        const y = `run_${p.id}_${a}`;
        bin.add(y);
        for (let d = a; d < a + R; d += 1) con(lin(y).add(rest3(p, d), -1), '<=', 0);
        if (a > 1) con(lin(y).add(rest3(p, a - 1)), '<=', 1);
        starts.add(y);
      }
      softGe('fewRestRuns', starts, p.restStyle === 'together' ? 2 : 1);
    }
    if (on('weekend')) {
      for (let d = 1; d <= N; d += 1) {
        const wd = weekdayOf(year, month, d);
        if (wd !== 0 && wd !== 6) continue;
        if (p.weekendPref === 'off') addPen('weekend', workW(p, d));
        if (p.weekendPref === 'work') addPen('weekend', rest3(p, d));
      }
    }
    // 余り日（できれば の段で、出勤より少しだけ良くない、ぐらいの重さ）
    for (let d = 1; d <= N; d += 1) addPen('_spare', kindX(p, d, 'spare'), SPARE_WEIGHT);
    // 責任者の順位を近づける軽い式（試し。たし算だけ）
    if (leaderWeight > 0) {
      const o = p.rank ? rankOrder(data, p.rank) : nRanks;
      for (let d = 1; d <= N; d += 1) addPen('_leader', shiftX(p, d, (s) => s.onePerDay), (leaderWeight * Math.max(0, o)) / nRanks);
    }
  }

  // ---------- 段 ----------
  const stageRules = (st) => {
    if (Array.isArray(st.rules)) return st.rules.filter((r) => on(r) && (r === 'sixPlus' || S(r) === 'hard'));
    const want = st.rules === '*hard' ? 'hard' : 'soft';
    // 自分の段がある決まりでも、「できれば」にしたものは「できれば」の段へ入る
    const list = Object.keys(pen).filter((r) => !r.startsWith('_') && !NOT_IN_STAGES.has(r) && S(r) === want && !(want === 'hard' && OWN_STAGE.has(r)));
    if (want === 'soft') {
      list.push('_spare');
      if (pen._change) list.push('_change');
      if (leaderWeight > 0) list.push('_leader');
    }
    return list;
  };
  const stages = STAGES.map((st) => {
    const rules = stageRules(st).filter((r) => pen[r] && !pen[r].isConst);
    const obj = new Lin();
    for (const r of rules) obj.add(pen[r]);
    // 定数だけの決まり（どう作っても変わらない量）は、量の記録にだけ足す
    for (const r of stageRules(st)) if (pen[r]?.isConst) obj.add(pen[r].c);
    return { key: st.key, name: st.name, rules, objective: obj };
  }).filter((st) => st.rules.length > 0);

  // LP の文。bounds: [{ objective: Lin, max }] は、前の段の「これ以上悪くしない」
  const lp = (objective, bounds) => {
    const lines = ['Minimize', ` obj: ${terms(objective)}`, 'Subject To'];
    cons.forEach((c, i) => lines.push(` c${i}: ${c}`));
    bounds.forEach((b, i) => lines.push(` b${i}: ${terms(b.objective)} <= ${fmt(b.max - b.objective.c + 1e-6)}`));
    lines.push(' fixzero: zero = 0', 'Binary', ` ${[...bin].join(' ')}`, 'End');
    return lines.join('\n');
  };

  // 答え（変数の名前 → 値 の Map）から表を作る。決まっているマスは、その値（空きのまま固定は入れない）
  const readTable = (values) => {
    const table = {};
    const val = (v) => (values.get(v) ?? 0) > 0.5;
    for (const p of data.staff) {
      for (let d = 1; d <= N; d += 1) {
        const c = cells.get(key(p.id, d));
        let out = null;
        if (c.fixed !== undefined) out = c.fixed ? { ...c.fixed } : null;
        else {
          for (const [sid, v] of c.x) if (val(v)) out = { kind: 'shift', shift: sid };
          for (const k of ['off', 'paid', 'spare', 'ake']) if (!out && val(c[k])) out = { kind: k };
        }
        if (out) (table[p.id] ??= {})[d] = out;
      }
    }
    return table;
  };

  // 段の量を、変数の値から計算する（式の量と check.js の量を比べるため）
  const amountOf = (rule, values) => {
    const l = pen[rule];
    if (!l) return 0;
    let v = l.c;
    for (const [name, a] of l.t) v += a * (values.get(name) ?? 0);
    return Math.round(v * 1000) / 1000;
  };

  return { stages, lp, readTable, amountOf, size: { bin: bin.size, cont: cont.size, cons: cons.length } };
}
