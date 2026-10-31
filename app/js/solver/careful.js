// じっくり作る（6-2。docs/じっくり作る案.md）の中身。画面には触らない。node からも使う。
// まとめ役（startCareful。画面の側）が Worker を何本か作り、Worker の側（runCandidate）が候補ごとに解いて、良い答えを送る。
// Worker を作る関数を渡すので、ブラウザでは Web Worker、node の道具では worker_threads で、同じ中身が動く。
import { solveStaged } from './stages.js?v=6.2';
import { prepareRepair } from './repair.js?v=6.2';
import { finishTable } from './finish.js?v=6.2';
import { checkTable, isImproved, compareResults } from '../check.js?v=6.2';

export const CAREFUL_SECONDS = 600;
// 時間の見張り：合計＋20秒たっても終わらない Worker は止める
const WATCH_EXTRA = 20;
// 候補 あ の解き直し（「エラーを自動で直す」と同じ。変わるマスの上限をくり返す。種は 10 から回ごとに）
const REPAIR_BUDGETS = [10, 25, 50];
const REPAIR_SECONDS = 20;
const REPAIR_SEED = 10;
// い・う・い2 の「できれば」の段を区切って解く1回の秒（stages.js の solveInRounds。1回の HiGHS のメモリを上限より小さく保つ。
// 2026-10-31 確かめ役と決めた：120秒までなら 15人×30日で 749MB、25人・50人×31日で 452MB だった）
const SOFT_ROUND_SECONDS = 120;

// 候補（Worker が少ない機械では、上から順に使う）。seedAdd は1分の答えの種に足す数
export const CANDIDATES = [
  { id: 'a', name: '1分から直しを重ねる' },
  { id: 'i', name: '長く解く', seedAdd: 1 },
  { id: 'u', name: '数え方に近い式', seedAdd: 2, exact: true },
  { id: 'i2', name: '長く解く（別の種）', seedAdd: 3 },
];
export const candidateName = (id) => CANDIDATES.find((c) => c.id === id)?.name ?? id;

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// 時間の配分（合計 600秒なら、探す 570秒・仕上げ 25秒・選ぶまでの余り 5秒。短くしたときは同じ割合）
export function timePlan(seconds) {
  const finish = Math.min(25, seconds / 24);
  const gap = Math.min(5, seconds / 120);
  return { search: seconds - gap - finish, finish, total: seconds };
}

// 1本が使うメモリの見込み（MB）。cells は月の大きさ（人数 × 日数）。
// 測り G（6-2。「できれば」の段を区切って解く形で、600秒・3か月 × 4候補。node の分を引いたメモリと WebAssembly のメモリの大きいほう）の
// いちばん多い値が MEMORY_MAX_MB、50人×31日の月のいちばん多い値が MEMORY_50_MB。
// メモリは月の大きさより解く長さで増えるので、どの月も MEMORY_MAX_MB を見込み、50人×31日より大きい月だけ、式が大きくなる分を見込む。余裕に 1.25 倍。
// 2026-10-31（確かめ役と決めた）：1430MB は 15人×30日の候補 い の WebAssembly のメモリ、1125MB は 50人×31日の候補 い2 の node の分を引いたメモリ。
// m は 1788MB になり、8GB 以下の機械は1本（候補 あ だけ）・16GB は2本・32GB 以上は4本。い・う・い2 のメモリを減らすかは 6-3 で決める
const MEMORY_MAX_MB = 1430;
const MEMORY_50_MB = 1125;
const CELLS_50 = 50 * 31;
const MEMORY_MARGIN = 1.25;
export function workerMemoryMB(cells = 0) {
  return MEMORY_MARGIN * Math.max(MEMORY_MAX_MB, cells > CELLS_50 ? (MEMORY_50_MB * cells) / CELLS_50 : 0);
}

