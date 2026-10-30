// シフト表を検査して、決まりごとの数を機械で読める形（JSON）で出す（docs/数え方の表.md の 4 章）。
// 使い方: node tools/count.mjs 保存したファイル.json
//   同じデータからは、いつも1文字も同じ JSON が出る。
import { readFileSync } from 'node:fs';
import { parseData } from '../app/js/storage.js';
import { checkTable } from '../app/js/check.js';

const file = process.argv[2];
if (!file) {
  console.error('使い方: node tools/count.mjs 保存したファイル.json');
  process.exit(2);
}
const r = parseData(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
if (r.error) {
  console.error(`読めませんでした: ${r.error.join(' / ')}`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(checkTable(r.data), null, 2) + '\n');
