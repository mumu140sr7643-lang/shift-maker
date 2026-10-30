// 手順6 シフト表。マスを押すと、入れるものを選ぶ小窓が出る。変えるたびに決まりを検査し直し、印・件数の帯・一覧を直す。
import { h, append } from '../dom.js?v=3.2';
import { app, commit } from '../state.js?v=3.2';
import {
  REST_KINDS, shiftById, cellOf, marksOf, requestOf, setCellByHand, setLock, cellSymbol, cellName,
} from '../model.js?v=3.2';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=3.2';
import { notify } from '../dialog.js?v=3.2';
import { checkTable } from '../check.js?v=3.2';
import { screenTitle } from './common.js?v=3.2';
import { staffGrid } from './staffgrid.js?v=3.2';
import { needGrid } from './needgrid.js?v=3.2';
import { markIndex, markClasses, markBadges, countBand, errorList, worsened } from './checkview.js?v=3.2';

const SVG = 'http://www.w3.org/2000/svg';
const NL = String.fromCharCode(10); // マウスを置いたときの文の改行

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

function tableCell(d, p, day, marks) {
  const v = cellOf(d, p.id, day);
  const mk = marks.get(`c|${p.id}|${day}`);
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
  cls.push(...markClasses(mk));
  const label = [
    cellName(d, v),
    m.locked ? '固定' : null,
    m.edited ? '作ったあとに手で変えた' : null,
    req ? `希望は${cellName(d, req)}` : null,
    mk ? `エラー${mk.texts.length}件` : null,
  ].filter(Boolean).join('・');
  const extra = m.locked || mk ? h('span', { class: 'cell-marks' }, m.locked ? lockIcon() : null, markBadges(mk)) : null;
  return { text: cellSymbol(d, v), cls, label, extra, title: mk ? mk.texts.join(NL) : null };
}

function headMark(mk) {
  return mk ? { cls: markClasses(mk), title: mk.texts.join(NL) } : null;
}

function openPicker(p, day, changed, returnFocus) {
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
    close();
    changed(true);
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
    changed(false);
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
    h('li', {}, h('span', { class: 'legend-cell m-six' }, h('span', { class: 'mk mk-six' })), '6連勤以上（濃い赤の太い枠・四角）'),
    h('li', {}, h('span', { class: 'legend-cell m-hard' }, h('span', { class: 'mk mk-hard' })), '絶対の決まりに合わない（赤い枠・丸）'),
    h('li', {}, h('span', { class: 'legend-cell m-soft' }, h('span', { class: 'mk mk-soft' })), 'できれば守る決まりに合わない（黄土色の点線・三角）'),
    h('li', {}, h('span', { class: 'legend-cell k-spare' }), '余り日（青緑の縞）'),
    h('li', {}, 'マスにマウスを置くと、そのマスのエラーの文が出ます。'),
  );
}

// シフト表で、そのシフト・区分に入っている人数（人数に数えないシフトは「―」）
function assignedCounter(d) {
  return (shiftId, emp, day) => {
    const s = shiftById(d, shiftId);
    if (!s || !s.counts || s.training) return null;
    return d.staff.filter((p) => {
      const v = cellOf(d, p.id, day);
      return v?.kind === 'shift' && v.shift === shiftId && (emp === 'all' || p.employment === emp);
    }).length;
  };
}

function breakdown(d, result, key) {
  const { month } = d.month;
  if (key === 'short') {
    const items = result.items.filter((it) => it.rule === 'shortage');
    return h('div', {}, h('h3', { text: `不足の内訳（${result.totals.shortSlots}コマ）` }),
      items.length ? h('ul', {}, items.map((it) => h('li', { text: it.text }))) : h('p', { class: 'help', text: '足りない日はありません。' }));
  }
  const rows = [];
  for (const p of d.staff) {
    const days = Object.entries(d.month.table[p.id] ?? {}).filter(([, v]) => v.kind === 'spare').map(([day]) => `${month}月${day}日`);
    if (days.length) rows.push(`${p.name || '名前なし'}さん：${days.join('・')}`);
  }
  return h('div', {}, h('h3', { text: `余り日の内訳（${result.totals.spare}日）` }),
    rows.length ? h('ul', {}, rows.map((t) => h('li', { text: t }))) : h('p', { class: 'help', text: '余り日はありません。' }),
    h('p', { class: 'help', text: '余り日は、人が多すぎて出勤させずに置く日です。公休には数えません。' }));
}

