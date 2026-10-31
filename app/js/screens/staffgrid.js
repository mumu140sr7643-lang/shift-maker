// スタッフ×日の表（手順4 希望の入力・手順6 シフト表）。
// 行がスタッフ、列が日。名前の列は止まり、表の中だけ横に動く。
// マスはボタン。Tab で表に入り、矢印キーで動き、Enter・スペースで押す（Tab で止まるのは1マスだけ）。
import { h } from '../dom.js?v=3.3';
import { monthDays } from '../model.js?v=3.3';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=3.3';

// cell(p, day) → { text, cls: [], label, extra: Node | null, title }
// onPick(p, day, button) は、マスを押したとき
// rowMark(p)・dayMark(day) → { cls: [], title } は、名前の列・日の見出しの印（無ければ印なし）
export function staffGrid({ data, testid, cellTestid, cell, onPick, rowMark = null, dayMark = null }) {
  const nDays = monthDays(data);
  const { year, month } = data.month;
  const buttons = new Map(); // `${pid}|${day}` → button
  const rowHeads = new Map(); // pid → th
  const dayHeads = []; // day-1 → th
  let current = null;

  const paint = (p, day) => {
    const btn = buttons.get(`${p.id}|${day}`);
    const c = cell(p, day);
    btn.className = ['grid-cell', ...(c.cls || [])].join(' ');
    btn.setAttribute('aria-label', `${p.name || '名前なし'} ${month}月${day}日（${WEEKDAY_LABELS[weekdayOf(year, month, day)]}） ${c.label}`);
    if (c.title) btn.title = c.title;
    else btn.removeAttribute('title');
    btn.textContent = '';
    if (c.extra) btn.append(c.extra);
    btn.append(h('span', { class: 'cell-text', text: c.text }));
  };

  const paintHead = (el, base, mark) => {
    el.className = [...base, ...(mark?.cls || [])].join(' ');
    if (mark?.title) el.title = mark.title;
    else if (el.dataset.baseTitle) el.title = el.dataset.baseTitle;
    else el.removeAttribute('title');
  };
  const paintHeads = () => {
    if (rowMark) for (const p of data.staff) paintHead(rowHeads.get(p.id), ['sticky-col', 'staff-head'], rowMark(p));
    if (dayMark) dayHeads.forEach((th, i) => paintHead(th, th.dataset.baseClass.split(' '), dayMark(i + 1)));
  };

  const focusAt = (r, day) => {
    const p = data.staff[r];
    if (!p || day < 1 || day > nDays) return;
    const btn = buttons.get(`${p.id}|${day}`);
    if (current) current.tabIndex = -1;
    btn.tabIndex = 0;
    current = btn;
    btn.focus();
  };

  const onKey = (e) => {
    const btn = e.target.closest('button.grid-cell');
    if (!btn) return;
    const r = Number(btn.dataset.row);
    const day = Number(btn.dataset.day);
    const move = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (move) {
      e.preventDefault();
      focusAt(r + move[0], day + move[1]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(r, 1);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(r, nDays);
    }
  };

  const onClick = (e) => {
    const btn = e.target.closest('button.grid-cell');
    if (!btn) return;
    if (current && current !== btn) current.tabIndex = -1;
    btn.tabIndex = 0;
    current = btn;
    const p = data.staff[Number(btn.dataset.row)];
    onPick(p, Number(btn.dataset.day), btn);
  };

  const head = h(
    'tr',
    {},
    h('th', { scope: 'col', class: 'sticky-col', text: 'スタッフ' }),
    Array.from({ length: nDays }, (_, i) => {
      const day = i + 1;
      const wd = weekdayOf(year, month, day);
      const special = data.month.special.filter((s) => s.day === day).map((s) => s.name);
      const baseClass = ['day-head', wd === 0 ? 'is-sun' : '', wd === 6 ? 'is-sat' : '', special.length ? 'is-special' : ''].join(' ').trim();
      const th = h(
        'th',
        {
          scope: 'col',
          class: baseClass,
          title: special.length ? `特別な日：${special.join('・')}` : null,
          dataset: { baseClass, baseTitle: special.length ? `特別な日：${special.join('・')}` : '' },
        },
        h('span', { text: String(day) }),
        h('span', { class: 'wd', text: WEEKDAY_LABELS[wd] }),
      );
      dayHeads.push(th);
      return th;
    }),
  );
  const body = data.staff.map((p, r) =>
    h(
      'tr',
      {},
      (() => {
        const th = h('th', { scope: 'row', class: 'sticky-col staff-head', testid: 'grid-row-head', dataset: { staffId: p.id } }, h('span', { text: p.name || '名前なし' }));
        rowHeads.set(p.id, th);
        return th;
      })(),
      Array.from({ length: nDays }, (_, i) => {
        const day = i + 1;
        const btn = h('button', { type: 'button', tabindex: -1, testid: cellTestid, dataset: { row: String(r), day: String(day), staffId: p.id } });
        buttons.set(`${p.id}|${day}`, btn);
        return h('td', {}, btn);
      }),
    ),
  );
  const paintAll = () => {
    data.staff.forEach((p) => { for (let day = 1; day <= nDays; day += 1) paint(p, day); });
    paintHeads();
  };
  paintAll();
  const first = buttons.get(`${data.staff[0]?.id}|1`);
  if (first) {
    first.tabIndex = 0;
    current = first;
  }
  const table = h('table', { class: 'staff-grid', on: { keydown: onKey, click: onClick } }, h('thead', {}, head), h('tbody', {}, body));
  return {
    el: h('div', { class: 'table-wrap', testid }, table),
    refresh: (p, day) => { if (buttons.has(`${p.id}|${day}`)) paint(p, day); },
    refreshAll: paintAll,
    focusCell: (pid, day) => {
      const r = data.staff.findIndex((p) => p.id === pid);
      if (r >= 0) focusAt(r, Math.min(Math.max(day, 1), nDays));
    },
  };
}
