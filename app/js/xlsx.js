// Excel に出す（4-3）。ExcelJS（vendor/exceljs、MIT）を、「Excel に出す」を押したときだけ読み込む（最初の画面を軽くするため）。
// シート：シフト表（マスの記号と、シフトの「Excel に出すときの色」）・集計表・件数（件数とエラーの一覧）。
// 文字は文字として入れる（式にはしない）ので、= などで始まる名前も式として読まれない。
import { monthDays, cellOf, cellSymbol, shiftById, REST_KINDS } from './model.js?v=5.3';
import { weekdayOf, WEEKDAY_LABELS } from './calendar.js?v=5.3';
import { checkTable } from './check.js?v=5.3';
import { RULE_BY_ID } from './rules.js?v=5.3';
import { summarize, summaryColumns } from './summary.js?v=5.3';

const EXCELJS_URL = new URL('../../vendor/exceljs/exceljs.bare.min.js?v=5.3', import.meta.url).href;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 休みなどの色（画面の明るい表示と同じ）
const REST_COLORS = { off: '#ECEEF1', paid: '#DFF1E3', half: '#EAF4DC', ake: '#E4E4E4', spare: '#D9F1EE' };
const LEVEL_NAMES = { six: '6連勤以上', hard: '絶対', soft: 'できれば' };

let loading = null;
export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS が見つかりません')));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('ExcelJS を読み込めませんでした'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;
const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function cellColor(data, v) {
  if (!v) return null;
  if (v.kind === 'shift') return shiftById(data, v.shift)?.color ?? null;
  return REST_COLORS[v.kind] ?? null;
}

function shiftSheet(wb, data) {
  const ws = wb.addWorksheet('シフト表', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });
  const N = monthDays(data);
  const { year, month } = data.month;
  ws.getCell(1, 1).value = `${year}年${month}月 シフト表`;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = 'スタッフ';
  ws.getCell(3, 1).value = '';
  for (let d = 1; d <= N; d += 1) {
    const wd = weekdayOf(year, month, d);
    const top = ws.getCell(2, d + 1);
    const bottom = ws.getCell(3, d + 1);
    top.value = d;
    bottom.value = WEEKDAY_LABELS[wd];
    for (const c of [top, bottom]) {
      c.alignment = { horizontal: 'center' };
      c.border = BORDER;
      if (wd === 0) c.font = { color: { argb: 'FFB42318' } };
      if (wd === 6) c.font = { color: { argb: 'FF1D5BB8' } };
    }
  }
  data.staff.forEach((p, i) => {
    const row = 4 + i;
    const name = ws.getCell(row, 1);
    name.value = p.name || '名前なし';
    name.border = BORDER;
    for (let d = 1; d <= N; d += 1) {
      const v = cellOf(data, p.id, d);
      const c = ws.getCell(row, d + 1);
      c.value = cellSymbol(data, v);
      c.alignment = { horizontal: 'center' };
      c.border = BORDER;
      const color = cellColor(data, v);
      if (color) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(color) } };
      if (v?.kind === 'shift' && shiftById(data, v.shift)?.onePerDay) c.font = { bold: true };
    }
  });
  const legendRow = 5 + data.staff.length;
  ws.getCell(legendRow, 1).value = '記号';
  ws.getCell(legendRow, 2).value = [
    ...data.settings.shifts.map((s) => `${s.symbol}＝${s.name || s.symbol}`),
    ...REST_KINDS.map((r) => `${r.symbol}＝${r.label}`),
  ].join('　');
  ws.getColumn(1).width = 12;
  for (let d = 1; d <= N; d += 1) ws.getColumn(d + 1).width = 5;
}

function summarySheet(wb, data) {
  const ws = wb.addWorksheet('集計表', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  const cols = summaryColumns(data);
  const sum = summarize(data);
  const head = ws.addRow(['スタッフ', ...cols.map((c) => c.label)]);
  head.font = { bold: true };
  sum.rows.forEach((r) => ws.addRow([r.name || '名前なし', ...cols.map((c) => c.value(r))]));
  const total = ws.addRow(['合計', ...cols.map((c) => c.value(sum.totals))]);
  total.font = { bold: true };
  ws.addRow([]);
  ws.addRow(['数え方：半休は出勤1日・有給0.5日・労働時間は半休の日の時間。明けは出勤日数と労働時間に入れない。研修のシフトは出勤に数える。空きのマスは数えない。']);
  ws.getColumn(1).width = 12;
  cols.forEach((_, i) => { ws.getColumn(i + 2).width = 14; });
}

function countSheet(wb, data) {
  const ws = wb.addWorksheet('件数');
  const res = checkTable(data);
  if (res.tableEmpty) {
    ws.addRow(['まだシフト表がありません。']);
    return;
  }
  const t = res.totals;
  ws.addRow(['6連勤以上（件）', t.sixPlus]);
  ws.addRow(['絶対（件）', t.hard]);
  ws.addRow(['できれば（件）', t.soft]);
  ws.addRow(['余り日（日）', t.spare]);
  ws.addRow(['不足（コマ）', t.shortSlots]);
  ws.addRow([]);
  const head = ws.addRow(['重さ', '決まり', '内容']);
  head.font = { bold: true };
  const level = (it) => (it.rule === 'sixPlus' ? 'six' : it.strength === 'hard' ? 'hard' : 'soft');
  for (const lv of ['six', 'hard', 'soft']) {
    for (const it of res.items.filter((x) => level(x) === lv)) ws.addRow([LEVEL_NAMES[lv], RULE_BY_ID[it.rule]?.name ?? it.rule, it.text]);
  }
  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 28;
  ws.getColumn(3).width = 80;
}

// Excel のファイル（中身）を作る。返す：Blob
export async function buildWorkbook(data) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'シフト表メーカー';
  shiftSheet(wb, data);
  summarySheet(wb, data);
  countSheet(wb, data);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_TYPE });
}
