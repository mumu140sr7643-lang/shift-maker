// 画面の部品を作る小さな関数。
// 名前や記号などの文字は、必ず「文字」として入れる（HTML としては入れない。HTML を組み立てて入れる書き方も使わない）。

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'testid') el.dataset.testid = value;
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (key === 'selected') el.selected = Boolean(value);
    else if (key === 'disabled') el.disabled = Boolean(value);
    else if (key === 'style') el.style.cssText = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

// null・undefined・false は飛ばして足す（Element.append は null を「null」という文字にしてしまうため）
export function append(el, ...children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, ...c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let uid = 0;
export function nextUid(prefix = 'f') {
  uid += 1;
  return `${prefix}-${uid}`;
}

// ラベル付きの入力欄（説明の文があれば下に出す）
export function field(label, input, help = null, testid = null) {
  if (!input.id) input.id = nextUid();
  return h(
    'div',
    { class: 'field', testid },
    h('label', { for: input.id, text: label }),
    input,
    help ? h('p', { class: 'help', text: help }) : null,
  );
}

export function select(options, value, props = {}) {
  return h(
    'select',
    props,
    options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === value })),
  );
}

// 数の入力欄。範囲外・数でないときは onBad(理由) を呼び、前の数に戻す
export function numberInput(value, { min, max, step = 1, allowBlank = false, onChange, onBad, ...props }) {
  const input = h('input', { type: 'number', inputmode: 'decimal', min, max, step, value: value ?? '', ...props });
  input.addEventListener('wheel', (e) => {
    if (document.activeElement === input) e.preventDefault();
  }, { passive: false });
  input.addEventListener('change', () => {
    const raw = input.value.trim();
    if (raw === '' && allowBlank) {
      onChange(null);
      return;
    }
    const n = Number(raw);
    const stepOk = Math.abs(n / step - Math.round(n / step)) < 1e-9;
    if (raw === '' || !Number.isFinite(n) || n < min || n > max || !stepOk) {
      const unit = step === 1 ? '' : `（${step}きざみ）`;
      onBad?.(`${min}〜${max}の数を入れてください${unit}。`);
      input.value = value ?? '';
      return;
    }
    value = n;
    onChange(n);
  });
  return input;
}
