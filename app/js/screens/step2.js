// 手順2 シフトの種類
import { h, append, field, select, numberInput, clear } from '../dom.js?v=4.3';
import { app, commit, rerender } from '../state.js?v=4.3';
import { GROUP_IDS, LIMITS, symbolProblem, newShift, removeShift, shiftUsage, setCombine } from '../model.js?v=4.3';
import { ask, form } from '../dialog.js?v=4.3';
import { screenTitle, section, checkbox, warn } from './common.js?v=4.3';
import { needGrid } from './needgrid.js?v=4.3';

// 開いている「詳細」と折りたたみは、画面を作り直しても開いたままにする
const openDetails = new Set();
let needOpen = false;

function groupOptions(d) {
  return GROUP_IDS.map((g) => ({ value: g, label: d.settings.groupNames[g] }));
}

function updateSymbolLabels(shiftId, symbol) {
  document.querySelectorAll('[data-sym-of]').forEach((el) => {
    if (el.dataset.symOf === shiftId) el.textContent = symbol;
  });
}

function shiftRows(refreshGrid) {
  const d = app.data;
  const names = d.settings.employmentNames;
  return d.settings.shifts.flatMap((s, i) => {
    const symbol = h('input', { type: 'text', value: s.symbol, maxlength: 3, autocomplete: 'off', class: 'in-symbol', 'aria-label': '記号', testid: 'shift-symbol' });
    symbol.addEventListener('change', () => {
      const v = symbol.value.trim();
      const problem = symbolProblem(app.data, v, s.id);
      if (problem) {
        warn(problem);
        symbol.value = s.symbol;
        return;
      }
      symbol.value = v;
      commit((x) => { x.settings.shifts[i].symbol = v; });
      updateSymbolLabels(s.id, v);
    });
    const name = h('input', { type: 'text', value: s.name, maxlength: 30, autocomplete: 'off', 'aria-label': '名称', testid: 'shift-name' });
    name.addEventListener('change', () => {
      name.value = name.value.trim();
      commit((x) => { x.settings.shifts[i].name = name.value; });
    });
    const needNum = (emp, label) =>
      numberInput(s.need[emp], {
        min: LIMITS.need[0],
        max: LIMITS.need[1],
        class: 'num-short',
        'aria-label': `ふだんの必要人数（${label}）`,
        testid: `shift-need-${emp}`,
        onBad: warn,
        onChange: (n) => {
          commit((x) => { x.settings.shifts[i].need[emp] = n; });
          refreshGrid();
        },
      });
    const open = openDetails.has(s.id);
    const toggle = h('button', {
      type: 'button',
      class: 'btn btn-small',
      'aria-expanded': String(open),
      testid: 'shift-detail-toggle',
      text: open ? '詳細 ▲' : '詳細 ▼',
      on: {
        click: () => {
          if (openDetails.has(s.id)) openDetails.delete(s.id);
          else openDetails.add(s.id);
          rerender();
        },
      },
    });
    const main = h(
      'tr',
      { testid: 'shift-row', dataset: { shiftId: s.id } },
      h('td', { 'data-label': '記号' }, symbol),
      h('td', { 'data-label': '名称' }, name),
      h('td', { 'data-label': '時間帯のグループ' }, select(groupOptions(d), s.group, {
        'aria-label': '時間帯のグループ',
        testid: 'shift-group',
        on: { change: (e) => commit((x) => { x.settings.shifts[i].group = e.target.value; }) },
      })),
      h('td', { 'data-label': '労働時間（時間）' }, numberInput(s.hours, {
        min: LIMITS.hours[0],
        max: LIMITS.hours[1],
        step: 0.5,
        class: 'num-short',
        'aria-label': '労働時間（時間）',
        testid: 'shift-hours',
        onBad: warn,
        onChange: (n) => commit((x) => { x.settings.shifts[i].hours = n; }),
      })),
      !s.counts || s.training
        ? h('td', { colspan: 2, 'data-label': 'ふだんの必要人数' }, h('span', { class: 'help need-off', testid: 'shift-need-off', text: '人数に数えないシフトなので、必要人数は見ません' }))
        : s.combine
        ? h('td', { colspan: 2, 'data-label': 'ふだんの必要人数（合わせて）' }, h('span', { class: 'inline-label', text: '合わせて' }), needNum('all', '合わせて'))
        : [
            h('td', { 'data-label': `ふだんの必要人数（${names.full}）` }, needNum('full', names.full)),
            h('td', { 'data-label': `ふだんの必要人数（${names.part}）` }, needNum('part', names.part)),
          ],
      h('td', { class: 'toggle-cell' }, toggle),
    );
    if (!open) return [main];

    const usage = shiftUsage(d, s.id);
    const flag = (key, label, help, testid, extra = {}) =>
      h(
        'div',
        { class: 'field' },
        checkbox(label, s[key], (v) => commit((x) => {
          const t = x.settings.shifts[i];
          t[key] = v;
          if (key === 'training' && v) t.counts = false;
        }, { render: key === 'training' || key === 'counts' }), { testid, ...extra }),
        help ? h('p', { class: 'help', text: help }) : null,
      );
    const color = h('input', { type: 'color', value: s.color, testid: 'shift-color', id: `color-${s.id}` });
    color.addEventListener('change', () => commit((x) => { x.settings.shifts[i].color = color.value.toUpperCase(); }));
    const move = (dir) => commit((x) => {
      const list = x.settings.shifts;
      [list[i], list[i + dir]] = [list[i + dir], list[i]];
    }, { render: true });
    const del = async () => {
      const lines = [];
      if (usage.staff) lines.push(`このシフトを担当できる人（${usage.staff}人）から外れます。`);
      if (usage.cells) lines.push(`希望・シフト表でこのシフトを使っているマス（${usage.cells}か所）も消えます。`);
      if (usage.akes) lines.push(`シフト表で、その次の日の明け（${usage.akes}か所）も消えます（固定した明けは残します）。`);
      lines.push('日ごとの必要人数と、このシフトの必要人数の決まりも消えます。');
      const v = await ask({
        title: `シフト「${s.symbol}」を消しますか？`,
        lines,
        buttons: [
          { label: 'やめる', value: 'cancel' },
          { label: '消す', value: 'ok', kind: 'danger', testid: 'shift-delete-ok' },
        ],
      });
      if (v !== 'ok') return;
      openDetails.delete(s.id);
      commit((x) => removeShift(x, s.id), { render: true });
    };
    const detail = h(
      'tr',
      { class: 'detail-row', testid: 'shift-detail' },
      h(
        'td',
        { colspan: 7 },
        h(
          'div',
          { class: 'detail-grid' },
          flag('counts', '人数に数える', '外すと、このシフトに入った人は必要人数に数えません。', 'shift-counts', { disabled: s.training }),
          flag('training', '研修扱い（人数に数えない出勤）', '出勤した日に数えますが、人数とスキルには数えません。', 'shift-training'),
          flag('night', '夜勤（次の日は明け）', '夜勤の次の日は「明け（明）」になり、ほかのシフトは入りません。遅い→早いなどの決まりでは、時間帯のグループに関係なく「夜」として数えます。', 'shift-night'),
          flag('onePerDay', '1日1人の役', '「その時間帯の責任者」のように、1日に1人だけ入る役です。', 'shift-one-per-day'),
          h(
            'div',
            { class: 'field' },
            checkbox(`${names.full}と${names.part}を合わせて数える`, s.combine, (v) => commit((x) => setCombine(x, x.settings.shifts[i], v), { render: true }), { testid: 'shift-combine' }),
            h('p', { class: 'help', text: '区分を分けずに、合わせた人数で必要人数を決めます。' }),
          ),
          field('Excel に出すときの色', color),
        ),
        h('p', { class: 'help', text: `このシフトを担当できる人：${usage.staff}人（手順3 スタッフで変えられます）` }),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-small', text: '↑ 上へ', disabled: i === 0, on: { click: () => move(-1) } }),
          h('button', { type: 'button', class: 'btn btn-small', text: '↓ 下へ', disabled: i === d.settings.shifts.length - 1, on: { click: () => move(1) } }),
          h('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'このシフトを消す', testid: 'shift-delete', on: { click: del } }),
        ),
      ),
    );
    return [main, detail];
  });
}

