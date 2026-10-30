// 決まりの一覧と、マスの状態ごとの性質（docs/数え方の表.md の 1 章・2 章）。
// 検査・画面・手引き・自動で作る（v3）は、名前も数え方も、すべてここから引く。画面には触らない。
import { shiftById } from './model.js?v=2.2';

export const STRENGTH_NAMES = { hard: '絶対', soft: 'できれば', off: 'なし', always: 'いつも数える' };

// fixed: 強さを選べない（その強さのまま）。work: 手順1の「勤務の決まり」のチェックと同じ1つの値になる決まり
export const RULES = [
  { id: 'shortage', name: '人員不足', strength: 'hard', group: 'staffing' },
  { id: 'overstaff', name: '定数オーバー', strength: 'soft', group: 'staffing' },
  { id: 'skillShort', name: 'スキル不足', strength: 'hard', group: 'staffing' },
  { id: 'skillTarget', name: 'スキルの目標に届かない', strength: 'soft', group: 'staffing' },
  { id: 'onePerDayDup', name: '1日1人の役が重なる', strength: 'hard', group: 'staffing' },
  { id: 'leaderRank', name: '責任者の順位', strength: 'soft', group: 'staffing' },
  { id: 'specialRank', name: '特別な日に決めた役職の人がいない', strength: 'soft', group: 'staffing' },
  { id: 'dailySkill', name: '日ごとに要るスキルを持たない人が入っている', strength: 'hard', fixed: true, group: 'staffing' },
  { id: 'overStreak', name: '連勤超過', strength: 'hard', group: 'streak' },
  { id: 'sixPlus', name: '6連勤以上', strength: 'always', fixed: true, group: 'streak' },
  { id: 'switchInStreak', name: '連勤中の時間帯の切り替え', strength: 'soft', group: 'streak' },
  { id: 'lateToEarly', name: '遅い→早い（休みなし）', strength: 'hard', work: 'forbidLateToEarly', group: 'time' },
  { id: 'lateOffEarly', name: '遅い→休み→早い', strength: 'soft', group: 'time' },
  { id: 'twoOffLateEarly', name: '遅い→早いの間の2連休が足りない', strength: 'hard', fixed: true, group: 'time' },
  { id: 'switchCount', name: '時間帯の切り替え回数', strength: 'soft', group: 'time' },
  { id: 'bias', name: '早い・遅いの偏り', strength: 'soft', group: 'time' },
  { id: 'groupPref', name: '時間帯の希望と合わない', strength: 'soft', group: 'time' },
  { id: 'singleWork', name: '1日だけの出勤', strength: 'soft', group: 'rest' },
  { id: 'singleOff', name: '1日だけの休み', strength: 'soft', work: 'avoidSingleOff', group: 'rest' },
  { id: 'longRest', name: '連休が長すぎる', strength: 'soft', group: 'rest' },
  { id: 'fewRestRuns', name: '連休の回数が足りない', strength: 'soft', group: 'rest' },
  { id: 'restStyle', name: '休み方の希望と合わない', strength: 'soft', group: 'rest' },
  { id: 'weekend', name: '土日の希望と合わない', strength: 'soft', group: 'rest' },
  { id: 'offShort', name: '公休が足りない', strength: 'hard', group: 'days' },
  { id: 'paidDiff', name: '有給の日数のずれ', strength: 'soft', group: 'days' },
  { id: 'notAssigned', name: '担当外のシフト', strength: 'hard', group: 'cell' },
  { id: 'nightNext', name: '夜勤の次の日が休みでない', strength: 'hard', group: 'cell' },
  { id: 'requestDiff', name: '希望と違う', strength: 'hard', fixed: true, group: 'cell' },
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
    const group = s ? s.group : null;
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
