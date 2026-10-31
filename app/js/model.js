// データの形と、データを作る・確かめる・直す関数。
// 画面（DOM）には触らない。ブラウザでも node（確かめの道具）でも同じものを使う。
import { daysInMonth, weekdayOf } from './calendar.js?v=6.2';

// データの形の版。形を変えたら 1 つ上げ、migrate() に古い形を直す手順を足す。
export const FORMAT_VERSION = 1;

// 時間帯のグループ（中の名前は変えない。画面の名前だけ）
export const GROUPS = [
  { id: 'early', label: '早い時間帯' },
  { id: 'late', label: '遅い時間帯' },
  { id: 'night', label: '夜' },
];
export const GROUP_IDS = GROUPS.map((g) => g.id);

export const EMPLOYMENT_IDS = ['full', 'part'];

// 休みなどの記号（シフトの記号に使えない）
export const REST_KINDS = [
  { id: 'off', symbol: '休', label: '公休' },
  { id: 'paid', symbol: '有', label: '有給' },
  { id: 'half', symbol: '半', label: '半休' },
  { id: 'ake', symbol: '明', label: '明け' },
  { id: 'spare', symbol: '余', label: '余り日' },
];
export const RESERVED_SYMBOLS = REST_KINDS.map((r) => r.symbol);

export const REQUEST_KINDS = ['off', 'paid', 'half', 'shift'];
export const TABLE_KINDS = ['shift', 'off', 'paid', 'half', 'ake', 'spare'];

export const GROUP_PREFS = ['any', 'early', 'late'];
export const BIAS_PREFS = ['even', 'early', 'late'];
export const REST_STYLES = ['any', 'together', 'spread'];
export const WEEKEND_PREFS = ['any', 'off', 'work'];

const ID_PREFIX = { staff: 'p', shift: 's', rank: 'r', skill: 'k', special: 'd', rule: 'n' };

export const LIMITS = {
  need: [0, 99],
  hours: [0, 24],
  offDays: [0, 31],
  paidDays: [0, 31],
  consecutive: [1, 31],
  prevConsecutive: [0, 31],
  restRun: [1, 10],
  switches: [0, 31],
  bias: [0, 31],
};

export function defaultSettings() {
  return {
    groupNames: { early: '早い時間帯', late: '遅い時間帯', night: '夜' },
    employmentNames: { full: '社員', part: 'パート・アルバイト' },
    ranks: [],
    skills: [],
    shifts: [],
    work: {
      maxConsecutive: 5,
      forbidLateToEarly: true,
      avoidSingleOff: true,
      restRun: 2,
      maxSwitches: 2,
      biasAllowance: 3,
      halfDayHours: 4,
    },
    strengths: {},
    needRules: [],
  };
}

export function newMonth(year, month) {
  return {
    year,
    month,
    special: [],
    needOverride: {},
    dailySkill: {},
    requests: {},
    table: {},
    marks: {},
    runs: [],
  };
}

export function emptyData(year, month, sample = 'blank') {
  return {
    formatVersion: FORMAT_VERSION,
    sample,
    settings: defaultSettings(),
    staff: [],
    month: newMonth(year, month),
    nextIds: { staff: 1, shift: 1, rank: 1, skill: 1, special: 1, rule: 1 },
  };
}

export function newId(data, kind) {
  const n = data.nextIds[kind];
  data.nextIds[kind] = n + 1;
  return ID_PREFIX[kind] + n;
}

export function newShift(data, fields = {}) {
  return {
    id: newId(data, 'shift'),
    symbol: '',
    name: '',
    group: 'early',
    hours: 8,
    need: { full: 0, part: 0, all: 0 },
    combine: false,
    counts: true,
    training: false,
    night: false,
    onePerDay: false,
    color: '#FFF2CC',
    ...fields,
  };
}

export function newStaff(data, fields = {}) {
  return {
    id: newId(data, 'staff'),
    name: '',
    employment: 'part',
    rank: data.settings.ranks.length ? data.settings.ranks[data.settings.ranks.length - 1].id : null,
    shifts: [],
    skills: [],
    offDays: 9,
    paidDays: 0,
    groupPref: 'any',
    biasPref: 'even',
    restStyle: 'any',
    weekendPref: 'any',
    maxConsecutive: null,
    twoOffAfterLateEarly: false,
    prevConsecutive: 0,
    prevLastShift: null,
    memo: '',
    ...fields,
  };
}

