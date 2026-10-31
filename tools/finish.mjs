// 仕上げの入れ替え（6-1。docs/じっくり作る案.md の 3 章）を node で動かす道具。作り物のデータだけ。
// 使い方: node tools/finish.mjs 保存したファイル.json [--seconds 25] [--checks 5000] [--out フォルダ]
//   --checks（数える回数の上限）で区切るか、良くなる入れ替えが無くなって止まったときは、同じ表なら1文字も同じ答え。
//   --seconds で区切ると、パソコンの速さで答えが変わる。
// 出すもの：前後の件数・入れた入れ替えの一覧・数えた回数・秒・止まった理由・確かめ（verifyFinish）の結果。
// --out に出すもの：finished.json（仕上げた表を入れたデータ。このアプリで取り込める）・finish.json（上の結果）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseData } from '../app/js/storage.js';
import { checkTable, compareResults } from '../app/js/check.js';
import { RULES, strengthOf } from '../app/js/rules.js';
import { canonicalJSON, clone, cellOf, monthDays, shiftById } from '../app/js/model.js';
import { finishTable, applyMove } from '../app/js/solver/finish.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ---------- 確かめ（finish.js とは別に書いた数え方） ----------

const valueKey = (v) => (!v ? '-' : v.kind === 'shift' ? `s:${v.shift}` : v.kind);

// 出勤（連勤の数え方。数え方の表 1 章：シフト・半休・明け）
const isWork = (v) => v?.kind === 'shift' || v?.kind === 'half' || v?.kind === 'ake';

// 6連勤以上の続き：[{ staff, from, to }]（前の月の終わりの連勤も入れる）
export function sixRunsOf(data, table) {
  const N = monthDays(data);
  const out = [];
  for (const p of data.staff) {
    let from = null;
    let len = 0;
    const close = (to) => {
      if (len >= 6) out.push({ staff: p.id, from, to });
      len = 0;
    };
    for (let d = 1; d <= N; d += 1) {
      if (isWork(table[p.id]?.[d])) {
        if (len === 0) {
          from = d === 1 && p.prevConsecutive > 0 ? 1 - p.prevConsecutive : d;
          len = d === 1 ? p.prevConsecutive : 0;
        }
        len += 1;
      } else if (len) close(d - 1);
    }
    if (len) close(N);
  }
  return out;
}

// 説明書 3 節の「改善したか」の 1〜5（check.js の isImproved とは別に書いたもの）
export function judgeImproved(data, before, after) {
  const hard = RULES.filter((r) => r.id !== 'sixPlus' && strengthOf(data, r.id) === 'hard').map((r) => r.id);
  const on = (id) => strengthOf(data, id) !== 'off';
  const cnt = (res, id) => res.items.filter((it) => it.rule === id).length;
  const amt = (res, id) => (on(id) ? res.items.filter((it) => it.rule === id).reduce((a, it) => a + it.amount, 0) : 0);
  const soft = (res) => res.items.filter((it) => strengthOf(data, it.rule) === 'soft').length;
  const b6 = sixRunsOf(data, before.table);
  const a6 = sixRunsOf(data, after.table);
  const ok1 = hard.every((id) => cnt(after.res, id) <= cnt(before.res, id));
  const ok2 = amt(after.res, 'overStreak') <= amt(before.res, 'overStreak');
  const ok3 = a6.length <= b6.length && a6.every((a) => b6.some((b) => b.staff === a.staff && b.from <= a.from && a.to <= b.to));
  const ok4 = amt(after.res, 'offShort') <= amt(before.res, 'offShort');
  const hardSame = hard.every((id) => cnt(after.res, id) === cnt(before.res, id));
  const less = hard.some((id) => cnt(after.res, id) < cnt(before.res, id))
    || amt(after.res, 'overStreak') < amt(before.res, 'overStreak')
    || a6.length < b6.length
    || amt(after.res, 'offShort') < amt(before.res, 'offShort')
    || (hardSame && soft(after.res) < soft(before.res));
  return { improved: ok1 && ok2 && ok3 && ok4 && less, ok3 };
}

