// CP-SAT に式が正しく移ったかの確かめ（docs/OR-Tools の試し.md の 2 章）。作り物のデータだけ。
// 使い方: node tools/cpsat-same.mjs [--months 8] [--nodes 2000] [--time 90] [--workers 4]
//   とても小さめの月（6〜12人。希望あり）で、段ごとに HiGHS（調べる数 --nodes。同じ答えになる）で解き、次の2つを確かめる。
//   (1) 入れる確かめ（解かないで済む）：HiGHS の各段の答え（変数の値）を CP-SAT の式にそのまま入れて、全部の式を満たすか・上限の中か・
//       段の量が HiGHS と同じか。そのまま入らないとき（HiGHS では、その段で重みの無い量の変数が小数をとれる）は、2択の変数を HiGHS の値に決めて、
//       量の変数だけを CP-SAT に選ばせ、段の量が HiGHS 以下になるか。どちらもだめなら、CP-SAT の式が「きつすぎる」（本当の答えを外す）。
//   --from 2 なら、2つ目の月から（1つだけ回し直すとき）。量の比べは 1e-4 まで同じとみる（HiGHS の小数のずれ）。
//   (2) 解く確かめ：CP-SAT で6段を解き、前の段までの量が両方で同じあいだ、段ごとに比べる。
//       HiGHS が「解ききった」段で CP-SAT の量がそれより小さい → 式が「ゆるすぎる」。両方が解ききって量が違う → まちがい。
//       CP-SAT が時間内に言い切れず、量が大きいだけ → まちがいではない（そこから先は上限が違うので比べない）。
//       量の変数の上限を4倍にしたほうが小さい量になった → 上限が答えを切っている。上限にぴったり当たった値が無いかも見る。
import { makeSample } from './make-sample.mjs';
import { cpsatFile, runPython } from './cpsat.mjs';
import { buildModel } from '../app/js/solver/build.js';
import { monthDays } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const linJson = (l) => ({ c: l.c, t: [...l.t] });
const valueOf = (lin, values) => {
  let v = lin.c;
  for (const [name, k] of lin.t) v += k * (values.get(name) ?? 0);
  return v;
};

// stages.js の runLp と同じ解き方（前処理の番号 9 を止める・差 0・種 1・線 1本）
function runLp(highs, text, options) {
  const model = highs.createModel({ format: 'lp', data: text });
  try {
    for (const [k, v] of Object.entries(options)) model.raw.setOptionValue(k, v);
    const n = model.getDimensions().numCols;
    const names = [];
    for (let i = 0; i < n; i += 1) names.push(model.getColName(i));
    model.run();
    const code = model.getModelStatus();
    const objective = model.getObjectiveValue();
    let values = null;
    if (![8, 9].includes(code) && Number.isFinite(objective) && Math.abs(objective) < 1e20) {
      const col = model.getSolution().colValue;
      values = new Map(names.map((nm, i) => [nm, col[i]]));
    }
    return { code, values };
  } finally {
    model.dispose();
  }
}

// HiGHS で段ごとに解き、段ごとの答え（変数の値）を残す
async function highsStages(model, nodes) {
  const out = [];
  const bounds = [];
  for (const st of model.stages) {
    const res = runLp(await highsLoader(), model.lp(st.objective, bounds), { output_flag: false, mip_rel_gap: 0, random_seed: 1, threads: 1, presolve: 'on', presolve_rule_off: 1 << 9, mip_max_nodes: nodes });
    if (!res.values) break;
    const value = Math.round(valueOf(st.objective, res.values) * 1e6) / 1e6;
    out.push({ key: st.key, name: st.name, status: res.code === 7 ? 'solved' : 'limit', value, values: res.values, bounds: bounds.map((b) => ({ objective: linJson(b.objective), max: b.max })), objective: linJson(st.objective) });
    bounds.push({ objective: st.objective, max: value });
  }
  return out;
}