export function newSkill(data, fields = {}) {
  return {
    id: newId(data, 'skill'),
    name: '',
    min: { early: 0, late: 0, night: 0 },
    target: { early: 0, late: 0, night: 0 },
    ...fields,
  };
}

export function newRank(data, name) {
  return { id: newId(data, 'rank'), name };
}

export function newSpecialDay(data, fields = {}) {
  return { id: newId(data, 'special'), day: 1, name: '', rankNeeds: [], ...fields };
}

// ---------- 探す ----------

export function shiftById(data, id) {
  return data.settings.shifts.find((s) => s.id === id) || null;
}
export function staffById(data, id) {
  return data.staff.find((p) => p.id === id) || null;
}
export function rankById(data, id) {
  return data.settings.ranks.find((r) => r.id === id) || null;
}
export function rankOrder(data, id) {
  return data.settings.ranks.findIndex((r) => r.id === id);
}

export function monthDays(data) {
  return daysInMonth(data.month.year, data.month.month);
}

// ---------- 記号の確かめ ----------

// 記号に問題があれば、理由の文を返す。問題がなければ空の文字。
export function symbolProblem(data, symbol, exceptShiftId = null) {
  const s = String(symbol ?? '').trim();
  if (!s) return '記号が空です。1〜3文字の記号を入れてください。';
  if (s.length > 3) return '記号は3文字までにしてください。';
  if (/^[=+\-@]/.test(s)) {
    return '「=」「+」「-」「@」で始まる記号は、表計算のソフトで式として読まれるため使えません。';
  }
  if (RESERVED_SYMBOLS.includes(s)) {
    return `「${s}」は休みなどの記号（${REST_KINDS.map((r) => r.symbol).join('・')}）と同じなので使えません。`;
  }
  const dup = data.settings.shifts.find((x) => x.id !== exceptShiftId && x.symbol === s);
  if (dup) return `「${s}」はほかのシフト（${dup.name || dup.symbol}）で使っています。ちがう記号にしてください。`;
  return '';
}

// ---------- 必要人数 ----------

// 表の行：社員とパートを合わせて数えるシフトは 1 行、そうでなければ区分ごとに 1 行
export function needRows(data) {
  const rows = [];
  for (const s of data.settings.shifts) {
    if (s.combine) rows.push({ shiftId: s.id, emp: 'all' });
    else for (const emp of EMPLOYMENT_IDS) rows.push({ shiftId: s.id, emp });
  }
  return rows;
}

function ruleMatches(data, rule, day) {
  const when = rule.when || {};
  const { year, month } = data.month;
  if (Array.isArray(when.weekdays) && when.weekdays.includes(weekdayOf(year, month, day))) return true;
  if (Array.isArray(when.monthDays) && when.monthDays.includes(day)) return true;
  if (when.special && data.month.special.some((d) => d.day === day)) return true;
  return false;
}

function ruleAppliesToRow(shift, rule, emp) {
  if (rule.shift !== shift.id) return false;
  if (emp === 'all') return true;
  return rule.emp === 'all' || rule.emp === emp;
}

// ふだんの数（決まりが当たればその数）。{ value, rules: [当たった決まりの名前] }
export function baseNeed(data, shiftId, emp, day) {
  const shift = shiftById(data, shiftId);
  if (!shift) return { value: 0, rules: [] };
  let value = shift.need[emp] ?? 0;
  const rules = [];
  for (const rule of data.settings.needRules) {
    if (!ruleAppliesToRow(shift, rule, emp) || !ruleMatches(data, rule, day)) continue;
    value = rule.op === 'set' ? rule.value : value + rule.value;
    rules.push(rule.label);
  }
  return { value: Math.max(0, value), rules };
}

function overrideOf(data, shiftId, emp, day) {
  return data.month.needOverride?.[shiftId]?.[emp]?.[day];
}

// その日の必要人数。source は 'plain'（ふだん）・'rule'（決まり）・'override'（日ごとに上書き）
export function needOn(data, shiftId, emp, day) {
  const base = baseNeed(data, shiftId, emp, day);
  const o = overrideOf(data, shiftId, emp, day);
  if (Number.isInteger(o)) return { value: o, source: 'override', base: base.value, rules: base.rules };
  return { value: base.value, source: base.rules.length ? 'rule' : 'plain', base: base.value, rules: base.rules };
}

