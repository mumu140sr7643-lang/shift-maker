// CSV に出す（4-3）。画面には触らない。node からも使う。
// Excel で開いても文字化けしないよう、先頭に BOM を付けた UTF-8・行の終わりは CRLF。
// 式として読まれないよう、= + - @ タブ 改行（CR）で始まる文字の前に ' を付ける。カンマ・改行・" を含む文字は " で囲み、" は "" にする。
import { monthDays, cellOf, cellSymbol } from './model.js?v=5.2';
import { weekdayOf, WEEKDAY_LABELS } from './calendar.js?v=5.2';
import { summarize, summaryColumns } from './summary.js?v=5.2';

const BOM = String.fromCharCode(0xfeff);
const RISKY_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s = String(value);
  if (RISKY_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows) {
  return `${BOM}${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// シフト表の CSV：行がスタッフ、列が日（マスの記号）。右に集計表の列、いちばん下に合計の行
export function shiftTableRows(data) {
  const N = monthDays(data);
  const { year, month } = data.month;
  const cols = summaryColumns(data);
  const sum = summarize(data);
  const days = Array.from({ length: N }, (_, i) => i + 1);
  const head = ['スタッフ', ...days.map((d) => `${month}/${d}（${WEEKDAY_LABELS[weekdayOf(year, month, d)]}）`), ...cols.map((c) => c.label)];
  const body = data.staff.map((p, i) => [
    p.name || '名前なし',
    ...days.map((d) => cellSymbol(data, cellOf(data, p.id, d))),
    ...cols.map((c) => c.value(sum.rows[i])),
  ]);
  const total = ['合計', ...days.map(() => ''), ...cols.map((c) => c.value(sum.totals))];
  return [head, ...body, total];
}

export function shiftTableCsv(data) {
  return toCsv(shiftTableRows(data));
}
