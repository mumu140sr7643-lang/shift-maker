// CP-SAT に式が正しく移ったかの確かめ（docs/OR-Tools の試し.md の 2 章）。作り物のデータだけ。
// 使い方: node tools/cpsat-same.mjs [--months 12] [--nodes 2000] [--time 60] [--workers 8]
//   とても小さめの月（6〜12人。希望あり）で、HiGHS（調べる数 --nodes。同じ答えになる）と CP-SAT を、同じ段の式で解く。
//   はじめの段から順に、両方が「解ききった」段どうしの最小値が同じか（式の量 ＝ 式の量）を比べる。
//   どちらかが解ききらなかった段から先は、上限が違ってくるので比べない（何段目まで比べたかを出す）。
//   あわせて、量の変数の上限を「日数 × 人数」の4倍に広げても同じ最小値になるか、上限にぴったり当たった値が無いかも見る。
import { makeSample } from './make-sample.mjs';
import { cpsatFile } from './cpsat.mjs';
import { solveStaged } from '../app/js/solver/stages.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const months = arg('months', 12);
const nodes = arg('nodes', 2000);
const time = arg('time', 60);
const workers = arg('workers', 8);
const problems = [];
let compared = 0;
for (let seed = 1; seed <= months; seed += 1) {
  const d = await makeSample({ seed: 700 + seed, staff: 6 + (seed % 7) });
  const h = await solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: nodes, seed: 1 });
  const c1 = (await cpsatFile(d, { workers, time, seed: 1 })).solved;
  const c4 = (await cpsatFile(d, { workers, time, seed: 1, ubTimes: 4 })).solved;
  const line = [`月 ${seed}（${d.staff.length}人）`];
  if (!h.ok || !c1.ok) {
    if (h.ok !== c1.ok) problems.push(`月 ${seed}：HiGHS ${h.ok ? '作れた' : h.reason}・CP-SAT ${c1.ok ? '作れた' : c1.reason}`);
    console.log(`${line[0]}：作れなかった（HiGHS ${h.reason ?? 'ok'}・CP-SAT ${c1.reason ?? 'ok'}${c1.error ? ` ${c1.error}` : ''}）`);
    continue;
  }
  let n = 0;
  for (let i = 0; i < h.stages.length; i += 1) {
    const a = h.stages[i];
    const b = c1.stages[i];
    const w = c4.stages[i];
    if (!b || a.key !== b.key) {
      problems.push(`月 ${seed}：段の並びが違う（${a.key} と ${b?.key}）`);
      break;
    }
    if (a.status !== 'solved' || b.status !== 'solved') break;
    n += 1;
    if (Math.abs(a.value - b.value) > 1e-6) problems.push(`月 ${seed} の段 ${a.name}：HiGHS ${a.value}・CP-SAT ${b.value}`);
    if (w?.status === 'solved' && Math.abs(w.value - b.value) > 1e-6) problems.push(`月 ${seed} の段 ${a.name}：上限を4倍にしたら ${b.value} → ${w.value}`);
  }
  compared += n;
  if (c1.ubHits?.length) problems.push(`月 ${seed}：量の変数が上限にぴったり当たった（${c1.ubHits.slice(0, 3).join(' ')}）`);
  console.log(`${line[0]}：比べた段 ${n}/${h.stages.length}（HiGHS ${h.stages.map((s) => s.status).join(',')}／CP-SAT ${c1.stages.map((s) => s.status).join(',')}）`);
}
console.log(`比べた段 ${compared}`);
for (const p of problems) console.log(`× ${p}`);
console.log(problems.length ? `問題 ${problems.length}` : '問題 0');
process.exit(problems.length ? 1 : 0);