// 仕上げの結果を確かめる。返す：問題の文の一覧（空なら通った）
//   1. 各人の 出勤・公休・有給・余り日 の日数（半休・明けも）が同じ  2. 各日の シフトごとの人数が同じ
//   3. 動かさないマス（固定・希望・半休・空き・明け・夜勤）が同じ  4. 変わったマスに、担当外・日ごとに要るスキルの無い人のシフトが無い
//   5. 入れた入れ替えを1つずつ当て直して、どれも「改善」（judgeImproved）で、並べる順でも良い。6連勤以上を作らない・長くしない・つなげない
//   6. 当て直した表が、返ってきた表と同じ
export function verifyFinish(data, result) {
  const problems = [];
  const N = monthDays(data);
  const t0 = data.month.table;
  const t1 = result.table;
  const who = (pid) => data.staff.find((p) => p.id === pid)?.name || pid;
  for (const p of data.staff) {
    const tally = (t) => {
      const c = { shift: 0, off: 0, paid: 0, spare: 0, half: 0, ake: 0 };
      for (let d = 1; d <= N; d += 1) if (t[p.id]?.[d]) c[t[p.id][d].kind] += 1;
      return JSON.stringify(c);
    };
    if (tally(t0) !== tally(t1)) problems.push(`${who(p.id)}さんの 出勤・休みの日数が変わった（${tally(t0)} → ${tally(t1)}）`);
    for (let d = 1; d <= N; d += 1) {
      const a = t0[p.id]?.[d] ?? null;
      const b = t1[p.id]?.[d] ?? null;
      const locked = data.month.marks[p.id]?.[d]?.locked;
      const req = data.month.requests[p.id]?.[d];
      const night = a?.kind === 'shift' && shiftById(data, a.shift)?.night;
      const fixedKind = !a || a.kind === 'half' || a.kind === 'ake' || night;
      if ((locked || req || fixedKind) && valueKey(a) !== valueKey(b)) problems.push(`${who(p.id)}さんの ${d}日 は動かさないマスなのに変わった（${valueKey(a)} → ${valueKey(b)}）`);
      if (valueKey(a) !== valueKey(b) && b?.kind === 'shift') {
        if (!p.shifts.includes(b.shift)) problems.push(`${who(p.id)}さんの ${d}日 に担当外のシフトが入った`);
        const need = data.month.dailySkill[b.shift]?.[d];
        if (need?.length && !need.some((k) => p.skills.includes(k))) problems.push(`${who(p.id)}さんの ${d}日 に、日ごとに要るスキルの無いシフトが入った`);
      }
    }
  }
  for (let d = 1; d <= N; d += 1) {
    const perShift = (t) => {
      const c = {};
      for (const p of data.staff) {
        const v = t[p.id]?.[d];
        if (v?.kind === 'shift') c[v.shift] = (c[v.shift] ?? 0) + 1;
      }
      return JSON.stringify(Object.entries(c).sort());
    };
    if (perShift(t0) !== perShift(t1)) problems.push(`${d}日 のシフトごとの人数が変わった`);
  }
  // 入れた入れ替えを1つずつ当て直す
  const cur = clone(data);
  let prev = { table: clone(cur.month.table), res: checkTable(cur) };
  for (const [i, mv] of result.moves.entries()) {
    applyMove(cur.month.table, mv);
    const now = { table: clone(cur.month.table), res: checkTable(cur) };
    const j = judgeImproved(data, prev, now);
    if (!j.improved) problems.push(`${i + 1}つ目の入れ替え（${mv.kind} ${who(mv.a)}・${who(mv.b)} ${mv.days.join('・')}日）が、説明書 3 節の「改善」でない${j.ok3 ? '' : '（6連勤以上が増えた・長くなった・つながった）'}`);
    if (!(compareResults(now.res, prev.res) < 0)) problems.push(`${i + 1}つ目の入れ替えが、並べる順で良くなっていない`);
    prev = now;
  }
  if (canonicalJSON(cur.month.table) !== canonicalJSON(t1)) problems.push('入れた入れ替えを当て直した表が、返ってきた表と違う');
  // 6連勤以上の数え方を check.js と突き合わせる（道具の数え方のまちがいを見つけるため）
  const mine = sixRunsOf(data, t1).map((r) => `${r.staff}|${r.from}|${r.to}`).sort().join(' ');
  const theirs = checkTable({ ...data, month: { ...data.month, table: t1 } }).items.filter((it) => it.rule === 'sixPlus').map((it) => `${it.staff}|${it.from}|${it.to}`).sort().join(' ');
  if (mine !== theirs) problems.push(`6連勤以上の数え方が check.js と違う（道具: ${mine || 'なし'} / check.js: ${theirs || 'なし'}）`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.log('使い方: node tools/finish.mjs 保存したファイル.json [--seconds 25] [--checks 5000] [--out フォルダ]');
    process.exit(1);
  }
  const parsed = parseData(readFileSync(file, 'utf8'));
  const data = parsed.data ?? parsed;
  const seconds = arg('seconds') === null ? (arg('checks') === null ? 25 : null) : Number(arg('seconds'));
  const maxChecks = arg('checks') === null ? Infinity : Number(arg('checks'));
  const result = finishTable(data, { seconds, maxChecks });
  const problems = verifyFinish(data, result);
  const name = (pid) => data.staff.find((p) => p.id === pid)?.name || pid;
  const sym = (v) => (!v ? '空き' : v.kind === 'shift' ? shiftById(data, v.shift)?.symbol ?? '?' : { off: '休', paid: '有', spare: '余' }[v.kind] ?? v.kind);
  // 入れ替えの文（1つずつ当てながら、その時点のマスで書く）
  const replay = clone(data);
  const texts = result.moves.map((mv) => {
    const text = `${name(mv.a)}・${name(mv.b)}：${mv.days.map((d) => `${d}日 ${sym(cellOf(replay, mv.a, d))}⇔${sym(cellOf(replay, mv.b, d))}`).join('、')}`;
    applyMove(replay.month.table, mv);
    return text;
  });
  const report = {
    before: result.before,
    after: result.after,
    moves: result.moves.map((mv, i) => ({ ...mv, text: texts[i] })),
    checks: result.checks,
    seconds: result.seconds,
    end: result.end,
    problems,
  };
  console.log(`前：6連勤以上 ${result.before.sixPlus}・絶対 ${result.before.hard}・できれば ${result.before.soft}`);
  console.log(`後：6連勤以上 ${result.after.sixPlus}・絶対 ${result.after.hard}・できれば ${result.after.soft}`);
  console.log(`入れた入れ替え ${result.moves.length}・数えた回数 ${result.checks}・${result.seconds}秒・止まった理由 ${result.end}`);
  for (const m of report.moves) console.log(`  ${m.kind === 'day' ? '同じ日' : 'たすき掛け'} ${m.text}`);
  console.log(problems.length ? `確かめ：問題 ${problems.length}\n${problems.map((p) => `  ${p}`).join('\n')}` : '確かめ：問題 0');
  const out = arg('out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'finished.json'), canonicalJSON({ ...data, month: { ...data.month, table: result.table } }));
    writeFileSync(join(out, 'finish.json'), JSON.stringify(report, null, 2));
  }
  process.exit(problems.length ? 1 : 0);
}