// Worker の数（4 章）：CPU の数 − 1（最大4本・少なくとも1本。分からなければ1本）。
// deviceMemory が分かるときは 2GB 以下で1本・4GB 以下で2本まで。タッチだけの機械は2本まで。
// さらに、使ってよいメモリ（deviceMemory の 4分の1。分からないときは、タッチだけの機械 1GB・それ以外 2GB）を、1本の見込みで割った数まで
export function workerCount({ cpus, memory, touchOnly, cells = 0 }) {
  let n = Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus) - 1 : 1;
  n = Math.max(1, Math.min(CANDIDATES.length, n));
  if (Number.isFinite(memory)) {
    if (memory <= 2) n = Math.min(n, 1);
    else if (memory <= 4) n = Math.min(n, 2);
  }
  if (touchOnly) n = Math.min(n, 2);
  const budgetMB = (Number.isFinite(memory) ? memory / 4 : touchOnly ? 1 : 2) * 1024;
  return Math.max(1, Math.min(n, Math.floor(budgetMB / workerMemoryMB(cells))));
}

// ---------- Worker の側 ----------

// 1つの候補を解く。post(m) で答えを送る：
//   { type: 'answer', role, label: 'quick'|'stage'|'repair'|'finish', table, seconds, stages?, moves? } … この候補の、それまでよりも並べる順で良い答え
//   { type: 'end', role, seconds, stages?, rounds?, reason? }                                             … この候補が終わった
export async function runCandidate(data, { role, seed, seconds = CAREFUL_SECONDS, quickSeconds = 60, loadHighs, post, now = defaultNow }) {
  const t0 = now();
  const el = () => (now() - t0) / 1000;
  const plan = timePlan(seconds);
  const resOf = (table) => checkTable({ ...data, month: { ...data.month, table } });
  let best = null;
  const offer = (table, label, extra = {}) => {
    const res = resOf(table);
    if (best && !(compareResults(res, best.res) < 0)) return false;
    best = { table, res, label };
    post({ type: 'answer', role, label, table, seconds: Math.round(el() * 10) / 10, ...extra });
    return true;
  };
  const finishBest = () => {
    if (!best) return 0;
    const left = Math.min(plan.finish, plan.search + plan.finish - el());
    const f = finishTable({ ...data, month: { ...data.month, table: best.table } }, { seconds: Math.max(0.5, left), now });
    if (f.moves.length) offer(f.table, 'finish', { moves: f.moves.length, from: best.label });
    return f.moves.length;
  };
  const cand = CANDIDATES.find((c) => c.id === role);

  if (role === 'a') {
    // 1分の答え（保険）：1分で作ると同じ計算（同じ種・同じ秒）
    const quick = await solveStaged(data, { loadHighs, timeLimit: quickSeconds, seed });
    if (!quick.ok) {
      post({ type: 'end', role, seconds: el(), reason: quick.reason, conflicts: quick.conflicts ?? [], stages: quick.stages ?? [] });
      return;
    }
    offer(quick.table, 'quick', { stages: quick.stages });
    // いまのいちばん良い答えから、変わるマスを限って解き直しを重ねる。良くなったときだけ次の出発点にする
    let rounds = 0;
    let skipped = 0;
    while (el() + 3 < plan.search && skipped < REPAIR_BUDGETS.length) {
      const budget = REPAIR_BUDGETS[rounds % REPAIR_BUDGETS.length];
      const s = REPAIR_SEED + rounds;
      rounds += 1;
      const base = prepareRepair({ ...data, month: { ...data.month, table: best.table } });
      if (base.requestDiffs + base.noVar > budget) {
        skipped += 1;
        continue;
      }
      skipped = 0;
      const r = await solveStaged(base.prepared, { loadHighs, timeLimit: Math.min(REPAIR_SECONDS, plan.search - el()), seed: s, keepCurrent: true, changeLimit: budget - base.requestDiffs });
      if (!r.ok) continue;
      const res = resOf(r.table);
      if (isImproved(best.res, res) && compareResults(res, best.res) < 0) offer(r.table, 'repair', { round: rounds, budget });
    }
    const moves = finishBest();
    post({ type: 'end', role, seconds: el(), stages: quick.stages, rounds, moves });
    return;
  }

  // い・う・い2：段の順番は1分と同じで、長い時間で解く。段が終わるたび・「できれば」の段の回ごとの表を答えとして出す
  const r = await solveStaged(data, {
    loadHighs,
    timeLimit: plan.search,
    seed,
    exact: Boolean(cand?.exact),
    tighten: true,
    softRound: SOFT_ROUND_SECONDS,
    onProgress: (p) => {
      if ((p.phase === 'done' || p.phase === 'round') && p.table) offer(p.table, 'stage', { stage: p.stage });
    },
  });
  if (r.ok) offer(r.table, 'stage', { stages: r.stages });
  const moves = finishBest();
  post({ type: 'end', role, seconds: el(), stages: r.stages ?? [], amounts: r.amounts ?? null, solverTable: r.ok ? r.table : null, reason: r.ok ? null : r.reason, moves });
}

