// 手順5 自動で作る：1分で作る（おためし）。計算は裏方（solver/worker.js の Web Worker）で行うので、画面は固まらない。
// 計算は写しで行い、終わってから、そのあいだにデータが変わっていないことを確かめて本物の表に入れる。
import { h, append } from '../dom.js?v=3.2';
import { app, commit, rerender, goStep } from '../state.js?v=3.2';
import { canonicalJSON, clone, applyGenerated } from '../model.js?v=3.2';
import { checkTable, solveConflicts, unavoidableErrors } from '../check.js?v=3.2';
import { RULE_BY_ID } from '../rules.js?v=3.2';
import { ask, notify } from '../dialog.js?v=3.2';
import { takeBackup, backupLines } from '../backup.js?v=3.2';
import { timeLabel } from '../calendar.js?v=3.2';
import { screenTitle } from './common.js?v=3.2';
import { countBand } from './checkview.js?v=3.2';

const QUICK_SECONDS = 60;

// 1分で作るの秒。確かめの道具だけが、アドレスの ?seconds=5 のように短くする（3〜60秒）
function quickSeconds() {
  const n = Number(new URLSearchParams(window.location.search).get('seconds'));
  return Number.isInteger(n) && n >= 3 && n <= QUICK_SECONDS ? n : QUICK_SECONDS;
}

// 計算中の仕事（画面を作り直しても残す）
let job = null;

const hasCells = (d) => Object.values(d.month.table).some((row) => Object.keys(row).length > 0);
const ruleLine = (it) => `${RULE_BY_ID[it.rule]?.name ?? it.rule}：${it.text}`;

// 作る前に足りないもの（スタッフ・シフトが無い）
function basicProblems(d) {
  const out = [];
  if (!d.staff.length) out.push('スタッフがいません。手順3 スタッフで、1人以上入れてください。');
  if (!d.settings.shifts.length) out.push('シフトの種類がありません。手順2 シフトの種類で、1つ以上入れてください。');
  return out;
}

function stopJob() {
  if (!job) return;
  job.worker.terminate();
  clearInterval(job.timer);
  job.dialog.close();
  job.dialog.remove();
  job = null;
}

function progressDialog(seconds, onStop) {
  const stage = h('p', { class: 'run-stage', testid: 'run-stage', text: 'はじめの段を用意しています' });
  const bar = h('progress', { class: 'run-bar', max: String(seconds), value: '0', testid: 'run-progress', 'aria-label': 'たった時間' });
  const time = h('p', { class: 'run-time', testid: 'run-time', text: `0秒たちました（あと最大${seconds}秒）` });
  const best = h('p', { class: 'run-best', testid: 'run-best', text: 'いまのいちばん良い答え：まだありません（はじめの段を解いています）' });
  const dlg = h(
    'dialog',
    { class: 'dialog run-dialog', testid: 'run-dialog', 'aria-labelledby': 'run-title' },
    h('h2', { id: 'run-title', text: 'シフトを作っています' }),
    stage,
    bar,
    time,
    best,
    h('p', { class: 'help', text: '作っているあいだは、入力・手順の移動・月の切り替え・取り込みを止めています（作っている途中の表とぶつからないようにするため）。止めたいときは「中止」を押してください。表は前のままになります。' }),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn btn-danger', text: '中止', testid: 'run-stop', on: { click: onStop } })),
  );
  // Esc では閉じない（中止は「中止」で）
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.appendChild(dlg);
  dlg.showModal();
  return { dlg, stage, bar, time, best };
}

function failText(reason, conflicts) {
  if (reason === 'conflict') return `このままでは作れません。${conflicts.slice(0, 3).map(ruleLine).join(' ／ ')}。手順5 の「作る前の確かめ」を見て直してください。シフト表は前のままです。`;
  if (reason === 'infeasible') return '条件どうしがぶつかって作れませんでした。シフト表は前のままです。手順4 の希望と、手順6 で固定したマスを見直してください。';
  return '時間内に作れませんでした。シフト表は前のままです。スタッフの数や希望の数を見直してください（このあとの版の「じっくり作る」では、もっと時間をかけて作れます）。';
}

