// 計算中の小窓と、裏方（solver/worker.js の Web Worker）とのやり取り。
// 手順5 の自動で作る（1分・じっくり）・手順6 のエラーを自動で直す・途中から作り直す で同じものを使う。
// 計算は写しで行うので、中止しても表は前のまま。計算中は小窓がほかの操作を止める。
import { h } from '../dom.js?v=6.2';
import { rerender } from '../state.js?v=6.2';
import { notify } from '../dialog.js?v=6.2';
import { startCareful, workerCount, CAREFUL_SECONDS } from '../solver/careful.js?v=6.2';
import { monthDays } from '../model.js?v=6.2';

export const QUICK_SECONDS = 60;

// 1分で作るの秒。確かめの道具だけが、アドレスの ?seconds=5 のように短くする（3〜60秒）
export function quickSeconds() {
  const n = Number(new URLSearchParams(window.location.search).get('seconds'));
  return Number.isInteger(n) && n >= 3 && n <= QUICK_SECONDS ? n : QUICK_SECONDS;
}

// じっくり作るの合計の秒。確かめの道具だけが、アドレスの ?careful=20 のように短くする（10〜600秒）
export function carefulSeconds() {
  const n = Number(new URLSearchParams(window.location.search).get('careful'));
  return Number.isInteger(n) && n >= 10 && n <= CAREFUL_SECONDS ? n : CAREFUL_SECONDS;
}

// じっくり作るの Worker の数（docs/じっくり作る案.md の 4 章）。月の大きさ（人数 × 日数）でメモリの見込みが変わるので、データを渡す
export function carefulWorkers(d) {
  const touchOnly = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  return workerCount({ cpus: navigator.hardwareConcurrency, memory: navigator.deviceMemory, touchOnly, cells: d.staff.length * monthDays(d) });
}

// 計算中の仕事（画面を作り直しても残す）
let job = null;
export const isSolving = () => Boolean(job);

function stopJob() {
  if (!job) return;
  job.cancel();
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
    worker = new Worker(new URL('../solver/worker.js?v=6.2', import.meta.url), { type: 'module' });
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
  job = { cancel: () => worker.terminate(), dialog: ui.dlg, timer: setInterval(tick, 250) };
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

const totalsText = (x) => `6連勤以上 ${x.sixPlus}件・絶対 ${x.hard}件・できれば ${x.soft}件`;

// じっくり作る（6-2）。Worker を何本か作り（careful.js の startCareful）、終わったら onResult(result) を呼ぶ。
// 中止・計算の部品が止まって答えが無いときは呼ばない。「ここまでの答えで終える」は、1分の答えができてから押せる
export function startCarefulSolving({ data, seed, onResult }) {
  if (job) return;
  const seconds = carefulSeconds();
  const workers = carefulWorkers(data);
  const phaseText = {
    quick: '1分の答えを作っています（保険）',
    search: workers > 1 ? `何通りかで、より良い答えを探しています（${workers}通り同時）` : '1分の答えから、より良い答えを探しています',
    finish: '仕上げをしています',
  };
  const stage = h('p', { class: 'run-stage', testid: 'run-stage', dataset: { phase: 'quick' }, text: phaseText.quick });
  const bar = h('progress', { class: 'run-bar', max: String(seconds), value: '0', testid: 'run-progress', 'aria-label': 'たった時間' });
  const time = h('p', { class: 'run-time', testid: 'run-time', text: `0秒たちました（あと最大${seconds}秒）` });
  const quick = h('p', { class: 'run-quick', testid: 'run-quick', text: '1分の答え：まだありません' });
  const best = h('p', { class: 'run-best', testid: 'run-best', text: 'いまのいちばん良い答え：まだありません' });
  const early = h('button', { type: 'button', class: 'btn', text: 'ここまでの答えで終える', testid: 'run-early', disabled: true });
  const earlyWhy = h('p', { class: 'help why', testid: 'run-early-why', text: '1分の答えができると押せます。' });
  const dlg = h(
    'dialog',
    { class: 'dialog run-dialog', testid: 'run-dialog', dataset: { workers: String(workers) }, 'aria-labelledby': 'run-title' },
    h('h2', { id: 'run-title', text: 'シフトを作っています（じっくり作る）' }),
    stage,
    bar,
    time,
    quick,
    best,
    workers === 1 ? h('p', { class: 'help', testid: 'run-single', text: '1分の答えを、時間いっぱいまで直していきます。' }) : null,
    h('p', { class: 'help', text: '計算のあいだは、ほかの重いアプリを閉じてください。画面を閉じたり、ほかのアプリに切り替えたりすると、計算が止まることがあります。' }),
    h('p', { class: 'help', text: '中止は、作った答えを入れずに終わります（表は前のまま）。ここまでの答えで終えると、いまのいちばん良い答えを入れます。' }),
    earlyWhy,
    h(
      'div',
      { class: 'dialog-buttons' },
      early,
      h('button', { type: 'button', class: 'btn btn-danger', text: '中止', testid: 'run-stop', on: { click: () => handle.stop() } }),
    ),
  );
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.appendChild(dlg);
  dlg.showModal();
  const makeWorker = () => {
    const w = new Worker(new URL('../solver/worker.js?v=6.2', import.meta.url), { type: 'module' });
    return {
      post: (m) => w.postMessage(m),
      onMessage: (fn) => {
        w.onmessage = (e) => fn(e.data);
      },
      onError: (fn) => {
        w.onerror = (e) => {
          e.preventDefault();
          fn(e);
        };
      },
      terminate: () => w.terminate(),
    };
  };
  const handle = startCareful(data, {
    makeWorker,
    workers,
    seconds,
    quickSeconds: quickSeconds(),
    seed,
    onEvent: (e) => {
      if (e.type === 'phase') {
        stage.textContent = phaseText[e.phase];
        stage.dataset.phase = e.phase;
      }
      if (e.type === 'quick') {
        quick.textContent = `1分の答え：${totalsText(e.totals)}`;
        early.disabled = false;
        earlyWhy.hidden = true;
      }
      if (e.type === 'best') {
        best.textContent = `いまのいちばん良い答え：${totalsText(e.totals)}`;
        best.dataset.hard = String(e.totals.hard);
      }
    },
  });
  early.addEventListener('click', () => handle.finishNow());
  const t0 = performance.now();
  const tick = () => {
    const el = Math.min(seconds, (performance.now() - t0) / 1000);
    bar.value = el;
    time.textContent = `${Math.floor(el)}秒たちました（あと最大${Math.max(0, Math.ceil(seconds - el))}秒）`;
  };
  job = { cancel: () => handle.stop(), dialog: dlg, timer: setInterval(tick, 250) };
  handle.promise.then((r) => {
    stopJob();
    if (!r.ok && r.reason === 'stopped') {
      notify('中止しました。シフト表は前のままです。', { testid: 'run-stopped' });
      rerender();
      return;
    }
    if (!r.ok && (r.reason === 'lost' || r.reason === 'no-worker')) {
      notify('計算の部品が止まりました。シフト表は前のままです。ページを読み込み直して、もう一度ためしてください。', { kind: 'error', testid: 'run-error' });
      rerender();
      return;
    }
    onResult(r);
  });
}
