// いまのデータと画面の状態。変えるときは commit() を通す（自動で保存する）。
import { saveData } from './storage.js?v=5.2';
import { clearNotices } from './dialog.js?v=5.2';

export const app = {
  data: null,
  step: 0, // 0 = 見本を選ぶ画面、1〜6 = 手順
  savedAt: null,
  saveFailed: false,
  selectedStaff: null,
};

let renderAll = () => {};
let renderChrome = () => {};
let navigate = () => {};

export function setRenderers(all, chrome, nav) {
  renderAll = all;
  renderChrome = chrome;
  navigate = nav;
}

export function goStep(n) {
  navigate(n);
}

function persist() {
  const r = saveData(app.data);
  app.saveFailed = !r.ok;
  if (r.ok) app.savedAt = r.at;
}

// 変える前と後を見るもの（その場の知らせ など）：{ before(data) → しるし, after(しるし, data, { why, undo }) }
const commitWatchers = [];
export function watchCommits(w) {
  commitWatchers.push(w);
}

// mutate(data) でデータを変えて保存する。
// render: true なら画面を作り直す。false なら上の帯（保存の時刻など）だけ直す
// （入力中の欄から目印が外れないように、欄を直接変えたときは false にする）
// why：何を変えたか（その場の知らせに書く）。undo：その変更を取り消す関数（知らせに「取り消す」を出すとき）
export function commit(mutate, { render = false, why = null, undo = null } = {}) {
  const marks = commitWatchers.map((w) => w.before(app.data));
  mutate(app.data);
  persist();
  commitWatchers.forEach((w, i) => w.after(marks[i], app.data, { why, undo }));
  if (render) renderAll();
  else renderChrome();
}

// データをまるごと置きかえたときに呼ぶもの（元に戻すの履歴を消す など）
const replaceHooks = [];
export function onReplaceData(fn) {
  replaceHooks.push(fn);
}

// データをまるごと置きかえる（見本・控えから戻す・取り込み）。
// 前のデータについての知らせは、もう当てはまらないので消す
export function replaceData(data, { step = null } = {}) {
  clearNotices();
  replaceHooks.forEach((fn) => fn());
  app.data = data;
  app.selectedStaff = null;
  if (step !== null) app.step = step;
  persist();
  renderAll();
}

export function rerender() {
  renderAll();
}
