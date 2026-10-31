// 手順1 基本設定
import { h, append, field, select, numberInput } from '../dom.js?v=5.2';
import { app, commit, rerender } from '../state.js?v=5.2';
import { clearHistory } from '../history.js?v=5.2';
import {
  GROUP_IDS, LIMITS, newRank, newSkill, newSpecialDay, staffWithRank, removeRank, removeSkill,
  monthHasContent, switchMonth, monthDays, shiftById,
} from '../model.js?v=5.2';
import { monthLabel, weekdayOf, WEEKDAY_LABELS, isNextMonth } from '../calendar.js?v=5.2';
import { ask, notify } from '../dialog.js?v=5.2';
import { takeBackup, backupLines } from '../backup.js?v=5.2';
import { exportData } from '../files.js?v=5.2';
import { screenTitle, section, checkbox, textInput, warn } from './common.js?v=5.2';
import { RULES, RULE_GROUPS, strengthOf, setStrength } from '../rules.js?v=5.2';

function monthValue(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

async function changeMonth(input) {
  const d = app.data;
  const [y, m] = input.value.split('-').map(Number);
  if (!y || !m) {
    input.value = monthValue(d.month.year, d.month.month);
    return;
  }
  if (y === d.month.year && m === d.month.month) return;
  const from = monthLabel(d.month.year, d.month.month);
  const to = monthLabel(y, m);
  if (monthHasContent(d)) {
    const lines = [
      `${from}の、日付のついたデータ（特別な日・日ごとの必要人数・希望・シフト表など）を片付けてから、${to}に切り替えます。スタッフと設定は残ります。`,
      ...backupLines(d),
    ];
    if (isNextMonth(d.month, { year: y, month: m })) {
      lines.push('前の月の終わりの連勤日数と最後のシフトは、手順3 スタッフで1人ずつ入れてください（自動で引き継ぐしくみは、あとの版で入ります）。');
    }
    const v = await ask({
      title: `${to}に切り替えますか？`,
      lines,
      buttons: [
        { label: 'やめる', value: 'cancel', testid: 'month-cancel' },
        { label: '先に書き出してから片付ける', value: 'export', testid: 'month-export-clear' },
        { label: '片付けて切り替える', value: 'clear', kind: 'danger', testid: 'month-clear' },
      ],
      testid: 'month-dialog',
    });
    if (v !== 'export' && v !== 'clear') {
      input.value = monthValue(d.month.year, d.month.month);
      return;
    }
    if (v === 'export') exportData(d);
    if (!takeBackup('month', d)) {
      notify('ブラウザに控えを保存できなかったので、月の切り替えをやめました。先に「保存と控え」からファイルに書き出してください。', { kind: 'error', testid: 'error-notice' });
      input.value = monthValue(d.month.year, d.month.month);
      return;
    }
  }
  commit((data) => switchMonth(data, y, m));
  clearHistory();
  rerender();
  notify(`${to}に切り替えました。`, { kind: 'ok', testid: 'month-notice' });
}

function workSection() {
  const w = app.data.settings.work;
  const num = (key, label, limits, help, testid, step = 1) =>
    field(
      label,
      numberInput(w[key], {
        min: limits[0],
        max: limits[1],
        step,
        testid,
        onBad: warn,
        onChange: (n) => commit((d) => { d.settings.work[key] = n; }),
      }),
      help,
    );
  const flag = (key, label, help, testid) =>
    h(
      'div',
      { class: 'field' },
      checkbox(label, w[key], (v) => commit((d) => { d.settings.work[key] = v; }, { render: true }), { testid }),
      help ? h('p', { class: 'help', text: help }) : null,
    );
  return section(
    '勤務の決まり',
    'シフト表のエラーを数えるときの決まりです。スタッフごとに変えたいときは、手順3 スタッフで決められます。',
    h(
      'div',
      { class: 'grid-fields' },
      num('maxConsecutive', '連勤の上限（日）', LIMITS.consecutive, 'これより長く続けて出勤すると「連勤超過」になります。', 'work-max-consecutive'),
      num('restRun', '連休の目安（日）', LIMITS.restRun, '続けて休むときに、何日続くのがよいかの目安です。目安より3日以上長い連休は「連休が長すぎる」になります。目安以上の連休が月に1回もない（「連休にしたい」人は2回）と「連休の回数が足りない」になります。', 'work-rest-run'),
      num('maxSwitches', '時間帯の切り替え回数の上限（回／月）', LIMITS.switches, '早い時間帯と遅い時間帯が入れかわる回数の上限です。', 'work-max-switches'),
      num('biasAllowance', '早い・遅いの偏りを許す日数（日）', LIMITS.bias, '「均等」の人で、早い時間帯と遅い時間帯の日数の差がこれより大きいと知らせます。', 'work-bias'),
      num('halfDayHours', '半休の日の労働時間（時間）', LIMITS.hours, '集計表の労働時間に使います。', 'work-half-hours', 0.5),
    ),
    flag('forbidLateToEarly', '遅い時間帯の次の日に、早い時間帯を入れない', '休む間が短くなるのを防ぎます。', 'work-forbid-late-early'),
    flag('avoidSingleOff', '1日だけの休みを、なるべく避ける', '休みをなるべく2日以上続けます。', 'work-avoid-single-off'),
  );
}

function rankSection() {
  const ranks = app.data.settings.ranks;
  const move = (i, dir) =>
    commit((d) => {
      const list = d.settings.ranks;
      [list[i], list[i + dir]] = [list[i + dir], list[i]];
    }, { render: true });
  const del = async (r) => {
    const users = staffWithRank(app.data, r.id);
    if (users.length) {
      warn(`「${r.name}」の人がいるので消せません（${users.map((p) => p.name || '名前なし').join('、')}）。手順3 スタッフで役職を変えてから消してください。`);
      return;
    }
    if (ranks.length === 1) {
      warn('役職は1つ以上必要です。');
      return;
    }
    const v = await ask({
      title: `役職「${r.name}」を消しますか？`,
      lines: ['特別な日にこの役職の条件があれば、その条件も消えます。'],
      buttons: [
        { label: 'やめる', value: 'cancel' },
        { label: '消す', value: 'ok', kind: 'danger', testid: 'rank-delete-ok' },
      ],
    });
    if (v === 'ok') commit((d) => removeRank(d, r.id), { render: true });
  };
  return section(
    '役職（上ほど順位が上）',
    '順位は、その時間帯の責任者をだれにするかを決めるときに使います。名前も数も自由です。',
    h(
      'ol',
      { class: 'rank-list', testid: 'rank-list' },
      ranks.map((r, i) =>
        h(
          'li',
          { class: 'row' },
          textInput(r.name, {
            'aria-label': `${i + 1}番目の役職の名前`,
            testid: 'rank-name',
            required: '役職の名前が空です。名前を入れてください。',
            onChange: (v) => commit((d) => { d.settings.ranks[i].name = v; }),
          }),
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `「${r.name}」を1つ上へ`, disabled: i === 0, text: '↑', on: { click: () => move(i, -1) } }),
          h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `「${r.name}」を1つ下へ`, disabled: i === ranks.length - 1, text: '↓', on: { click: () => move(i, 1) } }),
          h('button', { type: 'button', class: 'btn btn-small btn-plain', text: '消す', testid: 'rank-delete', on: { click: () => del(r) } }),
        ),
      ),
    ),
    h('button', {
      type: 'button',
      class: 'btn',
      testid: 'rank-add',
      text: '役職を足す',
      on: { click: () => commit((d) => { d.settings.ranks.push(newRank(d, '新しい役職')); }, { render: true }) },
    }),
  );
}

