// じっくり作るの node の Worker（worker_threads）。ブラウザの solver/worker.js の 'careful' と同じ中身（careful.js の runCandidate）を動かす。
// 測りのため、この Worker の HiGHS の WebAssembly のメモリのいちばん大きいとき（1回の HiGHS ごと。careful-memory.mjs と同じ読み方）と、
// HiGHS が止まった回（onAbort）を数えて、'end' に memory として付ける（中身の計算は変えない）
import { parentPort } from 'node:worker_threads';
import highsLoader from '../vendor/highs/highs.mjs';
import { runCandidate } from '../app/js/solver/careful.js';

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
const loadHighs = () => highsLoader({ onAbort: () => { aborts += 1; } });

parentPort.on('message', async (m) => {
  const post = (x) => {
    if (x.type === 'end') {
      note();
      parentPort.postMessage({ ...x, memory: { wasmMaxMB: Math.round((wasmMax / 1024 / 1024) * 10) / 10, aborts } });
    } else parentPort.postMessage(x);
  };
  try {
    await runCandidate(m.data, { role: m.role, seed: m.seed, seconds: m.seconds, quickSeconds: m.quickSeconds, loadHighs, post });
  } catch (err) {
    parentPort.postMessage({ type: 'error', role: m.role, message: String(err?.message ?? err) });
  }
});
