// 「変えてはいけない出力」を書き出す（前後の比べに使う）。
// 使い方: node tools/snapshot.mjs --out tools/out/snap-new [--root 前の版を置いたフォルダ]
//   前の版と比べるとき:
//     git worktree add ../shift-maker-old <前のコミット>
//     node tools/snapshot.mjs --root ../shift-maker-old --out tools/out/snap-old
//     node tools/snapshot.mjs --out tools/out/snap-new
//     node tools/compare.mjs tools/out/snap-old tools/out/snap-new
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';
import { makeSample } from './make-sample.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const root = resolve(arg('root', ROOT));
const out = resolve(arg('out', join(ROOT, 'tools/out/snap')));
mkdirSync(out, { recursive: true });

const M = await import(pathToFileURL(join(root, 'app/js/model.js')).href);
const S = await import(pathToFileURL(join(root, 'app/js/samples.js')).href);

const months = [[2026, 11], [2027, 2], [2028, 2], [2026, 12]];
for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
  for (const [y, m] of months) {
    writeFileSync(join(out, `sample-${kind}-${y}-${m}.json`), M.canonicalJSON(S.buildSample(kind, y, m)));
  }
}
for (let seed = 1; seed <= 10; seed += 1) {
  writeFileSync(join(out, `random-${seed}.json`), M.canonicalJSON(await makeSample({ seed, root })));
}
const fixtures = join(ROOT, 'tools/fixtures');
for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.json'))) {
  const obj = M.migrate(JSON.parse(readFileSync(join(fixtures, name), 'utf8')));
  writeFileSync(join(out, `fixture-${name}`), M.canonicalJSON(obj));
}
console.log(`書き出しました: ${out}`);
