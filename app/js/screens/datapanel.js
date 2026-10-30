// 「保存と控え」の小窓：ひとつ前の保存に戻す・控えから戻す・書き出す・リセット。
import { h, append } from '../dom.js?v=1.1';
import { app, replaceData, rerender } from '../state.js?v=1.1';
import { prevSave, loadBackup, saveBackup, clearData, BACKUP_REASONS } from '../storage.js?v=1.1';
import { ask, notify } from '../dialog.js?v=1.1';
import { exportData } from '../files.js?v=1.1';
import { timeLabel } from '../calendar.js?v=1.1';

const at = (iso) => (iso ? timeLabel(new Date(iso)) : '時刻不明');

export function restoreBackup() {
  const b = loadBackup();
  if (!b) {
    notify('控えが見つかりませんでした。', { kind: 'warn', testid: 'warn-notice' });
    return;
  }
  replaceData(b.data, { step: 1 });
  notify(`${BACKUP_REASONS[b.reason] || '控え'}のデータに戻しました。いま戻す前のデータは「ひとつ前の保存」に入っています。`, { kind: 'ok', testid: 'restored-notice' });
}

async function confirmRestorePrev(prev) {
  const v = await ask({
    title: 'ひとつ前の保存に戻しますか？',
    lines: [`いまのデータを、ひとつ前の保存（${at(prev.at)}）に置きかえます。いまのデータは、かわりに「ひとつ前の保存」に入るので、もう一度押せば戻せます。`],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'restore-prev-cancel' },
      { label: '戻す', value: 'ok', kind: 'primary', testid: 'restore-prev-ok' },
    ],
  });
  if (v !== 'ok') return;
  replaceData(prev.data);
  notify('ひとつ前の保存に戻しました。', { kind: 'ok', testid: 'restored-notice' });
}

async function confirmRestoreBackup(b) {
  const what = BACKUP_REASONS[b.reason] || '控え';
  const v = await ask({
    title: `${what}に戻しますか？`,
    lines: [`いまのデータを、${what}（${at(b.at)}）のデータに置きかえます。いまのデータは「ひとつ前の保存」に入るので、戻すこともできます。`],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'restore-backup-cancel' },
      { label: '戻す', value: 'ok', kind: 'primary', testid: 'restore-backup-ok' },
    ],
  });
  if (v === 'ok') restoreBackup();
}

async function confirmReset() {
  const v = await ask({
    title: 'リセットしますか？',
    lines: [
      'いまの設定・スタッフ・この月のデータを消して、業種の見本を選ぶ画面に戻ります。',
      '消す前のデータは控えに残します。あとで「リセットの前に戻す」で戻せます。',
    ],
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'reset-cancel' },
      { label: '先に書き出してからリセットする', value: 'export', testid: 'reset-export' },
      { label: 'リセットする', value: 'reset', kind: 'danger', testid: 'reset-ok' },
    ],
    testid: 'reset-dialog',
  });
  if (v !== 'reset' && v !== 'export') return;
  if (v === 'export') exportData(app.data);
  if (!saveBackup('reset', app.data)) {
    notify('ブラウザに控えを保存できなかったので、リセットをやめました。先に「ファイルに書き出す」で残してください。', { kind: 'error', testid: 'error-notice' });
    return;
  }
  clearData();
  app.data = null;
  app.savedAt = null;
  app.step = 0;
  rerender();
  notify('リセットしました。リセットの前のデータは控えに残しています。', {
    kind: 'ok',
    testid: 'reset-notice',
    actions: [{ label: 'リセットの前に戻す', testid: 'reset-undo', onClick: restoreBackup }],
  });
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
  const backup = loadBackup();
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
      h('h3', { text: '控え' }),
      backup
        ? [
            h('p', { class: 'help', text: `${BACKUP_REASONS[backup.reason] || '控え'}（${at(backup.at)}）のデータがあります。この控えは、あとの自動保存では消えません。` }),
            h('button', { type: 'button', class: 'btn', testid: 'restore-backup', text: `${BACKUP_REASONS[backup.reason] || '控え'}に戻す`, on: { click: then(() => confirmRestoreBackup(backup)) } }),
          ]
        : h('p', { class: 'help', text: 'まだありません。リセット・月の片付け・取り込みの前に、自動で作ります。' }),
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
      h('p', { class: 'help', text: 'ファイルからの取り込みは準備中です。次の版で使えるようになります。' }),
    ),
    h(
      'section',
      { class: 'panel-part' },
      h('h3', { text: 'はじめからやり直す' }),
      h('p', { class: 'help', text: 'いまのデータを消して、業種の見本を選ぶ画面に戻ります。消す前に控えを残します。' }),
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
