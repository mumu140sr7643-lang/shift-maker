// 元に戻す・やり直すの履歴（4-1）。中身は undo.js。
// 履歴は、このページを開いているあいだだけ持つ（ブラウザに保存しない。読み直すと消える）。
//   保存すると、データと同じ保存場所を大きく使い、別のタブで変えたデータとも合わなくなるため。
//   自動で作る前の表は、控え（「保存と控え」）からも戻せる。
// データをまるごと置きかえたとき（見本・取り込み・控えから戻す・別のタブで変えた）と、月を切り替えたときは消す。
import { app, commit, rerender, onReplaceData } from './state.js?v=4.3';
import { snapshotOf, diffSnapshots, applyChanges } from './undo.js?v=4.3';

export const MAX_HISTORY = 100;
let undoStack = [];
let redoStack = [];

const ymOf = (d) => `${d.month.year}-${d.month.month}`;

// mutate(data) でデータを変えて保存し、変わった所を「label」として履歴に積む。
// render: true なら、積んでから画面を作り直す（「元に戻す」のボタンが新しい履歴を見るように）
export function record(label, mutate, { render = false } = {}) {
  const before = snapshotOf(app.data);
  commit(mutate);
  const changes = diffSnapshots(before, snapshotOf(app.data));
  if (changes.length) {
    undoStack.push({ label, ym: ymOf(app.data), changes });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
  }
  if (render) rerender();
}

export function clearHistory() {
  undoStack = [];
  redoStack = [];
}
onReplaceData(clearHistory);

export const nextUndo = () => undoStack[undoStack.length - 1] ?? null;
export const nextRedo = () => redoStack[redoStack.length - 1] ?? null;

function step(from, to, direction) {
  const entry = from.pop();
  if (!entry) return null;
  // 月が変わっていたら、前の月の変更は当てない
  if (entry.ym !== ymOf(app.data)) {
    clearHistory();
    return { label: entry.label, applied: 0, skipped: entry.changes.length, otherMonth: true };
  }
  let res = null;
  commit((x) => { res = applyChanges(x, entry.changes, direction); });
  if (res.applied.length) to.push({ label: entry.label, ym: entry.ym, changes: res.applied });
  rerender();
  return { label: entry.label, applied: res.applied.length, skipped: res.skipped };
}

// 返す：{ label, applied（戻した所の数）, skipped（そのあと変えたので、いまのままにした所の数）, otherMonth? } | null
export function undo() {
  return step(undoStack, redoStack, 'undo');
}

export function redo() {
  return step(redoStack, undoStack, 'redo');
}
