// ファイルに書き出す。
import { canonicalJSON } from './model.js?v=1.3.1';

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
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
