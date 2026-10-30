// 日ごとの必要人数の表（手順2。あとでシフト表の下でも使う）。
// キーボードで続けて入れられる：押すと数字が選ばれ、打つと置き換わる。
// Enter で次の日、Shift+Enter で前の日、↑↓ で上下の行、Esc でやめる。
// Shift を押しながら日を押す（なぞる）と何日か選べ、数字を打って Enter で全部に入る。
import { h } from '../dom.js?v=1.3.1';
import { app, commit } from '../state.js?v=1.3.1';
import { needRows, needOn, setNeedOverride, shiftById, monthDays } from '../model.js?v=1.3.1';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=1.3.1';

function rowLabel(d, row) {
  const s = shiftById(d, row.shiftId);
  const emp = row.emp === 'all' ? '合わせて' : d.settings.employmentNames[row.emp];
  return { symbol: s.symbol, emp };
}

export function needGrid() {
  const d = app.data;
  const rows = needRows(d);
  const nDays = monthDays(d);
  const { year, month } = d.month;
  const msg = h('p', { class: 'grid-msg', role: 'status', testid: 'need-grid-message' });
  const cells = []; // cells[row][day-1] = input
  let sel = null; // { row, from, to }
  let anchor = null; // { row, day }
  let dragging = false;

  const say = (t) => { msg.textContent = t; };

  const paint = (r, day) => {
    const input = cells[r][day - 1];
    const row = rows[r];
    const info = needOn(app.data, row.shiftId, row.emp, day);
    input.value = String(info.value);
    input.dataset.stored = String(info.value);
    input.classList.toggle('is-override', info.source === 'override');
    input.classList.toggle('is-rule', info.source === 'rule');
    if (info.source === 'override') {
      input.title = `この日だけ変えた数です。ふだんは${info.base}人${info.rules.length ? `（決まり「${info.rules.join('」「')}」）` : ''}`;
    } else if (info.source === 'rule') {
      input.title = `決まり「${info.rules.join('」「')}」で${info.value}人です。`;
    } else {
      input.title = `ふだんの数（${info.value}人）です。`;
    }
  };

  const clearSel = () => {
    if (sel) for (let day = sel.from; day <= sel.to; day += 1) cells[sel.row][day - 1].classList.remove('is-selected');
    sel = null;
  };
  const setSel = (r, a, b) => {
    clearSel();
    sel = { row: r, from: Math.min(a, b), to: Math.max(a, b) };
    for (let day = sel.from; day <= sel.to; day += 1) cells[r][day - 1].classList.add('is-selected');
    const n = sel.to - sel.from + 1;
    say(n > 1 ? `${sel.from}日〜${sel.to}日の${n}日分を選んでいます。数字を打って Enter で全部に入ります（Esc でやめる）。` : '');
  };

  const pos = (input) => ({ r: Number(input.dataset.row), day: Number(input.dataset.day) });

  // 入れた数を保存する。うまく入れられたら true
  const save = (input) => {
    const { r, day } = pos(input);
    const raw = input.value.trim();
    if (raw === input.dataset.stored && !(sel && sel.row === r && sel.to > sel.from)) return true;
    if (!/^\d{1,2}$/.test(raw)) {
      say('0〜99の数を入れてください。前の数に戻しました。');
      input.value = input.dataset.stored;
      return false;
    }
    const n = Number(raw);
    const row = rows[r];
    const days = sel && sel.row === r && day >= sel.from && day <= sel.to
      ? Array.from({ length: sel.to - sel.from + 1 }, (_, i) => sel.from + i)
      : [day];
    commit((data) => days.forEach((x) => setNeedOverride(data, row.shiftId, row.emp, x, n)));
    days.forEach((x) => paint(r, x));
    const { symbol, emp } = rowLabel(app.data, row);
    say(days.length > 1 ? `${days[0]}日〜${days[days.length - 1]}日の「${symbol}」（${emp}）を${n}人にしました。` : '');
    return true;
  };

  const focusCell = (r, day) => {
    const input = cells[r]?.[day - 1];
    if (input) input.focus();
  };

  const onKey = (e) => {
    const input = e.target;
    const { r, day } = pos(input);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!save(input)) return;
      clearSel();
      anchor = null;
      focusCell(r, day + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!save(input)) return;
      clearSel();
      anchor = null;
      focusCell(r + (e.key === 'ArrowUp' ? -1 : 1), day);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = input.dataset.stored;
      clearSel();
      anchor = null;
      say('');
      input.select();
    }
  };

  const onMouseDown = (e) => {
    const input = e.target.closest('input.need-cell');
    if (!input) return;
    const { r, day } = pos(input);
    if (e.shiftKey) {
      e.preventDefault();
      if (!anchor || anchor.r !== r) anchor = { r, day };
      dragging = true;
      window.addEventListener('mouseup', stopDrag, { once: true });
      setSel(r, anchor.day, day);
      input.focus();
    } else {
      clearSel();
      anchor = { r, day };
      say('');
    }
  };
  const onMouseOver = (e) => {
    if (!dragging || !anchor) return;
    const input = e.target.closest('input.need-cell');
    if (!input) return;
    const { r, day } = pos(input);
    if (r === anchor.r) setSel(r, anchor.day, day);
  };
  const stopDrag = () => { dragging = false; };

  const head = h(
    'tr',
    {},
    h('th', { scope: 'col', class: 'sticky-col', text: 'シフト' }),
    Array.from({ length: nDays }, (_, i) => {
      const day = i + 1;
      const wd = weekdayOf(year, month, day);
      const special = d.month.special.filter((s) => s.day === day).map((s) => s.name);
      return h(
        'th',
        {
          scope: 'col',
          class: ['day-head', wd === 0 ? 'is-sun' : '', wd === 6 ? 'is-sat' : '', special.length ? 'is-special' : ''].join(' ').trim(),
          title: special.length ? `特別な日：${special.join('・')}` : null,
        },
        h('span', { text: String(day) }),
        h('span', { class: 'wd', text: WEEKDAY_LABELS[wd] }),
      );
    }),
  );
  const body = rows.map((row, r) => {
    const { symbol, emp } = rowLabel(d, row);
    cells[r] = [];
    return h(
      'tr',
      {},
      h('th', { scope: 'row', class: 'sticky-col' }, h('span', { class: 'sym', dataset: { symOf: row.shiftId }, text: symbol }), h('span', { class: 'emp', text: `（${emp}）` })),
      Array.from({ length: nDays }, (_, i) => {
        const day = i + 1;
        const input = h('input', {
          type: 'text',
          inputmode: 'numeric',
          maxlength: 2,
          autocomplete: 'off',
          class: 'need-cell',
          'aria-label': `${month}月${day}日（${WEEKDAY_LABELS[weekdayOf(year, month, day)]}） ${symbol}（${emp}）の必要人数`,
          testid: 'need-cell',
          dataset: { row: String(r), day: String(day), shift: row.shiftId, emp: row.emp },
          on: {
            focus: (e) => e.target.select(),
            keydown: onKey,
            change: (e) => save(e.target),
          },
        });
        cells[r][i] = input;
        return h('td', {}, input);
      }),
    );
  });

  const table = h('table', { class: 'need-grid', on: { mousedown: onMouseDown, mouseover: onMouseOver } }, h('thead', {}, head), h('tbody', {}, body));
  rows.forEach((_, r) => { for (let day = 1; day <= nDays; day += 1) paint(r, day); });

  return h(
    'div',
    { testid: 'need-grid' },
    h('div', { class: 'table-wrap' }, table),
    msg,
    h(
      'ul',
      { class: 'legend' },
      h('li', {}, h('span', { class: 'swatch swatch-override' }), 'この日だけ変えた数（マウスを置くと、ふだんの数が出ます）'),
      h('li', {}, h('span', { class: 'swatch swatch-rule' }), '必要人数の決まりで変わった数（点線の下線）'),
      h('li', {}, 'ふだんの数と同じ数を入れると、変えた印が消えます。'),
    ),
    h('p', { class: 'help', text: 'キーボードで続けて入れられます：マスを押すと数字が選ばれ、打つと置き換わります。Enter で次の日、Shift+Enter で前の日、↑↓ で上下の行に動きます。Shift を押しながら日を押す（なぞる）と何日か選べ、数字を打って Enter で全部に入ります。Esc でやめます。' }),
  );
}
