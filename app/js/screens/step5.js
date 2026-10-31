// 手順5 自動で作る：1分で作る（おためし）。計算は裏方（solver/worker.js の Web Worker）で行うので、画面は固まらない。
// 計算は写しで行い、終わってから、そのあいだにデータが変わっていないことを確かめて本物の表に入れる。
import { h, append } from '../dom.js?v=4.3';
import { app, rerender, goStep } from '../state.js?v=4.3';
import { record, undo, nextUndo } from '../history.js?v=4.3';
import { canonicalJSON, clone, applyGenerated } from '../model.js?v=4.3';
import { checkTable, solveConflicts, unavoidableErrors } from '../check.js?v=4.3';
import { RULE_BY_ID } from '../rules.js?v=4.3';
import { ask, notify } from '../dialog.js?v=4.3';
import { takeBackup, backupLines } from '../backup.js?v=4.3';
import { timeLabel } from '../calendar.js?v=4.3';
import { screenTitle } from './common.js?v=4.3';
import { countBand } from './checkview.js?v=4.3';
import { startSolving, isSolving, quickSeconds } from './solving.js?v=4.3';

// 元に戻すの履歴での呼び名（手順6 の「元に戻す」にも出る）
const GENERATED_LABEL = '自動で作った表';

const hasCells = (d) => Object.values(d.month.table).some((row) => Object.keys(row).length > 0);
const ruleLine = (it) => `${RULE_BY_ID[it.rule]?.name ?? it.rule}：${it.text}`;

// 作る前に足りないもの（スタッフ・シフトが無い）
function basicProblems(d) {
  const out = [];
  if (!d.staff.length) out.push('スタッフがいません。手順3 スタッフで、1人以上入れてください。');
  if (!d.settings.shifts.length) out.push('シフトの種類がありません。手順2 シフトの種類で、1つ以上入れてください。');
  return out;
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
  startSolving({
    payload: { kind: 'generate', data: clone(d), timeLimit: seconds, seed },
    seconds,
    title: 'シフトを作っています',
    onResult: (r) => {
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
      const run = {
        at: new Date().toISOString(),
        mode: 'quick',
        limit: seconds,
        seed,
        seconds: r.seconds,
        finished: r.stages.length > 0 && r.stages.every((s) => s.status === 'solved'),
        stages: r.stages.map((s) => ({ key: s.key, name: s.name, status: s.status, seconds: s.seconds })),
      };
      record(GENERATED_LABEL, (x) => {
        applyGenerated(x, r.table, run);
        run.totals = checkTable(x).totals;
      }, { render: true });
      notify('シフト表を作りました。下の「作った結果」と、手順6 シフト表で見られます。', { kind: 'ok', testid: 'run-done' });
    },
  });
}

async function start() {
  if (isSolving()) return;
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

// 作る前の表に戻す（いちばん新しい履歴が「自動で作った表」のとき）
function undoGenerated() {
  const res = undo();
  if (!res) return;
  notify(res.skipped ? `作る前の表に戻しました。作ったあとで変えた所 ${res.skipped}か所は、いまのままにしました。` : '作る前の表に戻しました。', { kind: 'ok', testid: 'run-undone' });
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
  const names = (status) => stages.filter((s) => s.status === status).map((s) => s.name);
  const limited = names('limit');
  const kept = names('kept');
  // 時間切れの段があっても、あとの段は解いている。どの段がどうだったかを、全部の名前で書く
  const status = r.finished
    ? '最後まで解ききりました。決めた順番（6連勤以上 → 「絶対」の決まり → 「できれば」の決まり）で、これ以上良い答えは無いところまで確かめました。'
    : [
        limited.length ? `時間内に最後まで確かめきれなかった段がありました（${limited.join('・')}）。その段は、時間内に見つけたいちばん良い答えです。` : '',
        kept.length ? `${kept.join('・')}の段では、前の段より良い答えが時間内に見つからず、前の段の答えのままです。` : '',
        names('solved').length ? 'ほかの段は最後まで解きました。' : '',
      ].join('') || '時間内に見つけたいちばん良い答えです。';
  const res = checkTable(d);
  const edited = Object.values(d.month.marks).some((row) => Object.values(row).some((m) => m.edited));
  return h(
    'section',
    { class: 'card', testid: 'run-result', dataset: { finished: String(Boolean(r.finished)) } },
    h('h2', { text: '作った結果' }),
    h('p', { testid: 'run-when', text: `${when}${r.mode === 'restart' ? `「途中から作り直す」（${Number(r.fromDay) || ''}日から）` : '「1分で作る」'}で作りました（${Math.round(Number(r.seconds) || 0)}秒）。` }),
    h('p', { testid: 'run-status', text: status }),
    h('h3', { text: 'いまのシフト表の件数' }),
    countBand(res),
    edited ? h('p', { class: 'help', testid: 'run-edited', text: '作ったあとに手で変えたマスがあります。件数は、いまの表で数えています。' }) : null,
    h('h3', { text: 'つぎにやること' }),
    h(
      'ul',
      { class: 'next-steps' },
      h('li', {}, h('button', { type: 'button', class: 'btn btn-primary', text: '手順6 シフト表で見る', testid: 'run-go-table', on: { click: () => goStep(6) } }), h('span', { class: 'help', text: '　エラーのあるマスに印が付きます。表の下の一覧から、そのマスへ移れます。' })),
      h('li', {}, h('button', { type: 'button', class: 'btn', text: 'もう一度作る', testid: 'run-again', on: { click: start } }), h('span', { class: 'help', text: '　少し違う表になることがあります（いまの表は控えに残します）。' })),
      nextUndo()?.label === GENERATED_LABEL
        ? h('li', {}, h('button', { type: 'button', class: 'btn', text: '作る前の表に戻す', testid: 'run-undo', on: { click: undoGenerated } }), h('span', { class: 'help', text: '　手順6 の「元に戻す」と同じです。作ったあとで手で変えたマスは、いまのままにします。' }))
        : null,
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
