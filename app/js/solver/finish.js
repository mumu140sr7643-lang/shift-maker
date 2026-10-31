// 仕上げの入れ替え（6-1。docs/じっくり作る案.md の 3 章）。画面には触らない。node からも使う。
// 自動で作った表の、決まっていないマスどうしを入れ替え、check.js で数えて良くなるときだけ入れる。
// 変えないもの：各人の 出勤・公休・有給・余り日 の日数と、各日の シフトごとの人数。乱数は使わない（同じ表なら同じ答え）。
import { checkTable, isImproved, compareResults } from '../check.js?v=6.2';
import { clone, cellOf, monthDays, shiftById } from '../model.js?v=6.2';

// たすき掛けで見る、もう1つの日の幅（その日の前後）
const CROSS_RANGE = 6;
// 入れ替えてよい値：シフト（夜勤でない）・公休・有給・余り日。半休・明け・空き・夜勤は動かさない（夜勤は次の日の明けがずれるため）
const MOVABLE = new Set(['shift', 'off', 'paid', 'spare']);

// 動かしてよいマスなら、その値。固定・希望のマスは動かさない
function movable(data, pid, day) {
  if (data.month.marks[pid]?.[day]?.locked) return null;
  if (data.month.requests[pid]?.[day]) return null;
  const v = cellOf(data, pid, day);
  if (!v || !MOVABLE.has(v.kind)) return null;
  if (v.kind === 'shift' && (!shiftById(data, v.shift) || shiftById(data, v.shift).night)) return null;
  return v;
}

const keyOf = (v) => (v.kind === 'shift' ? `s:${v.shift}` : v.kind);

// p さんが、その日にその値を入れられるか（担当・日ごとに要るスキル。build.js と同じ見方）
function canTake(data, p, day, v) {
  if (v.kind !== 'shift') return true;
  if (!p.shifts.includes(v.shift)) return false;
  const need = data.month.dailySkill[v.shift]?.[day];
  return !(need?.length && !need.some((k) => p.skills.includes(k)));
}

// 入れ替え（move）：{ kind: 'day' | 'cross', a, b, days }。a さんと b さんの、days の日のマスを入れ替える。
//   day  ：同じ日の出勤どうし（a さんのシフト S と b さんのシフト T、S と T は違う）
//   cross：2人×2日のたすき掛け（a さんが X・Y、b さんが Y・X。X と Y は違う値）
// いまの表で、その入れ替えをしてよいか
export function moveAllowed(data, mv) {
  const p = data.staff.find((x) => x.id === mv.a);
  const q = data.staff.find((x) => x.id === mv.b);
  if (!p || !q || p.id === q.id) return false;
  const [d1, d2] = mv.days;
  const a1 = movable(data, p.id, d1);
  const b1 = movable(data, q.id, d1);
  if (!a1 || !b1 || keyOf(a1) === keyOf(b1)) return false;
  if (!canTake(data, p, d1, b1) || !canTake(data, q, d1, a1)) return false;
  if (mv.kind === 'day') return mv.days.length === 1 && a1.kind === 'shift' && b1.kind === 'shift';
  if (mv.kind !== 'cross' || mv.days.length !== 2 || d1 === d2) return false;
  const a2 = movable(data, p.id, d2);
  const b2 = movable(data, q.id, d2);
  if (!a2 || !b2 || keyOf(a2) !== keyOf(b1) || keyOf(b2) !== keyOf(a1)) return false;
  return canTake(data, p, d2, b2) && canTake(data, q, d2, a2);
}

// 入れ替えを当てる（もう一度当てると元に戻る）
export function applyMove(table, mv) {
  for (const day of mv.days) {
    const a = table[mv.a]?.[day];
    const b = table[mv.b]?.[day];
    (table[mv.a] ??= {})[day] = b;
    (table[mv.b] ??= {})[day] = a;
  }
}

