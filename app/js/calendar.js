// 日付まわりの小さな関数。画面には触らない（node からも使う）。

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 0 = 日曜 … 6 = 土曜
export function weekdayOf(year, month, day) {
  return new Date(year, month - 1, day).getDay();
}

export function monthLabel(year, month) {
  return `${year}年${month}月`;
}

export function nextMonthOf(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
}

export function isNextMonth(from, to) {
  const n = from.month === 12 ? { year: from.year + 1, month: 1 } : { year: from.year, month: from.month + 1 };
  return n.year === to.year && n.month === to.month;
}

export function timeLabel(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${p(date.getHours())}:${p(date.getMinutes())}`;
}
