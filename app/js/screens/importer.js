// ファイルから取り込む。取り込む前に中身を全部確かめ、正しくなければ断って、いまのデータのままにする。
import { h } from '../dom.js?v=5.3';
import { app, replaceData } from '../state.js?v=5.3';
import { parseData } from '../storage.js?v=5.3';
import { importProblems } from '../model.js?v=5.3';
import { takeBackup, backupLines } from '../backup.js?v=5.3';
import { SAMPLE_KINDS } from '../samples.js?v=5.3';
import { monthLabel } from '../calendar.js?v=5.3';
import { exportData } from '../files.js?v=5.3';
import { ask, notify } from '../dialog.js?v=5.3';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// ファイルを選んでもらう。やめたら null
function pickFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true, testid: 'import-input' });
    const done = (file) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function refuse(problems) {
  const shown = problems.slice(0, 5);
  await ask({
    title: 'このファイルは取り込めませんでした',
    lines: [
      ...shown,
      problems.length > shown.length ? `ほかに${problems.length - shown.length}件あります。` : null,
      'いまのデータは、そのままです。',
    ].filter(Boolean),
    buttons: [{ label: '閉じる', value: 'ok', kind: 'primary', testid: 'import-error-close' }],
    testid: 'import-error-dialog',
  });
}

function summary(d) {
  const kind = SAMPLE_KINDS.find((k) => k.id === d.sample);
  return [
    kind ? `${kind.name}の見本から` : null,
    monthLabel(d.month.year, d.month.month),
    `スタッフ${d.staff.length}人`,
    `シフト${d.settings.shifts.length}種類`,
  ].filter(Boolean).join('・');
}

export async function importFromFile() {
  const file = await pickFile();
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) {
    await refuse([`ファイルが大きすぎます（${(file.size / 1024 / 1024).toFixed(1)}MB。5MB まで）。このアプリで書き出したファイルは、ふつう 1MB より小さくなります。`]);
    return;
  }
  let text;
  try {
    text = (await file.text()).replace(/^﻿/, '');
  } catch {
    await refuse(['ファイルを読めませんでした。']);
    return;
  }
  const r = parseData(text);
  if (r.error) {
    await refuse(r.error);
    return;
  }
  const more = importProblems(r.data);
  if (more.length) {
    await refuse(more);
    return;
  }
  const lines = [`「${file.name}」（${summary(r.data)}）を取り込みます。`];
  if (app.data) lines.push('いまの設定・スタッフ・この月のデータは、このファイルの中身に置きかわります。', ...backupLines(app.data));
  const v = await ask({
    title: 'このファイルを取り込みますか？',
    lines,
    buttons: [
      { label: 'やめる', value: 'cancel', testid: 'import-cancel' },
      app.data ? { label: '先に書き出してから取り込む', value: 'export', testid: 'import-export' } : null,
      { label: '取り込む', value: 'ok', kind: 'primary', testid: 'import-ok' },
    ].filter(Boolean),
    testid: 'import-dialog',
  });
  if (v !== 'ok' && v !== 'export') return;
  if (v === 'export') exportData(app.data);
  if (!takeBackup('import', app.data)) {
    notify('ブラウザに控えを保存できなかったので、取り込みをやめました。先に「保存と控え」の「ファイルに書き出す」で残してください。', { kind: 'error', testid: 'error-notice' });
    return;
  }
  replaceData(r.data, { step: 1 });
  notify(`「${file.name}」を取り込みました。`, { kind: 'ok', testid: 'import-notice' });
}
