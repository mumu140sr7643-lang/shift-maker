// 手順4 希望の入力：上の記号を選んでから、表のマスを押すと入る。
import { h, append } from '../dom.js?v=4.1';
import { app, commit } from '../state.js?v=4.1';
import { REST_KINDS, shiftById, requestOf, setRequest, cellSymbol, cellName } from '../model.js?v=4.1';
import { screenTitle } from './common.js?v=4.1';
import { requestConflicts } from '../check.js?v=4.1';
import { RULE_BY_ID } from '../rules.js?v=4.1';
import { staffGrid } from './staffgrid.js?v=4.1';

// 選んでいる記号（画面を作り直しても残す）。'off' | 'paid' | 'half' | シフトの番号 | 'clear'
let brush = 'off';

const REQUEST_RESTS = REST_KINDS.filter((r) => ['off', 'paid', 'half'].includes(r.id));

function brushValue(d) {
  if (brush === 'clear') return null;
  if (REQUEST_RESTS.some((r) => r.id === brush)) return { kind: brush };
  return shiftById(d, brush) ? { kind: 'shift', shift: brush } : null;
}

function sameRequest(a, b) {
  return a && b && a.kind === b.kind && (a.kind !== 'shift' || a.shift === b.shift);
}

function requestCell(d, p, day) {
  const r = requestOf(d, p.id, day);
  if (!r) return { text: '', cls: [], label: '希望なし' };
  if (r.kind === 'shift') {
    const s = shiftById(d, r.shift);
    return {
      text: cellSymbol(d, r),
      cls: ['req-shift', s ? `g-${s.group}` : '', s?.onePerDay ? 'is-one' : ''].filter(Boolean),
      label: `希望：この日は${cellName(d, r)}`,
    };
  }
  return { text: cellSymbol(d, r), cls: [`req-${r.kind}`], label: `希望：${cellName(d, r)}` };
}

function palette(d, onChange) {
  if (!shiftById(d, brush) && !['off', 'paid', 'half', 'clear'].includes(brush)) brush = 'off';
  const item = (id, symbol, label, cls) =>
    h(
      'button',
      {
        type: 'button',
        class: ['brush', cls, brush === id ? 'is-current' : ''].filter(Boolean).join(' '),
        'aria-pressed': String(brush === id),
        testid: 'brush',
        dataset: { brush: id },
        on: { click: () => { brush = id; onChange(); } },
      },
      h('span', { class: 'brush-sym', text: symbol }),
      h('span', { class: 'brush-label', text: label }),
    );
  return h(
    'div',
    { class: 'palette', role: 'group', 'aria-label': '入れる記号', testid: 'request-palette' },
    h('span', { class: 'palette-title', text: '休み' }),
    REQUEST_RESTS.map((r) => item(r.id, r.symbol, r.label, `req-${r.id}`)),
    d.settings.shifts.length ? h('span', { class: 'palette-title', text: '出勤を固定' }) : null,
    d.settings.shifts.map((s) => item(s.id, s.symbol, s.name || s.symbol, `req-shift g-${s.group}`)),
    h('span', { class: 'palette-title', text: '' }),
    item('clear', '×', '消す', 'brush-clear'),
  );
}

export function renderStep4(el) {
  const d = app.data;
  append(el, ...screenTitle('手順4 希望の入力', '休みの希望・有給・「この日はこのシフト」を入れます。'));
  if (!d.staff.length) {
    append(el, h('p', { class: 'empty', testid: 'request-empty', text: 'スタッフがいません。手順3 スタッフで、1人以上入れてください。' }));
    return;
  }
  const status = h('p', { class: 'help', role: 'status', testid: 'request-status' });
  const conflictBox = h('div', { class: 'conflicts', testid: 'request-conflicts', role: 'status' });
  const drawConflicts = () => {
    const list = requestConflicts(app.data);
    conflictBox.textContent = '';
    conflictBox.hidden = list.length === 0;
    conflictBox.dataset.count = String(list.length);
    if (!list.length) return;
    conflictBox.append(
      h('h3', { text: `希望だけで、どう作っても決まりに合わなくなるものがあります（${list.length}件）` }),
      h('p', { class: 'help', text: 'この希望のままだと、手順6や自動で作るときに必ずエラーになります。希望を変えるか、手順3 スタッフの担当できるシフト・手順1 の決まりを見直してください。' }),
      h('ul', {}, list.map((it) => h('li', { text: `${RULE_BY_ID[it.rule].name}：${it.text}` }))),
    );
  };
  const paletteBox = h('div');
  const showStatus = () => {
    const v = brushValue(d);
    status.textContent = brush === 'clear'
      ? 'いまは「消す」を選んでいます。表のマスを押すと、そのマスの希望が消えます。'
      : `いまは「${cellName(d, v)}」を選んでいます。表のマスを押すと入ります。同じマスをもう一度押すと消えます。`;
  };
  const redrawPalette = () => {
    paletteBox.textContent = '';
    paletteBox.append(palette(d, redrawPalette));
    showStatus();
  };
  const grid = staffGrid({
    data: d,
    testid: 'request-grid',
    cellTestid: 'request-cell',
    cell: (p, day) => requestCell(d, p, day),
    onPick: (p, day) => {
      const want = brushValue(d);
      const now = requestOf(d, p.id, day);
      const next = brush === 'clear' || sameRequest(now, want) ? null : want;
      commit((x) => setRequest(x, p.id, day, next));
      grid.refresh(p, day);
      drawConflicts();
    },
  });
  redrawPalette();
  drawConflicts();
  append(
    el,
    h(
      'section',
      { class: 'card' },
      h('h2', { text: '1. 入れる記号を選ぶ' }),
      paletteBox,
      status,
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: '2. 表のマスを押す' }),
      conflictBox,
      h('p', { class: 'help', text: '行がスタッフ、列が日です。表は横に動かせます。キーボードでは、矢印キーで動いて Enter で入ります。' }),
      grid.el,
    ),
  );
}
