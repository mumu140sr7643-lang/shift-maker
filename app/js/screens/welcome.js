// 初めて開いたとき（とリセットのあと）の、業種の見本を選ぶ画面。
import { h, append } from '../dom.js?v=1.3.2';
import { SAMPLE_KINDS, buildSample } from '../samples.js?v=1.3.2';
import { nextMonthOf, monthLabel } from '../calendar.js?v=1.3.2';
import { replaceData } from '../state.js?v=1.3.2';
import { screenTitle } from './common.js?v=1.3.2';
import { backupList, restoreBackup } from './datapanel.js?v=1.3.2';
import { importFromFile } from './importer.js?v=1.3.2';

function backupBox() {
  const list = backupList((b) => restoreBackup(b.id), 'welcome-backup-restore');
  if (!list) return null;
  return h(
    'div',
    { class: 'card card-note', testid: 'welcome-backup' },
    h('p', { text: '前のデータが控えに残っています。前のデータに戻したいときは、ここから戻せます。' }),
    list,
  );
}

export function renderWelcome(el) {
  const { year, month } = nextMonthOf(new Date());
  append(el,
    ...screenTitle(
      'シフト表メーカーへようこそ',
      '1か月分のシフト表を作るアプリです。まず、業種の見本を1つ選んでください。見本の設定とスタッフ（名前は A・B・C…の作り物）が入ります。入ったものは、あとで自由に変えられます。',
    ),
    backupBox(),
    h(
      'div',
      { class: 'sample-grid', testid: 'welcome' },
      SAMPLE_KINDS.map((k) => {
        const d = buildSample(k.id, year, month);
        const size = k.id === 'blank' ? '設定もスタッフも空です' : `シフト${d.settings.shifts.length}種類・スタッフ${d.staff.length}人`;
        return h(
          'section',
          { class: 'sample-card' },
          h('h2', { text: k.name }),
          h('p', { text: k.summary }),
          h('p', { class: 'help', text: size }),
          h('button', {
            type: 'button',
            class: 'btn btn-primary',
            testid: `sample-${k.id}`,
            text: k.id === 'blank' ? '白紙から始める' : `${k.name}の見本で始める`,
            on: { click: () => replaceData(buildSample(k.id, year, month), { step: 1 }) },
          }),
        );
      }),
    ),
    h('p', { class: 'help', text: `作る月は ${monthLabel(year, month)} です（手順1 基本設定で変えられます）。` }),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: '書き出したファイルがあるとき' }),
      h('p', { class: 'help', text: 'ほかのパソコンやブラウザで書き出したファイル（.json）を取り込んで、続きから始められます。' }),
      h('button', { type: 'button', class: 'btn', testid: 'welcome-import', text: 'ファイルから取り込んで始める', on: { click: importFromFile } }),
    ),
    h('p', { class: 'help', text: '入れたデータは、このブラウザの中にだけ保存されます。インターネットの向こうへは送りません。' }),
  );
}
