// 測り G（docs/じっくり作る案.md の 5 章）：50人×31日で、候補ごとに1本が使うメモリのいちばん多い所を測る。
// 使い方: node tools/careful-memory.mjs [--seconds 600] [--jobs 4] [--staff 50] [--year 2026 --month 12]
//   候補ごとに別の node を立ち上げ、その中で careful.js の runCandidate を動かして、終わったときの maxRSS（node の分も入る）を読む。
//   何もしない node の maxRSS も出すので、差がおおよその計算の分。4本ぶん（いちばん多い候補 × 4）が 1GB 以下かを見る
//   あわせて、HiGHS の WebAssembly のメモリのいちばん大きくなったときの大きさも出す（WebAssembly.instantiate を包んで、できたメモリを見る。
//   段ごとに HiGHS を読み込み直すので、次を読み込むとき（前のものは解き終わっている）と最後に、その大きさを読む）。本数の上限は2つの大きいほうで決める
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSample } from './make-sample.mjs';
import { CANDIDATES } from '../app/js/solver/careful.js';
import { ROOT, gitCommit } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const SECONDS = Number(argOf('seconds', 600));
const STAFF = Number(argOf('staff', 50));
const YEAR = Number(argOf('year', 2026));
const MONTH = Number(argOf('month', 12));
const self = fileURLToPath(import.meta.url);

async function monthData() {
  const d = await makeSample({ seed: STAFF * 100 + MONTH, staff: STAFF, year: YEAR, month: MONTH });
  d.month.requests = {};
  return d;
}

if (process.argv.includes('--child')) {
  const role = argOf('child', 'a');
  let lastMemory = null;
  let wasmMax = 0;
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
  if (role !== 'none') {
    const { runCandidate } = await import('../app/js/solver/careful.js');
    const highsLoader = (await import('../vendor/highs/highs.mjs')).default;
    const seed = 1 + (CANDIDATES.find((c) => c.id === role)?.seedAdd ?? 0);
    await runCandidate(await monthData(), { role, seed, seconds: SECONDS, quickSeconds: 60, loadHighs: () => highsLoader(), post: () => {} });
  }
  note();
  process.stdout.write(JSON.stringify({ role, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), wasmMaxMB: Math.round((wasmMax / 1024 / 1024) * 10) / 10 }));
  process.exit(0);
}

const runChild = (role) => new Promise((resolve) => {
  const p = spawn(process.execPath, [self, '--child', role, '--seconds', String(SECONDS), '--staff', String(STAFF), '--year', String(YEAR), '--month', String(MONTH)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (b) => {
    out += b;
  });
  p.on('close', () => resolve(JSON.parse(out || '{}')));
});

const roles = ['none', ...CANDIDATES.map((c) => c.id)];
const jobs = Number(argOf('jobs', 4));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (next < roles.length) {
    const role = roles[next];
    next += 1;
    results.push(await runChild(role));
  }
}));
const base = results.find((x) => x.role === 'none')?.maxRssMB ?? 0;
mkdirSync(join(ROOT, 'tools', 'out'), { recursive: true });
const roleRows = results.filter((y) => y.role !== 'none');
console.log(`${STAFF}人×${YEAR}年${MONTH}月・${SECONDS}秒`);
for (const x of roleRows) console.log(`${x.role}：${x.maxRssMB}MB（何もしない node ${base}MB を引くと ${x.maxRssMB - base}MB）・HiGHS の WebAssembly のメモリ いちばん大きいとき ${x.wasmMaxMB}MB`);
const worst = Math.max(...roleRows.map((y) => Math.max(y.maxRssMB - base, y.wasmMaxMB)));
console.log(`いちばん多い候補（2つの大きいほう）× 4 ＝ ${Math.round(worst * 4)}MB → ${worst * 4 <= 1024 ? '1GB 以下' : '1GB を超える（本数の上限を下げる）'}`);
writeFileSync(join(ROOT, 'tools', 'out', `careful-memory-${STAFF}-${YEAR}-${MONTH}.json`), JSON.stringify({ commit: gitCommit(), seconds: SECONDS, staff: STAFF, year: YEAR, month: MONTH, results }, null, 2));
