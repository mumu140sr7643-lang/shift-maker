// 検査の結果を画面に出す部品：マスの印の索引・件数の帯・エラーの一覧。
import { h } from '../dom.js?v=6.2';
import { RULE_BY_ID } from '../rules.js?v=6.2';
import { monthDays } from '../model.js?v=6.2';

const LEVEL_NAMES = { six: '6連勤以上', hard: '絶対', soft: 'できれば' };

export function levelOf(item) {
  return item.rule === 'sixPlus' ? 'six' : item.strength === 'hard' ? 'hard' : 'soft';
}

// 印を付ける所ごとに、エラーをまとめる。
//   c|スタッフ|日 … シフト表のマス（人と日のあるもの。続きのものは、その月の日の全部）
//   n|スタッフ   … 名前の列（人ごとの決まり）
//   s|シフト|日  … 表の下の必要人数のマス（人数の決まり）
//   d|日         … 日の見出し（スキル・責任者・特別な日）
export function markIndex(data, result) {
  const nDays = monthDays(data);
  const map = new Map();
  const put = (key, item) => {
    let m = map.get(key);
    if (!m) {
      m = { six: false, hard: false, soft: false, texts: [] };
      map.set(key, m);
    }
    m[levelOf(item)] = true;
    m.texts.push(`【${LEVEL_NAMES[levelOf(item)]}】${RULE_BY_ID[item.rule].name}：${item.text}`);
  };
  for (const it of result.items) {
    if (it.staff && it.day != null) put(`c|${it.staff}|${it.day}`, it);
    else if (it.staff && it.from != null) {
      for (let d = Math.max(1, it.from); d <= Math.min(nDays, it.to); d += 1) put(`c|${it.staff}|${d}`, it);
    } else if (it.staff) put(`n|${it.staff}`, it);
    else if (it.shift && it.day != null) put(`s|${it.shift}|${it.day}`, it);
    else if (it.day != null) put(`d|${it.day}`, it);
  }
  return map;
}

// 印の見た目（形と色で3段階。重なっても、角の印は全部出す）
export function markClasses(m) {
  if (!m) return [];
  return [m.six ? 'm-six' : m.hard ? 'm-hard' : m.soft ? 'm-soft' : null].filter(Boolean);
}

export function markBadges(m) {
  if (!m) return null;
  const box = h('span', { class: 'mk-box', 'aria-hidden': 'true' });
  if (m.six) box.append(h('span', { class: 'mk mk-six' }));
  if (m.hard) box.append(h('span', { class: 'mk mk-hard' }));
  if (m.soft) box.append(h('span', { class: 'mk mk-soft' }));
  return box;
}

// 件数の帯。表がまだ空なら案内を出す
export function countBand(result, { onOpen } = {}) {
  if (result.tableEmpty) {
    return h(
      'div',
      { class: 'band band-empty', testid: 'count-band', dataset: { empty: 'true' } },
      h('p', { text: 'まだシフト表がありません。手順5 で作るか、手順6 でマスを入れてください。マスが1つでも入ると、決まりに合っているかをここに出します。' }),
    );
  }
  const t = result.totals;
  const cell = (key, label, value, unit, cls, testid, open = null) => {
    const inner = [h('span', { class: 'band-label', text: label }), h('span', { class: 'band-num', text: String(value) }), h('span', { class: 'band-unit', text: unit })];
    return open
      ? h('button', { type: 'button', class: `band-item ${cls}`, testid, dataset: { count: String(value) }, 'aria-expanded': 'false', on: { click: (e) => open(key, e.currentTarget) } }, inner)
      : h('div', { class: `band-item ${cls}`, testid, dataset: { count: String(value) } }, inner);
  };
  return h(
    'div',
    { class: 'band', testid: 'count-band', dataset: { empty: 'false' } },
    cell('six', '6連勤以上', t.sixPlus, '件', 'b-six', 'band-six'),
    cell('hard', '絶対', t.hard, '件', 'b-hard', 'band-hard'),
    cell('soft', 'できれば', t.soft, '件', 'b-soft', 'band-soft'),
    cell('spare', '余り日', t.spare, '日', 'b-spare', 'band-spare', onOpen),
    cell('short', '不足', t.shortSlots, 'コマ', 'b-short', 'band-short', onOpen),
  );
}

// エラーの一覧（6連勤以上・絶対・できれば）。onFocus(item) で、その所へ動く
export function errorList(result, { onFocus } = {}) {
  if (result.tableEmpty) return null;
  const groups = ['six', 'hard', 'soft'].map((lv) => ({ lv, items: result.items.filter((it) => levelOf(it) === lv) }));
  return h(
    'div',
    { class: 'error-list', testid: 'error-list' },
    groups.map(({ lv, items }) =>
      h(
        'details',
        { class: `error-group eg-${lv}`, open: items.length > 0 && items.length <= 40, testid: `error-group-${lv}`, dataset: { count: String(items.length) } },
        h('summary', {}, h('span', { class: `mk mk-${lv}`, 'aria-hidden': 'true' }), ` ${LEVEL_NAMES[lv]}（${items.length}件）`),
        items.length
          ? h(
              'ul',
              {},
              items.map((it) =>
                h(
                  'li',
                  {},
                  h(
                    'button',
                    { type: 'button', class: 'error-item', testid: 'error-item', dataset: { rule: it.rule }, on: { click: () => onFocus?.(it) } },
                    h('span', { class: 'error-rule', text: RULE_BY_ID[it.rule].name }),
                    h('span', { text: it.text }),
                  ),
                ),
              ),
            )
          : h('p', { class: 'help', text: 'ありません。' }),
      ),
    ),
  );
}

// 前と比べて増えた決まり（「悪くなりました」の知らせに使う）
export function worsened(before, after) {
  if (!before || before.tableEmpty || after.tableEmpty) return [];
  const out = [];
  for (const [id, b] of Object.entries(before.byRule)) {
    const a = after.byRule[id];
    if (a.strength !== 'off' && a.count > b.count) out.push(`${RULE_BY_ID[id].name} ${b.count}→${a.count}件`);
  }
  return out;
}