function run(d) {
  const seconds = quickSeconds();
  const startText = canonicalJSON(d);
  const seed = (d.month.runs.length % 1000) + 1;
  let worker;
  try {
    worker = new Worker(new URL('../solver/worker.js?v=3.2', import.meta.url), { type: 'module' });
  } catch {
    notify('計算の部品を動かせませんでした。ページを読み込み直して、もう一度ためしてください。', { kind: 'error', testid: 'run-error' });
    return;
  }
  const ui = progressDialog(seconds, () => {
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
      if (m.phase === 'start') ui.stage.textContent = `いまの段：${m.stage}/${m.count}（${m.name}）`;
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
    const r = m.result;
    if (!r.ok) {
      notify(failText(r.reason, r.conflicts), { kind: 'error', testid: 'run-failed' });
      rerender();
      return;
    }
    // 計算のあいだに、別のタブ（画面）でデータが変わっていたら、そちらを守って入れない
    if (canonicalJSON(app.data) !== startText) {
      notify('計算のあいだに、別のタブ（画面）でデータが変わりました。そちらの内容を守るため、作った表は入れませんでした。もう一度「シフトを作る」を押してください。', { kind: 'warn', testid: 'run-changed' });
      rerender();
      return;
    }
    const record = {
      at: new Date().toISOString(),
      mode: 'quick',
      limit: seconds,
      seed,
      seconds: r.seconds,
      finished: r.stages.length > 0 && r.stages.every((s) => s.status === 'solved'),
      stages: r.stages.map((s) => ({ key: s.key, name: s.name, status: s.status, seconds: s.seconds })),
    };
    commit((x) => {
      applyGenerated(x, r.table, record);
      record.totals = checkTable(x).totals;
    }, { render: true });
    notify('シフト表を作りました。下の「作った結果」と、手順6 シフト表で見られます。', { kind: 'ok', testid: 'run-done' });
  };
  worker.onerror = (e) => {
    e.preventDefault();
    stopJob();
    notify('計算の部品を読み込めませんでした。シフト表は前のままです。ページを読み込み直して、もう一度ためしてください。', { kind: 'error', testid: 'run-error' });
    rerender();
  };
  worker.postMessage({ data: clone(d), timeLimit: seconds, seed });
}

async function start() {
  if (job) return;
  const d = app.data;
  if (basicProblems(d).length || solveConflicts(d).length) {
    rerender();
    return;
  }
  if (hasCells(d)) {
    const v = await ask({
      title: 'いまのシフト表を置きかえます',
      lines: ['いまのシフト表は、自動で作った表に置きかわります。固定したマスと希望は、そのまま残します。', ...backupLines(d)],
      buttons: [
        { label: 'やめる', value: 'cancel', testid: 'generate-cancel' },
        { label: '置きかえて作る', value: 'ok', kind: 'primary', testid: 'generate-ok' },
      ],
      testid: 'generate-confirm',
    });
    if (v !== 'ok') return;
    if (!takeBackup('generate', d)) {
      notify('控えをブラウザに残せなかったので、作るのをやめました。「保存と控え」から、いまのデータをファイルに書き出してから、もう一度ためしてください。', { kind: 'error', testid: 'generate-backup-failed' });
      return;
    }
  }
  run(app.data);
}

function modeCard() {
  const option = (value, label, help, disabled, testid) =>
    h(
      'label',
      { class: disabled ? 'mode is-disabled' : 'mode' },
      h('input', { type: 'radio', name: 'make-mode', value, checked: !disabled, disabled, testid }),
      h('span', { class: 'mode-text' }, h('span', { class: 'mode-name', text: label }), h('span', { class: 'help', text: help })),
    );
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: '1. 作り方を選ぶ' }),
    h(
      'div',
      { class: 'modes', role: 'radiogroup', 'aria-label': '作り方' },
      option('quick', '1分で作る（おためし）', '1分ほどで作ります。まず形を見たいときに。', false, 'mode-quick'),
      option('careful', 'じっくり作る（本番。最大10分ほど）', '準備中です。このあとの版で使えるようになります。', true, 'mode-careful'),
    ),
  );
}

function precheckCard(d, problems, blockers, unavoidable) {
  const parts = [];
  if (problems.length) {
    parts.push(h('div', { class: 'conflicts', testid: 'solve-missing' }, h('h3', { text: 'まだ作れません' }), h('ul', {}, problems.map((t) => h('li', { text: t })))));
  }
  if (blockers.length) {
    parts.push(
      h(
        'div',
        { class: 'conflicts', testid: 'solve-blockers', dataset: { count: String(blockers.length) } },
        h('h3', { text: `このままでは作れません（${blockers.length}件）` }),
        h('p', { class: 'help', text: '自動で作るときに必ず守る決まりと、希望・固定がぶつかっています。直してから「シフトを作る」を押してください。希望は 手順4 希望の入力、固定したマスは 手順6 シフト表、担当できるシフトとスキルは 手順3 スタッフ で直せます。' }),
        h('ul', {}, blockers.map((it) => h('li', { text: ruleLine(it) }))),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn btn-small', text: '手順4 希望の入力へ', testid: 'blockers-go-4', on: { click: () => goStep(4) } }),
          h('button', { type: 'button', class: 'btn btn-small', text: '手順6 シフト表へ', testid: 'blockers-go-6', on: { click: () => goStep(6) } }),
        ),
      ),
    );
  }
  if (unavoidable.length) {
    parts.push(
      h(
        'div',
        { class: 'unavoidable', testid: 'solve-unavoidable', dataset: { count: String(unavoidable.length) } },
        h('h3', { text: `希望・固定のとおりにすると、次のエラーは避けられません（${unavoidable.length}件）` }),
        h('p', { class: 'help', text: 'このまま作れますが、作った表にもこのエラーが残ります。減らしたいときは、希望・固定か、手順3 スタッフ の「前の月の終わり」の連勤を見直してください。' }),
        h('ul', {}, unavoidable.map((it) => h('li', { text: ruleLine(it) }))),
      ),
    );
  }
  if (!parts.length) parts.push(h('p', { class: 'precheck-ok', testid: 'precheck-ok', text: 'ぶつかる希望や固定はありません。このまま作れます。' }));
  return h('section', { class: 'card' }, h('h2', { text: '2. 作る前の確かめ' }), parts);
}