// ふだんの数と同じ数を入れたら、上書きを消す
export function setNeedOverride(data, shiftId, emp, day, value) {
  const base = baseNeed(data, shiftId, emp, day).value;
  const ov = data.month.needOverride;
  if (value === base) {
    if (ov[shiftId]?.[emp]) {
      delete ov[shiftId][emp][day];
      if (!Object.keys(ov[shiftId][emp]).length) delete ov[shiftId][emp];
      if (!Object.keys(ov[shiftId]).length) delete ov[shiftId];
    }
    return;
  }
  ov[shiftId] ??= {};
  ov[shiftId][emp] ??= {};
  ov[shiftId][emp][day] = value;
}

// 社員とパートを合わせて数える設定を切り替える（数は合わせた数・分けた数へ引き継ぐ）
export function setCombine(data, shift, combine) {
  if (shift.combine === combine) return;
  if (combine) shift.need.all = (shift.need.full ?? 0) + (shift.need.part ?? 0);
  shift.combine = combine;
}

// ---------- 月のデータ ----------

export function monthHasContent(data) {
  const m = data.month;
  return (
    m.special.length > 0 ||
    Object.keys(m.needOverride).length > 0 ||
    Object.keys(m.dailySkill).length > 0 ||
    Object.values(m.requests).some((r) => Object.keys(r).length) ||
    Object.values(m.table).some((r) => Object.keys(r).length) ||
    Object.values(m.marks).some((r) => Object.keys(r).length) ||
    m.runs.length > 0
  );
}

// 月を切り替える：日付つきのデータを片付ける。スタッフと設定は残す。
export function switchMonth(data, year, month) {
  data.month = newMonth(year, month);
}

// ---------- 希望とシフト表のマス ----------

// part[pid][day] に value を書く。null なら消す。空になった入れ物も消す
function writeCell(part, pid, day, value) {
  if (value) {
    part[pid] ??= {};
    part[pid][day] = value;
  } else if (part[pid]) {
    delete part[pid][day];
    if (!Object.keys(part[pid]).length) delete part[pid];
  }
}

function cellValue(value) {
  if (!value) return null;
  return value.kind === 'shift' ? { kind: 'shift', shift: value.shift } : { kind: value.kind };
}

export function requestOf(data, pid, day) {
  return data.month.requests[pid]?.[day] ?? null;
}

// 希望を入れる（value: { kind: 'off' | 'paid' | 'half' } か { kind: 'shift', shift }。null で消す）
export function setRequest(data, pid, day, value) {
  writeCell(data.month.requests, pid, day, cellValue(value));
}

export function cellOf(data, pid, day) {
  return data.month.table[pid]?.[day] ?? null;
}

export function marksOf(data, pid, day) {
  return data.month.marks[pid]?.[day] ?? {};
}

function setMark(data, pid, day, key, on) {
  const cur = { ...marksOf(data, pid, day) };
  if (on) cur[key] = true;
  else delete cur[key];
  writeCell(data.month.marks, pid, day, Object.keys(cur).length ? cur : null);
}

// 固定（自動で作るときに、このマスを変えない）
export function setLock(data, pid, day, on) {
  setMark(data, pid, day, 'locked', on);
}

export function isNightShift(data, value) {
  return value?.kind === 'shift' && Boolean(shiftById(data, value.shift)?.night);
}

// 同じ日の2人のマスを入れ替える（4-1。手順6 のドラッグ・マスの小窓）。固定したマスは入れ替えない。
// 夜勤の次の日の明けは、手で変えたときと同じに出し入れする（setCellByHand）。
// 返す：{ ok: false, reason: 'same' | 'locked' } | { ok: true, notes: [{ pid, next }] }（next は setCellByHand の返り値）
export function swapCells(data, pidA, pidB, day) {
  if (pidA === pidB) return { ok: false, reason: 'same' };
  if (marksOf(data, pidA, day).locked || marksOf(data, pidB, day).locked) return { ok: false, reason: 'locked' };
  const a = cellOf(data, pidA, day);
  const b = cellOf(data, pidB, day);
  const notes = [];
  const na = setCellByHand(data, pidA, day, b);
  const nb = setCellByHand(data, pidB, day, a);
  if (na) notes.push({ pid: pidA, next: na });
  if (nb) notes.push({ pid: pidB, next: nb });
  return { ok: true, notes };
}

// 自動で作った表を入れる。固定したマスの印は残し、「手で変えた」の印は消す（新しい表なので）。
// 作った記録（run）を month.runs に足し、新しい MAX_RUNS 回ぶんまで残す
export const MAX_RUNS = 20;
export function addRun(data, run) {
  data.month.runs.push(run);
  if (data.month.runs.length > MAX_RUNS) data.month.runs.splice(0, data.month.runs.length - MAX_RUNS);
}

