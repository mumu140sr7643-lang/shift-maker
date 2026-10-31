// じっくり作る（6-2）の測り C・E・F と、候補の数え（D の材料）。docs/じっくり作る案.md の 5 章。作り物のデータだけ。
// 使い方: node tools/careful-bench.mjs [--only careful,quick,few,summary] [--seconds 600] [--jobs 2] [--months 0-17] [--out tools/out/careful-bench]
//   careful：18か月 × 3回、Worker 4本（同時に --jobs 個。4本 × 2 = 8コア）
//   quick：同じ 18か月で、ほかに何も動かしていないときの「1分で作る」（60秒・種 1）× 3回（1つずつ）
//   few：測り E。作り物 3通り＋見本3つ × 1か月 × 3回を、Worker 1本と2本で（同時に4つ）
//   summary：比べの表（summary.json）。もうある答えは作り直さない（消してから回すと作り直す）
// 1分の答えの種は、どの回も 1（画面の「作った記録の数 + 1」の、はじめての月と同じ）。3回は同じ条件のくり返し
// 見込みの最低件数に届いた月（候補 え を作るかの決め方。2026-10-31 確かめ役と決めた）：その回の選んだ答え（仕上げのあと）を、画面と同じ reachedLowerBound で比べ、
//   3回のうち2回以上届いた月を「届いた月」と数える（1回でも・3回とも の月の数も出す）。届かなかった回は、どの決まりでいくつ差があるかも出す
// 回すたびに、測ったコミットの番号を meta-◯◯.json に、まとめには summary.json に書く
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseData } from '../app/js/storage.js';
import { checkTable, compareResults, rankKey } from '../app/js/check.js';
import { buildSample } from '../app/js/samples.js';
import { canonicalJSON } from '../app/js/model.js';
import { lowerBound, reachedLowerBound } from '../app/js/outlook.js';
import { RULES } from '../app/js/rules.js';
import { makeSample } from './make-sample.mjs';
import { compareAmounts } from './solve.mjs';
import { ROOT, gitCommit } from './lib.mjs';

const argOf = (n, f) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : f;
};
const only = argOf('only', 'careful,quick,few,summary').split(',');
const SECONDS = Number(argOf('seconds', 600));
const OUT = argOf('out', join(ROOT, 'tools', 'out', 'careful-bench'));
mkdirSync(OUT, { recursive: true });

// 18か月（OR-Tools の試しと同じ月）：見本3つ × 4か月 ＋ 作り物 6通り
export async function months18() {
  const list = [];
  for (const kind of ['restaurant', 'retail', 'care']) for (const [y, m] of [[2026, 11], [2027, 2], [2027, 5], [2027, 8]]) list.push({ id: `${kind}-${y}-${m}`, group: kind, data: buildSample(kind, y, m) });
  const made = async (staff, y, m, keepRequests, id) => {
    const d = await makeSample({ seed: staff * 100 + m, staff, year: y, month: m });
    if (!keepRequests) d.month.requests = {};
    list.push({ id, group: 'made', data: d });
  };
  await made(8, 2027, 2, false, 'made-8-2027-2');
  await made(15, 2026, 11, false, 'made-15-2026-11');
  await made(25, 2026, 12, false, 'made-25-2026-12');
  await made(50, 2026, 12, false, 'made-50-2026-12');
  await made(8, 2026, 11, false, 'short-8-2026-11');
  await made(20, 2027, 5, true, 'request-20-2027-5');
  return list;
}

const range = argOf('months', '0-17').split('-').map(Number);
const all = await months18();
const items = all.slice(range[0], range[1] + 1);
for (const it of all) {
  it.file = join(OUT, `${it.id}.json`);
  writeFileSync(it.file, canonicalJSON(it.data));
}
// 測り E の月：作り物 3通り（8・25・50人）＋見本3つ（2026年11月）
const FEW = ['made-8-2027-2', 'made-25-2026-12', 'made-50-2026-12', 'restaurant-2026-11', 'retail-2026-11', 'care-2026-11'];

