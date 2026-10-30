// 小窓（確かめ・選ぶ）と、画面の上の知らせ。
import { h, append, clear } from './dom.js?v=3.2';

// buttons: [{ label, value, kind: 'primary' | 'danger' | 'plain', testid }]
// 選んだボタンの value を返す。Esc で閉じたら 'cancel'
export function ask({ title, lines = [], buttons, testid = 'dialog', body = null }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'dialog', testid, 'aria-labelledby': 'dlg-title' });
    const done = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    append(dlg,
      h('h2', { id: 'dlg-title', text: title }),
      ...lines.map((t) => h('p', { text: t })),
      body,
      h(
        'div',
        { class: 'dialog-buttons' },
        buttons.map((b) =>
          h('button', {
            type: 'button',
            class: `btn btn-${b.kind || 'plain'}`,
            text: b.label,
            testid: b.testid,
            on: { click: () => done(b.value) },
          }),
        ),
      ),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done('cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

// 入力つきの小窓。check(values) が理由の文を返したら閉じずに小窓の中に出す。
// 決めたら values を、やめたら null を返す。
export function form({ title, intro = null, fields, okLabel, check, testid = 'form-dialog' }) {
  return new Promise((resolve) => {
    const err = h('p', { class: 'dialog-error', role: 'alert', testid: `${testid}-error` });
    const dlg = h('dialog', { class: 'dialog', testid, 'aria-labelledby': 'form-title' });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const formEl = h(
      'form',
      { method: 'dialog' },
      h('h2', { id: 'form-title', text: title }),
      intro ? h('p', { text: intro }) : null,
      fields.map((f) => f.el),
      err,
      h(
        'div',
        { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'btn btn-plain', text: 'やめる', testid: `${testid}-cancel`, on: { click: () => close(null) } }),
        h('button', { type: 'submit', class: 'btn btn-primary', text: okLabel, testid: `${testid}-ok` }),
      ),
    );
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.key, f.read()]));
      const problem = check(values);
      if (problem) {
        clear(err);
        err.append(problem);
        return;
      }
      close(values);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    append(dlg, formEl);
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

// 画面の上の知らせ。actions: [{ label, onClick, testid }]。
// kind: 'info' | 'ok' | 'warn' | 'error'
export function notify(text, { kind = 'info', actions = [], testid = 'notice' } = {}) {
  const box = document.getElementById('notices');
  const item = h(
    'div',
    { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status', testid },
    h('p', { text }),
    h(
      'div',
      { class: 'notice-actions' },
      actions.map((a) =>
        h('button', {
          type: 'button',
          class: 'btn btn-small',
          text: a.label,
          testid: a.testid,
          on: {
            click: () => {
              item.remove();
              a.onClick();
            },
          },
        }),
      ),
      h('button', { type: 'button', class: 'btn btn-small btn-plain', text: '閉じる', testid: `${testid}-close`, on: { click: () => item.remove() } }),
    ),
  );
  box.prepend(item);
  return item;
}

export function clearNotices() {
  clear(document.getElementById('notices'));
}
