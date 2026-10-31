// 「変えないもの」の確かめ（docs/じっくり作る案.md の 5 章 A）。作り物のデータだけ。
// 1分で作る・エラーを自動で直す（上限 10・25・50）・途中から作り直す（15日から）の答えを、調べる数で区切って書き出す。
// 前の版と比べるとき:
//   git worktree add 前の版を置くフォルダ 59660b5
//   node tools/solver-same.mjs --root 前の版を置くフォルダ --out tools/out/same-old
//   node tools/solver-same.mjs --out tools/out/same-new
//   node tools/compare.mjs tools/out/same-old tools/out/same-new
// 月：作り物 12通り（solve-bench --sizes と同じ）＋見本3つ × 2026年11月・2027年5月。種 1・2・3、調べる数 --nodes（はじめは 50）。
// 入れるデータは、どちらの版で回しても、この道具（いまの版）で作る。答えの秒は書かない（パソコンで変わるため）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT } from './lib.mjs';
import { makeSample } from './make-sample.mjs';
import { buildSample } from '../app/js/samples.js';
import { canonicalJSON, clone } from '../app/js/model.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = resolve(arg('root', ROOT));
const out = resolve(arg('out', join(ROOT, 'tools/out/same')));
const nodes = Number(arg('nodes', 50));
const jobs = Number(arg('jobs', 8));

async function inputs() {
  const list = [];
  for (const staff of [8, 15, 25, 50]) {
    for (const [y, m] of [[2027, 2], [2026, 11], [2026, 12]]) {
      const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
      d.month.requests = {};
      list.push({ id: `made-${staff}-${y}-${m}`, data: d });
    }
  }
  for (const kind of ['restaurant', 'retail', 'care']) for (const [y, m] of [[2026, 11], [2027, 5]]) list.push({ id: `sample-${kind}-${y}-${m}`, data: buildSample(kind, y, m) });
  return list;
}

// 秒を消す（パソコンで変わるため）
const noSeconds = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'seconds' ? undefined : x)));

async function one(item, seed) {
  const { solveStaged } = await import(pathToFileURL(join(root, 'app/js/solver/stages.js')).href);
  const { solveRepair, prepareRestart } = await import(pathToFileURL(join(root, 'app/js/solver/repair.js')).href);
  const highsLoader = (await import(pathToFileURL(join(root, 'vendor/highs/highs.mjs')).href)).default;
  const loadHighs = () => highsLoader();
  const res = { id: item.id, seed, nodes };
  const gen = await solveStaged(clone(item.data), { loadHighs, nodeLimit: nodes, seed });
  res.generate = noSeconds({ ok: gen.ok, reason: gen.reason ?? null, table: gen.table ?? null, stages: gen.stages, amounts: gen.amounts ?? null });
  if (gen.ok) {
    const made = clone(item.data);
    made.month.table = gen.table;
    const rep = await solveRepair(clone(made), { loadHighs, budgets: [10, 25, 50], nodeLimit: nodes, seed });
    res.repair = noSeconds(rep);
    const restart = await solveStaged(prepareRestart(made, 15), { loadHighs, nodeLimit: nodes, seed });
    res.restart = noSeconds({ ok: restart.ok, reason: restart.reason ?? null, table: restart.table ?? null, stages: restart.stages });
  }
  writeFileSync(join(out, `${item.id}-seed${seed}.json`), canonicalJSON(res));
}

const list = await inputs();
const oneArg = arg('one', null);
if (oneArg !== null) {
  const [i, seed] = oneArg.split(':').map(Number);
  await one(list[i], seed);
} else {
  mkdirSync(out, { recursive: true });
  const tasks = list.flatMap((it, i) => [1, 2, 3].map((seed) => `${i}:${seed}`));
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next];
      next += 1;
      await new Promise((ok) => {
        const p = spawn(process.execPath, [process.argv[1], '--root', root, '--out', out, '--nodes', String(nodes), '--one', t], { stdio: 'inherit' });
        p.on('close', ok);
      });
      done += 1;
      if (done % 9 === 0) console.log(`${done}/${tasks.length}（${Math.round((Date.now() - t0) / 1000)}秒）`);
    }
  }));
  console.log(`書き出しました：${tasks.length} ファイル（${out}）`);
}
