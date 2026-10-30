// データをまるごと消す・置きかえる操作（リセット・月の片付け・取り込み・控えやひとつ前の保存から戻す）の
// 前に、控えを残す。どんな順で何回続けても、確認の文で「消える」と書いたもの以外は戻せるようにする。
import { loadBackups, addBackup, MAX_BACKUPS, BACKUP_REASONS } from './storage.js?v=2.2';
import { canonicalJSON } from './model.js?v=2.2';
import { isUntouchedSample, SAMPLE_KINDS } from './samples.js?v=2.2';
import { timeLabel, monthLabel } from './calendar.js?v=2.2';

// 控えを作るか。skip: 'untouched'（見本のまま）・'same'（同じ控えがある）・null（作る）
// drops: 作ると消えるいちばん古い控え
export function planBackup(data) {
  if (!data) return { skip: 'empty', drops: null };
  if (isUntouchedSample(data)) return { skip: 'untouched', drops: null };
  const text = canonicalJSON(data);
  const list = loadBackups();
  if (list.some((b) => canonicalJSON(b.data) === text)) return { skip: 'same', drops: null };
  return { skip: null, drops: list.length >= MAX_BACKUPS ? list[list.length - 1] : null };
}

// 控えを残す。残せたか、残さなくてよいときは true。ブラウザに書けなかったときは false
export function takeBackup(reason, data) {
  const plan = planBackup(data);
  if (plan.skip) return true;
  return addBackup(reason, data);
}

export function backupLabel(b) {
  return `${BACKUP_REASONS[b.reason] || '控え'}（${timeLabel(new Date(b.at))}）`;
}

export function backupSummary(b) {
  const kind = SAMPLE_KINDS.find((k) => k.id === b.data.sample);
  return [
    kind ? `${kind.name}の見本から` : null,
    monthLabel(b.data.month.year, b.data.month.month),
    `スタッフ${b.data.staff.length}人`,
    `シフト${b.data.settings.shifts.length}種類`,
  ].filter(Boolean).join('・');
}

// 確認の小窓に書く文（いまのデータがどうなるか）
export function backupLines(data) {
  const plan = planBackup(data);
  if (plan.skip === 'empty') return [];
  if (plan.skip === 'untouched') return ['いまのデータは、見本を選んだまま何も変えていないので、控えは作りません（同じ見本はいつでも選び直せます）。'];
  if (plan.skip === 'same') return ['いまのデータと同じ控えが、すでに「保存と控え」にあります。そこから戻せます。'];
  const lines = ['いまのデータは控えに残します。あとで「保存と控え」から戻せます。'];
  if (plan.drops) lines.push(`控えは${MAX_BACKUPS}つまでなので、いちばん古い控え「${backupLabel(plan.drops)}」は消えます。`);
  return lines;
}
