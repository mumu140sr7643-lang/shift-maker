// 手順6 の「エラーを自動で直す」と「途中から作り直す」（4-2。docs/自動で直す案.md）。
// 直す：上限ごとの案を探して並べ、選んだ案を表で見せてから反映する。途中から：選んだ日までを残して、あとの日を作り直す。
// どちらも計算は写しで行い（solving.js）、入れる前にデータが変わっていないか確かめ、元に戻すの履歴に1つで入れる。
import { h, append, field, select } from '../dom.js?v=4.3';
import { app, rerender, onReplaceData } from '../state.js?v=4.3';
import { record } from '../history.js?v=4.3';
import { canonicalJSON, clone, cellName, monthDays, applyCellChanges, addRun } from '../model.js?v=4.3';
import { checkTable, solveConflicts } from '../check.js?v=4.3';
import { RULE_BY_ID } from '../rules.js?v=4.3';
import { ask, form, notify } from '../dialog.js?v=4.3';
import { takeBackup, backupLines } from '../backup.js?v=4.3';
import { prepareRepair, prepareRestart, tableChanges } from '../solver/repair.js?v=4.3';
import { startSolving, isSolving, quickSeconds } from './solving.js?v=4.3';

// 見ている案：{ baseText（探したときのデータ）, before（いまの件数）, proposal } | null
let preview = null;
// いちばん新しい探した結果（「ほかの案を見る」で並べ直す）：{ baseText, result } | null
let found = null;
onReplaceData(() => {
  preview = null;
  found = null;
});

export const currentPreview = () => preview;

const ruleLine = (it) => `${RULE_BY_ID[it.rule]?.name ?? it.rule}：${it.text}`;
const budgetName = (b) => (b === null || b === undefined ? '全部' : `${b}マスまで`);
const beforeAfter = (a, b) =>
  `6連勤以上 ${a.sixPlus}→${b.sixPlus}件・絶対 ${a.hard}→${b.hard}件・できれば ${a.soft}→${b.soft}件・不足 ${a.shortSlots}→${b.shortSlots}コマ`;
const hasCells = (d) => Object.values(d.month.table).some((row) => Object.keys(row).length > 0);

// 「エラーを自動で直す」を押せるか。返す：理由の文（押せるなら null）
export function repairBlockReason(result) {
  if (result.tableEmpty) return 'シフト表がまだ空です。手順5 で作るか、マスを入れてから使えます。';
  const t = result.totals;
  if (t.sixPlus + t.hard + t.soft === 0) return 'エラーが無いので、直すものはありません。';
  if (preview) return '案を見ているところです。上の「この案にする」か「やめる」を押してください。';
  return null;
}

// ---------- エラーを自動で直す ----------

export async function openRepair() {
  if (isSolving()) return;
  const d = app.data;
  const base = prepareRepair(d);
  const blockers = solveConflicts(base.prepared);
  if (blockers.length) {
    notify(`このままでは直せません。${blockers.slice(0, 3).map(ruleLine).join(' ／ ')}。固定したマスか、手順4 の希望を直してください。`, { kind: 'error', testid: 'repair-blocked' });
    return;
  }
  const per = Math.max(2, Math.round(quickSeconds() / 4));
  const v = await ask({
    title: 'エラーを自動で直す',
    lines: [
      `いまの表から、変えてよいマスの数を 10・25・50・全部 に限って、エラーが減る案を探します（${per * 4}秒ほど）。`,
      '固定したマス・空いているマス・半休はそのままにします。希望と違うマスは、希望のとおりに直します。',
      '探し終えたら案を並べます。案を選んで「この案にする」を押すまで、いまの表は変わりません。',
    ],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'repair-cancel-start' },
      { label: '直す案を探す', value: 'ok', kind: 'primary', testid: 'repair-start' },
    ],
    testid: 'repair-confirm',
  });
  if (v !== 'ok') return;
  const baseText = canonicalJSON(app.data);
  startSolving({
    payload: { kind: 'repair', data: clone(app.data), secondsEach: per, seed: 1 },
    seconds: per * 4,
    title: '直す案を探しています',
    stageText: (m) => `${budgetName(m.budget)}（${m.budgetIndex + 1}/${m.budgetCount}）　いまの段：${m.stage}/${m.count}（${m.name}）`,
    onResult: (r) => {
      if (!r.ok) {
        notify(r.reason === 'conflict' ? `このままでは直せません。${r.conflicts.slice(0, 3).map(ruleLine).join(' ／ ')}。` : '案を探せませんでした。', { kind: 'error', testid: 'repair-blocked' });
        rerender();
        return;
      }
      found = { baseText, result: r };
      rerender();
      showResults();
    },
  });
}

