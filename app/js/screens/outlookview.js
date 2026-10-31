// 手順5 の「詳しい機能」（v5。docs/見込みと説明の案.md）：作る前の見込み。
// 5-1：日ごとの余裕（全体・時間帯・スキルごと）と、休める人が0人の日に出勤になる人。
// 5-2：人手の余り・不足の表（最大流で「埋められる」）と、月の合計の人手（区分ごと）。
import { h } from '../dom.js?v=5.2';
import { monthDays } from '../model.js?v=5.2';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=5.2';
import { GROUPS, countedShift, groupOf, dayMargins, skillMargins, staffingTable, monthTotals } from '../outlook.js?v=5.2';

export function marginClass(m) {
  return m < 0 ? 'mg-neg' : m === 0 ? 'mg-zero' : m === 1 ? 'mg-one' : 'mg-ok';
}

function marginTable(d) {
  const N = monthDays(d);
  const { year, month } = d.month;
  const names = d.settings.groupNames;
  const rows = [{ label: '全体', days: dayMargins(d) }];
  for (const g of GROUPS) {
    if (d.settings.shifts.some((s) => countedShift(s) && groupOf(s) === g)) rows.push({ label: names[g], days: dayMargins(d, { group: g }) });
  }
  for (const sk of skillMargins(d)) {
    const name = d.settings.skills.find((k) => k.id === sk.skill)?.name ?? '';
    rows.push({ label: `${name}（${names[sk.group]}）`, days: sk.days, skill: true });
  }
  const days = Array.from({ length: N }, (_, i) => i + 1);
  return {
    rows,
    el: h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'margin-table', testid: 'margin-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'sticky-col', text: '' }), days.map((day) => h('th', { scope: 'col', text: `${day}`, title: `${month}月${day}日（${WEEKDAY_LABELS[weekdayOf(year, month, day)]}）` })))),
        h(
          'tbody',
          {},
          rows.map((r) =>
            h(
              'tr',
              { dataset: { row: r.label } },
              h('th', { scope: 'row', class: 'sticky-col', text: r.label }),
              r.days.map((m) => h('td', {
                class: `foot-cell ${marginClass(m.margin)}`,
                text: String(m.margin),
                title: `${month}月${m.day}日：${r.skill ? 'そのスキルを持ち出られる人' : '出られる人'} ${m.available}人・${r.skill ? '最低人数' : '必要人数'} ${m.need}人`,
              })),
            ),
          ),
        ),
      ),
    ),
  };
}

function staffingCard(d) {
  const { month } = d.month;
  const rows = staffingTable(d);
  const cell = (text, cls = null) => h('td', { class: cls, text });
  return [
    h('h3', { text: '人手の余り・不足の表' }),
    h('p', { class: 'help', text: '「埋められる」は、人を日と枠に1人1日1つずつ割り当てて、いちばん多く埋まる数です（月に働ける日数＝公休・有給の予定を引いた日数 を超えないように）。連勤などの、日をまたぐ決まりは見ていないので、作れる表より多めのことがあります。「出られる」は、その行の枠に入れる日数と、月に働ける日数の小さいほうの合計です。' }),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'staffing-table', testid: 'staffing-table' },
        h('thead', {}, h('tr', {}, ['', '余り・不足（人日）', '必要（人日）', '出られる（人日）', '埋められる（人日）', '足りない日', '休み・有給を削る日数'].map((t) => h('th', { scope: 'col', text: t })))),
        h(
          'tbody',
          {},
          rows.map((r) =>
            h(
              'tr',
              { dataset: { key: r.key } },
              h('th', { scope: 'row', text: r.label }),
              cell(r.short ? `不足 ${r.short}` : `余り ${r.spare}`, r.short ? 'is-short' : null),
              cell(String(r.need)),
              cell(String(r.available)),
              cell(String(r.fillable)),
              cell(r.shortDays.length ? r.shortDays.map((x) => `${month}月${x}日`).join('・') : 'なし'),
              cell(r.cutDays ? `${r.cutDays}日` : 'なし', r.cutDays ? 'is-short' : null),
            ),
          ),
        ),
      ),
    ),
    rows.some((r) => r.cutDays)
      ? h('p', { class: 'help', testid: 'staffing-cut', text: '「休み・有給を削る日数」がある行は、希望・固定と予定どおりの休みのままでは埋めきれず、その日数ぶん休みを削らないと埋まりません。' })
      : null,
  ];
}

function monthTotalCard(d) {
  const t = monthTotals(d);
  const row = (label, x) => h('tr', {}, h('th', { scope: 'row', text: label }), h('td', { text: String(x.need) }), h('td', { text: x.available === null ? '―' : String(x.available) }));
  return [
    h('h3', { text: '月の合計の人手' }),
    h('p', { class: 'help', text: '必要な人日は、人数に数えるシフトの必要人数の月の合計です。出られる人日は、月に働ける日数（その月の日数 − 公休・有給の予定 − 決まっている休みなど）の合計です。区分を合わせて数えるシフトは、社員もパートも入れます。' }),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'staffing-table', testid: 'month-total' },
        h('thead', {}, h('tr', {}, ['', '必要な人日', '出られる人日'].map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', {}, row('社員', t.full), row('パート・アルバイト', t.part), t.combined.need ? row('区分を合わせて数えるシフト', t.combined) : null, row('合計', t.total)),
      ),
    ),
  ];
}

export function outlookCard(d) {
  if (!d.staff.length || !d.settings.shifts.length) return null;
  const { month } = d.month;
  const table = marginTable(d);
  const whoOf = (ids) => ids.map((id) => d.staff.find((p) => p.id === id)?.name || '名前なし').join('・');
  const zero = table.rows[0].days.filter((m) => m.margin <= 0);
  return h(
    'details',
    { class: 'card outlook', testid: 'outlook-details' },
    h('summary', { text: '詳しい機能：作る前の見込み' }),
    h('h3', { text: '日ごとの余裕（あと何人休めるか）' }),
    h('p', { class: 'help', text: 'その日に出られる人の数 − その日の必要人数 です（時間帯の行は、その時間帯のシフトに入れる人と必要人数。スキルの行は、そのスキルを持ち、その時間帯に入れる人と最低人数）。希望・固定の休み、夜勤の次の日の明けは「出られない」に数えます。0 の日は赤、1 の日は黄色、マイナスは濃い赤です。' }),
    table.el,
    zero.length
      ? h('ul', { class: 'zero-days', testid: 'zero-days' }, zero.map((m) => h('li', {
        text: m.margin < 0
          ? `${month}月${m.day}日：出られる人（${whoOf(m.people) || 'なし'}）が全員出勤しても、${-m.margin}人足りません。`
          : `${month}月${m.day}日：出られる人が全員出勤になります（${whoOf(m.people)}）。`,
      })))
      : h('p', { class: 'help', testid: 'zero-days-none', text: '休める人が0人の日はありません。' }),
    ...monthTotalCard(d),
    ...staffingCard(d),
  );
}
