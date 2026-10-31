// 「保存と控え」の小窓：ひとつ前の保存に戻す・控えから戻す・書き出す・リセット。
import { h, append } from '../dom.js?v=6.2';
import { app, replaceData, rerender } from '../state.js?v=6.2';
import { prevSave, loadBackups, clearData, brokenCopy, MAX_BACKUPS } from '../storage.js?v=6.2';
import { planBackup, takeBackup, backupLines, backupLabel, backupSummary } from '../backup.js?v=6.2';
import { ask, notify, clearNotices } from '../dialog.js?v=6.2';
import { exportData, exportRaw } from '../files.js?v=6.2';
import { timeLabel } from '../calendar.js?v=6.2';
import { importFromFile } from './importer.js?v=6.2';

const at = (iso) => (iso ? timeLabel(new Date(iso)) : '時刻不明');

function backupFailed(what) {
  notify(`ブラウザに控えを保存できなかったので、${what}をやめました。先に「保存と控え」の「ファイルに書き出す」で残してください。`, { kind: 'error', testid: 'error-notice' });
}

// 控えから戻す。いまのデータがあれば、先にそれを控えに残す
export function restoreBackup(id) {
  const b = loadBackups().find((x) => x.id === id);
  if (!b) {
    notify('その控えが見つかりませんでした。', { kind: 'warn', testid: 'warn-notice' });
    return;
  }
  if (!takeBackup('restore', app.data)) {
    backupFailed('控えから戻すの');
    return;
  }
  replaceData(b.data, { step: 1 });
  notify(`「${backupLabel(b)}」の控えに戻しました。`, { kind: 'ok', testid: 'restored-notice' });
}

async function confirmRestorePrev(prev) {
  const v = await ask({
    title: 'ひとつ前の保存に戻しますか？',
    lines: [`いまのデータを、ひとつ前の保存（${at(prev.at)}）に置きかえます。`, ...backupLines(app.data)],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'restore-prev-cancel' },
      { label: '戻す', value: 'ok', kind: 'primary', testid: 'restore-prev-ok' },
    ],
  });
  if (v !== 'ok') return;
  if (!takeBackup('prev', app.data)) {
    backupFailed('ひとつ前の保存に戻すの');
    return;
  }
  replaceData(prev.data);
  notify('ひとつ前の保存に戻しました。', { kind: 'ok', testid: 'restored-notice' });
}

async function confirmRestoreBackup(b) {
  const v = await ask({
    title: `「${backupLabel(b)}」の控えに戻しますか？`,
    lines: [`いまのデータを、この控え（${backupSummary(b)}）に置きかえます。`, ...backupLines(app.data)],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'restore-backup-cancel' },
      { label: '戻す', value: 'ok', kind: 'primary', testid: 'restore-backup-ok' },
    ],
  });
  if (v === 'ok') restoreBackup(b.id);
}

async function confirmReset() {
  const v = await ask({
    title: 'リセットしますか？',
    lines: ['いまの設定・スタッフ・この月のデータを消して、業種の見本を選ぶ画面に戻ります。', ...backupLines(app.data)],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'reset-cancel' },
      { label: '先に書き出してからリセットする', value: 'export', testid: 'reset-export' },
      { label: 'リセットする', value: 'reset', kind: 'danger', testid: 'reset-ok' },
    ],
    testid: 'reset-dialog',
  });
  if (v !== 'reset' && v !== 'export') return;
  if (v === 'export') exportData(app.data);
  const made = !planBackup(app.data).skip;
  if (!takeBackup('reset', app.data)) {
    backupFailed('リセット');
    return;
  }
  const newest = made ? loadBackups()[0] : null;
  clearData();
  clearNotices();
  app.data = null;
  app.savedAt = null;
  app.step = 0;
  rerender();
  notify(made ? 'リセットしました。リセットの前のデータは控えに残しています。' : 'リセットしました。', {
    kind: 'ok',
    testid: 'reset-notice',
    actions: newest ? [{ label: 'リセットの前に戻す', testid: 'reset-undo', onClick: () => restoreBackup(newest.id) }] : [],
  });
}

