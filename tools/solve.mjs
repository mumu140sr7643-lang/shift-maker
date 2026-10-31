// 自動で作る（v3）を node で動かす道具。確かめ役も同じ条件で回せる。
// 使い方:
//   node tools/solve.mjs 保存したファイル.json [--nodes 2000] [--seed 1] [--time 60] [--out フォルダ] [--leader-weight 0.3] [--soft-warm on|off] [--soft-effort 1]
//   --nodes（調べる数の上限）で区切ると、同じデータ・同じ種なら、いつも同じ答えになる。
//   --time で区切ると、画面と同じ（パソコンの速さで答えが変わる）。
// --out に出すもの：stages.json（段ごとの結果）・result.json（できた表を入れたデータ。このアプリで取り込める）・
//   count.json（tools/count.mjs と同じ形）・compare.json（段の量と check.js の量の比べ）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseData } from '../app/js/storage.js';
import { checkTable } from '../app/js/check.js';
import { solveStaged } from '../app/js/solver/stages.js';
import { canonicalJSON, clone } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// 段の量と、できた表を check.js で数えた量を比べる（式の作りまちがいを見つけるため）
//   exact：同じになるはずのもの／approx：近い形で数えているので違ってよいもの
//   6連勤以上・連勤超過は、前の月だけで超えていた分（どう作っても変わらない）を式に入れていないので、検査の量から引く
export function compareAmounts(solved, counted, data) {
  const by = counted.byRule;
  const prevDays = (it) => (it.from < 1 ? 1 - it.from : 0);
  const six = counted.items.filter((it) => it.rule === 'sixPlus').reduce((s, it) => s + it.amount - 5 - Math.max(0, prevDays(it) - 5), 0);
  const limitOf = (pid) => data.staff.find((p) => p.id === pid)?.maxConsecutive ?? data.settings.work.maxConsecutive;
  const over = counted.items.filter((it) => it.rule === 'overStreak').reduce((s, it) => s + it.amount - Math.max(0, prevDays(it) - limitOf(it.staff)), 0);
  const exact = {
    sixPlus: { solver: solved.amounts.sixPlus ?? 0, check: six },
    shortage: { solver: solved.amounts.shortage ?? 0, check: by.shortage.amount },
    offShort: { solver: solved.amounts.offShort ?? 0, check: by.offShort.amount },
    overStreak: { solver: solved.amounts.overStreak ?? 0, check: over },
    overstaff: { solver: solved.amounts.overstaff ?? 0, check: by.overstaff.amount },
    onePerDayDup: { solver: solved.amounts.onePerDayDup ?? 0, check: by.onePerDayDup.amount },
    lateToEarly: { solver: solved.amounts.lateToEarly ?? 0, check: by.lateToEarly.count },
  };
  const approx = {
    switchInStreak: { solver: solved.amounts.switchInStreak ?? 0, check: by.switchInStreak.count },
    switchCount: { solver: solved.amounts.switchCount ?? 0, check: by.switchCount.amount },
    leaderRank: { solver: null, check: by.leaderRank.count },
  };
  // 解ききっていない段（時間・調べる数の上限）の決まりは、違反の量を表す数が実際より大きいままのことがあるので、
  // 「式の量 ≧ 検査の量」なら よし とする（loose: true）。解ききった段の決まりは、ぴったり同じでなければいけない
  const stageOf = (rule) => solved.stages.find((st) => st.rules?.includes(rule));
  for (const [k, v] of Object.entries(exact)) {
    if (by[k] && by[k].strength === 'off') {
      delete exact[k];
      continue;
    }
    const st = stageOf(k);
    if (st && st.status !== 'solved') {
      v.loose = true;
      v.same = v.solver >= v.check - 1e-6;
    } else v.same = Math.abs(v.solver - v.check) < 1e-6;
  }
  return { exact, approx };
}

export async function solveFile(data, { nodes = null, seed = 1, time = null, leaderWeight = 0, presolve = 'on', warmStart, softWarmStart, softEffort } = {}) {
  const solved = await solveStaged(data, {
    loadHighs: () => highsLoader(),
    nodeLimit: nodes,
    timeLimit: time,
    seed,
    leaderWeight,
    presolve,
    ...(warmStart === undefined ? {} : { warmStart }),
    ...(softWarmStart === undefined ? {} : { softWarmStart }),
    ...(softEffort === undefined ? {} : { softOptions: { mip_heuristic_effort: softEffort } }),
  });
  if (!solved.ok) return { solved };
  const out = clone(data);
  out.month.table = solved.table;
  const counted = checkTable(out);
  return { solved, data: out, counted, compare: compareAmounts(solved, counted, data) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('使い方: node tools/solve.mjs 保存したファイル.json [--nodes 2000] [--seed 1] [--time 60] [--out フォルダ]');
    process.exit(2);
  }
  const r = parseData(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (r.error) {
    console.error(`読めませんでした: ${r.error.join(' / ')}`);
    process.exit(1);
  }
  const nodes = arg('nodes') ? Number(arg('nodes')) : null;
  const time = arg('time') ? Number(arg('time')) : null;
  const soft = arg('soft-warm');
  const res = await solveFile(r.data, { nodes: nodes ?? (time ? null : 2000), seed: Number(arg('seed', 1)), time, leaderWeight: Number(arg('leader-weight', 0)), presolve: arg('presolve', 'on'), softWarmStart: soft === null ? undefined : soft === 'on', softEffort: arg('soft-effort') === null ? undefined : Number(arg('soft-effort')) });
  const out = arg('out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stages.json'), JSON.stringify(res.solved, (k, v) => (k === 'table' ? undefined : v), 2));
    if (res.data) {
      writeFileSync(join(out, 'result.json'), canonicalJSON(res.data));
      writeFileSync(join(out, 'count.json'), JSON.stringify(res.counted, null, 2));
      writeFileSync(join(out, 'compare.json'), JSON.stringify(res.compare, null, 2));
    }
  }
  const s = res.solved;
  console.log(`結果: ${s.ok ? 'できた' : `できなかった（${s.reason}）`}  式の大きさ: ${JSON.stringify(s.size ?? {})}`);
  for (const st of s.stages) console.log(`  段 ${st.name}: ${st.status}（HiGHS の状態 ${st.code}） ${st.seconds}秒 量=${st.value}`);
  if (s.conflicts) for (const c of s.conflicts.slice(0, 10)) console.log(`  ぶつかり: ${c.text}`);
  if (res.counted) console.log(`検査: ${JSON.stringify(res.counted.totals)}`);
  if (res.compare) {
    const bad = Object.entries(res.compare.exact).filter(([, v]) => !v.same);
    console.log(bad.length ? `段の量と検査の量が違う: ${JSON.stringify(Object.fromEntries(bad))}` : '段の量と検査の量は同じ（同じになるはずのもの）');
  }
}
