// 元に戻す・やり直すの中身（4-1。説明書 6 節）。画面には触らない。node からも使う。
// 変える前と後の「見張る所」を写し、違う所だけを変更として持つ。
// 戻すときは「いまもその値のままの所」だけ戻す（そのあと別の操作で変えた所は、いまのまま）。
import { shiftById, monthDays } from './model.js?v=6.1';

// 見張る所：月の表のマス・マスの印（固定・手で変えた）・希望（5-3 の直し方のボタンで外すため）・日ごとの必要人数・作った記録
//   depth は、その下の何段目を1つの値として比べるか（table[人][日]・requests[人][日]・needOverride[シフト][区分][日]・runs はまるごと）
const ROOTS = [
  { key: 'table', depth: 2 },
  { key: 'marks', depth: 2 },
  { key: 'requests', depth: 2 },
  { key: 'needOverride', depth: 3 },
  { key: 'runs', depth: 0 },
];

function leaves(value, depth, path, out) {
  if (depth === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.set(JSON.stringify(path), JSON.stringify(value));
    return out;
  }
  for (const [k, v] of Object.entries(value)) leaves(v, depth - 1, [...path, k], out);
  return out;
}

// 見張る所を写す（比べるための文字にしておく）
export function snapshotOf(data) {
  const snap = { ym: `${data.month.year}-${data.month.month}` };
  for (const r of ROOTS) snap[r.key] = leaves(data.month[r.key], r.depth, [], new Map());
  return snap;
}

// 2つの写しの違い。返す：[{ root, path, before, after }]（無い所は undefined）
export function diffSnapshots(a, b) {
  const changes = [];
  for (const r of ROOTS) {
    const keys = new Set([...a[r.key].keys(), ...b[r.key].keys()]);
    for (const k of keys) {
      const x = a[r.key].get(k);
      const y = b[r.key].get(k);
      if (x === y) continue;
      changes.push({ root: r.key, path: JSON.parse(k), before: x === undefined ? undefined : JSON.parse(x), after: y === undefined ? undefined : JSON.parse(y) });
    }
  }
  return changes;
}

function getAt(obj, path) {
  let v = obj;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return v;
}

// 値を入れる（undefined なら消し、空になった入れ物も消す）
function setAt(obj, path, value) {
  if (value === undefined) {
    const stack = [obj];
    for (const k of path.slice(0, -1)) {
      const next = stack[stack.length - 1][k];
      if (next === null || typeof next !== 'object') return;
      stack.push(next);
    }
    delete stack[stack.length - 1][path[path.length - 1]];
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (Object.keys(stack[i]).length) break;
      delete stack[i - 1][path[i - 1]];
    }
    return;
  }
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = JSON.parse(JSON.stringify(value));
}

// その変更を、いまのデータに戻せるか（人・日・シフトが、まだあるか）
function stillFits(data, ch, value) {
  if (ch.root === 'table' || ch.root === 'marks' || ch.root === 'requests') {
    const [pid, day] = ch.path;
    if (!data.staff.some((p) => p.id === pid) || Number(day) < 1 || Number(day) > monthDays(data)) return false;
    if ((ch.root === 'table' || ch.root === 'requests') && value?.kind === 'shift' && !shiftById(data, value.shift)) return false;
  }
  if (ch.root === 'needOverride' && !shiftById(data, ch.path[0])) return false;
  return true;
}

// 変更をいまのデータに当てる。direction: 'undo'（after → before）| 'redo'（before → after）
// いまの値が「戻す前の値」と同じ所だけ変える。返す：{ applied: [変えた変更], skipped: 数 }
export function applyChanges(data, changes, direction) {
  const applied = [];
  let skipped = 0;
  for (const ch of changes) {
    const from = direction === 'undo' ? ch.after : ch.before;
    const to = direction === 'undo' ? ch.before : ch.after;
    const root = ch.root === 'runs' ? data.month : data.month[ch.root];
    const path = ch.root === 'runs' ? ['runs'] : ch.path;
    const now = getAt(root, path);
    if (JSON.stringify(now) !== JSON.stringify(from) || !stillFits(data, ch, to)) {
      skipped += 1;
      continue;
    }
    if (ch.root === 'runs') data.month.runs = to === undefined ? [] : JSON.parse(JSON.stringify(to));
    else setAt(root, path, to);
    applied.push(ch);
  }
  return { applied, skipped };
}