const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'ignore', env: process.env });
  p.on('close', resolve);
});
async function pool(tasks, jobs, fn, label, key) {
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  const meta = { label, commit: gitCommit(), seconds: SECONDS, jobs, tasks: tasks.length, started: new Date().toISOString() };
  writeFileSync(join(OUT, `meta-${key}.json`), JSON.stringify(meta, null, 2));
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
    while (next < tasks.length) {
      const t = tasks[next];
      next += 1;
      await fn(t);
      done += 1;
      console.log(`${label} ${done}/${tasks.length}（${Math.round((Date.now() - t0) / 1000)}秒）`);
    }
  }));
  writeFileSync(join(OUT, `meta-${key}.json`), JSON.stringify({ ...meta, ended: new Date().toISOString(), commitAtEnd: gitCommit() }, null, 2));
}
const dirOf = (it, conf, r) => join(OUT, it.id, `${conf}-r${r}`);
const RUNS = [1, 2, 3];

if (only.includes('careful')) {
  const tasks = items.flatMap((it) => RUNS.map((r) => ({ it, r }))).filter(({ it, r }) => !existsSync(join(dirOf(it, 'W4', r), 'careful.json')));
  await pool(tasks, Number(argOf('jobs', 2)), ({ it, r }) => runNode([join(ROOT, 'tools', 'careful.mjs'), it.file, '--seconds', String(SECONDS), '--workers', '4', '--seed', '1', '--out', dirOf(it, 'W4', r)]), 'じっくり（4本）', 'careful');
}
if (only.includes('quick')) {
  const tasks = items.flatMap((it) => RUNS.map((r) => ({ it, r }))).filter(({ it, r }) => !existsSync(join(dirOf(it, 'H', r), 'stages.json')));
  await pool(tasks, 1, ({ it, r }) => runNode([join(ROOT, 'tools', 'solve.mjs'), it.file, '--time', '60', '--seed', '1', '--out', dirOf(it, 'H', r)]), '1分で作る', 'quick');
}
if (only.includes('few')) {
  const tasks = items.filter((it) => FEW.includes(it.id)).flatMap((it) => [1, 2].flatMap((w) => RUNS.map((r) => ({ it, w, r })))).filter(({ it, w, r }) => !existsSync(join(dirOf(it, `W${w}`, r), 'careful.json')));
  await pool(tasks, 4, ({ it, w, r }) => runNode([join(ROOT, 'tools', 'careful.mjs'), it.file, '--seconds', String(SECONDS), '--workers', String(w), '--seed', '1', '--out', dirOf(it, `W${w}`, r)]), 'じっくり（1本・2本）', 'few');
}

