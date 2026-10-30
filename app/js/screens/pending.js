// まだ作っていない手順の画面。
import { h, append } from '../dom.js?v=1.3.2';
import { screenTitle } from './common.js?v=1.3.2';

export function renderPending(el, title, when) {
  append(el,
    ...screenTitle(title),
    h(
      'div',
      { class: 'empty', testid: 'pending-message' },
      h('p', { text: when === 'next' ? '準備中です。次の版で使えるようになります。' : '準備中です。このあとの版で使えるようになります。' }),
      h('p', { class: 'help', text: 'いまは、手順1〜4で設定・スタッフ・希望を入れて、手順6 シフト表で手で作れます。入れたものは自動で保存されます。' }),
    ),
  );
}
