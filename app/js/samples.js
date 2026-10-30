// 業種の見本。スタッフはすべて作り物（A・B・C…）。
// 「ちょうど良くきつい月」に合わせるのは、自動で作れるようになってから（v3）。
import { emptyData, newRank, newSkill, newShift, newStaff, newSpecialDay, newId, canonicalJSON } from './model.js?v=2.3';
import { daysInMonth } from './calendar.js?v=2.3';

export const SAMPLE_KINDS = [
  {
    id: 'restaurant',
    name: '飲食店',
    summary: '朝・昼・夜の3つのシフトと、朝・夜の時間帯責任者。週末は人数を増やします。',
  },
  {
    id: 'retail',
    name: '小売店',
    summary: '早番・中番・遅番と売場責任者。セール日には役職者を多めに入れます。',
  },
  {
    id: 'care',
    name: '介護施設',
    summary: '早出・日勤・遅出・夜勤。夜勤の次の日は明け。資格のある人を時間帯ごとに1人以上。',
  },
  {
    id: 'blank',
    name: '白紙から',
    summary: '何も入っていない状態から、自分で設定します。',
  },
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function addRanks(d, names) {
  d.settings.ranks = names.map((n) => newRank(d, n));
  return d.settings.ranks.map((r) => r.id);
}

function addStaff(d, list) {
  list.forEach((p, i) => d.staff.push(newStaff(d, { name: LETTERS[i], ...p })));
}

function restaurant(d) {
  const [boss, leader, member] = addRanks(d, ['店長', 'リーダー', 'スタッフ']);
  const cook = newSkill(d, { name: '調理', min: { early: 1, late: 1, night: 0 }, target: { early: 2, late: 2, night: 0 } });
  const cash = newSkill(d, { name: 'レジ', min: { early: 1, late: 1, night: 0 }, target: { early: 1, late: 2, night: 0 } });
  d.settings.skills = [cook, cash];
  const S = (f) => newShift(d, f);
  const asa = S({ symbol: '朝', name: '朝', group: 'early', hours: 6, need: { full: 0, part: 2, all: 2 }, color: '#FFF2CC' });
  const hiru = S({ symbol: '昼', name: '昼', group: 'early', hours: 6, need: { full: 0, part: 2, all: 2 }, color: '#FCE4D6' });
  const yoru = S({ symbol: '夜', name: '夜', group: 'late', hours: 6, need: { full: 0, part: 2, all: 2 }, color: '#DDEBF7' });
  const asaS = S({ symbol: '朝責', name: '朝の時間帯責任者', group: 'early', hours: 8, need: { full: 1, part: 0, all: 1 }, onePerDay: true, color: '#FFE699' });
  const yoruS = S({ symbol: '夜責', name: '夜の時間帯責任者', group: 'late', hours: 8, need: { full: 1, part: 0, all: 1 }, onePerDay: true, color: '#BDD7EE' });
  d.settings.shifts = [asa, hiru, yoru, asaS, yoruS];
  d.settings.needRules = [
    { id: newId(d, 'rule'), label: '週末は昼を1人増やす', when: { weekdays: [0, 6] }, shift: hiru.id, emp: 'part', op: 'add', value: 1 },
    { id: newId(d, 'rule'), label: '週末は夜を1人増やす', when: { weekdays: [0, 6] }, shift: yoru.id, emp: 'part', op: 'add', value: 1 },
  ];
  const all = [asa.id, hiru.id, yoru.id, asaS.id, yoruS.id];
  const day = [asa.id, hiru.id];
  const night = [yoru.id];
  addStaff(d, [
    { employment: 'full', rank: boss, shifts: all, skills: [cook.id, cash.id], offDays: 9 },
    { employment: 'full', rank: leader, shifts: all, skills: [cook.id, cash.id], offDays: 9 },
    { employment: 'full', rank: leader, shifts: [asa.id, yoru.id, asaS.id, yoruS.id], skills: [cook.id], offDays: 9 },
    { employment: 'part', rank: member, shifts: day, skills: [cook.id], offDays: 12, groupPref: 'early' },
    { employment: 'part', rank: member, shifts: day, skills: [cash.id], offDays: 12, groupPref: 'early' },
    { employment: 'part', rank: member, shifts: [...day, ...night], skills: [cook.id, cash.id], offDays: 12 },
    { employment: 'part', rank: member, shifts: night, skills: [cook.id], offDays: 12, groupPref: 'late' },
    { employment: 'part', rank: member, shifts: night, skills: [cash.id], offDays: 12, groupPref: 'late' },
    { employment: 'part', rank: member, shifts: [...day, ...night], skills: [cash.id], offDays: 12, weekendPref: 'work' },
    { employment: 'part', rank: member, shifts: [...day, ...night], skills: [], offDays: 13, restStyle: 'together' },
    { employment: 'part', rank: member, shifts: day, skills: [], offDays: 14, weekendPref: 'off' },
    { employment: 'part', rank: member, shifts: night, skills: [cook.id], offDays: 12, prevConsecutive: 3, prevLastShift: yoru.id },
    { employment: 'part', rank: member, shifts: [...day, ...night], skills: [cook.id, cash.id], offDays: 12, paidDays: 1 },
    { employment: 'part', rank: member, shifts: [hiru.id, yoru.id], skills: [], offDays: 13 },
  ]);
}

function retail(d) {
  const [boss, chief, member] = addRanks(d, ['店長', '主任', 'スタッフ']);
  const reji = newSkill(d, { name: 'レジ', min: { early: 1, late: 1, night: 0 }, target: { early: 2, late: 2, night: 0 } });
  const shina = newSkill(d, { name: '品出し', min: { early: 1, late: 0, night: 0 }, target: { early: 2, late: 1, night: 0 } });
  d.settings.skills = [reji, shina];
  const S = (f) => newShift(d, f);
  const haya = S({ symbol: '早', name: '早番', group: 'early', hours: 8, need: { full: 1, part: 2, all: 3 }, color: '#FFF2CC' });
  const naka = S({ symbol: '中', name: '中番', group: 'early', hours: 8, need: { full: 0, part: 1, all: 1 }, color: '#E2EFDA' });
  const oso = S({ symbol: '遅', name: '遅番', group: 'late', hours: 8, need: { full: 1, part: 2, all: 3 }, color: '#DDEBF7' });
  const seki = S({ symbol: '責', name: '売場責任者', group: 'early', hours: 8, need: { full: 1, part: 0, all: 1 }, onePerDay: true, color: '#FFE699' });
  d.settings.shifts = [haya, naka, oso, seki];
  d.settings.needRules = [
    { id: newId(d, 'rule'), label: 'セール日は早番を1人増やす', when: { special: true }, shift: haya.id, emp: 'part', op: 'add', value: 1 },
  ];
  const nDays = daysInMonth(d.month.year, d.month.month);
  d.month.special = [15, 25]
    .filter((x) => x <= nDays)
    .map((day) => newSpecialDay(d, { day, name: 'セール日', rankNeeds: [{ rank: chief, count: 2 }] }));
  const all = [haya.id, naka.id, oso.id, seki.id];
  const work = [haya.id, naka.id, oso.id];
  addStaff(d, [
    { employment: 'full', rank: boss, shifts: all, skills: [reji.id, shina.id], offDays: 9 },
    { employment: 'full', rank: chief, shifts: all, skills: [reji.id, shina.id], offDays: 9 },
    { employment: 'full', rank: chief, shifts: all, skills: [reji.id], offDays: 9, biasPref: 'late' },
    { employment: 'full', rank: member, shifts: work, skills: [shina.id], offDays: 9 },
    { employment: 'part', rank: member, shifts: [haya.id, naka.id], skills: [reji.id], offDays: 12, groupPref: 'early' },
    { employment: 'part', rank: member, shifts: [haya.id, naka.id], skills: [shina.id], offDays: 12, groupPref: 'early' },
    { employment: 'part', rank: member, shifts: work, skills: [reji.id, shina.id], offDays: 12 },
    { employment: 'part', rank: member, shifts: [oso.id], skills: [reji.id], offDays: 12, groupPref: 'late' },
    { employment: 'part', rank: member, shifts: [oso.id], skills: [], offDays: 13, groupPref: 'late' },
    { employment: 'part', rank: member, shifts: work, skills: [reji.id], offDays: 12, weekendPref: 'work' },
    { employment: 'part', rank: member, shifts: work, skills: [], offDays: 13, restStyle: 'spread' },
    { employment: 'part', rank: member, shifts: [naka.id, oso.id], skills: [shina.id], offDays: 12, paidDays: 2 },
    { employment: 'part', rank: member, shifts: work, skills: [reji.id], offDays: 14, weekendPref: 'off' },
  ]);
}

function care(d) {
  const [manager, leader, member] = addRanks(d, ['管理者', 'リーダー', 'スタッフ']);
  const nurse = newSkill(d, { name: '看護', min: { early: 1, late: 1, night: 1 }, target: { early: 1, late: 1, night: 1 } });
  d.settings.skills = [nurse];
  const S = (f) => newShift(d, { combine: true, ...f });
  const hayade = S({ symbol: '早', name: '早出', group: 'early', hours: 8, need: { full: 0, part: 0, all: 2 }, color: '#FFF2CC' });
  const nikkin = S({ symbol: '日', name: '日勤', group: 'early', hours: 8, need: { full: 0, part: 0, all: 3 }, color: '#E2EFDA' });
  const osode = S({ symbol: '遅', name: '遅出', group: 'late', hours: 8, need: { full: 0, part: 0, all: 2 }, color: '#DDEBF7' });
  const yakin = S({ symbol: '夜', name: '夜勤', group: 'night', hours: 16, need: { full: 0, part: 0, all: 2 }, night: true, color: '#D9D2E9' });
  d.settings.shifts = [hayade, nikkin, osode, yakin];
  const all = [hayade.id, nikkin.id, osode.id, yakin.id];
  const day = [hayade.id, nikkin.id, osode.id];
  addStaff(d, [
    { employment: 'full', rank: manager, shifts: [nikkin.id], skills: [nurse.id], offDays: 9 },
    { employment: 'full', rank: leader, shifts: all, skills: [nurse.id], offDays: 9 },
    { employment: 'full', rank: leader, shifts: all, skills: [], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [nurse.id], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [nurse.id], offDays: 9, prevConsecutive: 1, prevLastShift: yakin.id },
    { employment: 'full', rank: member, shifts: all, skills: [], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [nurse.id], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [], offDays: 9, biasPref: 'early' },
    { employment: 'full', rank: member, shifts: all, skills: [nurse.id], offDays: 9 },
    { employment: 'full', rank: member, shifts: all, skills: [], offDays: 9, restStyle: 'together' },
    { employment: 'part', rank: member, shifts: day, skills: [nurse.id], offDays: 12 },
    { employment: 'part', rank: member, shifts: [hayade.id, nikkin.id], skills: [], offDays: 12, groupPref: 'early' },
    { employment: 'part', rank: member, shifts: [nikkin.id, osode.id], skills: [], offDays: 12 },
    { employment: 'part', rank: member, shifts: day, skills: [], offDays: 13, weekendPref: 'off' },
    { employment: 'part', rank: member, shifts: [nikkin.id], skills: [nurse.id], offDays: 14 },
    { employment: 'part', rank: member, shifts: [osode.id], skills: [], offDays: 12, groupPref: 'late' },
    { employment: 'part', rank: member, shifts: day, skills: [], offDays: 12, paidDays: 1 },
  ]);
}

const BUILDERS = { restaurant, retail, care, blank: () => {} };

// 見本を選んだまま、何も変えていないか（それなら消えても、同じ見本をいつでも選び直せる）
export function isUntouchedSample(data) {
  if (!BUILDERS[data?.sample]) return false;
  return canonicalJSON(buildSample(data.sample, data.month.year, data.month.month)) === canonicalJSON(data);
}

export function buildSample(kind, year, month) {
  if (!BUILDERS[kind]) throw new Error(`見本「${kind}」はありません。`);
  const d = emptyData(year, month, kind);
  if (kind === 'blank') d.settings.ranks = [newRank(d, 'スタッフ')];
  BUILDERS[kind](d);
  return d;
}