// エラーにかかわる「人・日」。重いもの（6連勤以上 → 絶対 → できれば）から順に。
//   人と日のあるもの → その日／人と続き（連勤・連休）→ 続きと前後1日／人だけ → その人の全部の日／日だけ → その日の全部の人
function hotCells(data, res) {
  const N = monthDays(data);
  const out = new Map();
  const push = (pid, day) => {
    if (day < 1 || day > N) return;
    const k = `${pid}|${day}`;
    if (!out.has(k)) out.set(k, { pid, day });
  };
  const weight = (it) => (it.rule === 'sixPlus' ? 0 : res.byRule[it.rule]?.strength === 'hard' ? 1 : 2);
  const items = res.items.map((it, i) => ({ it, i, w: weight(it) })).sort((x, y) => x.w - y.w || x.i - y.i).map((x) => x.it);
  for (const it of items) {
    if (it.staff && it.day) push(it.staff, it.day);
    else if (it.staff && it.from !== undefined) for (let d = it.from - 1; d <= it.to + 1; d += 1) push(it.staff, d);
    else if (it.staff) for (let d = 1; d <= N; d += 1) push(it.staff, d);
    else if (it.day) for (const p of data.staff) push(p.id, it.day);
  }
  return [...out.values()];
}

// その「人・日」にかかわる入れ替え（同じ日のほかの人と／前後 CROSS_RANGE 日とのたすき掛け）
function movesAt(data, cell, N) {
  const out = [];
  for (const q of data.staff) {
    if (q.id === cell.pid) continue;
    const [a, b] = cell.pid < q.id ? [cell.pid, q.id] : [q.id, cell.pid];
    out.push({ kind: 'day', a, b, days: [cell.day] });
    for (let d2 = Math.max(1, cell.day - CROSS_RANGE); d2 <= Math.min(N, cell.day + CROSS_RANGE); d2 += 1) {
      if (d2 !== cell.day) out.push({ kind: 'cross', a, b, days: [Math.min(cell.day, d2), Math.max(cell.day, d2)] });
    }
  }
  return out;
}

const moveKey = (mv) => `${mv.kind}|${mv.a}|${mv.b}|${mv.days.join(',')}`;

// 仕上げる。data の写しで行う（data は変えない）。
// opts：seconds（時間の上限。null で無し）・maxChecks（数える回数の上限。道具が同じ答えを出すため）・now（時刻の関数）・shouldStop
// 返す：{ table, moves, before, after（件数）, checks（数えた回数）, seconds, end: 'done'（良くなる入れ替えが無い）| 'time' | 'checks' | 'stopped' }
// 入れるのは、isImproved で「改善」、かつ並べる順（compareResults）でも良い入れ替えだけ。
// isImproved は、あとの6連勤以上がどれも前の1つの6連勤以上の中にあるときしか改善と言わないので、6連勤以上を作らない・長くしない・つなげない
export function finishTable(data, opts = {}) {
  const { seconds = 25, maxChecks = Infinity, shouldStop = () => false } = opts;
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const t0 = now();
  const work = clone(data);
  const N = monthDays(work);
  let base = checkTable(work);
  const before = base.totals;
  const moves = [];
  let checks = 0;
  let end = 'done';
  const over = () => {
    if (shouldStop()) return 'stopped';
    if (checks >= maxChecks) return 'checks';
    if (seconds !== null && (now() - t0) / 1000 >= seconds) return 'time';
    return null;
  };
  if (base.tableEmpty) return { table: work.month.table, moves, before, after: base.totals, checks, seconds: 0, end };
  let changed = true;
  outer: while (changed) {
    changed = false;
    const tried = new Set();
    for (const cell of hotCells(work, base)) {
      for (const mv of movesAt(work, cell, N)) {
        const k = moveKey(mv);
        if (tried.has(k)) continue;
        tried.add(k);
        if (!moveAllowed(work, mv)) continue;
        const stop = over();
        if (stop) {
          end = stop;
          break outer;
        }
        applyMove(work.month.table, mv);
        const after = checkTable(work);
        checks += 1;
        if (isImproved(base, after) && compareResults(after, base) < 0) {
          base = after;
          moves.push(mv);
          changed = true;
        } else {
          applyMove(work.month.table, mv);
        }
      }
    }
  }
  return { table: work.month.table, moves, before, after: base.totals, checks, seconds: Math.round((now() - t0) / 10) / 100, end };
}