// 探した案を並べる小窓
export function showResults() {
  if (!found) return;
  const { result } = found;
  const dlg = h('dialog', { class: 'dialog repair-results', testid: 'repair-results', 'aria-labelledby': 'repair-title' });
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  const goods = result.proposals.filter((p) => p.status === 'ok' && p.improved && p.sameAs === undefined);
  const card = (p) => {
    const name = budgetName(p.budget);
    let body;
    if (p.status === 'too-many') body = h('p', { class: 'help', text: 'この上限では直せませんでした（必ず変えるマスが多いため）。' });
    else if (p.status === 'no-answer') body = h('p', { class: 'help', text: '時間内に案が見つかりませんでした。' });
    else if (p.sameAs !== undefined) body = h('p', { class: 'help', text: `${budgetName(p.sameAs)}と同じ案です。` });
    else if (!p.improved) body = h('p', { class: 'help', text: `いまの表より良くなりませんでした（変わるマス ${p.changes.length}か所・${beforeAfter(result.before, p.totals)}）。` });
    else {
      body = [
        h('p', { text: `変わるマス ${p.changes.length}か所` }),
        h('p', { class: 'repair-counts', text: beforeAfter(result.before, p.totals) }),
        p.finished ? null : h('p', { class: 'help', text: '時間内に最後まで確かめきれなかった段があります（その段は、時間内に見つけたいちばん良い答えです）。' }),
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          text: 'この案を見る',
          testid: 'repair-view',
          dataset: { budget: name },
          on: {
            click: () => {
              close();
              preview = { baseText: found.baseText, before: result.before, proposal: p };
              rerender();
            },
          },
        }),
      ];
    }
    return h('li', { class: 'repair-item', testid: 'repair-item', dataset: { budget: name, status: p.status, improved: String(Boolean(p.improved)) } }, h('h3', { text: name }), body);
  };
  append(
    dlg,
    h('h2', { id: 'repair-title', text: '直す案' }),
    h('p', { text: `いまの表：6連勤以上 ${result.before.sixPlus}件・絶対 ${result.before.hard}件・できれば ${result.before.soft}件・不足 ${result.before.shortSlots}コマ` }),
    goods.length
      ? h('p', { class: 'help', text: '「この案を見る」で、案の表を手順6 の表で見られます（まだ変わりません）。' })
      : h('p', { class: 'notice notice-info', testid: 'repair-none', text: 'いまの表より良くなる案は見つかりませんでした。手順5 で作り直すか、手順1〜4 の設定・希望を見直してください。' }),
    h('ul', { class: 'repair-list' }, result.proposals.map(card)),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn', text: '閉じる', testid: 'repair-results-close', on: { click: close } })),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
}

function applyPreview() {
  const p = preview;
  preview = null;
  if (!p) return;
  if (canonicalJSON(app.data) !== p.baseText) {
    notify('案を探したあとで表が変わったので、この案は使えません。もう一度「エラーを自動で直す」を押してください。', { kind: 'warn', testid: 'repair-stale' });
    found = null;
    rerender();
    return;
  }
  found = null;
  const n = p.proposal.changes.length;
  record(`エラーを自動で直す（${n}か所）`, (x) => applyCellChanges(x, p.proposal.changes), { render: true });
  notify(`案にしました（${n}か所を変えました）。「元に戻す」で、直す前の表に戻せます。`, { kind: 'ok', testid: 'repair-done' });
}

// 案を見ているときの枠（表の上）
export function previewCard() {
  if (!preview) return null;
  const d = app.data;
  const { proposal, before } = preview;
  const who = (pid) => `${d.staff.find((p) => p.id === pid)?.name || '名前なし'}さん`;
  const list = proposal.changes.slice(0, 10).map((c) => h('li', { text: `${who(c.pid)} ${c.day}日　${cellName(d, c.before)} → ${cellName(d, c.after)}` }));
  return h(
    'div',
    { class: 'repair-preview', testid: 'repair-preview', role: 'status' },
    h('h2', { text: `案を見ています：${budgetName(proposal.budget)}（変わるマス ${proposal.changes.length}か所）` }),
    h('p', { class: 'repair-counts', text: beforeAfter(before, proposal.totals) }),
    h('p', { class: 'help', text: '下の表は、案のとおりに変えて見せています。変わるマスは点線の枠です。まだ本物の表は変わっていません（見ているあいだは、マスの変更・入れ替え・元に戻すを止めています）。' }),
    h('ul', { class: 'repair-changes', testid: 'repair-changes' }, list, proposal.changes.length > 10 ? h('li', { text: `ほか ${proposal.changes.length - 10}件` }) : null),
    h(
      'div',
      { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'この案にする', testid: 'repair-apply', on: { click: applyPreview } }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'ほかの案を見る',
        testid: 'repair-back',
        on: {
          click: () => {
            preview = null;
            rerender();
            showResults();
          },
        },
      }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: 'やめる（いまの表のまま）',
        testid: 'repair-cancel',
        on: {
          click: () => {
            preview = null;
            rerender();
          },
        },
      }),
    ),
  );
}

