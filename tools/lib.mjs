// 道具どうしで使う小さな関数。
import { readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 読み込むファイルの名前と、その ?v= を見つける
export const VERSION_RE = /([\w./-]+\.(?:mjs|js|css|wasm))\?v=([0-9][0-9A-Za-z.-]*)/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'out') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// アプリのファイル（HTML・CSS・JS）
export function sourceFiles() {
  const files = walk(join(ROOT, 'app'), []).filter((f) => /\.(js|css|html)$/.test(f));
  files.push(join(ROOT, 'index.html'));
  return files;
}

export function allFiles() {
  return walk(ROOT, []);
}

export function rel(p) {
  return relative(ROOT, p).split(sep).join('/');
}

// いまのコミットの番号と、コミットしていない変更があるか（測りの結果に書く。測った中身と、確かめ役が確かめる中身を同じにするため）
export function gitCommit() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const status = run('git status --porcelain');
  return { commit: run('git rev-parse --short HEAD'), dirty: status === null ? null : status.length > 0 };
}
