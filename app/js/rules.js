// 決まりの一覧と、マスの状態ごとの性質（docs/数え方の表.md の 1 章・2 章）。
// 検査・画面・手引き・自動で作る（v3）は、名前も数え方も、すべてここから引く。画面には触らない。
import { shiftById } from './model.js?v=3.3';

export const STRENGTH_NAMES = { hard: '絶対', soft: 'できれば', off: 'なし', always: 'いつも数える' };

// fixed: 強さを選べない（その強さのまま）。work: 手順1の「勤務の決まり」のチェックと同じ1つの値になる決まり
// help: 画面と手引きに出す、何を見る決まりかの短い説明。why: 選べない理由
export const RULES = [
  { id: 'shortage', name: '人員不足', strength: 'hard', help: 'その日・そのシフトの人数が、必要人数より少ない', group: 'staffing' },
  { id: 'overstaff', name: '定数オーバー', strength: 'soft', help: 'その日・そのシフトの人数が、必要人数より多い', group: 'staffing' },
  { id: 'skillShort', name: 'スキル不足', strength: 'hard', help: 'その時間帯に、スキルを持つ人が最低人数より少ない', group: 'staffing' },
  { id: 'skillTarget', name: 'スキルの目標に届かない', strength: 'soft', help: '最低人数はいるが、スキルを持つ人が目標人数より少ない', group: 'staffing' },
  { id: 'onePerDayDup', name: '1日1人の役が重なる', strength: 'hard', help: '1日1人の役のシフトに、2人以上入っている', group: 'staffing' },
  { id: 'leaderRank', name: '責任者の順位', strength: 'soft', help: '1日1人の役に、その時間帯でいちばん順位が上の人が入っていない', group: 'staffing' },
  { id: 'specialRank', name: '特別な日に決めた役職の人がいない', strength: 'soft', help: '特別な日に、決めた役職の人が足りない', group: 'staffing' },
  { id: 'dailySkill', name: '日ごとに要るスキルを持たない人が入っている', strength: 'hard', fixed: true, why: '自動で作るときに必ず守る決まりなので', help: 'その日のそのシフトに要るスキルを持たない人が入っている', group: 'staffing' },
  { id: 'overStreak', name: '連勤超過', strength: 'hard', help: '続けて出勤する日数が、連勤の上限を超える', group: 'streak' },
  { id: 'sixPlus', name: '6連勤以上', strength: 'always', fixed: true, why: '働きすぎを見のがさないため', help: '6日以上続けて出勤している（働きすぎの目安）', group: 'streak' },
  { id: 'switchInStreak', name: '連勤中の時間帯の切り替え', strength: 'soft', help: '続けて出勤している途中で、早い時間帯と遅い時間帯が入れかわる', group: 'streak' },
  { id: 'lateToEarly', name: '遅い→早い（休みなし）', strength: 'hard', work: 'forbidLateToEarly', help: '遅い時間帯の次の日に、早い時間帯', group: 'time' },
  { id: 'lateOffEarly', name: '遅い→休み→早い', strength: 'soft', help: '遅い時間帯 → 休み1日 → 早い時間帯', group: 'time' },
  { id: 'twoOffLateEarly', name: '遅い→早いの間の2連休が足りない', strength: 'hard', fixed: true, why: 'スタッフの設定（2連休にする）で決まる決まりなので', help: '「遅い→早いの間は2連休」の人の、遅い時間帯 → 休み1日 → 早い時間帯', group: 'time' },
  { id: 'switchCount', name: '時間帯の切り替え回数', strength: 'soft', help: '月の中で、早い時間帯と遅い時間帯の入れかわりが上限より多い', group: 'time' },
  { id: 'bias', name: '早い・遅いの偏り', strength: 'soft', help: '早い時間帯と遅い時間帯の日数の差が、許す日数より大きい', group: 'time' },
  { id: 'groupPref', name: '時間帯の希望と合わない', strength: 'soft', help: '時間帯の希望（早いだけ・遅いだけ）と合わないシフト', group: 'time' },
  { id: 'singleWork', name: '1日だけの出勤', strength: 'soft', help: '前の日も次の日も休みの、1日だけの出勤', group: 'rest' },
  { id: 'singleOff', name: '1日だけの休み', strength: 'soft', work: 'avoidSingleOff', help: '前の日も次の日も出勤の、1日だけの休み', group: 'rest' },
  { id: 'longRest', name: '連休が長すぎる', strength: 'soft', help: '連休が、連休の目安より3日以上長い', group: 'rest' },
  { id: 'fewRestRuns', name: '連休の回数が足りない', strength: 'soft', help: '連休の目安以上の連休が、月に1回もない（「連休にしたい」人は2回）', group: 'rest' },
  { id: 'restStyle', name: '休み方の希望と合わない', strength: 'soft', help: '休み方の希望（連休にしたい・ばらしたい）と合わない', group: 'rest' },
  { id: 'weekend', name: '土日の希望と合わない', strength: 'soft', help: '土日の希望（休みたい・出たい）と合わない', group: 'rest' },
  { id: 'offShort', name: '公休が足りない', strength: 'hard', help: '公休が、予定の日数より少ない', group: 'days' },
  { id: 'paidDiff', name: '有給の日数のずれ', strength: 'soft', help: '有給の日数が、設定の日数と違う', group: 'days' },
  { id: 'notAssigned', name: '担当外のシフト', strength: 'hard', help: '担当できないシフトに入っている', group: 'cell' },
  { id: 'nightNext', name: '夜勤の次の日が休みでない', strength: 'hard', help: '夜勤の次の日が、休み（明け）でない', group: 'cell' },
  { id: 'requestDiff', name: '希望と違う', strength: 'hard', fixed: true, why: '自動で作るときに必ず守る決まりなので', help: '希望の表と、シフト表のマスが違う', group: 'cell' },
];