// ---------- 途中から作り直す ----------

export async function openRestart() {
  if (isSolving()) return;
  const d = app.data;
  const N = monthDays(d);
  const { month } = d.month;
  const sel = select(
    Array.from({ length: N - 1 }, (_, i) => ({ value: String(i + 1), label: `${month}月${i + 1}日まではいまのまま（${i + 2}日から作り直す）` })),
    String(Math.floor(N / 2)),
    { testid: 'restart-day' },
  );
  const values = await form({
    title: '途中から作り直す',
    intro: ['選んだ日までのマスは、いまのまま変えません（固定の印は付けません）。あとの日は、固定したマスと希望のほかを作り直します。', ...backupLines(d)].join(''),
    fields: [{ key: 'day', el: field('どの日まで残すか', sel), read: () => Number(sel.value) }],
    okLabel: '作り直す',
    check: () => null,
    testid: 'restart-dialog',
  });
  if (!values) return;
  const fromDay = values.day + 1;
  const prepared = prepareRestart(app.data, fromDay);
  const blockers = solveConflicts(prepared, { lockedName: 'いまのまま残すマス' });
  if (blockers.length) {
    const shown = blockers.slice(0, 5).map(ruleLine);
    notify(
      `${values.day}日までのマスに、自動で作るときに必ず守る決まりとぶつかる所があります。直してから作り直してください。${shown.join(' ／ ')}${blockers.length > 5 ? ` ほか${blockers.length - 5}件` : ''}`,
      { kind: 'error', testid: 'restart-blocked' },
    );
    return;
  }
  if (hasCells(app.data) && !takeBackup('restart', app.data)) {
    notify('控えをブラウザに残せなかったので、作り直すのをやめました。「保存と控え」から、いまのデータをファイルに書き出してから、もう一度ためしてください。', { kind: 'error', testid: 'restart-backup-failed' });
    return;
  }
  const seconds = quickSeconds();
  const baseText = canonicalJSON(app.data);
  const seed = (app.data.month.runs.length % 1000) + 1;
  startSolving({
    payload: { kind: 'generate', data: prepared, timeLimit: seconds, seed },
    seconds,
    title: `${fromDay}日から作り直しています`,
    onResult: (r) => {
      if (!r.ok) {
        notify(r.reason === 'conflict' ? `作り直せませんでした。${r.conflicts.slice(0, 3).map(ruleLine).join(' ／ ')}。` : '時間内に作り直せませんでした。シフト表は前のままです。', { kind: 'error', testid: 'restart-failed' });
        rerender();
        return;
      }
      if (canonicalJSON(app.data) !== baseText) {
        notify('計算のあいだに、別のタブ（画面）でデータが変わりました。そちらの内容を守るため、作り直した表は入れませんでした。', { kind: 'warn', testid: 'run-changed' });
        rerender();
        return;
      }
      const changes = tableChanges(app.data, r.table);
      const run = {
        at: new Date().toISOString(),
        mode: 'restart',
        fromDay,
        limit: seconds,
        seed,
        seconds: r.seconds,
        finished: r.stages.length > 0 && r.stages.every((s) => s.status === 'solved'),
        stages: r.stages.map((s) => ({ key: s.key, name: s.name, status: s.status, seconds: s.seconds })),
      };
      record(`途中から作り直す（${fromDay}日から）`, (x) => {
        applyCellChanges(x, changes);
        run.totals = checkTable(x).totals;
        addRun(x, run);
      }, { render: true });
      notify(`${fromDay}日から作り直しました（${changes.length}か所が変わりました）。「元に戻す」で戻せます。`, { kind: 'ok', testid: 'restart-done' });
    },
  });
}
