// エラーを自動で直す・途中から作り直す（4-2。docs/自動で直す案.md）の中身。画面には触らない。node からも使う。
import { solveStaged } from './stages.js?v=4.3';
import { checkTable, isImproved, solveConflicts } from '../check.js?v=4.3';
import { clone, cellOf, monthDays, shiftById } from '../model.js?v=4.3';

// 変えてよいマスの数の上限（null は全部）
export const REPAIR_BUDGETS = [10, 25, 50, null];

const sameCell = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ? (b.kind === 'shift' ? { kind: 'shift', shift: b.shift } : { kind: b.kind }) : null);

// その人のその日に、そのシフトの変数があるか（担当・日ごとに要るスキル。build.js と同じ見方）
function hasShiftVar(data, p, day, sid) {
  if (!p.shifts.includes(sid) || !shiftById(data, sid)) return false;
  const need = data.month.dailySkill[sid]?.[day];
  return !(need?.length && !need.some((k) => p.skills.includes(k)));
}

function isNightCell(data, v) {
  return v?.kind === 'shift' && Boolean(shiftById(data, v.shift)?.night);
}

// 前の日が、決まった夜勤か（固定・希望の夜勤。1日は前の月の最後のシフト）。
// そのときだけ、次の日の空きは残さない（式で明けになる）。決まっていない夜勤なら、空きを残して夜勤のほうを変える
export function nightFixedBefore(data, p, day) {
  if (day === 1) return isNightCell(data, p.prevLastShift ? { kind: 'shift', shift: p.prevLastShift } : null);
  if (data.month.marks[p.id]?.[day - 1]?.locked) return isNightCell(data, cellOf(data, p.id, day - 1));
  return isNightCell(data, data.month.requests[p.id]?.[day - 1] ?? null);
}

function lockCopy(prepared, pid, day) {
  const marks = prepared.month.marks;
  marks[pid] ??= {};
  marks[pid][day] = { ...(marks[pid][day] ?? {}), locked: true };
}

// 直すための写し。固定・希望のほか、いま空いているマスと半休のマスも、そのまま残す（写しに固定の印を付ける）。
// ただし、決まった夜勤（固定・希望）の次の日の空きは残さない（式で明けになるため）。
// 返す：{ prepared, requestDiffs（希望と違うマスの数。希望の値に変わる）, noVar（いまの値の変数が無いマスの数。必ず変わる） }
export function prepareRepair(data) {
  const prepared = clone(data);
  const N = monthDays(data);
  let requestDiffs = 0;
  let noVar = 0;
  for (const p of data.staff) {
    for (let day = 1; day <= N; day += 1) {
      if (data.month.marks[p.id]?.[day]?.locked) continue;
      const v = cellOf(data, p.id, day);
      const req = data.month.requests[p.id]?.[day];
      if (req) {
        if (!sameCell(v, req)) requestDiffs += 1;
        continue;
      }
      if (!v) {
        if (!nightFixedBefore(data, p, day)) lockCopy(prepared, p.id, day);
        continue;
      }
      if (v.kind === 'half') {
        lockCopy(prepared, p.id, day);
        continue;
      }
      if (v.kind === 'shift' && !hasShiftVar(data, p, day, v.shift)) noVar += 1;
    }
  }
  return { prepared, requestDiffs, noVar };
}

// 途中から作り直すための写し：fromDay より前の日のマスを、いまの値のまま固定した写し（空きも空きのまま）
export function prepareRestart(data, fromDay) {
  const prepared = clone(data);
  for (const p of data.staff) for (let day = 1; day < fromDay; day += 1) lockCopy(prepared, p.id, day);
  return prepared;
}

// 2つの表の違うマス：[{ pid, day, before, after }]
export function tableChanges(data, table) {
  const out = [];
  const N = monthDays(data);
  for (const p of data.staff) {
    for (let day = 1; day <= N; day += 1) {
      const a = cellOf(data, p.id, day);
      const b = table[p.id]?.[day] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ pid: p.id, day, before: a, after: b });
    }
  }
  return out;
}

// 上限ごとに解き直して、案を作る。
// 返す：{ ok: false, reason: 'conflict', conflicts } | { ok: false, reason: 'stopped' } |
//       { ok: true, before: totals, proposals: [{ budget, status: 'ok' | 'too-many' | 'no-answer', table, changes, totals, improved, finished, sameAs, seconds }] }
//   too-many：必ず変えるマスが上限より多い（解く前に分かったか、解いて答えが無かった）
export async function solveRepair(data, { loadHighs, budgets = REPAIR_BUDGETS, secondsEach = 15, nodeLimit = null, seed = 1, onProgress = () => {}, shouldStop = () => false }) {
  const before = checkTable(data);
  const base = prepareRepair(data);
  const conflicts = solveConflicts(base.prepared);
  if (conflicts.length) return { ok: false, reason: 'conflict', conflicts };
  const proposals = [];
  for (const [i, budget] of budgets.entries()) {
    if (shouldStop()) return { ok: false, reason: 'stopped' };
    const known = base.requestDiffs + base.noVar;
    if (budget !== null && known > budget) {
      proposals.push({ budget, status: 'too-many', known });
      continue;
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const res = await solveStaged(base.prepared, {
      loadHighs,
      timeLimit: nodeLimit ? null : secondsEach,
      nodeLimit,
      seed,
      keepCurrent: true,
      changeLimit: budget === null ? null : budget - base.requestDiffs,
      shouldStop,
      onProgress: (pr) => onProgress({ ...pr, budget, budgetIndex: i, budgetCount: budgets.length }),
    });
    if (!res.ok) {
      if (res.reason === 'stopped') return { ok: false, reason: 'stopped' };
      proposals.push({ budget, status: res.reason === 'infeasible' ? 'too-many' : 'no-answer', known });
      continue;
    }
    const seconds = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 100) / 10;
    const after = checkTable({ ...data, month: { ...data.month, table: res.table } });
    const text = JSON.stringify(res.table);
    const same = proposals.find((x) => x.status === 'ok' && x.text === text);
    proposals.push({
      budget,
      status: 'ok',
      text,
      table: res.table,
      changes: tableChanges(data, res.table),
      totals: after.totals,
      improved: isImproved(before, after),
      finished: res.stages.length > 0 && res.stages.every((s) => s.status === 'solved'),
      sameAs: same ? same.budget : undefined,
      seconds,
    });
  }
  for (const pr of proposals) delete pr.text;
  return { ok: true, before: before.totals, proposals };
}
