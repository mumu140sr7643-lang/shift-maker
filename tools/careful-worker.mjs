// じっくり作るの node の Worker（worker_threads）。ブラウザの solver/worker.js の 'careful' と同じ中身（careful.js の runCandidate）を動かす。
import { parentPort } from 'node:worker_threads';
import highsLoader from '../vendor/highs/highs.mjs';
import { runCandidate } from '../app/js/solver/careful.js';

parentPort.on('message', async (m) => {
  try {
    await runCandidate(m.data, { role: m.role, seed: m.seed, seconds: m.seconds, quickSeconds: m.quickSeconds, loadHighs: () => highsLoader(), post: (x) => parentPort.postMessage(x) });
  } catch (err) {
    parentPort.postMessage({ type: 'error', role: m.role, message: String(err?.message ?? err) });
  }
});
