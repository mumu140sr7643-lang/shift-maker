// 見本の「ちょうど良くきつい月」の目安を確かめる道具（docs/自動で作る案.md の 9 章。決め方は CLAUDE.md）。作り物のデータだけ。
// 使い方: node tools/sample-gate.mjs [--year 2026 --month 11 | --months 12] [--jobs 3] [--only time60,nodes,time20] [--kinds restaurant,retail,care] [--soft-warm on|off] [--soft-effort 1]
// 見本のファイルを tools/out/gate/ に書き、tools/solve.mjs を別のプロセスで同時に動かし、できた表を check.js で数えた数を集める。
//   time60：--time 60 を同じ条件で3回     → 6連勤以上 0・絶対 1〜3・できれば 5〜20 に3回とも入る
//   nodes ：--nodes 2000 × 種 1・2・3      → 6連勤以上 0・絶対 1〜3 に3回とも入る（できれば は並べて出すだけ）
//   time20：--time 20 を1回               → 6連勤以上 0・絶対 1〜3（できれば は並べて出すだけ）
// 時間で区切るものは、同時に動かす数（--jobs）が多いと答えが悪くなる（パソコンが混むため）。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildSample } from '../app/js/samples.js';
import { canonicalJSON } from '../app/js/model.js';
import { ROOT } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const year = Number(argOf('year', 2026));
const month = Number(argOf('month', 11));
const jobs = Number(argOf('jobs', 3));
const only = argOf('only', 'time60,nodes,time20').split(',');
const kinds = argOf('kinds', 'restaurant,retail,care').split(',');
const softWarm = argOf('soft-warm', null); // 'on' | 'off' | null（stages.js の決めたとおり）
const softEffort = argOf('soft-effort', null); // 「できれば」の段の HiGHS の mip_heuristic_effort（null なら stages.js の決めたとおり）
const tag = [softWarm ? `soft-${softWarm}` : '', softEffort ? `effort-${softEffort}` : ''].filter(Boolean).join('-');
const OUT = join(ROOT, 'tools', 'out', tag ? `gate-${tag}` : 'gate');
mkdirSync(OUT, { recursive: true });

const GATES = {
  time60: { runs: [1, 2, 3].map((n) => ({ label: `60秒 ${n}回目`, args: ['--time', '60'] })), soft: true },
  nodes: { runs: [1, 2, 3].map((s) => ({ label: `調べる数2000 種${s}`, args: ['--nodes', '2000', '--seed', String(s)] })), soft: false },
  time20: { runs: [{ label: '20秒', args: ['--time', '20'] }], soft: false },
};

// --months 12 なら、2026年11月〜2027年10月の12か月（見本はアプリを開いた日の次の月で作るため）
const months = argOf('months', null) === '12'
  ? Array.from({ length: 12 }, (_, i) => [2026 + Math.floor((10 + i) / 12), ((10 + i) % 12) + 1])
  : [[year, month]];
const tasks = [];
for (const kind of kinds) {
  for (const [y, m] of months) {
    const file = join(OUT, `${kind}-${y}-${m}.json`);
    writeFileSync(file, canonicalJSON(buildSample(kind, y, m)));
    for (const g of only) {
      GATES[g].runs.forEach((r, i) => tasks.push({ kind, gate: g, label: `${y}年${m}月 ${r.label}`, file, args: r.args, out: join(OUT, `${kind}-${y}-${m}-${g}-${i + 1}`) }));
    }
  }
}

function run(task) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const extra = [...(softWarm ? ['--soft-warm', softWarm] : []), ...(softEffort ? ['--soft-effort', softEffort] : [])];
    const p = spawn(process.execPath, [join(ROOT, 'tools', 'solve.mjs'), task.file, ...task.args, ...extra, '--out', task.out], { stdio: 'ignore' });
    p.on('close', () => {
      const countFile = join(task.out, 'count.json');
      const c = existsSync(countFile) ? JSON.parse(readFileSync(countFile, 'utf8')) : null;
      const st = JSON.parse(readFileSync(join(task.out, 'stages.json'), 'utf8'));
      const hardRules = c ? Object.entries(c.byRule).filter(([, v]) => v.strength === 'hard' && v.count).map(([k, v]) => `${k}:${v.count}`) : [];
      const softRules = c ? Object.entries(c.byRule).filter(([, v]) => v.strength === 'soft' && v.count).map(([k, v]) => `${k}:${v.count}`) : [];
      resolve({ ...task, seconds: Math.round((Date.now() - t0) / 1000), totals: c?.totals ?? null, hardRules, softRules, stages: st.stages.map((s) => s.status) });
    });
  });
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
  while (next < tasks.length) {
    const task = tasks[next];
    next += 1;
    const r = await run(task);
    results.push(r);
    console.log(`${r.kind} ${r.label}: ${r.totals ? `6連勤以上 ${r.totals.sixPlus}・絶対 ${r.totals.hard}・できれば ${r.totals.soft}` : '作れなかった'}（${r.seconds}秒・段 ${r.stages.join(',')}）${r.hardRules.length ? ` 絶対の内訳 ${r.hardRules.join(' ')}` : ''}${r.softRules.length ? ` できればの内訳 ${r.softRules.join(' ')}` : ''}`);
  }
}));

const inRange = (r, soft) => r.totals && r.totals.sixPlus === 0 && r.totals.hard >= 1 && r.totals.hard <= 3 && (!soft || (r.totals.soft >= 5 && r.totals.soft <= 20));
const summary = [];
for (const kind of kinds) {
  for (const g of only) {
    const rs = results.filter((r) => r.kind === kind && r.gate === g);
    const want = { restaurant: 2, retail: 1, care: 1 }[kind];
    summary.push({
      kind,
      gate: g,
      pass: rs.every((r) => inRange(r, GATES[g].soft)),
      hardAsPlanned: rs.every((r) => r.totals && r.totals.sixPlus === 0 && (want === undefined || r.totals.hard === want)),
      softInRange: rs.filter((r) => r.totals && r.totals.soft >= 5 && r.totals.soft <= 20).length,
      runs: rs.length,
      totals: rs.map((r) => r.totals),
    });
  }
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ year, month, jobs, summary, results }, null, 2));
console.log('');
for (const s of summary) console.log(`${s.pass ? '○' : '×'} ${s.kind} ${s.gate}（6連勤以上0・絶対が決めた件数：${s.hardAsPlanned ? 'いつも' : 'ちがう回あり'}、できれば 5〜20：${s.softInRange}/${s.runs}回）: ${s.totals.map((t) => (t ? `${t.sixPlus}/${t.hard}/${t.soft}` : '-')).join('  ')}`);
console.log('（数は 6連勤以上/絶対/できれば）');
