// 版の番号をまとめて上げる：app/js/version.js と、読み込むファイルの ?v= を全部そろえる。
// 使い方: node tools/bump-version.mjs 1.2
import { readFileSync, writeFileSync } from 'node:fs';
import { sourceFiles, VERSION_RE } from './lib.mjs';

const next = process.argv[2];
if (!next || !/^[0-9][0-9A-Za-z.-]*$/.test(next)) {
  console.error('版の番号を書いてください。例: node tools/bump-version.mjs 1.2');
  process.exit(1);
}
let changed = 0;
for (const file of sourceFiles()) {
  const text = readFileSync(file, 'utf8');
  let out = text.replace(VERSION_RE, (_, name) => `${name}?v=${next}`);
  if (file.endsWith('version.js')) out = out.replace(/APP_VERSION = '[^']*'/, `APP_VERSION = '${next}'`);
  if (out !== text) {
    writeFileSync(file, out);
    changed += 1;
  }
}
console.log(`版を ${next} にしました（${changed} ファイル）。`);
