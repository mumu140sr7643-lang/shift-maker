// 手順3 スタッフ（左に一覧、右に選んだ人の詳細。スマホでは一覧→詳細）
import { h, append, field, select, numberInput, clear } from '../dom.js?v=1.2.1';
import { app, commit, rerender } from '../state.js?v=1.2.1';
import { LIMITS, newStaff, removeStaff, staffById, rankById } from '../model.js?v=1.2.1';
import { ask } from '../dialog.js?v=1.2.1';
import { screenTitle, checkbox, textInput, warn } from './common.js?v=1.2.1';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function nextName(d) {
  const used = new Set(d.staff.map((p) => p.name));
  for (const c of LETTERS) if (!used.has(c)) return c;
  return '新しい人';
}

function shiftSymbols(d, p) {
  const list = d.settings.shifts.filter((s) => p.shifts.includes(s.id)).map((s) => s.symbol);
  return list.length ? list.join('・') : '担当なし';
}

function renderList(box) {
  const d = app.data;
  clear(box);
  if (!d.staff.length) {
    box.append(h('p', { class: 'empty', text: 'まだスタッフがいません。「スタッフを追加」で足してください。' }));
    return;
  }
  box.append(
    h(
      'ul',
      { class: 'staff-list', testid: 'staff-list' },
      d.staff.map((p) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: p.id === app.selectedStaff ? 'staff-item is-current' : 'staff-item',
              'aria-current': p.id === app.selectedStaff ? 'true' : null,
              testid: 'staff-item',
              dataset: { staffId: p.id },
              on: { click: () => { app.selectedStaff = p.id; rerender(); } },
            },
            h('span', { class: 'staff-name', text: p.name || '名前なし' }),
            h('span', { class: 'staff-meta', text: `${rankById(d, p.rank)?.name ?? '役職なし'}・${d.settings.employmentNames[p.employment]}` }),
            h('span', { class: 'staff-meta', text: `担当：${shiftSymbols(d, p)}` }),
          ),
        ),
      ),
    ),
  );
}

