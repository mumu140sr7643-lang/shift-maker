// 公開の前に毎回通す確かめ（ブラウザを使わないもの）。
// 使い方: node tools/check.mjs
//   言葉の確かめには、リポジトリの外に置いた一覧（1行に1語）の場所を
//   SHIFT_MAKER_WORDS に入れる。例: SHIFT_MAKER_WORDS=../言葉の一覧.txt node tools/check.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, VERSION_RE, sourceFiles, rel } from './lib.mjs';
import { makeSample } from './make-sample.mjs';
import * as M from '../app/js/model.js';
import * as S from '../app/js/samples.js';
import { APP_VERSION } from '../app/js/version.js';

const results = [];
const check = (name, problems) => results.push({ name, problems });

// 1. 版の番号：読み込むファイルの ?v= が全部、アプリの版と同じか。?v= の付け忘れがないか
{
  const problems = [];
  for (const f of sourceFiles()) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(VERSION_RE)) if (m[2] !== APP_VERSION) problems.push(`${rel(f)}: ${m[0]}（アプリの版は ${APP_VERSION}）`);
    const imports = [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
    const tags = [...text.matchAll(/(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
    for (const spec of [...imports, ...tags]) if (!/\?v=/.test(spec)) problems.push(`${rel(f)}: ${spec} に ?v= がありません`);
  }
  check('版の番号（?v=）', problems);
}

// 2. HTML の開きタグと閉じタグの数
{
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
  const problems = [];
  for (const f of sourceFiles().filter((x) => x.endsWith('.html'))) {
    const text = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const count = {};
    for (const m of text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g)) {
      const tag = m[2].toLowerCase();
      if (VOID.has(tag) || tag === '!doctype') continue;
      count[tag] ??= 0;
      count[tag] += m[1] ? -1 : 1;
    }
    for (const [tag, n] of Object.entries(count)) if (n !== 0) problems.push(`${rel(f)}: <${tag}> の開きと閉じの数が ${n > 0 ? n + ' 個多い' : -n + ' 個足りない'}`);
  }
  check('タグの数', problems);
}

// 3. 文字を HTML として入れる書き方を使っていないか
{
  const problems = [];
  for (const f of sourceFiles().filter((x) => x.endsWith('.js'))) {
    const text = readFileSync(f, 'utf8');
    for (const word of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      if (text.includes(word)) problems.push(`${rel(f)}: ${word} を使っています`);
    }
  }
  check('文字は文字として入れる', problems);
}

// 4. 確かめ役が押す部品の名前（data-testid）が残っているか
{
  const list = JSON.parse(readFileSync(join(ROOT, 'tools/testids.json'), 'utf8'));
  const all = sourceFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
  const problems = list.filter((x) => !all.includes(x.find)).map((x) => `${x.id}（${x.find} が見つかりません）`);
  check(`部品の名前（${list.length} 個）`, problems);
}

// 5. JavaScript の書き方の誤り
{
  const problems = [];
  const files = [...sourceFiles().filter((x) => x.endsWith('.js')), ...readdirSync(join(ROOT, 'tools')).filter((x) => x.endsWith('.mjs')).map((x) => join(ROOT, 'tools', x))];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      problems.push(`${rel(f)}: ${String(e.stderr).split('\n').slice(0, 2).join(' ')}`);
    }
  }
  check('JavaScript の書き方', problems);
}

// 6. 見本：どの月でもデータの形が正しく、書いて読み直しても同じか。毎回同じものができるか
{
  const problems = [];
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
    for (const [y, m] of [[2026, 11], [2027, 2], [2028, 2], [2026, 12], [2027, 4]]) {
      const d = S.buildSample(kind, y, m);
      const errs = M.validateData(JSON.parse(JSON.stringify(d)));
      if (errs.length) problems.push(`${kind} ${y}-${m}: ${errs[0]}`);
      if (M.canonicalJSON(JSON.parse(JSON.stringify(d))) !== M.canonicalJSON(d)) problems.push(`${kind} ${y}-${m}: 書いて読み直すと変わる`);
      if (M.canonicalJSON(S.buildSample(kind, y, m)) !== M.canonicalJSON(d)) problems.push(`${kind} ${y}-${m}: 作るたびに変わる`);
      for (const p of d.staff) if (!/^[A-Z]$/.test(p.name)) problems.push(`${kind}: 見本の名前「${p.name}」が A〜Z ではありません`);
    }
  }
  check('業種の見本', problems);
}

// 7. 作り物のデータ（乱数）でも形が正しいか
{
  const problems = [];
  for (let seed = 1; seed <= 40; seed += 1) {
    const d = await makeSample({ seed });
    const errs = M.validateData(JSON.parse(JSON.stringify(d)));
    if (errs.length) problems.push(`種 ${seed}: ${errs[0]}`);
  }
  check('作り物のデータ（40 種）', problems);
}