async function addShift() {
  const d = app.data;
  const names = d.settings.employmentNames;
  const inp = (props) => h('input', { autocomplete: 'off', ...props });
  const symbol = inp({ type: 'text', maxlength: 3, testid: 'add-shift-symbol' });
  const name = inp({ type: 'text', maxlength: 30, testid: 'add-shift-name' });
  const group = select(groupOptions(d), 'early', { testid: 'add-shift-group' });
  const night = inp({ type: 'checkbox', testid: 'add-shift-night' });
  const counts = inp({ type: 'checkbox', checked: true, testid: 'add-shift-counts' });
  const full = inp({ type: 'number', min: 0, max: 99, value: '0', inputmode: 'numeric', class: 'num-short', testid: 'add-shift-need-full' });
  const part = inp({ type: 'number', min: 0, max: 99, value: '0', inputmode: 'numeric', class: 'num-short', testid: 'add-shift-need-part' });
  const staffBoxes = d.staff.map((p) => ({ p, box: inp({ type: 'checkbox', testid: 'add-shift-staff' }) }));
  const staffEl = staffBoxes.length
    ? h(
        'fieldset',
        { class: 'field' },
        h('legend', { text: '担当する人' }),
        h('div', { class: 'check-grid' }, staffBoxes.map(({ p, box }) => h('label', { class: 'check' }, box, h('span', { text: p.name || '名前なし' })))),
      )
    : h('p', { class: 'help', text: '担当する人は、手順3 スタッフで選べます。' });
  const values = await form({
    title: 'シフトを追加',
    intro: '記号は表のマスに出る短い文字です（例：早・遅・夜）。',
    testid: 'add-shift-dialog',
    okLabel: '追加する',
    fields: [
      { key: 'symbol', el: field('記号（3文字まで）', symbol), read: () => symbol.value.trim() },
      { key: 'name', el: field('名称', name), read: () => name.value.trim() },
      { key: 'group', el: field('時間帯のグループ', group), read: () => group.value },
      { key: 'night', el: h('label', { class: 'check' }, night, h('span', { text: '夜勤（次の日は明け）' })), read: () => night.checked },
      { key: 'counts', el: h('label', { class: 'check' }, counts, h('span', { text: '人数に数える' })), read: () => counts.checked },
      {
        key: 'need',
        el: h(
          'fieldset',
          { class: 'field' },
          h('legend', { text: 'ふだんの必要人数' }),
          h('div', { class: 'row' }, field(names.full, full), field(names.part, part)),
          h('p', { class: 'help', text: 'はじめは0人です。特定の日だけ使うシフトは0人のままにして、「日ごとの必要人数」で日ごとに入れます。' }),
        ),
        read: () => ({ full: full.value.trim(), part: part.value.trim() }),
      },
      { key: 'staff', el: staffEl, read: () => staffBoxes.filter((x) => x.box.checked).map((x) => x.p.id) },
    ],
    check: (v) => {
      const problem = symbolProblem(app.data, v.symbol);
      if (problem) return problem;
      for (const [emp, label] of [['full', names.full], ['part', names.part]]) {
        if (!/^\d{1,2}$/.test(v.need[emp])) return `ふだんの必要人数（${label}）は、0〜99の数を入れてください。`;
      }
      return '';
    },
  });
  if (!values) return;
  commit((x) => {
    const f = Number(values.need.full);
    const p = Number(values.need.part);
    const s = newShift(x, {
      symbol: values.symbol,
      name: values.name,
      group: values.group,
      night: values.night,
      counts: values.counts,
      need: { full: f, part: p, all: f + p },
    });
    x.settings.shifts.push(s);
    for (const st of x.staff) if (values.staff.includes(st.id)) st.shifts.push(s.id);
  }, { render: true });
}