const months = arg('months', 8);
const from = arg('from', 1);
// HiGHS の値の小数のずれ（9.999996 など）は同じとみる
const EPS = 1e-4;
const nodes = arg('nodes', 2000);
const time = arg('time', 90);
const workers = arg('workers', 4);
const problems = [];
const tally = { direct: 0, fixed: 0, checks: 0, compared: 0, sameValue: 0 };
for (let seed = from; seed <= months; seed += 1) {
  const d = await makeSample({ seed: 700 + seed, staff: 6 + (seed % 7) });
  const model = buildModel(d);
  const hs = await highsStages(model, nodes);
  // (1) 入れる確かめ
  const ub = monthDays(d) * Math.max(1, d.staff.length);
  const ck = await runPython({ mode: 'check', lp: model.lp(model.stages[0].objective, []), ub, workers, checks: hs.map((h) => ({ objective: h.objective, bounds: h.bounds, values: Object.fromEntries(h.values), value: h.value })) });
  if (!ck.ok) problems.push(`月 ${seed}：入れる確かめが動かなかった（${ck.error}）`);
  const kinds = [];
  for (const [i, c] of (ck.checks ?? []).entries()) {
    tally.checks += 1;
    if (c.direct) {
      tally.direct += 1;
      kinds.push('そのまま');
    } else if (c.violated === 0 && c.domainOut === 0 && c.offgrid === 0) {
      problems.push(`月 ${seed} の段 ${hs[i].name}：そのまま入ったのに段の量が違う（HiGHS ${c.highs}・CP-SAT の式 ${c.objective}）`);
      kinds.push('×');
    } else if (c.fixed && ['OPTIMAL', 'FEASIBLE'].includes(c.fixed.status) && c.fixed.objective <= c.highs + 1e-4) {
      tally.fixed += 1;
      kinds.push(`2択を決めて（破れた式 ${c.violated}・細かさ ${c.offgrid}）`);
    } else {
      problems.push(`月 ${seed} の段 ${hs[i].name}：HiGHS の答えが CP-SAT の式に入らない（破れた式 ${c.violated}・上限の外 ${c.domainOut}・細かさ ${c.offgrid}・2択を決めて ${c.fixed?.status} ${c.fixed?.objective}・HiGHS ${c.highs}・細かさの合わない変数 ${JSON.stringify(c.offNames)}）`);
      kinds.push('×');
    }
  }
  // (2) 解く確かめ
  const c1 = (await cpsatFile(d, { workers, time, seed: 1 })).solved;
  const c4 = (await cpsatFile(d, { workers, time, seed: 1, ubTimes: 4 })).solved;
  if (!c1.ok) {
    problems.push(`月 ${seed}：CP-SAT で作れなかった（${c1.reason}${c1.error ? ` ${c1.error}` : ''}）`);
    continue;
  }
  let n = 0;
  for (let i = 0; i < hs.length; i += 1) {
    const a = hs[i];
    const b = c1.stages[i];
    const w = c4.ok ? c4.stages[i] : null;
    if (!b || a.key !== b.key) {
      problems.push(`月 ${seed}：段の並びが違う（${a.key} と ${b?.key}）`);
      break;
    }
    n += 1;
    const diff = b.value - a.value;
    if (a.status === 'solved' && diff < -EPS) problems.push(`月 ${seed} の段 ${a.name}：HiGHS が解ききった ${a.value} より、CP-SAT の ${b.value} が小さい`);
    if (a.status === 'solved' && b.status === 'solved' && Math.abs(diff) > EPS) problems.push(`月 ${seed} の段 ${a.name}：両方解ききったのに HiGHS ${a.value}・CP-SAT ${b.value}`);
    if (b.status === 'solved' && a.status !== 'solved' && diff > EPS) problems.push(`月 ${seed} の段 ${a.name}：CP-SAT が解ききった ${b.value} より、HiGHS の ${a.value} が小さい`);
    // 上限を広げたほうが小さい量を見つけたら、上限が本当の答えを切っている
    if (w && w.value < b.value - EPS && b.status === 'solved') problems.push(`月 ${seed} の段 ${a.name}：上限を4倍にしたら ${b.value} → ${w.value}（上限が答えを切った）`);
    if (w && w.status === 'solved' && b.status === 'solved' && Math.abs(w.value - b.value) > EPS) problems.push(`月 ${seed} の段 ${a.name}：上限を4倍にしたら ${b.value} → ${w.value}`);
    tally.sameValue += Math.abs(diff) < EPS ? 1 : 0;
    if (Math.abs(diff) > EPS || (w && Math.abs(w.value - b.value) > EPS)) break;
  }
  tally.compared += n;
  if (c1.ubHits?.length) problems.push(`月 ${seed}：量の変数が上限にぴったり当たった（${c1.ubHits.slice(0, 3).join(' ')}）`);
  console.log(`月 ${seed}（${d.staff.length}人）：入れる確かめ ${kinds.join('／')}　解く確かめ 比べた段 ${n}/${hs.length}（HiGHS ${hs.map((s) => s.status).join(',')}／CP-SAT ${c1.stages.map((s) => s.status).join(',')}）`);
}
console.log(`入れる確かめ：段 ${tally.checks}（そのまま入った ${tally.direct}・2択を決めて入った ${tally.fixed}）`);
console.log(`解く確かめ：比べた段 ${tally.compared}（量が同じだった段 ${tally.sameValue}）`);
for (const p of problems) console.log(`× ${p}`);
console.log(problems.length ? `問題 ${problems.length}` : '問題 0');
process.exit(problems.length ? 1 : 0);