function skillSection() {
  const d0 = app.data;
  const del = async (k) => {
    const n = d0.staff.filter((p) => p.skills.includes(k.id)).length;
    const v = await ask({
      title: `スキル「${k.name}」を消しますか？`,
      lines: [n ? `このスキルを持っている人（${n}人）からも外れます。` : 'このスキルを持っている人はいません。'],
      buttons: [
        { label: 'やめる', value: 'cancel' },
        { label: '消す', value: 'ok', kind: 'danger', testid: 'skill-delete-ok' },
      ],
    });
    if (v === 'ok') commit((d) => removeSkill(d, k.id), { render: true });
  };
  const groupNames = d0.settings.groupNames;
  return section(
    'スキル',
    '「レジ」「調理」「資格あり」など、スタッフが持つ力です。時間帯のグループごとに、そのスキルを持つ人が何人いればよいかを決めます。「最低」より少ないと「スキル不足」、「目標」より少ないと「スキルの目標に届かない」になります。',
    d0.settings.skills.length
      ? h(
          'div',
          { class: 'skill-list', testid: 'skill-list' },
          d0.settings.skills.map((k, i) =>
            h(
              'div',
              { class: 'skill-card' },
              h(
                'div',
                { class: 'row' },
                field('名前', textInput(k.name, {
                  testid: 'skill-name',
                  required: 'スキルの名前が空です。名前を入れてください。',
                  onChange: (v) => commit((d) => { d.settings.skills[i].name = v; }),
                })),
                h('button', { type: 'button', class: 'btn btn-small btn-plain', text: '消す', testid: 'skill-delete', on: { click: () => del(k) } }),
              ),
              h(
                'table',
                { class: 'mini-table' },
                h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: '人数' }), GROUP_IDS.map((g) => h('th', { scope: 'col', text: groupNames[g] })))),
                h(
                  'tbody',
                  {},
                  [['min', '最低'], ['target', '目標']].map(([key, label]) =>
                    h(
                      'tr',
                      {},
                      h('th', { scope: 'row', text: label }),
                      GROUP_IDS.map((g) =>
                        h(
                          'td',
                          {},
                          numberInput(k[key][g], {
                            min: 0,
                            max: 99,
                            'aria-label': `${k.name}の${groupNames[g]}の${label}人数`,
                            testid: `skill-${key}-${g}`,
                            onBad: warn,
                            onChange: (n) => commit((d) => { d.settings.skills[i][key][g] = n; }),
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty', text: 'まだスキルがありません。「スキルを足す」で足せます。スキルを使わないなら、空のままでかまいません。' }),
    h('button', {
      type: 'button',
      class: 'btn',
      testid: 'skill-add',
      text: 'スキルを足す',
      on: { click: () => commit((d) => { d.settings.skills.push(newSkill(d, { name: '新しいスキル' })); }, { render: true }) },
    }),
  );
}

function employmentSection() {
  const names = app.data.settings.employmentNames;
  const one = (emp, label) =>
    field(label, textInput(names[emp], {
      testid: `emp-name-${emp}`,
      required: '区分の名前が空です。名前を入れてください。',
      onChange: (v) => commit((d) => { d.settings.employmentNames[emp] = v; }),
    }));
  return section(
    '雇用の区分',
    '必要人数を、区分ごとに分けて決められます（手順2）。画面に出す名前だけ変えられます。',
    h('div', { class: 'grid-fields' }, one('full', '1つ目の区分'), one('part', '2つ目の区分')),
  );
}

function specialSection() {
  const d0 = app.data;
  const { year, month } = d0.month;
  const nDays = monthDays(d0);
  const dayOptions = Array.from({ length: nDays }, (_, i) => ({
    value: String(i + 1),
    label: `${i + 1}日（${WEEKDAY_LABELS[weekdayOf(year, month, i + 1)]}）`,
  }));
  const rankOptions = d0.settings.ranks.map((r) => ({ value: r.id, label: r.name }));
  return section(
    `特別な日（${monthLabel(year, month)}）`,
    'イベントの日・忙しい日など、役職の人を多めに入れたい日です。「◯◯以上の人を◯人」は、その役職か、それより順位が上の人を数えます。',
    d0.month.special.length
      ? h(
          'div',
          { class: 'special-list', testid: 'special-list' },
          d0.month.special.map((sd, i) =>
            h(
              'div',
              { class: 'skill-card' },
              h(
                'div',
                { class: 'row' },
                field('日', select(dayOptions, String(sd.day), {
                  testid: 'special-day',
                  on: { change: (e) => commit((d) => { d.month.special[i].day = Number(e.target.value); }) },
                })),
                field('名前', textInput(sd.name, {
                  testid: 'special-name',
                  required: '特別な日の名前が空です。名前を入れてください（例：セール日）。',
                  onChange: (v) => commit((d) => { d.month.special[i].name = v; }),
                })),
                h('button', {
                  type: 'button',
                  class: 'btn btn-small btn-plain',
                  text: '消す',
                  testid: 'special-delete',
                  on: { click: () => commit((d) => { d.month.special.splice(i, 1); }, { render: true }) },
                }),
              ),
              sd.rankNeeds.map((rn, j) =>
                h(
                  'div',
                  { class: 'row' },
                  select(rankOptions, rn.rank, {
                    'aria-label': '役職',
                    testid: 'special-rank',
                    on: { change: (e) => commit((d) => { d.month.special[i].rankNeeds[j].rank = e.target.value; }) },
                  }),
                  h('span', { text: '以上の人を' }),
                  numberInput(rn.count, {
                    min: 0,
                    max: 99,
                    'aria-label': '人数',
                    class: 'num-short',
                    testid: 'special-count',
                    onBad: warn,
                    onChange: (n) => commit((d) => { d.month.special[i].rankNeeds[j].count = n; }),
                  }),
                  h('span', { text: '人' }),
                  h('button', {
                    type: 'button',
                    class: 'btn btn-small btn-plain',
                    text: '条件を消す',
                    on: { click: () => commit((d) => { d.month.special[i].rankNeeds.splice(j, 1); }, { render: true }) },
                  }),
                ),
              ),
              rankOptions.length
                ? h('button', {
                    type: 'button',
                    class: 'btn btn-small',
                    text: '役職の条件を足す',
                    testid: 'special-rank-add',
                    on: { click: () => commit((d) => { d.month.special[i].rankNeeds.push({ rank: d.settings.ranks[0].id, count: 1 }); }, { render: true }) },
                  })
                : null,
            ),
          ),
        )
      : h('p', { class: 'empty', text: 'この月の特別な日はまだありません。' }),
    h('button', {
      type: 'button',
      class: 'btn',
      testid: 'special-add',
      text: '特別な日を足す',
      on: { click: () => commit((d) => { d.month.special.push(newSpecialDay(d, { day: 1, name: '特別な日' })); }, { render: true }) },
    }),
  );
}

function ruleSentence(d, r) {
  const s = shiftById(d, r.shift);
  const when = r.when.weekdays
    ? r.when.weekdays.map((w) => WEEKDAY_LABELS[w]).join('・') + '曜日'
    : r.when.monthDays
      ? '毎月' + r.when.monthDays.join('・') + '日'
      : '特別な日';
  const emp = r.emp === 'all' ? '' : `（${d.settings.employmentNames[r.emp]}）`;
  const how = r.op === 'add' ? `${r.value}人増やす` : `${r.value}人にする`;
  return `${when}は、「${s ? s.symbol : '?'}」${emp}を${how}`;
}

// 決まりごとの強さ。開いたままにする（強さを変えると画面を作り直すため）
let detailOpen = false;

function strengthRows(d0) {
  const options = [
    { value: 'hard', label: '絶対' },
    { value: 'soft', label: 'できれば' },
    { value: 'off', label: 'なし（数えない）' },
  ];
  return RULE_GROUPS.map((g) =>
    h(
      'div',
      { class: 'strength-group' },
      h('h4', { text: g.name }),
      RULES.filter((r) => r.group === g.id).map((r) =>
        h(
          'div',
          { class: 'strength-row', testid: 'strength-row', dataset: { rule: r.id } },
          h('div', { class: 'strength-name' }, h('span', { class: 'strength-title', text: r.name }), h('span', { class: 'help', text: r.help })),
          r.fixed
            ? h('span', { class: 'strength-fixed', testid: `strength-${r.id}`, text: `${r.strength === 'always' ? 'いつも数える' : '絶対'}（${r.why}、変えられません）` })
            : select(options, strengthOf(d0, r.id), {
                'aria-label': `「${r.name}」の強さ`,
                testid: `strength-${r.id}`,
                on: { change: (e) => commit((d) => setStrength(d, r.id, e.target.value), { render: true }) },
              }),
        ),
      ),
    ),
  );
}

function detailSection() {
  const d0 = app.data;
  const box = h(
    'details',
    { class: 'card', testid: 'step1-details', open: detailOpen },
    h('summary', { text: '詳しい設定（ふだんは使わなくてかまいません）' }),
    h('h3', { text: '決まりごとの強さ' }),
    h('p', { class: 'help', text: '「絶対」は必ず守る決まり、「できれば」はなるべく守る決まりです。「なし」にした決まりは数えません。手順6の件数の帯と、自動で作るとき（あとの版）に使います。上の「勤務の決まり」のチェックを外すのと、強さを「なし」にするのは同じです。' }),
    h('div', { class: 'strength-list', testid: 'strength-list' }, strengthRows(d0)),
    h('h3', { text: '必要人数の決まり' }),
    d0.settings.needRules.length
      ? h('ul', { testid: 'need-rule-list' }, d0.settings.needRules.map((r) => h('li', { text: `${r.label}：${ruleSentence(d0, r)}` })))
      : h('p', { class: 'help', text: 'いまは決まりがありません。' }),
    h('p', { class: 'help', text: '決まりを足す・変える画面は準備中です。あとの版で使えるようになります。いまは、見本に入っている決まりが使われます（手順2の「日ごとの必要人数」で、点線の下線が付いた日）。' }),
  );
  box.addEventListener('toggle', () => { detailOpen = box.open; });
  return box;
}

export function renderStep1(el) {
  const d = app.data;
  const current = monthValue(d.month.year, d.month.month);
  const monthInput = h('input', { type: 'month', value: current, testid: 'target-month', min: '2000-01', max: '2100-12', required: true });
  const apply = h('button', { type: 'button', class: 'btn', testid: 'target-month-apply', text: 'この月にする', disabled: true });
  monthInput.addEventListener('input', () => { apply.disabled = !monthInput.value || monthInput.value === current; });
  apply.addEventListener('click', () => changeMonth(monthInput));
  append(el,
    ...screenTitle('手順1 基本設定', 'どの月の表を作るかと、勤務の決まり・役職・スキルを決めます。入れたものは自動で保存されます。'),
    section(
      '対象の年月',
      null,
      h('div', { class: 'row' }, field('作る月', monthInput), apply),
      h('p', { class: 'help', text: '月を選んで「この月にする」を押します。前の月の日付つきのデータがあるときは、片付けるか聞きます。' }),
    ),
    workSection(),
    rankSection(),
    skillSection(),
    employmentSection(),
    specialSection(),
    detailSection(),
  );
}