export function renderStep6(el) {
  const d = app.data;
  append(
    el,
    ...screenTitle('手順6 シフト表', 'マスを押すと、入れるシフトや休みを選べます。変えるたびに、決まりに合っているかを検査し直します。自動で作るのは、このあとの版で使えるようになります。'),
  );
  if (!d.staff.length) {
    append(el, h('p', { class: 'empty', testid: 'table-empty', text: 'スタッフがいません。手順3 スタッフで、1人以上入れてください。' }));
    return;
  }
  let result = checkTable(d);
  let marks = markIndex(d, result);
  const bandBox = h('div', { class: 'band-box' });
  const detailBox = h('div', { class: 'band-detail card', testid: 'band-detail', hidden: true });
  const listBox = h('div');
  let openKey = null;
  let need = null;

  const focusItem = (it) => {
    if (it.staff) grid.focusCell(it.staff, it.day ?? it.from ?? 1);
    else if (it.shift && it.day != null) document.querySelector(`input.need-cell[data-shift="${it.shift}"][data-day="${it.day}"]`)?.focus();
    else if (it.day != null && d.staff.length) grid.focusCell(d.staff[0].id, it.day);
  };
  const openDetail = (key, btn) => {
    openKey = openKey === key ? null : key;
    bandBox.querySelectorAll('button.band-item').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    detailBox.hidden = !openKey;
    detailBox.textContent = '';
    if (openKey) {
      btn.setAttribute('aria-expanded', 'true');
      detailBox.append(breakdown(d, result, openKey));
    }
  };
  const drawCheck = () => {
    bandBox.textContent = '';
    bandBox.append(countBand(result, { onOpen: openDetail }));
    listBox.textContent = '';
    const list = errorList(result, { onFocus: focusItem });
    if (list) listBox.append(h('h2', { text: 'エラーの一覧' }), h('p', { class: 'help', text: '押すと、そのマスへ動きます。' }), list);
    if (openKey && !result.tableEmpty) {
      detailBox.textContent = '';
      detailBox.append(breakdown(d, result, openKey));
    } else {
      openKey = null;
      detailBox.hidden = true;
    }
  };
  // 変えたあとに検査し直す。announce なら、増えた決まりを知らせる（止めはしない）
  const recheck = (announce) => {
    const before = result;
    result = checkTable(app.data);
    marks = markIndex(app.data, result);
    grid.refreshAll();
    need?.refresh();
    drawCheck();
    const w = announce ? worsened(before, result) : [];
    if (w.length) notify(`悪くなりました：${w.join('、')}`, { kind: 'warn', testid: 'worse-notice' });
  };

  const grid = staffGrid({
    data: d,
    testid: 'shift-grid',
    cellTestid: 'table-cell',
    cell: (p, day) => tableCell(d, p, day, marks),
    onPick: (p, day, btn) => openPicker(p, day, recheck, btn),
    rowMark: (p) => headMark(marks.get(`n|${p.id}`)),
    dayMark: (day) => headMark(marks.get(`d|${day}`)),
  });
  drawCheck();
  if (d.settings.shifts.length) need = needGrid({ assigned: assignedCounter(d), onChange: () => recheck(true) });
  append(
    el,
    h(
      'section',
      { class: 'card' },
      bandBox,
      detailBox,
      h('p', { class: 'help', text: '行がスタッフ、列が日です。表は横に動かせます。夜勤を入れると、次の日が空いていれば「明け」が入ります。' }),
      legend(d),
      grid.el,
    ),
    h('section', { class: 'card', testid: 'error-list-section' }, listBox),
    need
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: '日ごとの必要人数と、配置した人数' }),
          h('p', { class: 'help', text: '上の数は必要人数（手順2と同じ入れ方で変えられます）。下の「配置」は、シフト表で入れた人数です。' }),
          need.el,
        )
      : null,
  );
}
