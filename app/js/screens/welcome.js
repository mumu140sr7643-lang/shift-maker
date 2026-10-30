// 初めて開いたとき（とリセットのあと）の、業種の見本を選ぶ画面。
import { h, append } from '../dom.js?v=1.1';
import { SAMPLE_KINDS, buildSample } from '../samples.js?v=1.1';
import { nextMonthOf, monthLabel, timeLabel } from '../calendar.js?v=1.1';
import { replaceData } from '../state.js?v=1.1';
import { loadBackup, BACKUP_REASONS } from '../storage.js?v=1.1';
import { notify } from '../dialog.js?v=1.1';
import { screenTitle } from './common.js?v=1.1';

function backupBox() {
  const b = loadBackup();
  if (!b) return null;
  const what = BACKUP_REASONS[b.reason] || '前';
  return h(
    'div',
    { class: 'card card-note', testid: 'welcome-backup' },
    h('p', { text: `${what}（${timeLabel(new Date(b.at))}）のデータが控えに残っています。前のデータに戻したいときは、ここから戻せます。` }),
    h('button', {
      type: 'button',
      class: 'btn',
      testid: 'welcome-backup-restore',
      text: `${what}に戻す`,
      on: {
        click: () => {
          replaceData(b.data, { step: 1 });
          notify(`${what}のデータに戻しました。`, { kind: 'ok', testid: 'restored-notice' });
        },
      },
    }),
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
    h('p', { class: 'help', text: '入れたデータは、このブラウザの中にだけ保存されます。インターネットの向こうへは送りません。' }),
  );
}