export const RULE_GROUPS = [
  { id: 'staffing', name: '人数' },
  { id: 'streak', name: '連勤' },
  { id: 'time', name: '時間帯' },
  { id: 'rest', name: '休みの並び' },
  { id: 'days', name: '人ごとの日数' },
  { id: 'cell', name: '1つのマス' },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

// いま使う強さ。'hard' | 'soft' | 'off' | 'always'
// 手順1のチェックと同じ値になる決まりは、チェックが外れていれば「なし」
export function strengthOf(data, ruleId) {
  const rule = RULE_BY_ID[ruleId];
  if (rule.fixed) return rule.strength;
  if (rule.work && !data.settings.work[rule.work]) return 'off';
  const s = data.settings.strengths[ruleId];
  return s === 'hard' || s === 'soft' || s === 'off' ? s : rule.strength;
}

// 強さを変える（2-3 の画面から使う）。チェックと同じ値の決まりは、チェックも一緒に変える
export function setStrength(data, ruleId, value) {
  const rule = RULE_BY_ID[ruleId];
  if (rule.fixed) return;
  if (rule.work) {
    data.settings.work[rule.work] = value !== 'off';
    if (value === 'off') return;
  }
  if (value === rule.strength) delete data.settings.strengths[ruleId];
  else data.settings.strengths[ruleId] = value;
}

// ---------- マスの状態の性質（数え方の表の 1 章） ----------

const REST_KINDS = new Set(['off', 'paid', 'spare']);

// value: シフト表のマス（{ kind, shift } か null）
export function cellTraits(data, value) {
  if (!value) return { state: 'empty', streakWork: false, single: 'U', runRest: false, group: null, switchGroup: null, counts: false, workDay: 0 };
  if (value.kind === 'shift') {
    const s = shiftById(data, value.shift);
    // 夜勤のシフトは、時間帯のグループの設定に関係なく「夜」として数える（数え方の表の 1 章）
    const group = s ? (s.night ? 'night' : s.group) : null;
    return {
      state: s?.night ? 'night' : 'shift',
      streakWork: true,
      single: 'W',
      runRest: false,
      group,
      switchGroup: group === 'early' || group === 'late' ? group : null,
      counts: Boolean(s && s.counts && !s.training),
      night: Boolean(s?.night),
      workDay: 1,
    };
  }
  if (REST_KINDS.has(value.kind)) {
    return { state: value.kind, streakWork: false, single: 'R', runRest: true, group: null, switchGroup: null, counts: false, workDay: 0 };
  }
  if (value.kind === 'half') return { state: 'half', streakWork: true, single: 'W', runRest: false, group: null, switchGroup: null, counts: false, workDay: 1 };
  // 明け
  return { state: 'ake', streakWork: true, single: 'R', runRest: false, group: null, switchGroup: null, counts: false, workDay: 0 };
}

export function isRestKind(value) {
  return Boolean(value && REST_KINDS.has(value.kind));
}
