// 2 つのフォルダの書き出しを比べ、1 文字でも違うファイルを並べる。
// 使い方: node tools/compare.mjs 前のフォルダ 新しいフォルダ
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('使い方: node tools/compare.mjs 前のフォルダ 新しいフォルダ');
  process.exit(2);
}
const names = new Set([...readdirSync(a), ...readdirSync(b)]);
const diff = [];
for (const n of [...names].sort()) {
  const pa = join(a, n);
  const pb = join(b, n);
  if (!existsSync(pa)) diff.push(`新しく増えた: ${n}`);
  else if (!existsSync(pb)) diff.push(`なくなった: ${n}`);
  else if (readFileSync(pa, 'utf8') !== readFileSync(pb, 'utf8')) diff.push(`中身が違う: ${n}`);
}
if (diff.length) {
  console.log(diff.join('\n'));
  console.log(`違い ${diff.length} 件（全部で ${names.size} ファイル）`);
  process.exit(1);
}
console.log(`同じでした（${names.size} ファイル）。`);
