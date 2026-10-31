// 手順6 シフト表。マスを押すと、入れるものを選ぶ小窓が出る。変えるたびに決まりを検査し直し、印・件数の帯・一覧を直す。
// 変えた所は履歴（history.js）に積み、「元に戻す」「やり直す」で戻せる。同じ日の2人のマスは、ドラッグか小窓で入れ替えられる。
// 「エラーを自動で直す」の案を見ているあいだは、表を案の表に切りかえて見せる（repairview.js）。
import { h, append } from '../dom.js?v=5.2';
import { app } from '../state.js?v=5.2';
import {
  REST_KINDS, shiftById, cellOf, marksOf, requestOf, setCellByHand, setLock, swapCells, cellSymbol, cellName,
} from '../model.js?v=5.2';
import { record, undo, redo, nextUndo, nextRedo } from '../history.js?v=5.2';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=5.2';
import { notify } from '../dialog.js?v=5.2';
import { checkTable } from '../check.js?v=5.2';
import { screenTitle } from './common.js?v=5.2';
import { staffGrid } from './staffgrid.js?v=5.2';
import { needGrid } from './needgrid.js?v=5.2';
import { markIndex, markClasses, markBadges, countBand, errorList, worsened } from './checkview.js?v=5.2';
import { currentPreview, previewCard, openRepair, openRestart, repairBlockReason } from './repairview.js?v=5.2';
import { summarize, summaryColumns } from '../summary.js?v=5.2';
import { exportCsv, exportExcel } from '../files.js?v=5.2';

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