export function applyGenerated(data, table, run) {
  data.month.table = table;
  for (const [pid, days] of Object.entries(data.month.marks)) {
    for (const day of Object.keys(days)) setMark(data, pid, Number(day), 'edited', false);
  }
  addRun(data, run);
}

// 自動で直した案・途中から作り直した表の、変わるマスだけを入れる（4-2）。
// 変わったマスの「手で変えた」の印は外す（自動で変えたので）。changes: [{ pid, day, after }]
export function applyCellChanges(data, changes) {
  for (const ch of changes) {
    writeCell(data.month.table, ch.pid, ch.day, cellValue(ch.after));
    setMark(data, ch.pid, ch.day, 'edited', false);
  }
}

// 表のマスを手で変える。
// 夜勤を入れたら、次の日が空いていれば「明け」にする。夜勤を外したら、次の日の「明け」も外す。
// ただし次の日が固定してあれば、明けの出し入れでは変えない（固定は「このマスを変えない」印のため）。
// 一度自動で作った表（month.runs がある）を手で変えたら「手で変えた」の印を付ける。
// 返す：次の日をどうしたか null か
//   { what: 'ake-set' }               明けを入れた
//   { what: 'ake-cleared' }           明けを外した
//   { what: 'ake-blocked', cell }     次の日がもう埋まっていたので、明けにしなかった
//   { what: 'ake-locked', cell }      次の日が固定なので、明けにしなかった
//   { what: 'ake-kept-locked', cell } 次の日の明けが固定なので、外さなかった
export function setCellByHand(data, pid, day, value) {
  const t = data.month.table;
  const generated = data.month.runs.length > 0;
  const wasNight = isNightShift(data, cellOf(data, pid, day));
  writeCell(t, pid, day, cellValue(value));
  if (generated) setMark(data, pid, day, 'edited', true);
  if (day >= monthDays(data)) return null;
  const next = cellOf(data, pid, day + 1);
  const nextLocked = Boolean(marksOf(data, pid, day + 1).locked);
  if (isNightShift(data, value)) {
    if (next?.kind === 'ake') return null;
    if (nextLocked) return { what: 'ake-locked', cell: next };
    if (next) return { what: 'ake-blocked', cell: next };
    writeCell(t, pid, day + 1, { kind: 'ake' });
    if (generated) setMark(data, pid, day + 1, 'edited', true);
    return { what: 'ake-set' };
  }
  if (wasNight && next?.kind === 'ake') {
    if (nextLocked) return { what: 'ake-kept-locked', cell: next };
    writeCell(t, pid, day + 1, null);
    if (generated) setMark(data, pid, day + 1, 'edited', true);
    return { what: 'ake-cleared' };
  }
  return null;
}

// マスの記号（シフトは利用者が付けた記号、休みなどは休・有・半・明・余）
export function cellSymbol(data, value) {
  if (!value) return '';
  if (value.kind === 'shift') return shiftById(data, value.shift)?.symbol ?? '?';
  return REST_KINDS.find((r) => r.id === value.kind)?.symbol ?? '?';
}

export function cellName(data, value) {
  if (!value) return '空き';
  if (value.kind === 'shift') {
    const s = shiftById(data, value.shift);
    return s ? `${s.name || s.symbol}（${s.symbol}）` : '?';
  }
  return REST_KINDS.find((r) => r.id === value.kind)?.label ?? '?';
}

// ---------- 消す ----------

function dropFromMonthByStaff(data, staffId) {
  const m = data.month;
  delete m.requests[staffId];
  delete m.table[staffId];
  delete m.marks[staffId];
}

export function removeStaff(data, staffId) {
  data.staff = data.staff.filter((p) => p.id !== staffId);
  dropFromMonthByStaff(data, staffId);
}

// 夜勤のシフトを消すとき、一緒に消える明け（そのシフトのマスのすぐ次の日の明け。固定したものは残す）
function akesAfter(data, shiftId) {
  if (!shiftById(data, shiftId)?.night) return [];
  const out = [];
  for (const [pid, days] of Object.entries(data.month.table)) {
    for (const [day, v] of Object.entries(days)) {
      const next = Number(day) + 1;
      if (v.shift === shiftId && days[next]?.kind === 'ake' && !marksOf(data, pid, next).locked) out.push([pid, next]);
    }
  }
  return out;
}

