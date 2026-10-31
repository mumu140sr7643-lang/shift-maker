// 手順5 の「詳しい機能」（v5。docs/見込みと説明の案.md）：作る前の見込み。
// 5-1：日ごとの余裕（全体・時間帯・スキルごと）と、休める人が0人の日に出勤になる人。
import { h } from '../dom.js?v=5.1';
import { monthDays } from '../model.js?v=5.1';
import { weekdayOf, WEEKDAY_LABELS } from '../calendar.js?v=5.1';
import { GROUPS, countedShift, groupOf, dayMargins, skillMargins } from '../outlook.js?v=5.1';

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
  );
}