export function renderStep2(el) {
  const d = app.data;
  const names = d.settings.employmentNames;
  const gridBox = h('div');
  const refreshGrid = () => {
    if (!needOpen) return;
    clear(gridBox);
    gridBox.append(d.settings.shifts.length ? needGrid().el : h('p', { class: 'empty', text: 'シフトがありません。上の「シフトを追加」で足すと、ここで日ごとの人数を変えられます。' }));
  };
  const details = h(
    'details',
    { class: 'card', open: needOpen, testid: 'need-details' },
    h('summary', { text: '日ごとの必要人数（日によって人数を変えるとき）' }),
    h('p', { class: 'help', text: 'ふだんの数のままの日は、何もしなくてかまいません。ここで変えた数は、この月だけに使います。' }),
    gridBox,
  );
  details.addEventListener('toggle', () => {
    needOpen = details.open;
    if (needOpen) refreshGrid();
  });
  refreshGrid();

  append(el,
    ...screenTitle('手順2 シフトの種類', 'シフトの記号・時間帯・ふだんの必要人数を決めます。記号を変えても、表や希望はくずれません。'),
    section(
      'シフトの一覧',
      '「詳細」を押すと、人数に数えるか・研修扱い・夜勤・1日1人の役・色などを変えられます。',
      d.settings.shifts.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'shift-table', testid: 'shift-table' },
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  ['記号', '名称', '時間帯のグループ', '労働時間（時間）', `ふだんの必要人数（${names.full}）`, `（${names.part}）`, ''].map((t) => h('th', { scope: 'col', text: t })),
                ),
              ),
              h('tbody', {}, shiftRows(refreshGrid)),
            ),
          )
        : h('p', { class: 'empty', testid: 'shift-empty', text: 'まだシフトがありません。「シフトを追加」で足してください。' }),
      h('button', { type: 'button', class: 'btn btn-primary', testid: 'shift-add', text: 'シフトを追加', on: { click: addShift } }),
    ),
    details,
    h(
      'details',
      { class: 'card', testid: 'daily-skill-details' },
      h('summary', { text: '日ごとに要るスキル' }),
      h('p', { class: 'help', text: '準備中です。あとの版で使えるようになります。' }),
    ),
  );
}