// そのシフトを使っている所の数（消す前の確かめに使う）
export function shiftUsage(data, shiftId) {
  const staff = data.staff.filter((p) => p.shifts.includes(shiftId)).length;
  let cells = 0;
  for (const part of [data.month.requests, data.month.table]) {
    for (const days of Object.values(part)) {
      for (const v of Object.values(days)) if (v.shift === shiftId) cells += 1;
    }
  }
  return { staff, cells, akes: akesAfter(data, shiftId).length };
}

export function removeShift(data, shiftId) {
  for (const [pid, day] of akesAfter(data, shiftId)) {
    writeCell(data.month.table, pid, day, null);
    writeCell(data.month.marks, pid, day, null);
  }
  data.settings.shifts = data.settings.shifts.filter((s) => s.id !== shiftId);
  data.settings.needRules = data.settings.needRules.filter((r) => r.shift !== shiftId);
  for (const p of data.staff) {
    p.shifts = p.shifts.filter((id) => id !== shiftId);
    if (p.prevLastShift === shiftId) p.prevLastShift = null;
  }
  const m = data.month;
  delete m.needOverride[shiftId];
  delete m.dailySkill[shiftId];
  for (const part of [m.requests, m.table]) {
    for (const [pid, days] of Object.entries(part)) {
      for (const [day, v] of Object.entries(days)) {
        if (v.shift === shiftId) {
          delete days[day];
          if (m.marks[pid]) delete m.marks[pid][day];
        }
      }
    }
  }
}

export function removeSkill(data, skillId) {
  data.settings.skills = data.settings.skills.filter((k) => k.id !== skillId);
  for (const p of data.staff) p.skills = p.skills.filter((id) => id !== skillId);
  // 日ごとに要るスキルの形は「シフト → 日 → スキルの一覧」。スキルが空になった日・シフトは消す
  const daily = data.month.dailySkill;
  for (const [shiftId, days] of Object.entries(daily)) {
    for (const [day, list] of Object.entries(days)) {
      const rest = list.filter((id) => id !== skillId);
      if (rest.length) days[day] = rest;
      else delete days[day];
    }
    if (!Object.keys(days).length) delete daily[shiftId];
  }
}

// その役職の人（消せないときの説明に使う）
export function staffWithRank(data, rankId) {
  return data.staff.filter((p) => p.rank === rankId);
}

export function removeRank(data, rankId) {
  data.settings.ranks = data.settings.ranks.filter((r) => r.id !== rankId);
  for (const d of data.month.special) d.rankNeeds = d.rankNeeds.filter((n) => n.rank !== rankId);
}

// ---------- 古い形を新しい形へ直す ----------

// 直せないときは Error を投げる。直した結果は validateData() で確かめること。
export function migrate(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('データの形ではありません。');
  const v = obj.formatVersion;
  if (!Number.isInteger(v)) throw new Error('データの形の版が書かれていません。');
  if (v > FORMAT_VERSION) {
    throw new Error('このアプリより新しい版で作られたデータです。ページを読み直して（再読み込みして）からもう一度ためしてください。');
  }
  // v === 1 がいまの形。形を変えたら、ここに v1 → v2 のような直し方を足す。
  return obj;
}

