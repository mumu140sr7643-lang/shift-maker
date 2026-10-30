// 画面どうしで使う小さな部品。
import { h } from '../dom.js?v=1.1';
import { notify } from '../dialog.js?v=1.1';

export function warn(text) {
  notify(text, { kind: 'warn', testid: 'warn-notice' });
}

export function screenTitle(text, lead = null) {
  return [
    h('h1', { class: 'screen-title', testid: 'screen-title', text }),
    lead ? h('p', { class: 'lead', text: lead }) : null,
  ];
}

export function section(title, help, ...children) {
  return h(
    'section',
    { class: 'card' },
    h('h2', { text: title }),
    help ? h('p', { class: 'help', text: help }) : null,
    ...children,
  );
}

export function checkbox(label, checked, onChange, props = {}) {
  const input = h('input', { type: 'checkbox', checked, ...props, on: { change: (e) => onChange(e.target.checked) } });
  return h('label', { class: 'check' }, input, h('span', { text: label }));
}

// 文字の入力欄。空にできないときは、空にしたら前の文字に戻して知らせる
export function textInput(value, { onChange, required = null, maxlength = 40, ...props }) {
  const input = h('input', { type: 'text', value, maxlength, autocomplete: 'off', ...props });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (!v && required) {
      warn(required);
      input.value = value;
      return;
    }
    value = v;
    input.value = v;
    onChange(v);
  });
  return input;
}