function detail(p, refreshList) {
  const d = app.data;
  const idx = d.staff.findIndex((x) => x.id === p.id);
  const set = (key, refresh = false) => (v) => {
    commit((x) => { x.staff[idx][key] = v; });
    if (refresh) refreshList();
  };
  const num = (key, label, limits, help, testid, opts = {}) =>
    field(label, numberInput(p[key], { min: limits[0], max: limits[1], onBad: warn, onChange: set(key), testid, ...opts }), help);
  const pick = (key, label, options, help, testid, refresh = false) =>
    field(label, select(options, p[key], { testid, on: { change: (e) => set(key, refresh)(e.target.value) } }), help);
  const names = d.settings.employmentNames;
  const heading = h('h2', { text: `${p.name || '名前なし'}さんの設定` });

  const toggleIn = (key, id, on) =>
    commit((x) => {
      const list = x.staff[idx][key];
      const i = list.indexOf(id);
      if (on && i < 0) list.push(id);
      if (!on && i >= 0) list.splice(i, 1);
    });

  const del = async () => {
    const v = await ask({
      title: `${p.name || '名前なし'}さんを消しますか？`,
      lines: ['この人の希望・シフト表のマス・固定も消えます。', '消したあとでも、「保存と控え」の「ひとつ前の保存に戻す」で1回分は戻せます。'],
      buttons: [
        { label: 'やめる', value: 'cancel' },
        { label: '消す', value: 'ok', kind: 'danger', testid: 'staff-delete-ok' },
      ],
    });
    if (v !== 'ok') return;
    app.selectedStaff = null;
    commit((x) => removeStaff(x, p.id), { render: true });
  };

  return h(
    'div',
    { class: 'staff-detail card', testid: 'staff-detail' },
    h('button', { type: 'button', class: 'btn btn-small back-to-list', testid: 'staff-back', text: '← 一覧へ戻る', on: { click: () => { app.selectedStaff = null; rerender(); } } }),
    heading,
    h(
      'div',
      { class: 'grid-fields' },
      field('名前', textInput(p.name, {
        testid: 'staff-name',
        maxlength: 20,
        required: '名前が空です。名前を入れてください（例：A）。',
        onChange: (v) => {
          set('name', true)(v);
          heading.textContent = `${v}さんの設定`;
        },
      })),
      pick('employment', '区分', [{ value: 'full', label: names.full }, { value: 'part', label: names.part }], null, 'staff-employment', true),
      pick('rank', '役職', d.settings.ranks.map((r) => ({ value: r.id, label: r.name })), null, 'staff-rank', true),
    ),
    h(
      'fieldset',
      { class: 'field' },
      h('legend', { text: '担当できるシフト' }),
      d.settings.shifts.length
        ? h('div', { class: 'check-grid' }, d.settings.shifts.map((s) =>
            checkbox(`${s.symbol}（${s.name || '名称なし'}）`, p.shifts.includes(s.id), (on) => { toggleIn('shifts', s.id, on); refreshList(); }, { testid: 'staff-shift' })))
        : h('p', { class: 'help', text: '手順2 シフトの種類でシフトを足すと、ここで選べます。' }),
    ),
    h(
      'fieldset',
      { class: 'field' },
      h('legend', { text: 'スキル' }),
      d.settings.skills.length
        ? h('div', { class: 'check-grid' }, d.settings.skills.map((k) =>
            checkbox(k.name, p.skills.includes(k.id), (on) => toggleIn('skills', k.id, on), { testid: 'staff-skill' })))
        : h('p', { class: 'help', text: '手順1 基本設定でスキルを足すと、ここで選べます。' }),
    ),
    h(
      'div',
      { class: 'grid-fields' },
      num('offDays', '月の公休数（日）', LIMITS.offDays, 'その月に取る休みの日数です。', 'staff-off-days'),
      num('paidDays', '有給の日数（日）', LIMITS.paidDays, '0.5日きざみ。半休は0.5日と数えます。', 'staff-paid-days', { step: 0.5 }),
      num('maxConsecutive', '個人の連勤上限（日）', LIMITS.consecutive, `空のときは、手順1の「連勤の上限」（${d.settings.work.maxConsecutive}日）を使います。`, 'staff-max-consecutive', { allowBlank: true }),
      pick('groupPref', '時間帯の希望', [
        { value: 'any', label: 'どちらも' },
        { value: 'early', label: '早い時間帯だけ' },
        { value: 'late', label: '遅い時間帯だけ' },
      ], null, 'staff-group-pref'),
      pick('biasPref', '早い・遅いの偏りの希望', [
        { value: 'even', label: '均等' },
        { value: 'early', label: '早い多め' },
        { value: 'late', label: '遅い多め' },
      ], null, 'staff-bias-pref'),
      pick('restStyle', '休み方の希望', [
        { value: 'any', label: '希望なし' },
        { value: 'together', label: '連休にしたい' },
        { value: 'spread', label: 'ばらしたい' },
      ], null, 'staff-rest-style'),
      pick('weekendPref', '土日の希望', [
        { value: 'any', label: '希望なし' },
        { value: 'off', label: '土日は休みたい' },
        { value: 'work', label: '土日に出たい' },
      ], null, 'staff-weekend-pref'),
    ),
    h(
      'div',
      { class: 'field' },
      checkbox('「遅い時間帯 → 早い時間帯」の間は2連休にする', p.twoOffAfterLateEarly, set('twoOffAfterLateEarly'), { testid: 'staff-two-off' }),
    ),
    h(
      'fieldset',
      { class: 'field' },
      h('legend', { text: '前の月の終わり' }),
      h('p', { class: 'help', text: '月をまたいだ連勤と「遅い → 早い」を数えるために使います。' }),
      h(
        'div',
        { class: 'grid-fields' },
        num('prevConsecutive', '前月末の連勤日数（日）', LIMITS.prevConsecutive, '前の月の最後の日まで、何日続けて出勤していたか。休みで終わったときは0。', 'staff-prev-consecutive'),
        field('前の月の最後のシフト', select(
          [{ value: '', label: 'なし（分からない）' }, { value: 'off', label: '休み' }, ...d.settings.shifts.map((s) => ({ value: s.id, label: `${s.symbol}（${s.name || '名称なし'}）` }))],
          p.prevLastShift ?? '',
          { testid: 'staff-prev-last', on: { change: (e) => set('prevLastShift')(e.target.value || null) } },
        )),
      ),
    ),
    field('メモ', (() => {
      const t = h('textarea', { rows: 2, maxlength: 200, testid: 'staff-memo' });
      t.value = p.memo;
      t.addEventListener('change', () => set('memo')(t.value));
      return t;
    })()),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-danger', testid: 'staff-delete', text: 'この人を消す', on: { click: del } })),
  );
}

export function renderStep3(el) {
  const d = app.data;
  if (app.selectedStaff && !staffById(d, app.selectedStaff)) app.selectedStaff = null;
  const listBox = h('div');
  const refreshList = () => renderList(listBox);
  refreshList();
  const selected = app.selectedStaff ? staffById(d, app.selectedStaff) : null;
  append(el,
    ...screenTitle('手順3 スタッフ', `スタッフの区分・役職・担当できるシフト・休みの数などを決めます。いま${d.staff.length}人です。`),
    h(
      'div',
      { class: selected ? 'staff-layout has-selection' : 'staff-layout' },
      h(
        'div',
        { class: 'staff-list-col card' },
        h('h2', { text: '一覧' }),
        listBox,
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          testid: 'staff-add',
          text: 'スタッフを追加',
          on: {
            click: () => {
              let id = null;
              commit((x) => {
                const p = newStaff(x, { name: nextName(x) });
                x.staff.push(p);
                id = p.id;
              });
              app.selectedStaff = id;
              rerender();
            },
          },
        }),
      ),
      selected
        ? detail(selected, refreshList)
        : h('div', { class: 'staff-detail card staff-detail-empty' }, h('p', { class: 'empty', text: d.staff.length ? '左の一覧から人を選ぶと、ここにくわしい設定が出ます。' : 'スタッフを足すと、ここにくわしい設定が出ます。' })),
    ),
  );
}