// 控えの一覧（新しい順）。onPick(b) で戻す
export function backupList(onPick, testid = 'restore-backup') {
  const list = loadBackups();
  if (!list.length) return null;
  return h(
    'ul',
    { class: 'backup-list', testid: 'backup-list' },
    list.map((b) =>
      h(
        'li',
        {},
        h('div', {}, h('strong', { text: backupLabel(b) }), h('p', { class: 'help', text: backupSummary(b) })),
        h('button', { type: 'button', class: 'btn btn-small', testid, dataset: { backupId: b.id }, text: 'この控えに戻す', on: { click: () => onPick(b) } }),
      ),
    ),
  );
}

export function openDataPanel() {
  const dlg = h('dialog', { class: 'dialog', testid: 'data-panel', 'aria-labelledby': 'dp-title' });
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  const then = (fn) => () => {
    close();
    fn();
  };
  const prev = prevSave();
  const broken = brokenCopy();
  const backups = backupList((b) => then(() => confirmRestoreBackup(b))());
  append(dlg,
    h('h2', { id: 'dp-title', text: '保存と控え' }),
    h('p', { text: `いまのデータは、このブラウザの中に自動で保存しています（最後に保存：${at(app.savedAt)}）。` }),
    h(
      'section',
      { class: 'panel-part' },
      h('h3', { text: 'ひとつ前の保存' }),
      prev
        ? [
            h('p', { class: 'help', text: `ひとつ前の保存（${at(prev.at)}）に戻せます。` }),
            h('button', { type: 'button', class: 'btn', testid: 'restore-prev', text: 'ひとつ前の保存に戻す', on: { click: then(() => confirmRestorePrev(prev)) } }),
          ]
        : h('p', { class: 'help', text: 'まだありません。何か変えると、変える前のデータがここに入ります。' }),
    ),
    h(
      'section',
      { class: 'panel-part' },
      h('h3', { text: `控え（新しい順・${MAX_BACKUPS}つまで）` }),
      h('p', { class: 'help', text: 'リセット・月の片付け・取り込み・戻す操作の前に、自動で作ります。あとの自動保存では消えません。' }),
      backups ?? h('p', { class: 'help', text: 'まだありません。' }),
    ),
    h(
      'section',
      { class: 'panel-part' },
      h('h3', { text: 'ファイル' }),
      h('p', { class: 'help', text: 'いまのデータをファイルに書き出すと、ほかのパソコンへ移したり、残しておいたりできます。' }),
      h('button', {
        type: 'button',
        class: 'btn',
        testid: 'export-file',
        text: 'ファイルに書き出す',
        on: {
          click: then(() => {
            const name = exportData(app.data);
            notify(`「${name}」を書き出しました（ブラウザのダウンロードの場所に入ります）。`, { kind: 'ok', testid: 'export-notice' });
          }),
        },
      }),
      h('p', { class: 'help', text: 'このアプリで書き出したファイル（.json）を取り込めます。取り込む前に中身を確かめ、いまのデータは控えに残します。' }),
      h('button', { type: 'button', class: 'btn', testid: 'import-file', text: 'ファイルから取り込む', on: { click: then(importFromFile) } }),
      broken
        ? [
            h('p', { class: 'help', text: `前に読めなかった保存データ（${at(broken.at)}）が残っています。ファイルにして残せます。` }),
            h('button', { type: 'button', class: 'btn', testid: 'broken-export-panel', text: '読めなかったデータをファイルに保存する', on: { click: then(() => exportRaw(broken.raw)) } }),
          ]
        : null,
    ),
    h(
      'section',
      { class: 'panel-part' },
      h('h3', { text: 'はじめからやり直す' }),
      h('p', { class: 'help', text: 'いまのデータを消して、業種の見本を選ぶ画面に戻ります。' }),
      h('button', { type: 'button', class: 'btn btn-danger', testid: 'reset', text: 'リセット（見本を選び直す）', on: { click: then(confirmReset) } }),
    ),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn btn-primary', testid: 'data-panel-close', text: '閉じる', on: { click: close } })),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
}