// ---------- まとめ役（画面の側） ----------

// makeWorker() → { post(m), onMessage(fn), onError(fn), terminate() }
// onEvent(e)：{ type: 'quick', totals } … 1分の答えができた
//             { type: 'best', totals, role, label } … いまのいちばん良い答えが変わった
//             { type: 'phase', phase: 'quick'|'search'|'finish', count } … 段階が変わった
//             { type: 'lost', role } … Worker が止まった
// 返す：{ promise, finishNow(), stop() }
//   promise の結果：{ ok: true, table, picked: { role, label }, quick, candidates, answers, seconds, how: 'done'|'timeout'|'early', count, finished, finishMoves }
//                  | { ok: false, reason: 'stopped'|'no-worker'|'lost'|'conflict'|'infeasible'|'no-answer', conflicts? }
export function startCareful(data, { makeWorker, workers = 4, seconds = CAREFUL_SECONDS, quickSeconds = 60, seed = 1, onEvent = () => {}, now = defaultNow, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const roles = CANDIDATES.slice(0, Math.max(1, Math.min(CANDIDATES.length, workers)));
  const plan = timePlan(seconds);
  const t0 = now();
  const el = () => Math.round(((now() - t0) / 1000) * 10) / 10;
  const answers = [];
  const state = new Map(roles.map((c) => [c.id, { role: c.id, name: c.name, done: false, lost: false, best: null, stages: [], amounts: null, solverTable: null, rounds: null, moves: 0, reason: null }]));
  let best = null;
  let quick = null;
  let ended = false;
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  const handles = [];
  const timers = [];

  const pick = (how) => {
    if (!best) {
      const a = state.get('a');
      if (a?.reason === 'conflict') return { ok: false, reason: 'conflict', conflicts: a.conflicts ?? [] };
      const reasons = [...state.values()].map((s) => s.reason).filter(Boolean);
      if ([...state.values()].every((s) => s.lost)) return { ok: false, reason: 'lost' };
      return { ok: false, reason: reasons.includes('infeasible') && reasons.every((r) => r === 'infeasible') ? 'infeasible' : 'no-answer' };
    }
    const from = state.get(best.role);
    const solverAnswer = best.label === 'stage' || best.label === 'quick';
    return {
      ok: true,
      table: best.table,
      picked: { role: best.role, label: best.label },
      quick: quick ? { totals: quick.res.totals, stages: quick.stages } : null,
      candidates: [...state.values()].map((s) => ({ role: s.role, name: s.name, totals: s.best?.res.totals ?? null, label: s.best?.label ?? null, at: s.best?.at ?? null, done: s.done, lost: s.lost, reason: s.reason, rounds: s.rounds, moves: s.moves, amounts: s.amounts, solverTable: s.solverTable, stages: s.stages.map((x) => ({ key: x.key, name: x.name, rules: x.rules, status: x.status, seconds: x.seconds, value: x.value, ...(x.tightened ? { tightened: x.tightened } : {}) })) })),
      answers: answers.map((x) => ({ role: x.role, label: x.label, at: x.at, totals: x.res.totals, table: x.table })),
      seconds: el(),
      how,
      count: roles.length,
      // 最後まで解ききった：選んだ答えが、段の全部が「解ききった」候補の答えそのもの（あ の解き直し・仕上げで変えた答えは書かない）
      finished: solverAnswer && best.role !== 'a' && from.stages.length > 0 && from.stages.every((x) => x.status === 'solved'),
      finishMoves: best.label === 'finish' ? best.moves : 0,
    };
  };
  const end = (how) => {
    if (ended) return;
    ended = true;
    for (const w of handles) {
      try {
        w.terminate();
      } catch {
        // 止まっている Worker はそのまま
      }
    }
    for (const t of timers) clearTimer(t);
    settle(how === 'stopped' ? { ok: false, reason: 'stopped' } : pick(how));
  };
  const checkAllDone = () => {
    if ([...state.values()].every((s) => s.done || s.lost)) end('done');
  };
  const receive = (m) => {
    if (ended) return;
    const s = state.get(m.role);
    if (!s) return;
    if (m.type === 'answer') {
      const res = checkTable({ ...data, month: { ...data.month, table: m.table } });
      const a = { role: m.role, label: m.label, table: m.table, res, at: el(), moves: m.moves ?? 0, stages: m.stages ?? null };
      answers.push(a);
      if (!s.best || compareResults(res, s.best.res) < 0) s.best = a;
      if (m.label === 'quick') {
        quick = a;
        s.stages = m.stages ?? [];
        onEvent({ type: 'quick', totals: res.totals });
        onEvent({ type: 'phase', phase: 'search', count: roles.length });
      }
      if (!best || compareResults(res, best.res) < 0) {
        best = a;
        onEvent({ type: 'best', totals: res.totals, role: m.role, label: m.label });
      }
      return;
    }
    if (m.type === 'end') {
      s.done = true;
      if (m.role !== 'a' || !s.stages.length) s.stages = m.stages ?? s.stages;
      s.rounds = m.rounds ?? null;
      s.moves = m.moves ?? 0;
      // 測り F（締め直し）のため：段の量と、その段の答えの表（い・う・い2）
      s.amounts = m.amounts ?? null;
      s.solverTable = m.solverTable ?? null;
      s.reason = m.reason ?? null;
      if (m.conflicts) s.conflicts = m.conflicts;
      // 1分の答えが作れなかったときも、ほかの候補は探し続ける
      if (m.role === 'a' && !quick) onEvent({ type: 'phase', phase: 'search', count: roles.length });
      checkAllDone();
      return;
    }
    if (m.type === 'error') {
      s.lost = true;
      s.reason = 'error';
      onEvent({ type: 'lost', role: m.role });
      checkAllDone();
    }
  };

  for (const c of roles) {
    let w;
    try {
      w = makeWorker();
    } catch {
      state.get(c.id).lost = true;
      continue;
    }
    handles.push(w);
    w.onMessage((m) => receive({ ...m, role: m.role ?? c.id }));
    w.onError(() => {
      if (ended) return;
      const s = state.get(c.id);
      if (s.done) return;
      s.lost = true;
      onEvent({ type: 'lost', role: c.id });
      checkAllDone();
    });
    w.post({ kind: 'careful', role: c.id, data, seed: seed + (c.seedAdd ?? 0), seconds, quickSeconds });
  }
  if (!handles.length) {
    ended = true;
    settle({ ok: false, reason: 'no-worker' });
  } else {
    onEvent({ type: 'phase', phase: 'quick', count: roles.length });
    timers.push(setTimer(() => !ended && onEvent({ type: 'phase', phase: 'finish', count: roles.length }), plan.search * 1000));
    timers.push(setTimer(() => end('timeout'), (seconds + WATCH_EXTRA) * 1000));
    checkAllDone();
  }
  return {
    promise,
    // ここまでの答えで終える（1分の答えができてから）
    finishNow: () => {
      if (!quick || ended) return false;
      end('early');
      return true;
    },
    stop: () => end('stopped'),
    hasQuick: () => Boolean(quick),
  };
}
