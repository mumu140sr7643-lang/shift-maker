// じっくり作る（6-2）を node で動かす道具。中身は画面と同じ careful.js（Worker は worker_threads）。
// 使い方: node tools/careful.mjs 保存したファイル.json [--seconds 600] [--workers 4] [--quick 60] [--seed 1] [--out フォルダ]
//   --seed は1分の答えの種（画面では「作った記録の数 + 1」）。い・う・い2 はそれに 1・2・3 を足す
// --out に出すもの：careful.json（候補ごとの結果・選んだ答え・答えの一覧の件数と時刻・この node のいちばん多いメモリ maxRssMB（Worker の分も入る））・
//   answers.json（全部の答えの表。careful-pick.mjs で選び直す）・
//   result.json（選んだ表を入れたデータ。このアプリで取り込める）・count.json（tools/count.mjs と同じ形）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parseData } from '../app/js/storage.js';
import { checkTable } from '../app/js/check.js';
import { canonicalJSON, clone } from '../app/js/model.js';
import { startCareful, CAREFUL_SECONDS } from '../app/js/solver/careful.js';

const WORKER_URL = new URL('./careful-worker.mjs', import.meta.url);

export function nodeWorker() {
  const w = new Worker(WORKER_URL);
  return {
    post: (m) => w.postMessage(m),
    onMessage: (fn) => w.on('message', fn),
    onError: (fn) => {
      w.on('error', fn);
      w.on('exit', (code) => code !== 0 && fn(new Error(`exit ${code}`)));
    },
    terminate: () => w.terminate(),
  };
}

export async function carefulFile(data, { seconds = CAREFUL_SECONDS, workers = 4, quick = 60, seed = 1, onEvent = () => {} } = {}) {
  const job = startCareful(data, { makeWorker: nodeWorker, workers, seconds, quickSeconds: quick, seed, onEvent });
  const r = await job.promise;
  if (!r.ok) return { r };
  const out = clone(data);
  out.month.table = r.table;
  return { r, data: out, counted: checkTable(out) };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node tools/careful.mjs 保存したファイル.json [--seconds 600] [--workers 4] [--quick 60] [--seed 1] [--out フォルダ]');
    process.exit(2);
  }
  const p = parseData(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (p.error) {
    console.error(`読めませんでした: ${p.error.join(' / ')}`);
    process.exit(1);
  }
  const t = (x) => (x ? `${x.sixPlus}/${x.hard}/${x.soft}` : 'なし');
  const res = await carefulFile(p.data, {
    seconds: Number(arg('seconds', CAREFUL_SECONDS)),
    workers: Number(arg('workers', 4)),
    quick: Number(arg('quick', 60)),
    seed: Number(arg('seed', 1)),
    onEvent: (e) => {
      if (e.type === 'quick') console.log(`1分の答え：${t(e.totals)}`);
      if (e.type === 'best') console.log(`いちばん良い答え：${t(e.totals)}（${e.role}・${e.label}）`);
      if (e.type === 'lost') console.log(`Worker が止まった：${e.role}`);
    },
  });
  const r = res.r;
  const out = arg('out');
  if (out) {
    mkdirSync(out, { recursive: true });
    const maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
    writeFileSync(join(out, 'careful.json'), JSON.stringify({ ...r, table: undefined, answers: r.answers?.map((a) => ({ ...a, table: undefined })), maxRssMB, workers: Number(arg('workers', 4)) }, null, 2));
    if (r.ok) {
      writeFileSync(join(out, 'answers.json'), JSON.stringify(r.answers));
      writeFileSync(join(out, 'result.json'), canonicalJSON(res.data));
      writeFileSync(join(out, 'count.json'), JSON.stringify(res.counted, null, 2));
    }
  }
  if (!r.ok) console.log(`結果：できなかった（${r.reason}）`);
  else {
    console.log(`結果：${t(res.counted.totals)}（選んだ候補 ${r.picked.role}・${r.picked.label}、${r.seconds}秒、${r.how}、${r.count}通り）`);
    for (const c of r.candidates) console.log(`  ${c.role} ${c.name}：${t(c.totals)}（${c.label ?? '―'}・${c.at ?? '―'}秒）${c.lost ? ' 止まった' : ''}${c.reason ? ` ${c.reason}` : ''}${c.rounds !== null ? ` 解き直し ${c.rounds}回` : ''}${c.moves ? ` 仕上げ ${c.moves}` : ''}`);
  }
  process.exit(0);
}