// ---------- 形の確かめ（読み込み・取り込みの前に使う） ----------

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const isInt = (x) => Number.isInteger(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const inRange = (x, [lo, hi]) => isNum(x) && x >= lo && x <= hi;

// 問題の一覧（だれが読んでも分かる文）を返す。空なら正しい。
export function validateData(d) {
  const errs = [];
  const bad = (msg) => errs.push(msg);
  if (!isObj(d)) return ['データの形ではありません。'];
  if (d.formatVersion !== FORMAT_VERSION) bad('データの形の版が合いません。');
  if (!isObj(d.settings)) return [...errs, '設定がありません。'];
  if (!Array.isArray(d.staff)) return [...errs, 'スタッフの一覧がありません。'];
  if (!isObj(d.month)) return [...errs, '月のデータがありません。'];
  if (!isObj(d.nextIds)) return [...errs, '番号の控えがありません。'];

  const st = d.settings;
  for (const g of GROUP_IDS) if (!isStr(st.groupNames?.[g])) bad('時間帯のグループの名前が足りません。');
  for (const e of EMPLOYMENT_IDS) if (!isStr(st.employmentNames?.[e])) bad('雇用の区分の名前が足りません。');
  for (const key of ['ranks', 'skills', 'shifts', 'needRules']) if (!Array.isArray(st[key])) bad(`設定の「${key}」が一覧になっていません。`);
  if (!isObj(st.work)) bad('勤務の決まりがありません。');
  if (!isObj(st.strengths)) bad('決まりの強さがありません。');
  if (errs.length) return errs;

  const ids = new Set();
  const uniq = (id, what) => {
    if (!isStr(id) || !id) bad(`${what}の番号がありません。`);
    else if (ids.has(id)) bad(`${what}の番号「${id}」が重なっています。`);
    else ids.add(id);
  };
  const rankIds = new Set();
  for (const r of st.ranks) {
    uniq(r?.id, '役職');
    rankIds.add(r?.id);
    if (!isStr(r?.name)) bad('役職の名前が文字ではありません。');
  }
  const skillIds = new Set();
  for (const k of st.skills) {
    uniq(k?.id, 'スキル');
    skillIds.add(k?.id);
    if (!isStr(k?.name)) bad('スキルの名前が文字ではありません。');
    for (const g of GROUP_IDS) {
      if (!inRange(k?.min?.[g], LIMITS.need) || !isInt(k?.min?.[g])) bad(`スキル「${k?.name}」の最低人数が正しくありません。`);
      if (!inRange(k?.target?.[g], LIMITS.need) || !isInt(k?.target?.[g])) bad(`スキル「${k?.name}」の目標人数が正しくありません。`);
    }
  }
  const shiftIds = new Set();
  const symbols = new Set();
  for (const s of st.shifts) {
    uniq(s?.id, 'シフト');
    shiftIds.add(s?.id);
    if (!isStr(s?.symbol) || !s.symbol.trim()) bad('記号が空のシフトがあります。');
    else {
      if (symbols.has(s.symbol)) bad(`シフトの記号「${s.symbol}」が重なっています。`);
      symbols.add(s.symbol);
      if (RESERVED_SYMBOLS.includes(s.symbol)) bad(`シフトの記号「${s.symbol}」が休みの記号と同じです。`);
      if (/^[=+\-@]/.test(s.symbol)) bad(`シフトの記号「${s.symbol}」が「=」「+」「-」「@」で始まっています。`);
    }
    if (!isStr(s?.name)) bad('シフトの名称が文字ではありません。');
    if (!GROUP_IDS.includes(s?.group)) bad(`シフト「${s?.symbol}」の時間帯のグループが正しくありません。`);
    if (!inRange(s?.hours, LIMITS.hours)) bad(`シフト「${s?.symbol}」の労働時間が正しくありません。`);
    for (const e of ['full', 'part', 'all']) {
      if (!isInt(s?.need?.[e]) || !inRange(s.need[e], LIMITS.need)) bad(`シフト「${s?.symbol}」のふだんの必要人数が正しくありません。`);
    }
    for (const f of ['combine', 'counts', 'training', 'night', 'onePerDay']) {
      if (typeof s?.[f] !== 'boolean') bad(`シフト「${s?.symbol}」の詳細（${f}）が正しくありません。`);
    }
    if (!isStr(s?.color) || !/^#[0-9A-Fa-f]{6}$/.test(s.color)) bad(`シフト「${s?.symbol}」の色が正しくありません。`);
  }
  for (const r of st.needRules) {
    uniq(r?.id, '必要人数の決まり');
    if (!shiftIds.has(r?.shift)) bad('必要人数の決まりに、無いシフトが書かれています。');
    if (!['full', 'part', 'all'].includes(r?.emp)) bad('必要人数の決まりの区分が正しくありません。');
    if (!['set', 'add'].includes(r?.op) || !isInt(r?.value)) bad('必要人数の決まりの数が正しくありません。');
    if (!isObj(r?.when)) bad('必要人数の決まりの条件がありません。');
  }
  const w = st.work;
  if (!inRange(w.maxConsecutive, LIMITS.consecutive) || !isInt(w.maxConsecutive)) bad('連勤の上限が正しくありません。');
  if (typeof w.forbidLateToEarly !== 'boolean' || typeof w.avoidSingleOff !== 'boolean') bad('勤務の決まりの選び方が正しくありません。');
  if (!inRange(w.restRun, LIMITS.restRun) || !isInt(w.restRun)) bad('連休の目安が正しくありません。');
  if (!inRange(w.maxSwitches, LIMITS.switches) || !isInt(w.maxSwitches)) bad('切り替え回数の上限が正しくありません。');
  if (!inRange(w.biasAllowance, LIMITS.bias) || !isInt(w.biasAllowance)) bad('偏りを許す日数が正しくありません。');
  if (!inRange(w.halfDayHours, LIMITS.hours)) bad('半休の労働時間が正しくありません。');

  const staffIds = new Set();
  for (const p of d.staff) {
    uniq(p?.id, 'スタッフ');
    staffIds.add(p?.id);
    const who = isStr(p?.name) && p.name ? `「${p.name}」` : '名前の無い人';
    if (!isStr(p?.name)) bad('スタッフの名前が文字ではありません。');
    if (!EMPLOYMENT_IDS.includes(p?.employment)) bad(`${who}の区分が正しくありません。`);
    if (p?.rank !== null && !rankIds.has(p?.rank)) bad(`${who}の役職が、役職の一覧にありません。`);
    if (!Array.isArray(p?.shifts) || p.shifts.some((id) => !shiftIds.has(id))) bad(`${who}の担当できるシフトに、無いシフトがあります。`);
    if (!Array.isArray(p?.skills) || p.skills.some((id) => !skillIds.has(id))) bad(`${who}のスキルに、無いスキルがあります。`);
    if (!isInt(p?.offDays) || !inRange(p.offDays, LIMITS.offDays)) bad(`${who}の月の公休数が正しくありません。`);
    if (!inRange(p?.paidDays, LIMITS.paidDays) || (p.paidDays * 2) % 1 !== 0) bad(`${who}の有給の日数が正しくありません（0.5日きざみ）。`);
    if (!GROUP_PREFS.includes(p?.groupPref)) bad(`${who}の時間帯の希望が正しくありません。`);
    if (!BIAS_PREFS.includes(p?.biasPref)) bad(`${who}の偏りの希望が正しくありません。`);
    if (!REST_STYLES.includes(p?.restStyle)) bad(`${who}の休み方の希望が正しくありません。`);
    if (!WEEKEND_PREFS.includes(p?.weekendPref)) bad(`${who}の土日の希望が正しくありません。`);
    if (p?.maxConsecutive !== null && (!isInt(p?.maxConsecutive) || !inRange(p.maxConsecutive, LIMITS.consecutive))) bad(`${who}の個人の連勤上限が正しくありません。`);
    if (typeof p?.twoOffAfterLateEarly !== 'boolean') bad(`${who}の「遅い→早い」の間の休みの設定が正しくありません。`);
    if (!isInt(p?.prevConsecutive) || !inRange(p.prevConsecutive, LIMITS.prevConsecutive)) bad(`${who}の前月末の連勤日数が正しくありません。`);
    if (p?.prevLastShift !== null && p?.prevLastShift !== 'off' && !shiftIds.has(p?.prevLastShift)) bad(`${who}の前月の最後のシフトが正しくありません。`);
    if (!isStr(p?.memo)) bad(`${who}のメモが文字ではありません。`);
  }

  const m = d.month;
  if (!isInt(m.year) || m.year < 2000 || m.year > 2100) bad('対象の年が正しくありません。');
  if (!isInt(m.month) || m.month < 1 || m.month > 12) bad('対象の月が正しくありません。');
  if (errs.length) return errs;
  const nDays = daysInMonth(m.year, m.month);
  const okDay = (x) => isInt(Number(x)) && Number(x) >= 1 && Number(x) <= nDays;
  for (const key of ['needOverride', 'dailySkill', 'requests', 'table', 'marks']) if (!isObj(m[key])) bad(`月のデータの「${key}」がありません。`);
  if (!Array.isArray(m.special) || !Array.isArray(m.runs)) bad('月のデータの一覧が正しくありません。');
  if (errs.length) return errs;
  for (const sd of m.special) {
    uniq(sd?.id, '特別な日');
    if (!okDay(sd?.day)) bad('特別な日の日付が、その月にありません。');
    if (!isStr(sd?.name)) bad('特別な日の名前が文字ではありません。');
    if (!Array.isArray(sd?.rankNeeds) || sd.rankNeeds.some((n) => !rankIds.has(n?.rank) || !isInt(n?.count) || !inRange(n.count, LIMITS.need))) {
      bad('特別な日の役職の人数が正しくありません。');
    }
  }
  for (const [sid, byEmp] of Object.entries(m.needOverride)) {
    if (!shiftIds.has(sid) || !isObj(byEmp)) { bad('日ごとの必要人数に、無いシフトがあります。'); continue; }
    for (const [emp, days] of Object.entries(byEmp)) {
      if (!['full', 'part', 'all'].includes(emp) || !isObj(days)) { bad('日ごとの必要人数の区分が正しくありません。'); continue; }
      for (const [day, v] of Object.entries(days)) {
        if (!okDay(day) || !isInt(v) || !inRange(v, LIMITS.need)) bad('日ごとの必要人数の数が正しくありません。');
      }
    }
  }
  for (const [sid, days] of Object.entries(m.dailySkill)) {
    if (!shiftIds.has(sid) || !isObj(days)) { bad('日ごとに要るスキルに、無いシフトがあります。'); continue; }
    for (const [day, list] of Object.entries(days)) {
      if (!okDay(day) || !Array.isArray(list) || list.some((k) => !skillIds.has(k))) bad('日ごとに要るスキルが正しくありません。');
    }
  }
  const checkCells = (part, kinds, what) => {
    for (const [pid, days] of Object.entries(part)) {
      if (!staffIds.has(pid) || !isObj(days)) { bad(`${what}に、いないスタッフがあります。`); continue; }
      for (const [day, v] of Object.entries(days)) {
        if (!okDay(day) || !isObj(v) || !kinds.includes(v.kind)) { bad(`${what}のマスが正しくありません。`); continue; }
        if (v.kind === 'shift' && !shiftIds.has(v.shift)) bad(`${what}に、無いシフトがあります。`);
      }
    }
  };
  checkCells(m.requests, REQUEST_KINDS, '希望');
  checkCells(m.table, TABLE_KINDS, 'シフト表');
  for (const [pid, days] of Object.entries(m.marks)) {
    if (!staffIds.has(pid) || !isObj(days)) { bad('マスの印に、いないスタッフがあります。'); continue; }
    for (const [day, v] of Object.entries(days)) if (!okDay(day) || !isObj(v)) bad('マスの印が正しくありません。');
  }

  // 番号を使い回さないための数が、使っている番号より大きいこと
  for (const [kind, prefix] of Object.entries(ID_PREFIX)) {
    const n = d.nextIds[kind];
    if (!isInt(n) || n < 1) { bad('番号の控えが正しくありません。'); continue; }
    for (const id of ids) {
      if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) && Number(id.slice(prefix.length)) >= n) {
        bad('番号の控えが、使っている番号より小さくなっています。');
        break;
      }
    }
  }
  return errs;
}