// changed：案で変わるマス（`人|日`）の集まり。案を見ているときだけ
function tableCell(d, p, day, marks, changed = null) {
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
  const proposed = Boolean(changed?.has(`${p.id}|${day}`));
  if (proposed) cls.push('is-proposed');
  cls.push(...markClasses(mk));
  const label = [
    cellName(d, v),
    proposed ? '案で変わるマス' : null,
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

const who = (p) => `${p.name || '名前なし'}さん`;

// 夜勤の次の日の明けをどうしたかの知らせ（next は setCellByHand の返り値）
function akeNotice(d, p, day, next) {
  const nextDay = `${who(p)}の${d.month.month}月${day + 1}日`;
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
}

// 同じ日の2人のマスを入れ替える。固定したマスは入れ替えない
function swapByHand(pa, pb, day, changed) {
  const d = app.data;
  if (marksOf(d, pa.id, day).locked || marksOf(d, pb.id, day).locked) {
    notify('固定したマスは入れ替えません。入れ替えるときは、先にマスを押して「このマスを固定する」を外してください。', { kind: 'warn', testid: 'swap-locked-notice' });
    return;
  }
  let res = null;
  record(`${who(pa)}と${who(pb)}の${d.month.month}月${day}日の入れ替え`, (x) => { res = swapCells(x, pa.id, pb.id, day); });
  changed(true);
  for (const n of res?.notes ?? []) akeNotice(app.data, app.data.staff.find((q) => q.id === n.pid), day, n.next);
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
    // いまと同じものなら何もしない（「手で変えた」の印も履歴も付けない。2026-10-31 確かめ役と決めた）
    if (same(now, value)) {
      close();
      return;
    }
    let next = null;
    record(`${who(p)}の${month}月${day}日`, (x) => { next = setCellByHand(x, p.id, day, value); });
    close();
    changed(true);
    akeNotice(d, p, day, next);
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
  const locked = Boolean(marksOf(d, p.id, day).locked);
  const lock = h('input', { type: 'checkbox', checked: locked, testid: 'pick-lock' });
  lock.addEventListener('change', () => {
    record(`${who(p)}の${month}月${day}日の固定`, (x) => setLock(x, p.id, day, lock.checked));
    changed(false);
  });
  const others = d.staff.filter((q) => q.id !== p.id);
  const swapBox = others.length
    ? h(
        'details',
        { class: 'pick-swap', testid: 'pick-swap' },
        h('summary', { text: 'この日の、ほかの人と入れ替える' }),
        locked ? h('p', { class: 'help', text: 'このマスは固定しているので、入れ替えられません。下の「このマスを固定する」を外すと入れ替えられます。' }) : null,
        h(
          'div',
          { class: 'pick-grid' },
          others.map((q) => {
            const qLocked = Boolean(marksOf(d, q.id, day).locked);
            return h(
              'button',
              {
                type: 'button',
                class: 'pick swap-option',
                testid: 'swap-option',
                dataset: { staffId: q.id },
                disabled: locked || qLocked,
                on: {
                  click: () => {
                    close();
                    swapByHand(p, q, day, changed);
                  },
                },
              },
              h('span', { class: 'pick-label', text: `${who(q)}（${cellName(d, cellOf(d, q.id, day))}）` }),
              qLocked ? h('span', { class: 'pick-note', text: '固定' }) : null,
            );
          }),
        ),
      )
    : null;
  append(
    dlg,
    h('h2', { id: 'picker-title', text: `${who(p)}　${month}月${day}日（${WEEKDAY_LABELS[weekdayOf(year, month, day)]}）` }),
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
    swapBox,
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

// 集計表（4-3）：人ごとの各シフトの回数・公休・有給・出勤日数・労働時間（数え方は summary.js）
function summaryTable(d) {
  const cols = summaryColumns(d);
  const sum = summarize(d);
  const row = (name, r, cls) => h('tr', { class: cls }, h('th', { scope: 'row', class: 'sticky-col', text: name }), cols.map((c) => h('td', { text: String(c.value(r)), dataset: { key: c.key } })));
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'summary-table', testid: 'summary-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'sticky-col', text: 'スタッフ' }), cols.map((c) => h('th', { scope: 'col', text: c.label })))),
      h('tbody', {}, sum.rows.map((r) => row(r.name || '名前なし', r, null)), row('合計', sum.totals, 'is-total')),
    ),
  );
}

async function doExportExcel(btn) {
  btn.disabled = true;
  try {
    const name = await exportExcel(app.data);
    notify(`「${name}」を書き出しました（ブラウザのダウンロードの場所に入ります）。Excel で開けます。`, { kind: 'ok', testid: 'export-excel-notice' });
  } catch {
    notify('Excel のファイルを作れませんでした。ページを読み込み直して、もう一度ためしてください（CSV なら「その他の操作」から書き出せます）。', { kind: 'error', testid: 'export-excel-error' });
  } finally {
    btn.disabled = false;
  }
}

function doExportCsv() {
  const name = exportCsv(app.data);
  notify(`「${name}」を書き出しました（ブラウザのダウンロードの場所に入ります）。`, { kind: 'ok', testid: 'export-csv-notice' });
}

// 元に戻す・やり直すの結果の知らせ
function tellUndo(res, what) {
  if (!res) return;
  if (res.otherMonth) notify('月を切り替えたので、前の月の変更は戻せません。', { kind: 'warn', testid: 'undo-notice' });
  else if (res.skipped) notify(`${what}ました（${res.label}）。そのあとで変えた所 ${res.skipped}か所は、いまのままにしました。`, { kind: 'info', testid: 'undo-notice' });
  else notify(`${what}ました（${res.label}）。`, { kind: 'ok', testid: 'undo-notice' });
}

export function renderStep6(el) {
  const d = app.data;
  append(
    el,
    ...screenTitle('手順6 シフト表', 'マスを押すと、入れるシフトや休みを選べます。変えるたびに、決まりに合っているかを検査し直します。自動で作るのは 手順5 です。'),
  );
  if (!d.staff.length) {
    append(el, h('p', { class: 'empty', testid: 'table-empty', text: 'スタッフがいません。手順3 スタッフで、1人以上入れてください。' }));
    return;
  }
  // 案を見ているときは、案の表で見せる（本物のデータは変えない）
  const pv = currentPreview();
  const view = pv ? { ...d, month: { ...d.month, table: pv.proposal.table } } : d;
  const changed = pv ? new Set(pv.proposal.changes.map((c) => `${c.pid}|${c.day}`)) : null;
  let result = checkTable(view);
  let marks = markIndex(view, result);
  const tools = h('div', { class: 'table-tools', testid: 'table-tools' });
  const bandBox = h('div', { class: 'band-box' });
  const detailBox = h('div', { class: 'band-detail card', testid: 'band-detail', hidden: true });
  const listBox = h('div');
  let openKey = null;
  let need = null;

  // 元に戻す・やり直す（押すと画面を作り直す）
  const drawTools = () => {
    tools.textContent = '';
    const u = pv ? null : nextUndo();
    const r = pv ? null : nextRedo();
    append(
      tools,
      h(
        'div',
        { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn', testid: 'undo', text: '元に戻す', disabled: !u, on: { click: () => tellUndo(undo(), '元に戻し') } }),
        h('button', { type: 'button', class: 'btn', testid: 'redo', text: 'やり直す', disabled: !r, on: { click: () => tellUndo(redo(), 'やり直し') } }),
        h(
          'details',
          { class: 'more-ops', testid: 'more-ops' },
          h('summary', { class: 'btn', text: 'その他の操作' }),
          h(
            'div',
            { class: 'more-ops-menu' },
            h('button', { type: 'button', class: 'btn', testid: 'restart', text: '途中から作り直す', disabled: Boolean(pv) || !d.settings.shifts.length, on: { click: openRestart } }),
            h('p', { class: 'help', text: pv ? '案を見ているあいだは使えません。' : '◯日までをいまのまま残して、あとの日を作り直します。' }),
            h('button', { type: 'button', class: 'btn', testid: 'export-csv', text: 'CSV に出す', disabled: Boolean(pv), on: { click: doExportCsv } }),
            h('p', { class: 'help', text: 'シフト表と集計表を、表計算のアプリで開ける形（CSV）で書き出します。' }),
          ),
        ),
        h('button', { type: 'button', class: 'btn btn-primary', testid: 'export-excel', text: 'Excel に出す', disabled: Boolean(pv), on: { click: (e) => doExportExcel(e.currentTarget) } }),
      ),
      h('p', { class: 'help', testid: 'undo-status', text: pv ? '案を見ているあいだは、元に戻す・やり直すを止めています。' : u ? `「元に戻す」で、「${u.label}」の前に戻ります。` : '戻せる変更はまだありません（このページを開いてから変えたものを戻せます。読み直すと消えます）。' }),
      r ? h('p', { class: 'help', testid: 'redo-status', text: `「やり直す」で、「${r.label}」をもう一度します。` }) : null,
    );
  };

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
    const why = repairBlockReason(result);
    bandBox.append(
      countBand(result, { onOpen: openDetail }),
      h(
        'div',
        { class: 'band-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', testid: 'repair', text: 'エラーを自動で直す', disabled: Boolean(why), on: { click: openRepair } }),
        h('span', { class: 'help', testid: 'repair-why', text: why ?? '変えてよいマスの数を決めて、エラーが減る案を探します。' }),
      ),
    );
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
    drawTools();
    const w = announce ? worsened(before, result) : [];
    if (w.length) notify(`悪くなりました：${w.join('、')}`, { kind: 'warn', testid: 'worse-notice' });
  };

  const grid = staffGrid({
    data: d,
    testid: 'shift-grid',
    cellTestid: 'table-cell',
    cell: (p, day) => tableCell(view, p, day, marks, changed),
    onPick: (p, day, btn) => (pv
      ? notify('案を見ているあいだは、マスを変えられません。上の「この案にする」か「やめる」を押してください。', { kind: 'info', testid: 'preview-notice' })
      : openPicker(p, day, recheck, btn)),
    onSwap: pv ? null : (pa, pb, day) => swapByHand(pa, pb, day, recheck),
    rowMark: (p) => headMark(marks.get(`n|${p.id}`)),
    dayMark: (day) => headMark(marks.get(`d|${day}`)),
  });
  drawCheck();
  drawTools();
  if (d.settings.shifts.length && !pv) need = needGrid({ assigned: assignedCounter(d), onChange: () => recheck(true) });
  append(
    el,
    h(
      'section',
      { class: 'card' },
      previewCard(),
      tools,
      bandBox,
      detailBox,
      h('p', { class: 'help', text: '行がスタッフ、列が日です。表は横に動かせます。夜勤を入れると、次の日が空いていれば「明け」が入ります。マスを同じ日のほかの人のマスへドラッグすると、2人のマスを入れ替えます（スマホやキーボードでは、マスを押して「この日の、ほかの人と入れ替える」）。' }),
      legend(d),
      grid.el,
    ),
    h('section', { class: 'card', testid: 'error-list-section' }, listBox),
    h(
      'section',
      { class: 'card', testid: 'summary-section' },
      h('h2', { text: '集計表' }),
      h('p', { class: 'help', text: `人ごとの回数と日数です${pv ? '（いまは案の表で数えています）' : ''}。半休は出勤1日・有給0.5日・労働時間は手順1 の「半休の日の労働時間」で数えます。明けは出勤日数と労働時間に入れません。研修のシフトは出勤に数えます。空きのマスは数えません。` }),
      summaryTable(view),
    ),
    need
      ? h(
          'section',
          { class: 'card' },
          h('h2', { text: '日ごとの必要人数と、配置した人数' }),
          h('p', { class: 'help', text: '上の数は必要人数（手順2と同じ入れ方で変えられます）。下の「配置」は、シフト表で入れた人数です。' }),
          need.el,
        )
      : pv
        ? h('section', { class: 'card' }, h('h2', { text: '日ごとの必要人数と、配置した人数' }), h('p', { class: 'help', text: '案を見ているあいだは出していません。「この案にする」か「やめる」を押すと出ます。' }))
        : null,
  );
}