function makeCard(d, canMake) {
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: '3. 作る' }),
    h('button', { type: 'button', class: 'btn btn-primary btn-big', text: 'シフトを作る', testid: 'generate', disabled: !canMake, on: { click: start } }),
    canMake ? null : h('p', { class: 'help why', testid: 'generate-why', text: '上の「2. 作る前の確かめ」を直すと押せます。' }),
    h('p', { class: 'help', text: `${quickSeconds()}秒ほどかかります。計算のあいだは、ほかの重いアプリを閉じてください（時間で区切って作るので、パソコンが混んでいると、答えが悪くなることがあります）。` }),
    hasCells(d) ? h('p', { class: 'help', text: 'いまのシフト表は、作った表に置きかわります。置きかえる前に控えを残すので、「保存と控え」から戻せます。' }) : null,
  );
}

function resultCard(d) {
  const r = d.month.runs[d.month.runs.length - 1];
  if (!r || typeof r !== 'object') return null;
  const at = new Date(r.at);
  const when = Number.isNaN(at.getTime()) ? '' : `${timeLabel(at)} に`;
  const stages = Array.isArray(r.stages) ? r.stages : [];
  const firstLimit = stages.find((s) => s.status !== 'solved');
  const kept = stages.filter((s) => s.status === 'kept');
  const status = r.finished
    ? '最後まで解ききりました。決めた順番（6連勤以上 → 「絶対」の決まり → 「できれば」の決まり）で、これ以上良い答えは無いところまで確かめました。'
    : `時間切れのため、時間内に見つけたいちばん良い答えを入れました（${firstLimit?.name ?? '「できれば」の決まり'}の段で止めました）。`;
  const res = checkTable(d);
  const edited = Object.values(d.month.marks).some((row) => Object.values(row).some((m) => m.edited));
  return h(
    'section',
    { class: 'card', testid: 'run-result', dataset: { finished: String(Boolean(r.finished)) } },
    h('h2', { text: '作った結果' }),
    h('p', { testid: 'run-when', text: `${when}「1分で作る」で作りました（${Math.round(Number(r.seconds) || 0)}秒）。` }),
    h('p', { testid: 'run-status', text: status }),
    kept.length ? h('p', { class: 'help', text: `${kept.map((s) => s.name).join('・')}の段では、前の段より良い答えが時間内に見つからず、前の段の答えのままです。` }) : null,
    h('h3', { text: 'いまのシフト表の件数' }),
    countBand(res),
    edited ? h('p', { class: 'help', testid: 'run-edited', text: '作ったあとに手で変えたマスがあります。件数は、いまの表で数えています。' }) : null,
    h('h3', { text: 'つぎにやること' }),
    h(
      'ul',
      { class: 'next-steps' },
      h('li', {}, h('button', { type: 'button', class: 'btn btn-primary', text: '手順6 シフト表で見る', testid: 'run-go-table', on: { click: () => goStep(6) } }), h('span', { class: 'help', text: '　エラーのあるマスに印が付きます。表の下の一覧から、そのマスへ移れます。' })),
      h('li', {}, h('button', { type: 'button', class: 'btn', text: 'もう一度作る', testid: 'run-again', on: { click: start } }), h('span', { class: 'help', text: '　少し違う表になることがあります（いまの表は控えに残します）。' })),
    ),
  );
}

export function renderStep5(el) {
  const d = app.data;
  append(el, ...screenTitle('手順5 自動で作る', '手順1〜4 で入れた設定・スタッフ・希望から、シフト表を自動で作ります。固定したマスと希望は、そのまま残します。'));
  const problems = basicProblems(d);
  const blockers = problems.length ? [] : solveConflicts(d);
  const unavoidable = problems.length ? [] : unavoidableErrors(d);
  append(el, modeCard(), precheckCard(d, problems, blockers, unavoidable), makeCard(d, !problems.length && !blockers.length), resultCard(d));
}