if (only.includes('summary')) {
  const resOf = (it, table) => checkTable({ ...it.data, month: { ...it.data.month, table } });
  const load = (it, conf, r) => {
    const dir = dirOf(it, conf, r);
    if (!existsSync(join(dir, 'careful.json'))) return null;
    const c = JSON.parse(readFileSync(join(dir, 'careful.json'), 'utf8'));
    if (!c.ok) return { c, ok: false };
    const answers = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'));
    const picked = resOf(it, parseData(readFileSync(join(dir, 'result.json'), 'utf8')).data.month.table);
    const quickA = answers.find((a) => a.label === 'quick');
    return { c, ok: true, answers, picked, quick: quickA ? resOf(it, quickA.table) : null };
  };
  const loadH = (it, r) => {
    const f = join(dirOf(it, 'H', r), 'result.json');
    if (!existsSync(f)) return null;
    return checkTable(parseData(readFileSync(f, 'utf8')).data);
  };
  const tot = (x) => (x ? `${x.totals.sixPlus}/${x.totals.hard}/${x.totals.soft}` : '作れない');
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

  const runSet = (conf, its) => {
    const out = { runs: 0, missing: 0, failed: 0, worseThanQuick: [], improved: 0, lbReached: 0, lbReachedAny: 0, lbReachedAll: 0, lbGaps: [], months: [], avg: {}, wins: {}, pickedBy: {}, tightened: [], amountMismatch: [], approxDiff: [], how: {} };
    const sums = { quick: { six: [], hard: [], soft: [] }, picked: { six: [], hard: [], soft: [] } };
    for (const it of its) {
      const lb = lowerBound(it.data);
      const row = { id: it.id, quick: [], picked: [], H: [] };
      let reached = 0;
      for (const r of RUNS) {
        const x = load(it, conf, r);
        if (!x) {
          out.missing += 1;
          continue;
        }
        out.runs += 1;
        if (!x.ok) {
          out.failed += 1;
          row.picked.push(`作れない（${x.c.reason}）`);
          continue;
        }
        out.how[x.c.how] = (out.how[x.c.how] ?? 0) + 1;
        row.quick.push(tot(x.quick));
        row.picked.push(tot(x.picked));
        // 必須：選んだ答えが、その回の1分の答えより並べる順で悪くない
        if (x.quick && compareResults(x.picked, x.quick) > 0) out.worseThanQuick.push(`${it.id} 回${r}`);
        if (x.quick && compareResults(x.picked, x.quick) < 0) out.improved += 1;
        if (x.quick) {
          sums.quick.six.push(x.quick.totals.sixPlus);
          sums.quick.hard.push(x.quick.totals.hard);
          sums.quick.soft.push(x.quick.totals.soft);
        }
        sums.picked.six.push(x.picked.totals.sixPlus);
        sums.picked.hard.push(x.picked.totals.hard);
        sums.picked.soft.push(x.picked.totals.soft);
        if (reachedLowerBound(x.picked, lb)) reached += 1;
        else {
          // 届かなかった回：6連勤以上と「絶対」の決まりごとに、選んだ答えの件数と見込みの差
          const gaps = RULES.filter((rr) => rr.id === 'sixPlus' || x.picked.byRule[rr.id].strength === 'hard')
            .map((rr) => ({ rule: rr.id, name: rr.name, got: x.picked.byRule[rr.id].count, lb: lb.byRule[rr.id] ?? 0 }))
            .filter((g) => g.got !== g.lb);
          out.lbGaps.push({ id: it.id, r, gaps: gaps.map((g) => `${g.name} ${g.got}件（見込み ${g.lb}件）`) });
        }
        out.pickedBy[`${x.c.picked.role}・${x.c.picked.label}`] = (out.pickedBy[`${x.c.picked.role}・${x.c.picked.label}`] ?? 0) + 1;
        // D の材料：候補ごとの最後の答え（どれも、その候補のそれまでより良い）で、ほかのどの候補より並べる順で良い回
        const bestOf = {};
        for (const a of x.answers) bestOf[a.role] = a;
        const roles = Object.keys(bestOf);
        for (const role of roles) {
          const mine = resOf(it, bestOf[role].table);
          if (roles.every((o) => o === role || compareResults(mine, resOf(it, bestOf[o].table)) < 0)) out.wins[role] = (out.wins[role] ?? 0) + 1;
        }
        // F：締め直した段と、正しく数える決まりの 式の量 = 検査の量（い・う・い2 の段の答えの表で）
        for (const cand of x.c.candidates) {
          for (const st of cand.stages ?? []) if (st.tightened) out.tightened.push({ id: it.id, r, role: cand.role, stage: st.key, from: st.tightened.from, to: st.tightened.to, applied: st.tightened.applied, ok: st.tightened.to <= st.tightened.from });
          if (cand.amounts && cand.solverTable) {
            const counted = resOf(it, cand.solverTable);
            const cmp = compareAmounts({ amounts: cand.amounts, stages: cand.stages }, counted, it.data, { exact: cand.role === 'u' });
            for (const [k, v] of Object.entries(cmp.exact)) if (!v.same) out.amountMismatch.push(`${it.id} 回${r} ${cand.role} ${k}：式 ${v.solver}・検査 ${v.check}${v.loose ? '（解ききっていない段）' : ''}`);
            // 近い形で数える決まり（違ってよい。分けて出す）
            for (const [k, v] of Object.entries(cmp.approx)) if (v.solver !== null && v.solver !== v.check) out.approxDiff.push(`${it.id} 回${r} ${cand.role} ${k}：式 ${v.solver}・検査 ${v.check}`);
          }
        }
      }
      for (const r of RUNS) row.H.push(tot(loadH(it, r)));
      if (reached >= 2) out.lbReached += 1;
      if (reached >= 1) out.lbReachedAny += 1;
      if (reached >= 3) out.lbReachedAll += 1;
      row.lbReachedRuns = reached;
      out.months.push(row);
    }
    out.avg = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, { six: avg(v.six), hard: avg(v.hard), soft: avg(v.soft) }]));
    return out;
  };
  // 何も動かしていないときの「1分で作る」との比べ（合否にしない）：月ごとに じっくり3回 × 1分3回
  const vsH = (conf, its) => {
    const o = { pairs: 0, better: 0, same: 0, worse: 0, worseMonths: [] };
    for (const it of its) {
      for (const r of RUNS) {
        const x = load(it, conf, r);
        if (!x?.ok) continue;
        for (const q of RUNS) {
          const h = loadH(it, q);
          if (!h) continue;
          o.pairs += 1;
          const k = compareResults(x.picked, h);
          if (k < 0) o.better += 1;
          else if (k > 0) {
            o.worse += 1;
            o.worseMonths.push(`${it.id} じっくり${r}（${tot(x.picked)}）と 1分${q}（${tot(h)}）：並べる順で先に違うのは ${rankKey(x.picked).findIndex((v, i) => v !== rankKey(h)[i]) + 1}つ目`);
          } else o.same += 1;
        }
      }
    }
    return o;
  };
  const fewIts = items.filter((it) => FEW.includes(it.id));
  const summary = {
    commit: gitCommit(),
    seconds: SECONDS,
    cpus: (await import('node:os')).cpus().length,
    C: runSet('W4', items),
    vsH: vsH('W4', items),
    E1: runSet('W1', fewIts),
    E2: runSet('W2', fewIts),
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  for (const [name, s] of [['C（4本）', summary.C], ['E（1本）', summary.E1], ['E（2本）', summary.E2]]) {
    console.log(`${name}：回 ${s.runs}（無い ${s.missing}・作れない ${s.failed}）・1分の答えより悪い回 ${s.worseThanQuick.length}${s.worseThanQuick.length ? `（${s.worseThanQuick.join('、')}）` : ''}・良くなった回 ${s.improved}`);
    console.log(`  見込みの最低件数に届いた月：3回のうち2回以上 ${s.lbReached}（1回でも ${s.lbReachedAny}・3回とも ${s.lbReachedAll}）／月 ${s.months.length}`);
    console.log(`  平均 1分の答え ${JSON.stringify(s.avg.quick)} → 選んだ答え ${JSON.stringify(s.avg.picked)}`);
    console.log(`  選んだ候補 ${JSON.stringify(s.pickedBy)}・ほかのどの候補より良かった回 ${JSON.stringify(s.wins)}・終わり方 ${JSON.stringify(s.how)}`);
    console.log(`  締め直し 解き直し ${s.tightened.length}・量が減った ${s.tightened.filter((x) => x.applied).length}（量が増えた ${s.tightened.filter((x) => !x.ok).length}）・式の量と検査の量が合わない ${s.amountMismatch.length}・近い形で数える決まりの違い ${s.approxDiff.length}`);
  }
  console.log(`1分で作る（何も動かしていないとき）との比べ：組 ${summary.vsH.pairs}・良い ${summary.vsH.better}・同じ ${summary.vsH.same}・悪い ${summary.vsH.worse}`);
}
