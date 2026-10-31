// 締め直し（docs/じっくり作る案.md の 6 章）の足しの確かめ（測り F の足し。2026-10-31 確かめ役と決めた）。作り物のデータだけ。
// 使い方: node tools/tighten-check.mjs [--time 3] [--nodes 0] [--first] [--seeds 1,2,3] [--stress 0] [--two-off] [--out tools/out/tighten-check.json]
//   作り物 12通り（solve-bench --sizes と同じ月）× 種を、短い時間で区切って締め直しありで解く（「絶対」の段を時間切れにするため）。
//   「絶対」の段は短い時間でも、調べる数 1 でもほとんど解ききる。--first で「できれば」より前の段を、HiGHS がはじめに見つけた答えで止める
//   （mip_max_improving_sols 1。確かめの道具だけの設定）。締め直しは、この設定も調べる数の上限も外して解く。
//   --stress N で、乱数の月（solve-stress.mjs と同じ作り方）を N か月足す。
//   --two-off で、どの月も3人に1人を「遅い→早いの間は2連休」にする（作り物の月には、この設定の人がいないため）。確かめること：
//   (1) 締め直した量 ≦ 締め直す前の量
//   (2) 締め直した直後の、その段の決まりの量（式）＝ その時点の表を check.js で数えた量（正しく数える決まりだけ。2択を決めたので、ぴったり同じになるはず）
//   (3) 最後の表で、解ききった段の決まりは 式の量 ＝ 検査の量、解ききっていない段の決まりは 式の量 ≧ 検査の量（測り F と同じ）
//   あわせて、締め直しの回数（量が減った回数）と段、前の段の答えのままにした段（kept）、段1で答えが無い月を数える（止まらずに進むか）
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkTable } from '../app/js/check.js';
import { solveStaged } from '../app/js/solver/stages.js';
import { clone } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';
import { makeSample } from './make-sample.mjs';
import { stressData } from './solve-stress.mjs';
import { compareAmounts } from './solve.mjs';
import { ROOT, gitCommit } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const TIME = Number(argOf('time', 3));
const NODES = Number(argOf('nodes', 0)) || null;
const FIRST = process.argv.includes('--first');
const SEEDS = argOf('seeds', '1,2,3').split(',').map(Number);
const STRESS = Number(argOf('stress', 0));
const TWO_OFF = process.argv.includes('--two-off');
const OUT = argOf('out', join(ROOT, 'tools', 'out', 'tighten-check.json'));
const loadHighs = () => highsLoader();

const months = [];
for (const staff of [8, 15, 25, 50]) {
  for (const [y, m] of [[2027, 2], [2026, 11], [2026, 12]]) {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    d.month.requests = {};
    months.push({ id: `made-${staff}-${y}-${m}`, data: d });
  }
}
for (let s = 1; s <= STRESS; s += 1) months.push({ id: `stress-${s}`, data: await stressData(s) });
if (TWO_OFF) {
  for (const it of months) {
    it.data.staff.forEach((p, i) => {
      p.twoOffAfterLateEarly = i % 3 === 0;
    });
  }
}

const out = { commit: gitCommit(), time: TIME, nodes: NODES, first: FIRST, seeds: SEEDS, twoOff: TWO_OFF, runs: 0, conflict: 0, noAnswer: [], kept: [], tries: 0, applied: 0, stages: {}, breaks: [], approx: [], unchecked: {}, finalLoose: 0 };
const resOf = (data, table) => checkTable({ ...data, month: { ...data.month, table } });
for (const it of months) {
  for (const seed of SEEDS) {
    const tables = new Map();
    const r = await solveStaged(clone(it.data), {
      loadHighs,
      timeLimit: TIME,
      nodeLimit: NODES,
      hardOptions: FIRST ? { mip_max_improving_sols: 1 } : {},
      seed,
      tighten: true,
      onProgress: (p) => {
        if (p.phase === 'done' && p.table) tables.set(p.stage, p.table);
      },
    });
    out.runs += 1;
    const where = `${it.id} 種${seed}`;
    if (r.reason === 'conflict') {
      out.conflict += 1;
      continue;
    }
    if (!r.ok && r.stages[0]?.status === 'none') out.noAnswer.push(where);
    r.stages.forEach((st, i) => {
      if (st.status === 'kept') out.kept.push(`${where} ${st.key}`);
      const tg = st.tightened;
      if (!tg) return;
      out.tries += 1;
      if (tg.applied) {
        out.applied += 1;
        out.stages[st.key] = (out.stages[st.key] ?? 0) + 1;
      }
      // (1)
      if (!(tg.to <= tg.from + 1e-9)) out.breaks.push(`${where} ${st.key}：締め直した量 ${tg.to} が前の量 ${tg.from} より大きい`);
      // (2) その段の答えの表（締め直したあと）を check.js で数えて、その段の決まりの量とぴったり比べる
      const table = tables.get(i + 1);
      if (!table) {
        out.breaks.push(`${where} ${st.key}：締め直した段の表が届いていない`);
        return;
      }
      const cmp = compareAmounts({ amounts: tg.amounts, stages: [{ rules: st.rules, status: 'solved' }] }, resOf(it.data, table), it.data);
      for (const rule of st.rules) {
        if (cmp.exact[rule]) {
          if (!cmp.exact[rule].same) out.breaks.push(`${where} ${st.key} ${rule}：締め直した直後の式 ${cmp.exact[rule].solver}・検査 ${cmp.exact[rule].check}`);
        } else if (cmp.approx[rule]) out.approx.push(`${where} ${st.key} ${rule}：式 ${tg.amounts[rule]}・検査 ${cmp.approx[rule].check}`);
        else out.unchecked[rule] = (out.unchecked[rule] ?? 0) + 1;
      }
    });
    // (3) 最後の表（測り F と同じ見方）
    if (r.ok) {
      const cmp = compareAmounts(r, resOf(it.data, r.table), it.data);
      for (const [k, v] of Object.entries(cmp.exact)) {
        if (!v.same) out.breaks.push(`${where} 最後の表 ${k}：式 ${v.solver}・検査 ${v.check}${v.loose ? '（解ききっていない段）' : ''}`);
        else if (v.loose && v.solver > v.check + 1e-6) out.finalLoose += 1;
      }
    }
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
const stageCount = Object.keys(out.stages).length;
console.log(`コミット ${out.commit.commit}${out.commit.dirty ? '（コミットしていない変更あり）' : ''}・${TIME}秒${NODES ? `・調べる数 ${NODES}` : ''}${FIRST ? '・はじめの答えで止める' : ''}${TWO_OFF ? '・3人に1人が2連休の設定' : ''}・回 ${out.runs}（解く前のぶつかり ${out.conflict}）`);
console.log(`締め直し：解き直し ${out.tries}回・量が減った ${out.applied}回（${JSON.stringify(out.stages)}）→ ${out.applied >= 20 && stageCount >= 2 ? '20回以上・2つ以上の段で起きた' : '足りない（時間を短くするか、乱数の月を足す）'}`);
console.log(`前の段の答えのままにした段 ${out.kept.length}・段1で答えが無い月 ${out.noAnswer.length}（どちらも止まらずに進めばよい）`);
console.log(`近い形で数える決まり（違ってよい）${out.approx.length}・比べていない決まり ${JSON.stringify(out.unchecked)}・最後の表で 式 > 検査 だった解ききっていない段の決まり ${out.finalLoose}`);
console.log(`破れ ${out.breaks.length}`);
for (const b of out.breaks.slice(0, 20)) console.log(`  ${b}`);
process.exit(out.breaks.length ? 1 : 0);
