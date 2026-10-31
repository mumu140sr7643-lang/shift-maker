// 計算中の小窓と、裏方（solver/worker.js の Web Worker）とのやり取り。
// 手順5 の自動で作る・手順6 のエラーを自動で直す・途中から作り直す で同じものを使う。
// 計算は写しで行うので、中止しても表は前のまま。計算中は小窓がほかの操作を止める。
import { h } from '../dom.js?v=5.2';
import { rerender } from '../state.js?v=5.2';
import { notify } from '../dialog.js?v=5.2';

export const QUICK_SECONDS = 60;

// 1分で作るの秒。確かめの道具だけが、アドレスの ?seconds=5 のように短くする（3〜60秒）
export function quickSeconds() {
  const n = Number(new URLSearchParams(window.location.search).get('seconds'));
  return Number.isInteger(n) && n >= 3 && n <= QUICK_SECONDS ? n : QUICK_SECONDS;
}

// 計算中の仕事（画面を作り直しても残す）
let job = null;
export const isSolving = () => Boolean(job);

function stopJob() {
  if (!job) return;
  job.worker.terminate();
  clearInterval(job.timer);
  job.dialog.close();
  job.dialog.remove();
  job = null;
}

function progressDialog(title, seconds, onStop) {
  const stage = h('p', { class: 'run-stage', testid: 'run-stage', text: 'はじめの段を用意しています' });
  const bar = h('progress', { class: 'run-bar', max: String(seconds), value: '0', testid: 'run-progress', 'aria-label': 'たった時間' });
  const time = h('p', { class: 'run-time', testid: 'run-time', text: `0秒たちました（あと最大${seconds}秒）` });
  const best = h('p', { class: 'run-best', testid: 'run-best', text: 'いまのいちばん良い答え：まだありません（はじめの段を解いています）' });
  const dlg = h(
    'dialog',
    { class: 'dialog run-dialog', testid: 'run-dialog', 'aria-labelledby': 'run-title' },
    h('h2', { id: 'run-title', text: title }),
    stage,
    bar,
    time,
    best,
    h('p', { class: 'help', text: '計算しているあいだは、入力・手順の移動・月の切り替え・取り込みを止めています（計算の途中の表とぶつからないようにするため）。止めたいときは「中止」を押してください。表は前のままになります。' }),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn btn-danger', text: '中止', testid: 'run-stop', on: { click: onStop } })),
  );
  // Esc では閉じない（中止は「中止」で）
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.appendChild(dlg);
  dlg.showModal();
  return { dlg, stage, bar, time, best };
}

const defaultStage = (m) => `いまの段：${m.stage}/${m.count}（${m.name}）`;

// payload を裏方へ送り、終わったら onResult(result) を呼ぶ（中止・エラーのときは呼ばない）。
// seconds は小窓に出す「あと最大◯秒」の合計。stageText(m) は段の始まりの文
export function startSolving({ payload, seconds, title, stageText = defaultStage, onResult }) {
  if (job) return;
  let worker;
  try {
    worker = new Worker(new URL('../solver/worker.js?v=5.2', import.meta.url), { type: 'module' });
  } catch {
    notify('計算の部品を動かせませんでした。ページを読み込み直して、もう一度ためしてください。', { kind: 'error', testid: 'run-error' });
    return;
  }
  const ui = progressDialog(title, seconds, () => {
    stopJob();
    notify('中止しました。シフト表は前のままです。', { testid: 'run-stopped' });
    rerender();
  });
  const t0 = performance.now();
  const tick = () => {
    const el = Math.min(seconds, (performance.now() - t0) / 1000);
    ui.bar.value = el;
    ui.time.textContent = `${Math.floor(el)}秒たちました（あと最大${Math.max(0, Math.ceil(seconds - el))}秒）`;
  };
  job = { worker, dialog: ui.dlg, timer: setInterval(tick, 250) };
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      if (m.phase === 'start') ui.stage.textContent = stageText(m);
      if (m.totals) {
        ui.best.textContent = `いまのいちばん良い答え：6連勤以上 ${m.totals.sixPlus}件・絶対 ${m.totals.hard}件・できれば ${m.totals.soft}件`;
        ui.best.dataset.hard = String(m.totals.hard);
      }
      return;
    }
    stopJob();
    if (m.type === 'error') {
      notify(`計算の部品が止まりました（${m.message}）。シフト表は前のままです。ページを読み込み直して、もう一度ためしてください。`, { kind: 'error', testid: 'run-error' });
      rerender();
      return;
    }
    onResult(m.result);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    stopJob();
    notify('計算の部品を読み込めませんでした。シフト表は前のままです。ページを読み込み直して、もう一度ためしてください。', { kind: 'error', testid: 'run-error' });
    rerender();
  };
  worker.postMessage(payload);
}
