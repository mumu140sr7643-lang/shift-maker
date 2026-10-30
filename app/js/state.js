// いまのデータと画面の状態。変えるときは commit() を通す（自動で保存する）。
import { saveData } from './storage.js?v=2.1';
import { clearNotices } from './dialog.js?v=2.1';

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

// mutate(data) でデータを変えて保存する。
// render: true なら画面を作り直す。false なら上の帯（保存の時刻など）だけ直す
// （入力中の欄から目印が外れないように、欄を直接変えたときは false にする）
export function commit(mutate, { render = false } = {}) {
  mutate(app.data);
  persist();
  if (render) renderAll();
  else renderChrome();
}

// データをまるごと置きかえる（見本・控えから戻す・取り込み）。
// 前のデータについての知らせは、もう当てはまらないので消す
export function replaceData(data, { step = null } = {}) {
  clearNotices();
  app.data = data;
  app.selectedStaff = null;
  if (step !== null) app.step = step;
  persist();
  renderAll();
}

export function rerender() {
  renderAll();
}
