// 手順6 シフト表（いまは手で作る）。マスを押すと、入れるものを選ぶ小窓が出る。
import { h, append } from '../dom.js?v=2.1';
import { app, commit } from '../state.js?v=2.1';
import {
  REST_KINDS, shiftById, cellOf, marksOf, requestOf, setCellByHand, setLock, cellSymbol, cellName,
} from '../model.js?v=2.1';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=2.1';
import { notify } from '../dialog.js?v=2.1';
import { screenTitle } from './common.js?v=2.1';
import { staffGrid } from './staffgrid.js?v=2.1';

const SVG = 'http://www.w3.org/2000/svg';

// 固定の印（線画の錠）
function lockIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('class', 'lock-icon');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: 2, y: 5.5, width: 8, height: 5.5, rx: 1 })) body.setAttribute(k, String(v));
  const shackle = document.createElementNS(SVG, 'path');
  shackle.setAttribute('d', 'M4 5.5V4a2 2 0 0 1 4 0v1.5');
  svg.append(body, shackle);
  return svg;
}

function tableCell(d, p, day) {
  const v = cellOf(d, p.id, day);
  const m = marksOf(d, p.id, day);
  const req = requestOf(d, p.id, day);
  const cls = [];
  if (v?.kind === 'shift') {
    const s = shiftById(d, v.shift);
    if (s) cls.push(`g-${s.group}`);
    if (s?.onePerDay) cls.push('is-one');
  } else if (v) {
    cls.push(`k-${v.kind}`);
  }
  if (m.locked) cls.push('is-locked');
  if (m.edited) cls.push('is-edited');
  const label = [
    cellName(d, v),
    m.locked ? '固定' : null,
    m.edited ? '作ったあとに手で変えた' : null,
    req ? `希望は${cellName(d, req)}` : null,
  ].filter(Boolean).join('・');
  return { text: cellSymbol(d, v), cls, label, extra: m.locked ? lockIcon() : null };
}

function openPicker(p, day, refresh, returnFocus) {
  const d = app.data;
  const { year, month } = d.month;
  const now = cellOf(d, p.id, day);
  const req = requestOf(d, p.id, day);
  const dlg = h('dialog', { class: 'dialog picker', testid: 'cell-picker', 'aria-labelledby': 'picker-title' });
  const close = () => {
    dlg.close();
    dlg.remove();
    returnFocus.focus();
  };
  const choose = (value) => {
    let next = null;
    commit((x) => { next = setCellByHand(x, p.id, day, value); });
    refresh(p, day);
    refresh(p, day + 1);
    close();
    const nextDay = `${month}月${day + 1}日`;
    if (next?.what === 'ake-blocked') {
      notify(
        `${nextDay}には、もう「${cellName(d, next.cell)}」が入っているので、明けにしていません。夜勤の次の日は休み（明け）にする決まりです。`,
        { kind: 'warn', testid: 'ake-blocked-notice' },
      );
    } else if (next?.what === 'ake-locked') {
      notify(`${nextDay}は固定しているので、明けにしていません。夜勤の次の日は休み（明け）にする決まりです。`, { kind: 'warn', testid: 'ake-locked-notice' });
    } else if (next?.what === 'ake-kept-locked') {
      notify(`${nextDay}の明けは固定しているので、そのままにしました。`, { kind: 'info', testid: 'ake-kept-notice' });
    }
  };
  const same = (a, b) => (a === null && b === null) || (a && b && a.kind === b.kind && (a.kind !== 'shift' || a.shift === b.shift));
  const option = (value, symbol, label, cls, note = null) =>
    h(
      'button',
      {
        type: 'button',
        class: ['pick', ...cls, same(now, value) ? 'is-current' : ''].filter(Boolean).join(' '),
        'aria-pressed': String(Boolean(same(now, value))),
        testid: 'pick-option',
        dataset: { kind: value ? value.kind : 'empty', shift: value?.shift ?? '' },
        on: { click: () => choose(value) },
      },
      h('span', { class: 'pick-sym', text: symbol }),
      h('span', { class: 'pick-label', text: label }),
      note ? h('span', { class: 'pick-note', text: note }) : null,
    );
  const lock = h('input', { type: 'checkbox', checked: Boolean(marksOf(d, p.id, day).locked), testid: 'pick-lock' });
  lock.addEventListener('change', () => {
    commit((x) => setLock(x, p.id, day, lock.checked));
    refresh(p, day);
  });
  append(
    dlg,
    h('h2', { id: 'picker-title', text: `${p.name || '名前なし'}さん　${month}月${day}日（${WEEKDAY_LABELS[weekdayOf(year, month, day)]}）` }),
    h('p', { text: `いま：${cellName(d, now)}` }),
    req ? h('p', { class: 'help', testid: 'pick-request', text: `この日の希望：${cellName(d, req)}` }) : null,
    d.settings.shifts.length
      ? [
          h('h3', { text: 'シフト' }),
          h(
            'div',
            { class: 'pick-grid' },
            d.settings.shifts.map((s) =>
              option({ kind: 'shift', shift: s.id }, s.symbol, s.name || s.symbol, [`g-${s.group}`, s.onePerDay ? 'is-one' : ''], p.shifts.includes(s.id) ? null : '担当外'),
            ),
          ),
        ]
      : h('p', { class: 'help', text: 'シフトがありません。手順2 シフトの種類で足すと、ここで選べます。' }),
    h('h3', { text: '休みなど' }),
    h(
      'div',
      { class: 'pick-grid' },
      REST_KINDS.map((r) => option({ kind: r.id }, r.symbol, r.label, [`k-${r.id}`])),
      option(null, '', '空ける', ['pick-empty']),
    ),
    h('label', { class: 'check pick-lock' }, lock, h('span', { text: 'このマスを固定する（自動で作るときに、このマスを変えない）' })),
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn', testid: 'picker-close', text: '閉じる', on: { click: close } })),
  );
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
}

function legend(d) {
  const g = d.settings.groupNames;
  return h(
    'ul',
    { class: 'legend legend-row', testid: 'table-legend' },
    ['early', 'late', 'night'].map((id) => h('li', {}, h('span', { class: `swatch g-${id}` }), g[id])),
    h('li', {}, h('span', { class: 'legend-bold', text: '太字' }), '1日1人の役'),
    h('li', {}, lockIcon(), '固定（自動で作るときに変えない）'),
    h('li', {}, h('span', { class: 'legend-dot' }), '自動で作ったあとに、手で変えたマス'),
    h('li', {}, `休＝公休・有＝有給・半＝半休・明＝明け・余＝余り日`),
  );
}

export function renderStep6(el) {
  const d = app.data;
  append(
    el,
    ...screenTitle('手順6 シフト表', 'マスを押すと、入れるシフトや休みを選べます。いまは手で作れます。自動で作る・決まりの検査は、このあとの版で使えるようになります。'),
  );
  if (!d.staff.length) {
    append(el, h('p', { class: 'empty', testid: 'table-empty', text: 'スタッフがいません。手順3 スタッフで、1人以上入れてください。' }));
    return;
  }
  const grid = staffGrid({
    data: d,
    testid: 'shift-grid',
    cellTestid: 'table-cell',
    cell: (p, day) => tableCell(d, p, day),
    onPick: (p, day, btn) => openPicker(p, day, grid.refresh, btn),
  });
  append(
    el,
    h(
      'section',
      { class: 'card' },
      h('p', { class: 'help', text: '行がスタッフ、列が日です。表は横に動かせます。夜勤を入れると、次の日が空いていれば「明け」が入ります。' }),
      legend(d),
      grid.el,
    ),
  );
}
