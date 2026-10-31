// ファイルに書き出す。
import { canonicalJSON } from './model.js?v=6.3';
import { shiftTableCsv } from './csv.js?v=6.3';

export function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function downloadText(filename, text, type = 'application/json') {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// いまのデータを、このアプリで取り込める形（JSON）で書き出す
export function exportData(data) {
  const { year, month } = data.month;
  const name = `shift-maker_${year}-${String(month).padStart(2, '0')}_${stamp(new Date())}.json`;
  downloadText(name, canonicalJSON(data));
  return name;
}

export function exportRaw(text) {
  downloadText(`shift-maker_読めなかったデータ_${stamp(new Date())}.txt`, text, 'text/plain');
}

// シフト表と集計表を CSV で書き出す（4-3）
export function exportCsv(data) {
  const { year, month } = data.month;
  const name = `シフト表_${year}年${month}月_${stamp(new Date())}.csv`;
  downloadText(name, shiftTableCsv(data), 'text/csv');
  return name;
}

// シフト表・集計表・件数を Excel で書き出す（4-3。ExcelJS は押したときだけ読み込む）
export async function exportExcel(data) {
  const { buildWorkbook } = await import('./xlsx.js?v=6.3');
  const { year, month } = data.month;
  const name = `シフト表_${year}年${month}月_${stamp(new Date())}.xlsx`;
  downloadBlob(name, await buildWorkbook(data));
  return name;
}
