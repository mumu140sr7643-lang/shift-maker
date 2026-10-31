// 測り G2（docs/じっくり作る案.md の 5 章。報告だけで、合否にしない）：候補 い の解き方（種 2・締め直しあり）で合計 570秒、
// 「できれば」の段を区切る（120秒）・区切らない を比べる。月は 15人×2026年11月・25人×2026年12月・50人×2026年12月（測り G と同じ作り方）。
// 使い方: node tools/careful-rounds.mjs [--seconds 570] [--jobs 6]
//   1回ずつ別の node で動かし、HiGHS の WebAssembly のメモリのいちばん大きいとき（careful-memory.mjs と同じ読み方）と、HiGHS が止まった回（onAbort）を読む。
//   書くもの：「できれば」の段の最後の量・段の状態・番号（区切る回は回ごとの番号と、良くなった回）・できた表の件数（6連勤以上/絶対/できれば）
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, gitCommit, errorCount } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const SECONDS = Number(argOf('seconds', 570));
const ROUND = 120;
const self = fileURLToPath(import.meta.url);

if (process.argv.includes('--child')) {
  const [staff, year, month] = argOf('child', '15,2026,11').split(',').map(Number);
  const round = Number(argOf('round', 0)) || null;
  let lastMemory = null;
  let wasmMax = 0;
  let aborts = 0;
  const note = () => {
    if (lastMemory) wasmMax = Math.max(wasmMax, lastMemory.buffer.byteLength);
  };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...args) => {
    const made = await instantiate.apply(WebAssembly, args);
    note();
    lastMemory = Object.values((made.instance ?? made).exports).find((x) => x instanceof WebAssembly.Memory) ?? null;
    return made;
  };
  const { makeSample } = await import('./make-sample.mjs');
  const { solveStaged } = await import('../app/js/solver/stages.js');
  const { checkTable } = await import('../app/js/check.js');
  const highsLoader = (await import('../vendor/highs/highs.mjs')).default;
  const d = await makeSample({ seed: staff * 100 + month, staff, year, month });
  d.month.requests = {};
  const r = await solveStaged(d, { loadHighs: () => highsLoader({ onAbort: () => { aborts += 1; } }), timeLimit: SECONDS, seed: 2, tighten: true, softRound: round });
  note();
  const soft = r.stages?.find((s) => s.key === 'soft');
  const totals = r.ok ? checkTable({ ...d, month: { ...d.month, table: r.table } }).totals : null;
  process.stdout.write(JSON.stringify({
    staff, year, month, round, ok: r.ok, seconds: r.seconds,
    soft: soft ? { value: soft.value, status: soft.status, code: soft.code, seconds: soft.seconds, roundCodes: soft.roundCodes ?? null, roundBetter: soft.roundBetter ?? null } : null,
    totals: totals ? `${totals.sixPlus}/${totals.hard}/${totals.soft}` : null,
    wasmMaxMB: Math.round((wasmMax / 1024 / 1024) * 10) / 10, aborts, errors: errorCount(r.stages),
  }));
  process.exit(0);
}

const runChild = (m, round) => new Promise((resolve) => {
  const p = spawn(process.execPath, [self, '--child', m.join(','), '--round', String(round), '--seconds', String(SECONDS)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (b) => {
    out += b;
  });
  p.on('close', () => resolve(JSON.parse(out || '{}')));
});

const tasks = [];
for (const m of [[15, 2026, 11], [25, 2026, 12], [50, 2026, 12]]) for (const round of [ROUND, 0]) tasks.push({ m, round });
const jobs = Number(argOf('jobs', 6));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < tasks.length) {
    const t = tasks[next];
    next += 1;
    results.push(await runChild(t.m, t.round));
  }
}));
results.sort((a, b) => a.staff - b.staff || (b.round ?? 0) - (a.round ?? 0));
mkdirSync(join(ROOT, 'tools', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'out', 'careful-rounds.json'), JSON.stringify({ commit: gitCommit(), seconds: SECONDS, results }, null, 2));
const status = { solved: '解ききった', limit: '時間切れ', kept: '前の段の答えのまま', none: '答えなし' };
for (const x of results) {
  const s = x.soft;
  console.log(`${x.staff}人×${x.year}年${x.month}月・${x.round ? `${x.round}秒ずつ区切る` : '区切らない'}：「できれば」の段 ${s?.value ?? '―'}（${status[s?.status] ?? s?.status}・番号 ${s?.code}・${s?.seconds}秒）${s?.roundCodes ? `・回 ${s.roundCodes.length}（番号 ${s.roundCodes.join(',')}・良くなった回 ${s.roundBetter.join(',') || 'なし'}）` : ''}・表 ${x.totals}・WebAssembly のメモリ いちばん大きいとき ${x.wasmMaxMB}MB・止まった ${x.aborts}回・番号 −1 ${x.errors}回`);
}
