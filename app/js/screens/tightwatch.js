// その場の知らせ（5-1。説明書 5 節）：データを変えるたびに、変える前と後の「あと何人休めるか」を比べ、
// 新しく 0 人以下の日・きつい期間ができたら、画面の下に何を変えたからかを書いて知らせる。
// 変えて元に戻ったら（その日がもう 0 人でない・その期間がもう無い）知らせを消す。
import { watchCommits } from '../state.js?v=6.1';
import { notify } from '../dialog.js?v=6.1';
import { dayMargins, newTightness, tightRanges } from '../outlook.js?v=6.1';

const active = []; // [{ el, zeroDays, ranges }]

const marginsOf = (data) => (data?.staff && data?.month ? dayMargins(data) : null);

function stillHolds(n, after) {
  const now = tightRanges(after);
  return n.zeroDays.some((d) => after[d - 1]?.margin <= 0) || n.ranges.some((r) => now.some((x) => x.from <= r.from && r.to <= x.to));
}

function noticeText(data, n, after, why) {
  const m = data.month.month;
  const parts = [];
  for (const d of n.zeroDays) {
    const x = after[d - 1];
    parts.push(x.margin < 0 ? `${m}月${d}日は、出られる人が必要人数より${-x.margin}人少なくなります。` : `${m}月${d}日は、休める人が0人になります。`);
  }
  for (const r of n.ranges) parts.push(`${m}月${r.from}日〜${r.to}日は、あと1人以下の日が続きます。`);
  return `${parts.join('')}${why ? `（${why}）` : ''}`;
}

watchCommits({
  before: marginsOf,
  after: (before, data, { why, undo }) => {
    const after = marginsOf(data);
    for (let i = active.length - 1; i >= 0; i -= 1) {
      const a = active[i];
      if (!a.el.isConnected || !after || !stillHolds(a, after)) {
        a.el.remove();
        active.splice(i, 1);
      }
    }
    if (!before || !after) return;
    const n = newTightness(before, after);
    if (!n.zeroDays.length && !n.ranges.length) return;
    const el = notify(noticeText(data, n, after, why), {
      kind: 'warn',
      testid: 'tight-notice',
      actions: undo ? [{ label: 'この希望を取り消す', testid: 'tight-undo', onClick: undo }] : [],
    });
    active.push({ el, zeroDays: n.zeroDays, ranges: n.ranges });
  },
});
