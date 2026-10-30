// 起動と、画面の切り替え。
import { app, setRenderers } from './state.js?v=3.2';
import { loadData, brokenCopy, getPref, setPref, KEYS, parseData } from './storage.js?v=3.2';
import { APP_VERSION } from './version.js?v=3.2';
import { h, clear } from './dom.js?v=3.2';
import { notify, clearNotices } from './dialog.js?v=3.2';
import { exportRaw } from './files.js?v=3.2';
import { monthLabel, timeLabel } from './calendar.js?v=3.2';
import { renderWelcome } from './screens/welcome.js?v=3.2';
import { renderStep1 } from './screens/step1.js?v=3.2';
import { renderStep2 } from './screens/step2.js?v=3.2';
import { renderStep3 } from './screens/step3.js?v=3.2';
import { renderStep4 } from './screens/step4.js?v=3.2';
import { renderStep5 } from './screens/step5.js?v=3.2';
import { renderStep6 } from './screens/step6.js?v=3.2';
import { openDataPanel } from './screens/datapanel.js?v=3.2';

const STEPS = [
  { n: 1, title: '基本設定', render: renderStep1 },
  { n: 2, title: 'シフトの種類', render: renderStep2 },
  { n: 3, title: 'スタッフ', render: renderStep3 },
  { n: 4, title: '希望の入力', render: renderStep4 },
  { n: 5, title: '自動で作る', render: renderStep5 },
  { n: 6, title: 'シフト表', render: renderStep6 },
];

const $ = (id) => document.getElementById(id);

function applyTheme(value) {
  const root = document.documentElement;
  if (value === 'light' || value === 'dark') root.dataset.theme = value;
  else delete root.dataset.theme;
}

function renderChrome() {
  const d = app.data;
  $('month-label').textContent = d ? `${monthLabel(d.month.year, d.month.month)}の表` : '';
  const status = $('save-status');
  status.classList.toggle('is-error', app.saveFailed);
  if (app.saveFailed) {
    status.textContent = 'ブラウザに保存できませんでした。「保存と控え」からファイルに書き出してください。';
  } else if (d && app.savedAt) {
    status.textContent = `保存しました（${timeLabel(new Date(app.savedAt))}）`;
  } else {
    status.textContent = '';
  }
  $('data-button').hidden = !d;
  $('app-version').textContent = `版 ${APP_VERSION}`;
}

function renderNav() {
  const nav = $('steps');
  clear(nav);
  const on = app.step >= 1 && app.data;
  nav.hidden = !on;
  document.body.classList.toggle('no-steps', !on);
  $('menu-toggle').hidden = !on;
  if (!on) return;
  const cur = STEPS.find((s) => s.n === app.step);
  $('menu-toggle').textContent = `手順${cur.n} ${cur.title}`;
  nav.append(
    h(
      'ol',
      {},
      STEPS.map((s) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: s.n === app.step ? 'step is-current' : 'step',
              'aria-current': s.n === app.step ? 'step' : null,
              testid: `step-${s.n}`,
              on: { click: () => goStep(s.n) },
            },
            h('span', { class: 'step-no', text: `手順${s.n}` }),
            h('span', { class: 'step-title', text: s.title }),
          ),
        ),
      ),
    ),
  );
}

function prevNext() {
  const i = STEPS.findIndex((s) => s.n === app.step);
  const prev = STEPS[i - 1];
  const next = STEPS[i + 1];
  return h(
    'div',
    { class: 'prev-next' },
    prev
      ? h('button', { type: 'button', class: 'btn', testid: 'prev-step', on: { click: () => goStep(prev.n) } }, `← 前へ（手順${prev.n} ${prev.title}）`)
      : h('span'),
    next
      ? h('button', { type: 'button', class: 'btn btn-primary', testid: 'next-step', on: { click: () => goStep(next.n) } }, `次へ（手順${next.n} ${next.title}）→`)
      : h('span'),
  );
}

function renderAll() {
  renderChrome();
  renderNav();
  const screen = $('screen');
  clear(screen);
  if (!app.data || app.step === 0) {
    renderWelcome(screen);
    return;
  }
  STEPS.find((s) => s.n === app.step).render(screen);
  screen.append(prevNext());
}

function goStep(n) {
  clearNotices();
  app.step = n;
  setPref(KEYS.step, String(n));
  document.body.classList.remove('menu-open');
  $('menu-toggle').setAttribute('aria-expanded', 'false');
  renderAll();
  window.scrollTo(0, 0);
  $('screen').focus({ preventScroll: true });
}

function boot() {
  setRenderers(renderAll, renderChrome, goStep);
  const theme = getPref(KEYS.theme) || 'auto';
  applyTheme(theme);
  $('theme').value = theme;
  $('theme').addEventListener('change', (e) => {
    setPref(KEYS.theme, e.target.value === 'auto' ? null : e.target.value);
    applyTheme(e.target.value);
  });
  $('menu-toggle').addEventListener('click', () => {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    $('menu-toggle').setAttribute('aria-expanded', String(open));
  });
  $('data-button').addEventListener('click', () => openDataPanel());

  const r = loadData();
  if (r.status === 'ok') {
    app.data = r.data;
    app.savedAt = r.savedAt;
    const step = Number(getPref(KEYS.step));
    app.step = step >= 1 && step <= 6 ? step : 1;
  } else {
    app.step = 0;
  }
  renderAll();
  if (r.status === 'broken') {
    notify(
      `保存してあったデータを読めませんでした（${r.errors[0]}）。読めなかったデータは、消さずに控えに残してあります。見本を選んで始めるか、控えをファイルに保存して残してください。`,
      {
        kind: 'error',
        testid: 'broken-notice',
        actions: [
          {
            label: '読めなかったデータをファイルに保存する',
            testid: 'broken-export',
            onClick: () => {
              const b = brokenCopy();
              if (b) exportRaw(b.raw);
            },
          },
        ],
      },
    );
  }

  // 別のタブで同じアプリを開いて変えたとき、古い内容で上書きしないように読み直す
  window.addEventListener('storage', (e) => {
    if (e.key !== KEYS.data || e.newValue === null) return;
    const p = parseData(e.newValue);
    if (!p.data) return;
    app.data = p.data;
    app.savedAt = getPref(KEYS.savedAt);
    if (app.step === 0) app.step = 1;
    renderAll();
    notify('別のタブ（画面）で変えた内容を読み込みました。', { testid: 'other-tab-notice' });
  });
}

boot();
