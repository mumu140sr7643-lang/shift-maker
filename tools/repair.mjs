// エラーを自動で直す（4-2）を node で動かす道具。確かめ役も同じ条件で回せる。作り物のデータだけ。
// 使い方: node tools/repair.mjs 保存したファイル.json [--budgets 10,25,50,all] [--nodes 2000 | --time 15] [--seed 1] [--out フォルダ]
//   上限ごとに：結果（案・この上限では直せない・時間内に案が無い）、変わるマスの数、件数の前後、改善か（isImproved）、
//   守るはずのこと（上限より多く変わらない・固定は変わらない・希望のマスは希望の値・空きと半休は変わらない）を出す。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseData } from '../app/js/storage.js';
import { solveRepair, nightFixedBefore } from '../app/js/solver/repair.js';
import { cellOf, monthDays } from '../app/js/model.js';
import highsLoader from '../vendor/highs/highs.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const asCell = (r) => (r ? (r.kind === 'shift' ? { kind: 'shift', shift: r.shift } : { kind: r.kind }) : null);

// 案が、守るはずのことを守っているか。返す：まずい所の文の一覧
export function checkProposal(data, pr) {
  const bad = [];
  if (pr.budget !== null && pr.changes.length > pr.budget) bad.push(`上限 ${pr.budget} より多く変わった（${pr.changes.length}）`);
  const N = monthDays(data);
  for (const p of data.staff) {
    for (let day = 1; day <= N; day += 1) {
      const now = cellOf(data, p.id, day);
      const next = pr.table[p.id]?.[day] ?? null;
      const where = `${p.name} ${day}日`;
      if (data.month.marks[p.id]?.[day]?.locked) {
        if (!same(now, next)) bad.push(`固定したマスが変わった（${where}）`);
        continue;
      }
      const req = data.month.requests[p.id]?.[day];
      if (req) {
        if (!same(next, asCell(req))) bad.push(`希望のマスが希望の値でない（${where}）`);
        continue;
      }
      if (now?.kind === 'half' && !same(now, next)) bad.push(`半休のマスが変わった（${where}）`);
      if (!now && next) {
        const prevNight = nightFixedBefore(data, p, day);
        if (!(prevNight && next.kind === 'ake')) bad.push(`空きのマスが埋まった（${where}）`);
      }
    }
  }
  return bad;
}

export async function repairFile(data, { budgets, nodes = null, time = 15, seed = 1 } = {}) {
  return solveRepair(data, { loadHighs: () => highsLoader(), budgets, secondsEach: nodes ? null : time, nodeLimit: nodes, seed });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  const r = parseData(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (r.error) {
    console.error(`読めませんでした: ${r.error.join(' / ')}`);
    process.exit(1);
  }
  const budgets = arg('budgets', '10,25,50,all').split(',').map((x) => (x === 'all' ? null : Number(x)));
  const nodes = arg('nodes') ? Number(arg('nodes')) : null;
  const res = await repairFile(r.data, { budgets, nodes, time: Number(arg('time', 15)), seed: Number(arg('seed', 1)) });
  const out = arg('out');
  if (!res.ok) {
    console.log(`直せません（${res.reason}）`);
    for (const c of res.conflicts ?? []) console.log(`  ぶつかり: ${c.text}`);
  } else {
    const t = (x) => `6連勤以上 ${x.sixPlus}・絶対 ${x.hard}・できれば ${x.soft}・不足 ${x.shortSlots}`;
    console.log(`いま: ${t(res.before)}`);
    for (const pr of res.proposals) {
      const name = pr.budget === null ? '全部' : `${pr.budget}マスまで`;
      if (pr.status !== 'ok') {
        console.log(`  ${name}: ${pr.status === 'too-many' ? 'この上限では直せない（必ず変えるマスが多い）' : '時間内に案が無い'}`);
        continue;
      }
      const bad = checkProposal(r.data, pr);
      console.log(`  ${name}: 変わるマス ${pr.changes.length}・${t(pr.totals)}・${pr.improved ? '改善' : '改善しない'}${pr.sameAs !== undefined ? `（${pr.sameAs}マスまでと同じ）` : ''}${bad.length ? `・まずい所 ${bad.join(' / ')}` : ''}`);
    }
  }
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'repair.json'), JSON.stringify(res, (k, v) => (k === 'table' ? undefined : v), 2));
  }
}