// 8. 古い形のデータを読めるか（tools/fixtures は消さずに増やしていく）
{
  const problems = [];
  const dir = join(ROOT, 'tools/fixtures');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) problems.push('tools/fixtures に古い形のデータがありません');
  for (const name of files) {
    try {
      const obj = M.migrate(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      const errs = M.validateData(obj);
      if (errs.length) problems.push(`${name}: ${errs[0]}`);
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }
  check(`古い形のデータ（${files.length} 個）`, problems);
}

// 9. まずいデータを断るか（取り込み・読み込みの前の確かめ）
{
  const problems = [];
  const good = S.buildSample('restaurant', 2026, 11);
  const cases = [
    ['記号が「=」で始まる', (d) => { d.settings.shifts[0].symbol = '=SUM(1)'; }],
    ['記号が休みと同じ', (d) => { d.settings.shifts[0].symbol = '休'; }],
    ['記号が重なる', (d) => { d.settings.shifts[1].symbol = d.settings.shifts[0].symbol; }],
    ['いないシフトを担当', (d) => { d.staff[0].shifts.push('s999'); }],
    ['番号が重なる', (d) => { d.staff[1].id = d.staff[0].id; }],
    ['番号の控えが小さい', (d) => { d.nextIds.staff = 1; }],
    ['月にない日', (d) => { d.month.requests[d.staff[0].id] = { 31: { kind: 'off' } }; }],
    ['新しすぎる形', (d) => { d.formatVersion = 99; }],
    ['公休数が数でない', (d) => { d.staff[0].offDays = '9'; }],
  ];
  for (const [name, breakIt] of cases) {
    const d = M.clone(good);
    breakIt(d);
    let rejected = false;
    try {
      rejected = M.validateData(M.migrate(d)).length > 0;
    } catch {
      rejected = true;
    }
    if (!rejected) problems.push(`${name} を断れませんでした`);
  }
  check(`まずいデータを断る（${cases.length} 通り）`, problems);
}

// 9b. 取り込むときの大きさの確かめ（見本は通り、大きすぎるものは断る）
{
  const problems = [];
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
    const errs = M.importProblems(S.buildSample(kind, 2026, 11));
    if (errs.length) problems.push(`見本 ${kind} を断ってしまう: ${errs[0]}`);
  }
  const good = S.buildSample('care', 2026, 11);
  const cases = [
    ['名前が長すぎる', (d) => { d.staff[0].name = 'あ'.repeat(M.IMPORT_LIMITS.name + 1); }],
    ['スタッフが多すぎる', (d) => { d.staff = Array.from({ length: M.IMPORT_LIMITS.staff + 1 }, () => d.staff[0]); }],
    ['メモが長すぎる', (d) => { d.staff[0].memo = 'x'.repeat(M.IMPORT_LIMITS.memo + 1); }],
  ];
  for (const [name, breakIt] of cases) {
    const d = M.clone(good);
    breakIt(d);
    if (!M.importProblems(d).length) problems.push(`${name} を断れませんでした`);
  }
  check(`取り込むときの大きさ（${cases.length} 通り）`, problems);
}

// 10. 言葉の確かめ：一覧の言葉が、リポジトリのファイル・コミットの文に入っていないか
{
  const listPath = process.env.SHIFT_MAKER_WORDS;
  if (!listPath || !existsSync(listPath)) {
    check('言葉の確かめ', ['一覧の場所（SHIFT_MAKER_WORDS）が指定されていないので、確かめていません']);
  } else {
    const words = readFileSync(listPath, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter((w) => w && !w.startsWith('#'));
    const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    let log = '';
    try {
      log = execFileSync('git', ['log', '--all', '--format=%an%n%ae%n%B'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      log = '';
    }
    const hits = new Set();
    for (const f of tracked) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      words.forEach((w, i) => { if (text.includes(w) || f.includes(w)) hits.add(`一覧の${i + 1}行目の言葉が ${f} にあります`); });
    }
    words.forEach((w, i) => { if (log.includes(w)) hits.add(`一覧の${i + 1}行目の言葉が、コミットの記録にあります`); });
    check(`言葉の確かめ（${words.length} 語・${tracked.length} ファイル）`, [...hits]);
  }
}

let failed = 0;
for (const r of results) {
  const skipped = r.name.startsWith('言葉の確かめ') && r.problems.length === 1 && r.problems[0].includes('確かめていません');
  const mark = r.problems.length === 0 ? '○' : skipped ? '－' : '×';
  if (mark === '×') failed += 1;
  console.log(`${mark} ${r.name}`);
  for (const p of r.problems.slice(0, 10)) console.log(`    ${p}`);
  if (r.problems.length > 10) console.log(`    ほか ${r.problems.length - 10} 件`);
}
console.log(failed ? `\n${failed} 個の確かめに通りませんでした。` : '\n全部通りました。');
process.exit(failed ? 1 : 0);