// 取り込むときだけの確かめ：数や文字の長さが、画面で使える大きさか。
// （ブラウザに保存してあるデータは、この確かめでは断らない。読めなくなると困るため）
export const IMPORT_LIMITS = { staff: 500, shifts: 50, ranks: 50, skills: 50, special: 62, needRules: 200, name: 100, memo: 2000 };

export function importProblems(d) {
  const L = IMPORT_LIMITS;
  const errs = [];
  const count = (list, max, what) => {
    if (list.length > max) errs.push(`${what}が多すぎます（${list.length}。${max}まで）。`);
  };
  count(d.staff, L.staff, 'スタッフ');
  count(d.settings.shifts, L.shifts, 'シフトの種類');
  count(d.settings.ranks, L.ranks, '役職');
  count(d.settings.skills, L.skills, 'スキル');
  count(d.month.special, L.special, '特別な日');
  count(d.settings.needRules, L.needRules, '必要人数の決まり');
  const names = [
    ...d.staff.map((p) => ['スタッフの名前', p.name]),
    ...d.settings.shifts.map((s) => ['シフトの名称', s.name]),
    ...d.settings.ranks.map((r) => ['役職の名前', r.name]),
    ...d.settings.skills.map((k) => ['スキルの名前', k.name]),
    ...d.month.special.map((s) => ['特別な日の名前', s.name]),
    ...d.settings.needRules.map((r) => ['必要人数の決まりの名前', r.label ?? '']),
    ...Object.values(d.settings.groupNames).map((n) => ['時間帯のグループの名前', n]),
    ...Object.values(d.settings.employmentNames).map((n) => ['区分の名前', n]),
  ];
  for (const [what, text] of names) {
    if (String(text).length > L.name) {
      errs.push(`${what}が長すぎます（${String(text).length}文字。${L.name}文字まで）。`);
      break;
    }
  }
  if (d.staff.some((p) => p.memo.length > L.memo)) errs.push(`スタッフのメモが長すぎます（${L.memo}文字まで）。`);
  return errs;
}

// 比べるための、キーの順をそろえた JSON
export function canonicalJSON(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
