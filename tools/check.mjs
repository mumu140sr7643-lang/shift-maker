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
import { parseData } from '../app/js/storage.js';
import * as C from '../app/js/check.js';
import * as R from '../app/js/rules.js';
import { solveStaged } from '../app/js/solver/stages.js';
import highsLoader from '../vendor/highs/highs.mjs';
import { snapshotOf, diffSnapshots, applyChanges } from '../app/js/undo.js';
import { prepareRepair, prepareRestart, solveRepair, tableChanges } from '../app/js/solver/repair.js';
import { checkProposal } from './repair.mjs';
import { summarize } from '../app/js/summary.js';
import { csvCell, toCsv, shiftTableRows } from '../app/js/csv.js';
import { dayMargins, tightRanges, newTightness, staffingTable, monthTotals, lowerBound, fixesFor, applyFix, reasonsFor } from '../app/js/outlook.js';
import { checkFlow, checkMinimum } from './outlook-brute.mjs';

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
    // Worker や HiGHS の .wasm のように、new URL('…', import.meta.url) で読み込むもの
    const urls = [...text.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of [...imports, ...tags, ...urls]) if (!/\?v=/.test(spec)) problems.push(`${rel(f)}: ${spec} に ?v= がありません`);
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
  // 見本を変えたあと（v3-3）：前の版の見本のまま保存したデータは、同じ見本を選び直しても戻らないので、
  // 「何も変えていない見本」と見なさない（リセットなどの前に控えを残す）。いまの見本は見なす
  const oldCare = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/format1-care-2026-11.json'), 'utf8'));
  if (S.isUntouchedSample(oldCare)) problems.push('前の版の見本のまま保存したデータを、何も変えていない見本と見なす（控えが作られない）');
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
    if (!S.isUntouchedSample(JSON.parse(JSON.stringify(S.buildSample(kind, 2026, 11))))) problems.push(`いまの見本 ${kind} を、何も変えていない見本と見なさない`);
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

// 9c. 書き出したファイルを取り込むと、1文字も違わずに同じデータになる（見本4つ・作り物の月40種・古い形のデータ）
{
  const problems = [];
  const all = [];
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) all.push([`見本 ${kind}`, S.buildSample(kind, 2026, 11)]);
  for (let seed = 1; seed <= 40; seed += 1) all.push([`作り物 種${seed}`, await makeSample({ seed, withTable: seed % 2 === 0 })]);
  for (const name of readdirSync(join(ROOT, 'tools/fixtures')).filter((f) => f.endsWith('.json'))) {
    all.push([`古い形 ${name}`, JSON.parse(readFileSync(join(ROOT, 'tools/fixtures', name), 'utf8'))]);
  }
  for (const [name, d] of all) {
    const text = M.canonicalJSON(d);
    const r = parseData(text);
    if (r.error) problems.push(`${name}: 取り込めない（${r.error[0]}）`);
    else if (M.importProblems(r.data).length) problems.push(`${name}: 大きさで断られる`);
    else if (M.canonicalJSON(r.data) !== text) problems.push(`${name}: 取り込むと中身が変わる`);
  }
  const newer = parseData(JSON.stringify({ ...S.buildSample('care', 2026, 11), formatVersion: M.FORMAT_VERSION + 1 }));
  if (!newer.error || !newer.error[0].includes('新しい版')) problems.push('新しすぎる版のファイルを「新しい版」と書いて断れない');
  check(`書き出し→取り込みで同じになる（${all.length} 通り）`, problems);
}

// 9d. スキルを消しても、日ごとに要るスキルのデータがこわれない
{
  const problems = [];
  const d = S.buildSample('restaurant', 2026, 11);
  const [k1, k2] = d.settings.skills.map((k) => k.id);
  const s1 = d.settings.shifts[0].id;
  d.month.dailySkill = { [s1]: { 3: [k1], 4: [k1, k2] } };
  try {
    M.removeSkill(d, k1);
    if (JSON.stringify(d.month.dailySkill) !== JSON.stringify({ [s1]: { 4: [k2] } })) problems.push(`日ごとに要るスキルが ${JSON.stringify(d.month.dailySkill)} になった`);
    const errs = M.validateData(JSON.parse(JSON.stringify(d)));
    if (errs.length) problems.push(`消したあと読めない: ${errs[0]}`);
  } catch (e) {
    problems.push(`エラーになった: ${e.message}`);
  }
  check('スキルを消す（日ごとに要るスキルがあるとき）', problems);
}

// 11. 数え方の小さな例（docs/数え方の表.md 第2版。確かめ役と決めた A・B・C と相談の答え）
{
  const problems = [];
  const expect = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}: ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
  };
  // 2026年11月（1日は日曜、7日は土曜）。早・遅・夜の3つ、スタッフ1人、公休数0
  const base = () => {
    const d = M.emptyData(2026, 11, 'blank');
    d.settings.ranks = [M.newRank(d, '上'), M.newRank(d, '下')];
    const zero = { full: 0, part: 0, all: 0 };
    const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', need: { ...zero } });
    const L = M.newShift(d, { symbol: '遅', name: '遅', group: 'late', need: { ...zero } });
    const N = M.newShift(d, { symbol: '夜', name: '夜', group: 'night', night: true, need: { ...zero } });
    d.settings.shifts = [E, L, N];
    const p = M.newStaff(d, { name: 'A', shifts: [E.id, L.id, N.id], rank: d.settings.ranks[1].id, offDays: 0, paidDays: 0, prevLastShift: null, prevConsecutive: 0 });
    d.staff = [p];
    return { d, E, L, N, p };
  };
  const put = (d, pid, seq, start = 1) => seq.forEach((v, i) => { if (v) (d.month.table[pid] ??= {})[start + i] = v; });
  const S = (s) => ({ kind: 'shift', shift: s.id });
  const K = (k) => ({ kind: k });
  const n = (d, rule) => C.checkTable(d).byRule[rule].count;

  // A：半休・明けをはさむ組は作らない
  for (const [name, seq, want] of [
    ['遅→半休→早', (x) => [S(x.L), K('half'), S(x.E)], 0],
    ['遅→遅→半休→早→早', (x) => [S(x.L), S(x.L), K('half'), S(x.E), S(x.E)], 0],
    ['遅→（手で入れた）明け→早', (x) => [S(x.L), K('ake'), S(x.E)], 0],
    ['遅→早', (x) => [S(x.L), S(x.E)], 1],
  ]) {
    const x = base();
    put(x.d, x.p.id, seq(x));
    expect(`A ${name} の遅い→早い`, n(x.d, 'lateToEarly'), want);
  }
  {
    const x = base();
    x.d.settings.work.maxSwitches = 0;
    put(x.d, x.p.id, [S(x.E), S(x.L), K('half'), S(x.L), K('off'), S(x.E)]);
    expect('A 切り替えの回数は半休・休みを飛ばして数える（早→遅→遅→早で2回）', C.checkTable(x.d).byRule.switchCount.amount, 2);
  }
  // B：連休は公休・有給・余り日の続きで数え、明けを入れない
  const careSeq = (x, lastRun = true) => {
    const block = [S(x.N), K('ake'), K('off'), S(x.E), S(x.E)];
    return [...block, ...block, ...block, ...block, S(x.N), K('ake'), K('off'), K('off'), S(x.E), S(x.E), S(x.E), S(x.E), ...(lastRun ? [K('off'), K('off')] : [S(x.E), S(x.E)])];
  };
  {
    const x = base();
    x.p.offDays = 7;
    x.p.restStyle = 'together';
    put(x.d, x.p.id, careSeq(x));
    const r = C.checkTable(x.d);
    expect('B 介護の並び（連休2回）で「連休にしたい」人の連休の回数が足りない', r.byRule.fewRestRuns.count, 0);
    expect('B 夜勤→明け→公休→早 の公休は1日だけの休みにならない', r.byRule.singleOff.count, 0);
    const y = base();
    y.p.offDays = 7;
    y.p.restStyle = 'together';
    put(y.d, y.p.id, careSeq(y, false));
    expect('B 月末の連休を外すと、連休は1回（足りないのは1回）', C.checkTable(y.d).byRule.fewRestRuns.amount, 1);
    const z = base();
    z.p.offDays = 7;
    z.p.restStyle = 'spread';
    put(z.d, z.p.id, careSeq(z));
    expect('B「ばらしたい」人の 夜勤→明け→公休→公休 は休み方の希望と合わない、にならない', C.checkTable(z.d).byRule.restStyle.count, 0);
  }
  // C：人員不足・定数オーバーは1日・1シフトで1件
  {
    const x = base();
    x.E.need = { full: 1, part: 1, all: 2 };
    const q = M.newStaff(x.d, { name: 'B', employment: 'part', shifts: [x.E.id], offDays: 0, paidDays: 0 });
    const r2 = M.newStaff(x.d, { name: 'C', employment: 'part', shifts: [x.E.id], offDays: 0, paidDays: 0 });
    x.p.employment = 'full';
    x.d.staff.push(q, r2);
    put(x.d, q.id, [S(x.E)]);
    put(x.d, r2.id, [S(x.E)]);
    put(x.d, x.p.id, [K('off')]);
    const r = C.checkTable(x.d);
    const day1 = (rule) => r.items.filter((it) => it.rule === rule && it.day === 1 && it.shift === x.E.id).map((it) => it.amount);
    expect('C 社員が1人足りず、パートが1人多い日の人員不足', day1('shortage'), [1]);
    expect('C 同じ日の定数オーバー', day1('overstaff'), [1]);
  }
  // 相談1：希望と違う（ぴったり同じかで見る）
  {
    const x = base();
    x.d.month.requests[x.p.id] = { 2: { kind: 'off' } };
    put(x.d, x.p.id, [S(x.E), K('paid')]);
    expect('相談1 公休の希望の日に有給は「希望と違う」', n(x.d, 'requestDiff'), 1);
    put(x.d, x.p.id, [S(x.E), K('off')]);
    expect('相談1 同じなら0', n(x.d, 'requestDiff'), 0);
    delete x.d.month.table[x.p.id][2];
    expect('相談1 表のマスが空きなら数えない', n(x.d, 'requestDiff'), 0);
    put(x.d, x.p.id, [S(x.E)], 2);
    expect('相談1 公休の希望の日に早番なら1件', n(x.d, 'requestDiff'), 1);
    expect('相談1 強さは選べない（絶対）', C.checkTable(x.d).byRule.requestDiff.strength, 'hard');
  }
  // 相談2：遅い→早いの間の2連休が足りない（別の決まり。同じ組を両方に数えない）
  {
    const x = base();
    x.p.twoOffAfterLateEarly = true;
    put(x.d, x.p.id, [S(x.L), K('off'), S(x.E)]);
    expect('相談2 2連休の人の 遅→休→早', [n(x.d, 'twoOffLateEarly'), n(x.d, 'lateOffEarly')], [1, 0]);
    const y = base();
    put(y.d, y.p.id, [S(y.L), K('off'), S(y.E)]);
    expect('相談2 ほかの人の 遅→休→早', [n(y.d, 'twoOffLateEarly'), n(y.d, 'lateOffEarly')], [0, 1]);
  }
  // 相談5：土日の希望（11月7日は土曜）
  {
    const x = base();
    x.p.weekendPref = 'off';
    put(x.d, x.p.id, [S(x.E)], 7);
    expect('相談5 土日は休みたい人の土曜の出勤', n(x.d, 'weekend'), 1);
    const y = base();
    y.p.weekendPref = 'work';
    put(y.d, y.p.id, [K('off')], 7);
    expect('相談5 土日に出たい人の土曜の休み', n(y.d, 'weekend'), 1);
    put(y.d, y.p.id, [K('off')], 9);
    expect('相談5 月曜の休みは見ない', n(y.d, 'weekend'), 1);
  }
  // 相談6：空の表は数えない
  {
    const x = base();
    x.p.offDays = 9;
    let r = C.checkTable(x.d);
    expect('相談6 空の表', [r.tableEmpty, r.totals.hard, r.totals.soft, r.items.length], [true, 0, 0, 0]);
    put(x.d, x.p.id, [S(x.E)]);
    r = C.checkTable(x.d);
    expect('相談6 1マスでも入っていれば数える', [r.tableEmpty, r.byRule.offShort.count], [false, 1]);
  }
  // 手順1のチェックと強さは1つの値
  {
    const x = base();
    put(x.d, x.p.id, [S(x.L), S(x.E)]);
    R.setStrength(x.d, 'lateToEarly', 'off');
    expect('強さ「なし」でチェックも外れ、数えない', [x.d.settings.work.forbidLateToEarly, n(x.d, 'lateToEarly')], [false, 0]);
    R.setStrength(x.d, 'lateToEarly', 'soft');
    expect('強さを選ぶとチェックも入る', [x.d.settings.work.forbidLateToEarly, R.strengthOf(x.d, 'lateToEarly')], [true, 'soft']);
    x.d.settings.work.avoidSingleOff = false;
    expect('チェックを外すと強さは「なし」', R.strengthOf(x.d, 'singleOff'), 'off');
  }
  // 6連勤以上と連勤超過（前の月から続く）・夜勤の次の日
  {
    const x = base();
    x.p.prevConsecutive = 3;
    x.p.prevLastShift = x.E.id;
    put(x.d, x.p.id, [S(x.E), S(x.E), S(x.E), K('off')]);
    const r = C.checkTable(x.d);
    const six = r.items.find((it) => it.rule === 'sixPlus');
    expect('前の月から続く6連勤（始まりは -2）', six && [six.from, six.to, six.amount], [-2, 3, 6]);
    expect('連勤超過の超えた日数（上限5日）', r.byRule.overStreak.amount, 1);
    const y = base();
    put(y.d, y.p.id, [S(y.N), S(y.E)]);
    expect('夜勤の次の日が出勤', n(y.d, 'nightNext'), 1);
    const z = base();
    z.p.prevLastShift = z.N.id;
    z.p.prevConsecutive = 1;
    put(z.d, z.p.id, [K('ake')]);
    expect('前の月の最後が夜勤で、1日が明け', n(z.d, 'nightNext'), 0);
  }
  // 夜勤のシフトの時間帯のグループを「遅い」にしてあっても、遅い→早いには数えない（夜勤の次の日だけ）
  {
    const x = base();
    x.N.group = 'late';
    put(x.d, x.p.id, [S(x.N), S(x.E)], 10);
    expect('グループが「遅い」の夜勤の次の日に早番', [n(x.d, 'nightNext'), n(x.d, 'lateToEarly')], [1, 0]);
    const y = base();
    y.N.group = 'late';
    y.p.prevLastShift = y.N.id;
    y.p.prevConsecutive = 1;
    put(y.d, y.p.id, [S(y.E)]);
    expect('前の月の最後がグループ「遅い」の夜勤で、1日が早番', [n(y.d, 'nightNext'), n(y.d, 'lateToEarly')], [1, 0]);
  }
  // 責任者の順位（いちばん上の人が2人以上なら、だれか1人が役に入っていればよい）
  {
    const x = base();
    const role = M.newShift(x.d, { symbol: '責', name: '責任者', group: 'early', onePerDay: true, need: { full: 0, part: 0, all: 0 } });
    x.d.settings.shifts.push(role);
    const [top, low] = x.d.settings.ranks.map((r) => r.id);
    const b = M.newStaff(x.d, { name: 'B', rank: top, shifts: [x.E.id, role.id], offDays: 0, paidDays: 0 });
    const c = M.newStaff(x.d, { name: 'C', rank: top, shifts: [x.E.id, role.id], offDays: 0, paidDays: 0 });
    x.d.staff.push(b, c);
    x.p.rank = low;
    put(x.d, x.p.id, [S(role)]);
    put(x.d, b.id, [S(x.E)]);
    expect('順位が下の人が役に入り、上の人が早にいる', n(x.d, 'leaderRank'), 1);
    put(x.d, x.p.id, [S(x.E)]);
    put(x.d, c.id, [S(role)]);
    expect('いちばん上の順位の2人のうち1人が役に入っている', n(x.d, 'leaderRank'), 0);
  }
  // 良し悪しの比べ方
  {
    const x = base();
    x.E.need = { full: 0, part: 0, all: 2 };
    x.E.combine = true;
    put(x.d, x.p.id, [S(x.E), S(x.E)]);
    const before = C.checkTable(x.d);
    const y = M.clone(x.d);
    y.staff.push(M.newStaff(y, { name: 'B', shifts: [x.E.id], offDays: 0, paidDays: 0 }));
    put(y, y.staff[1].id, [S(x.E)]);
    const after = C.checkTable(y);
    expect('人員不足が減れば改善', C.isImproved(before, after), true);
    expect('同じなら改善ではない', C.isImproved(before, before), false);
    const z = M.clone(x.d);
    put(z, x.p.id, [S(x.E), S(x.E), S(x.E), S(x.E), S(x.E), S(x.E)]);
    expect('6連勤以上が新しくできたら改善ではない', C.isImproved(before, C.checkTable(z)), false);
    expect('並べる順で、良いほうが先', C.compareResults(after, before) < 0, true);
  }
  // 同じデータからは、いつも同じ結果
  for (let seed = 1; seed <= 10; seed += 1) {
    const d = await makeSample({ seed, withTable: true });
    if (JSON.stringify(C.checkTable(d)) !== JSON.stringify(C.checkTable(M.clone(d)))) problems.push(`種 ${seed}: 同じデータで結果が変わる`);
  }
  check('数え方の小さな例（数え方の表 第2版）', problems);
}

// 12. 希望だけで必ずエラーになるもの（requestConflicts）
{
  const problems = [];
  const mk = () => {
    const d = M.emptyData(2026, 11, 'blank');
    const zero = { full: 0, part: 0, all: 0 };
    const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', need: { ...zero } });
    const N = M.newShift(d, { symbol: '夜', name: '夜', group: 'night', night: true, need: { ...zero } });
    const X = M.newShift(d, { symbol: '外', name: '担当外', group: 'early', need: { ...zero } });
    d.settings.shifts = [E, N, X];
    const p = M.newStaff(d, { name: 'A', shifts: [E.id, N.id], offDays: 0, paidDays: 0 });
    d.staff = [p];
    return { d, E, N, X, p };
  };
  const rules = (d) => C.requestConflicts(d).map((it) => it.rule);
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
    if (C.requestConflicts(S.buildSample(kind, 2026, 11)).length) problems.push(`見本 ${kind} の希望の例で、知らせが出る（見本の希望は、作る前の確かめで止めない種類だけにする）`);
  }
  {
    const x = mk();
    x.d.month.requests[x.p.id] = { 3: { kind: 'shift', shift: x.X.id } };
    if (!rules(x.d).includes('notAssigned')) problems.push('担当外のシフトの希望を、知らせない');
  }
  {
    const x = mk();
    x.d.month.requests[x.p.id] = { 3: { kind: 'shift', shift: x.N.id }, 4: { kind: 'shift', shift: x.E.id } };
    if (!rules(x.d).includes('nightNext')) problems.push('夜勤の次の日に出勤の希望を、知らせない');
    x.d.month.requests[x.p.id] = { 3: { kind: 'shift', shift: x.N.id } };
    if (rules(x.d).includes('nightNext')) problems.push('夜勤の次の日に希望が無いのに知らせる（明けにできる）');
    x.d.month.requests[x.p.id] = { 3: { kind: 'shift', shift: x.N.id }, 4: { kind: 'off' } };
    if (rules(x.d).includes('nightNext')) problems.push('夜勤の次の日が休みの希望なのに知らせる');
  }
  {
    const x = mk();
    x.d.month.requests[x.p.id] = Object.fromEntries([1, 2, 3, 4, 5, 6].map((day) => [day, { kind: 'shift', shift: x.E.id }]));
    const r = rules(x.d);
    if (!r.includes('sixPlus') || !r.includes('overStreak')) problems.push(`6日続けて出勤の希望で、6連勤以上と連勤超過を知らせない（${r.join(',')}）`);
    x.d.month.requests[x.p.id][4] = { kind: 'off' };
    if (rules(x.d).length) problems.push('間に休みの希望があるのに、続きとして知らせる');
  }
  check('希望だけで必ずエラーになるもの', problems);
}

// 13. 解く前のぶつかり（solveConflicts）：希望に、固定したマスを足して確かめる
{
  const problems = [];
  const mk = () => {
    const d = M.emptyData(2026, 11, 'blank');
    const zero = { full: 0, part: 0, all: 0 };
    const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', need: { ...zero } });
    const N = M.newShift(d, { symbol: '夜', name: '夜', group: 'night', night: true, need: { ...zero } });
    d.settings.shifts = [E, N];
    const p = M.newStaff(d, { name: 'A', shifts: [E.id, N.id], offDays: 0, paidDays: 0 });
    d.staff = [p];
    return { d, E, N, p };
  };
  const lock = (d, pid, day, v) => {
    if (v) (d.month.table[pid] ??= {})[day] = v;
    else delete d.month.table[pid]?.[day];
    (d.month.marks[pid] ??= {})[day] = { locked: true };
  };
  const rules = (d) => C.solveConflicts(d).map((it) => it.rule);
  for (const kind of ['restaurant', 'retail', 'care', 'blank']) {
    for (const [y, m] of [[2026, 11], [2027, 2], [2027, 7]]) {
      const d = S.buildSample(kind, y, m);
      if (C.solveConflicts(d).length) problems.push(`見本 ${kind} ${y}-${m} で、作る前に止める知らせが出る`);
      if (C.unavoidableErrors(d).length) problems.push(`見本 ${kind} ${y}-${m} で、避けられないエラーが出る`);
    }
  }
  {
    const x = mk();
    x.d.month.requests[x.p.id] = { 3: { kind: 'off' } };
    lock(x.d, x.p.id, 3, { kind: 'shift', shift: x.E.id });
    if (!rules(x.d).includes('requestDiff')) problems.push('固定したマスと希望が違うのに、知らせない');
    lock(x.d, x.p.id, 3, { kind: 'off' });
    if (rules(x.d).length) problems.push('固定したマスと希望が同じなのに、知らせる');
  }
  {
    const x = mk();
    lock(x.d, x.p.id, 3, { kind: 'shift', shift: x.N.id });
    lock(x.d, x.p.id, 4, null);
    if (!rules(x.d).includes('nightNext')) problems.push('夜勤を固定した次の日が、空きのまま固定されているのに知らせない');
    const y = mk();
    y.p.prevLastShift = y.N.id;
    lock(y.d, y.p.id, 1, null);
    if (!rules(y.d).includes('nightNext')) problems.push('前の月の最後が夜勤で、1日が空きのまま固定されているのに知らせない');
  }
  {
    const x = mk();
    for (const day of [1, 2, 3]) lock(x.d, x.p.id, day, { kind: 'shift', shift: x.E.id });
    x.d.month.requests[x.p.id] = { 4: { kind: 'shift', shift: x.E.id }, 5: { kind: 'shift', shift: x.E.id }, 6: { kind: 'shift', shift: x.E.id } };
    if (rules(x.d).includes('sixPlus')) problems.push('6連勤以上は式で量を減らすだけなので、解く前に止めない');
    if (!C.unavoidableErrors(x.d).some((it) => it.rule === 'sixPlus')) problems.push('固定と希望を合わせて6日続けて出勤なのに、避けられないエラーとして6連勤以上を知らせない');
  }
  {
    // 夜勤の次の日が決まっていなければ明けになる（式で縛る）ので、明けも出勤に数えて避けられない連勤を出す
    const x = mk();
    lock(x.d, x.p.id, 1, { kind: 'shift', shift: x.N.id });
    for (const day of [3, 4, 5, 6]) lock(x.d, x.p.id, day, { kind: 'shift', shift: x.E.id });
    if (!C.unavoidableErrors(x.d).some((it) => it.rule === 'sixPlus')) problems.push('夜勤→（明けになる日）→出勤4日 の6連勤以上を、避けられないエラーとして知らせない');
    lock(x.d, x.p.id, 2, { kind: 'off' });
    if (C.unavoidableErrors(x.d).length) problems.push('夜勤の次の日を休みに固定したのに、避けられないエラーを知らせる');
  }
  check('解く前のぶつかり（固定したマスも入れる）と、避けられないエラー', problems);
}

// 13b. 自動で作った表を入れる（applyGenerated）：固定は残す・手で変えた印は消す・記録は 20 回まで
{
  const problems = [];
  const d = S.buildSample('restaurant', 2026, 11);
  const p = d.staff[0];
  d.month.marks[p.id] = { 2: { locked: true, edited: true }, 3: { edited: true } };
  d.month.runs = Array.from({ length: M.MAX_RUNS }, (_, i) => ({ at: `run-${i}` }));
  M.applyGenerated(d, { [p.id]: { 1: { kind: 'off' } } }, { at: 'new' });
  if (d.month.table[p.id]?.[1]?.kind !== 'off') problems.push('作った表が入らない');
  if (!d.month.marks[p.id]?.[2]?.locked || d.month.marks[p.id]?.[2]?.edited) problems.push('固定の印が消えた、または手で変えた印が残った');
  if (d.month.marks[p.id]?.[3]) problems.push('手で変えた印だけのマスの印が残った');
  if (d.month.runs.length !== M.MAX_RUNS || d.month.runs[0].at !== 'run-1' || d.month.runs[M.MAX_RUNS - 1].at !== 'new') problems.push(`記録が新しい ${M.MAX_RUNS} 回ぶんになっていない`);
  if (M.validateData(JSON.parse(JSON.stringify(d))).length) problems.push('作った表を入れたデータが、データの形の確かめに通らない');
  check('自動で作った表を入れる（固定は残す・記録は 20 回まで）', problems);
}

// 14. 自動で作る（小さな月）：同じ種・同じ上限なら同じ表／固定したマスは変わらない／担当外を入れない
{
  const problems = [];
  const d = S.buildSample('restaurant', 2026, 11);
  const p0 = d.staff[0];
  (d.month.table[p0.id] ??= {})[5] = { kind: 'paid' };
  (d.month.marks[p0.id] ??= {})[5] = { locked: true };
  const run = () => solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: 5, seed: 1, maxStages: 2 });
  const a = await run();
  const b = await run();
  if (!a.ok) problems.push(`見本の月で作れない（${a.reason}）`);
  else {
    if (JSON.stringify(a.table) !== JSON.stringify(b.table)) problems.push('同じ種・同じ上限なのに、表が違う');
    if (a.table[p0.id]?.[5]?.kind !== 'paid') problems.push('固定したマス（有給）が変わった');
    const after = M.clone(d);
    after.month.table = a.table;
    const c = C.checkTable(after);
    for (const r of ['notAssigned', 'requestDiff', 'nightNext']) if (c.byRule[r].count) problems.push(`できた表に ${r} が ${c.byRule[r].count}件`);
  }
  check('自動で作る（小さな月で、同じ答え・固定を守る）', problems);
}

// 15. 元に戻す・やり直す（undo.js）と、同じ日の2人の入れ替え（swapCells）（4-1）
{
  const problems = [];
  const d = S.buildSample('care', 2026, 11);
  const [a, b, c] = d.staff;
  const night = d.settings.shifts.find((x) => x.night);
  const early = d.settings.shifts.find((x) => !x.night && b.shifts.includes(x.id) && a.shifts.includes(x.id));
  // 1つの操作：マス・固定の印・日ごとの必要人数・作った記録を変える → 戻すと1文字も同じ、やり直すと変えたあとと1文字も同じ
  const text0 = M.canonicalJSON(d);
  const s0 = snapshotOf(d);
  M.setCellByHand(d, a.id, 3, { kind: 'shift', shift: night.id });
  M.setLock(d, c.id, 7, true);
  M.setNeedOverride(d, early.id, 'all', 9, 5);
  d.month.runs.push({ at: 'x' });
  const ch = diffSnapshots(s0, snapshotOf(d));
  const text1 = M.canonicalJSON(d);
  if (ch.length !== 5) problems.push(`変えた所の数が ${ch.length}（マス2・印1・必要人数1・記録1 の 5 のはず）`);
  const u = applyChanges(d, ch, 'undo');
  if (M.canonicalJSON(d) !== text0 || u.skipped) problems.push('元に戻すと、変える前と1文字も同じにならない');
  applyChanges(d, ch, 'redo');
  if (M.canonicalJSON(d) !== text1) problems.push('やり直すと、変えたあとと1文字も同じにならない');
  // そのあとで変えた所は、いまのまま（ほかは戻す）
  M.setCellByHand(d, a.id, 3, { kind: 'off' });
  const u2 = applyChanges(d, ch, 'undo');
  if (u2.skipped !== 2 || M.cellOf(d, a.id, 3)?.kind !== 'off' || M.marksOf(d, c.id, 7).locked) problems.push(`そのあとで変えた所を戻した、またはほかを戻さなかった（いまのままにした所 ${u2.skipped}）`);
  // いなくなった人のマスは戻さない
  const d2 = S.buildSample('care', 2026, 11);
  const t0 = snapshotOf(d2);
  M.setCellByHand(d2, d2.staff[1].id, 2, { kind: 'off' });
  const ch2 = diffSnapshots(t0, snapshotOf(d2));
  d2.staff.splice(1, 1);
  delete d2.month.table[b.id];
  const u3 = applyChanges(d2, ch2, 'undo');
  if (u3.applied.length || d2.month.table[b.id]) problems.push('いなくなった人のマスを戻した');
  // 入れ替え：夜勤と早出を入れ替えると、明けも動く。固定したマスは入れ替えない
  const d3 = S.buildSample('care', 2026, 11);
  const [p, q] = [d3.staff[1], d3.staff[3]];
  M.setCellByHand(d3, p.id, 10, { kind: 'shift', shift: night.id });
  M.setCellByHand(d3, q.id, 10, { kind: 'shift', shift: early.id });
  const r = M.swapCells(d3, p.id, q.id, 10);
  if (!r.ok || M.cellOf(d3, p.id, 10)?.shift !== early.id || M.cellOf(d3, q.id, 10)?.shift !== night.id) problems.push('同じ日の2人のマスが入れ替わらない');
  if (M.cellOf(d3, p.id, 11) !== null || M.cellOf(d3, q.id, 11)?.kind !== 'ake') problems.push('入れ替えたあと、明けが夜勤の人の次の日に動かない');
  M.setLock(d3, p.id, 12, true);
  const before3 = M.canonicalJSON(d3);
  if (M.swapCells(d3, p.id, q.id, 12).ok || M.canonicalJSON(d3) !== before3) problems.push('固定したマスを入れ替えた');
  check('元に戻す・やり直す（変えた所だけ・いまもその値の所だけ）と入れ替え', problems);
}

// 16. エラーを自動で直す・途中から作り直す（repair.js）（4-2）
{
  const problems = [];
  const d = await makeSample({ seed: 9, staff: 10, withTable: true });
  d.month.marks = {}; // 作り物の月の固定には、希望とぶつかるものがあるので外す
  const [p0, p1, p2] = d.staff;
  // 式の決まりを破っているマス：担当外のシフト・希望と違うマス
  const outside = d.settings.shifts.find((x) => !p0.shifts.includes(x.id));
  if (outside) d.month.table[p0.id] = { ...(d.month.table[p0.id] ?? {}), 4: { kind: 'shift', shift: outside.id } };
  d.month.requests[p1.id] = { ...(d.month.requests[p1.id] ?? {}), 6: { kind: 'paid' } };
  d.month.table[p1.id] = { ...(d.month.table[p1.id] ?? {}), 6: { kind: 'off' } };
  // 空き・半休・固定
  d.month.table[p2.id] = { ...(d.month.table[p2.id] ?? {}), 7: { kind: 'off' }, 9: { kind: 'half' } };
  delete d.month.table[p2.id][8];
  d.month.marks[p2.id] = { ...(d.month.marks[p2.id] ?? {}), 10: { locked: true } };
  delete d.month.requests[p2.id];
  const base = prepareRepair(d);
  if (base.requestDiffs < 1) problems.push('希望と違うマスを数えない');
  if (outside && base.noVar < 1) problems.push('担当外のシフトのマスを、必ず変わるマスに数えない');
  if (!base.prepared.month.marks[p2.id]?.[8]?.locked || !base.prepared.month.marks[p2.id]?.[9]?.locked) problems.push('空き・半休のマスを、写しで残さない');
  if (d.month.marks[p2.id]?.[8]) problems.push('本物のデータに固定の印を付けた');
  const known = base.requestDiffs + base.noVar;
  const res = await solveRepair(d, { loadHighs: () => highsLoader(), budgets: [known - 1, 40, null], nodeLimit: 5, secondsEach: null });
  if (!res.ok) problems.push(`直す案を作れない（${res.reason}）`);
  else {
    if (res.proposals[0].status !== 'too-many') problems.push('必ず変えるマスより小さい上限で、「この上限では直せません」にならない');
    for (const pr of res.proposals.filter((x) => x.status === 'ok')) {
      const bad = checkProposal(d, pr);
      if (bad.length) problems.push(`上限 ${pr.budget ?? '全部'} の案：${bad.slice(0, 2).join(' / ')}`);
      if (tableChanges(d, pr.table).length !== pr.changes.length) problems.push('変わるマスの数が合わない');
    }
  }
  // 途中から作り直す：選んだ日より前は、写しで固定（空きも）。本物には印を付けない
  const r = prepareRestart(d, 11);
  if (!d.staff.every((p) => [1, 5, 10].every((day) => r.month.marks[p.id]?.[day]?.locked)) || r.month.marks[p0.id]?.[11]?.locked) problems.push('途中から作り直すの写しで、選んだ日より前だけを固定にしていない');
  const blockers = C.solveConflicts(r, { lockedName: 'いまのまま残すマス' });
  if (outside && !blockers.some((it) => it.rule === 'notAssigned')) problems.push('残す日に担当外のシフトがあるのに、作る前に止めない');
  if (blockers.some((it) => it.rule === 'requestDiff' && !it.text.includes('いまのまま残すマス'))) problems.push('残すマスのぶつかりの文が「固定したマス」のまま');
  check('エラーを自動で直す・途中から作り直す（上限・残すマス・止める）', problems);
}

// 17. 集計表（summary.js）と CSV（csv.js）（4-3）
{
  const problems = [];
  const d = M.emptyData(2026, 11, 'blank');
  const zero = { full: 0, part: 0, all: 0 };
  const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', hours: 8, need: { ...zero } });
  const T = M.newShift(d, { symbol: '研', name: '研修', group: 'early', hours: 6, training: true, counts: false, need: { ...zero } });
  const N = M.newShift(d, { symbol: '夜', name: '夜', group: 'night', hours: 16, night: true, need: { ...zero } });
  d.settings.shifts = [E, T, N];
  d.settings.work.halfDayHours = 4;
  const p = M.newStaff(d, { name: 'A', shifts: [E.id, T.id, N.id], offDays: 9, paidDays: 1 });
  d.staff = [p];
  const cells = { 1: { kind: 'shift', shift: E.id }, 2: { kind: 'shift', shift: T.id }, 3: { kind: 'shift', shift: N.id }, 4: { kind: 'ake' }, 5: { kind: 'half' }, 6: { kind: 'off' }, 7: { kind: 'paid' }, 8: { kind: 'spare' } };
  d.month.table[p.id] = cells;
  const r = summarize(d).rows[0];
  const want = { workDays: 4, hours: 8 + 6 + 16 + 4, off: 1, paid: 1.5, half: 1, ake: 1, spare: 1, empty: 22 };
  for (const [k, v] of Object.entries(want)) if (r[k] !== v) problems.push(`集計表の ${k} が ${r[k]}（${v} のはず。数え方の表 1 章）`);
  if (r.shiftCounts[E.id] !== 1 || r.shiftCounts[T.id] !== 1 || r.shiftCounts[N.id] !== 1) problems.push('シフトごとの回数が合わない');
  // CSV：式として読まれない形・カンマ・改行・二重引用符
  const cases = [['=SUM(1)', "'=SUM(1)"], ['+1', "'+1"], ['-A', "'-A"], ['@x', "'@x"], ['\tx', "'\tx"], ['a,b', '"a,b"'], ['a"b', '"a""b"'], ['a\nb', '"a\nb"'], ['=a,b', `"'=a,b"`], ['ふつう', 'ふつう'], [12.5, '12.5'], [-1, '-1']];
  for (const [inp, out] of cases) if (csvCell(inp) !== out) problems.push(`CSV の ${JSON.stringify(inp)} が ${JSON.stringify(csvCell(inp))}（${JSON.stringify(out)} のはず）`);
  const text = toCsv([['a', 'b'], ['c', 'd']]);
  if (text !== `${String.fromCharCode(0xfeff)}a,b\r\nc,d\r\n`) problems.push('CSV の先頭に BOM が無い、または行の終わりが CRLF でない');
  const rows = shiftTableRows(d);
  if (rows.length !== 3 || rows[1][0] !== 'A' || rows[1][1] !== '早' || rows[1][5] !== '半' || rows[2][0] !== '合計') problems.push('CSV のシフト表の形が合わない');
  check('集計表（数え方の表 1 章）と CSV（BOM・式にならない・カンマ・改行）', problems);
}

// 18. 日ごとの余裕・あと何人休めるか・きつい期間（outlook.js）（5-1）
{
  const problems = [];
  const d = M.emptyData(2026, 11, 'blank');
  const one = { full: 0, part: 0, all: 1 };
  const zero = { full: 0, part: 0, all: 0 };
  const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', combine: true, need: { ...one } });
  const L = M.newShift(d, { symbol: '遅', name: '遅', group: 'late', combine: true, need: { ...one } });
  const T = M.newShift(d, { symbol: '研', name: '研修', group: 'early', training: true, counts: false, combine: true, need: { ...zero } });
  const Nt = M.newShift(d, { symbol: '夜', name: '夜', group: 'night', night: true, combine: true, need: { ...zero } });
  d.settings.shifts = [E, L, T, Nt];
  const k1 = M.newSkill(d, { name: 'k1' });
  d.settings.skills = [k1];
  const A = M.newStaff(d, { name: 'A', shifts: [E.id, L.id], skills: [k1.id] });
  const B = M.newStaff(d, { name: 'B', shifts: [E.id, L.id, Nt.id] });
  const Cc = M.newStaff(d, { name: 'C', shifts: [E.id, T.id] });
  const D = M.newStaff(d, { name: 'D', shifts: [T.id] });
  d.staff = [A, B, Cc, D];
  const before = dayMargins(d);
  if (before.some((m) => m.margin !== 1 || m.available !== 3 || m.need !== 2)) problems.push('はじめの余裕が 3人 − 2人 ＝ 1 にならない（人数に数えないシフトだけの人を数えた など）');
  if (JSON.stringify(tightRanges(before)) !== JSON.stringify([{ from: 1, to: 30 }])) problems.push('1 以下が続く月が、1つのきつい期間にならない');
  M.setRequest(d, A.id, 3, { kind: 'off' }); // 休みの希望
  d.month.table[Cc.id] = { 4: { kind: 'paid' } };
  d.month.marks[Cc.id] = { 4: { locked: true } }; // 有給に固定
  M.setRequest(d, Cc.id, 5, { kind: 'shift', shift: T.id }); // 研修に決まっている（人数に数えない）
  M.setRequest(d, B.id, 6, { kind: 'half' }); // 半休
  M.setRequest(d, B.id, 7, { kind: 'shift', shift: Nt.id }); // 決まった夜勤 → 8日は明け
  d.month.marks[A.id] = { 9: { locked: true } }; // 空きのまま固定
  d.month.dailySkill[E.id] = { 10: [k1.id] }; // 10日の早は k1 が要る → C は出られない
  const after = dayMargins(d);
  const want = { 3: 0, 4: 0, 5: 0, 6: 0, 7: 1, 8: 0, 9: 0, 10: 0, 11: 1 };
  for (const [day, m] of Object.entries(want)) if (after[day - 1].margin !== m) problems.push(`${day}日のあと何人休めるかが ${after[day - 1].margin}（${m} のはず）`);
  const n = newTightness(before, after);
  if (JSON.stringify(n.zeroDays) !== JSON.stringify([3, 4, 5, 6, 8, 9, 10]) || n.ranges.length) problems.push(`新しくできた 0 人の日が ${JSON.stringify(n.zeroDays)}`);
  const mk = (arr) => arr.map((m, i) => ({ day: i + 1, margin: m }));
  const nt = newTightness(mk([3, 3, 3, 3]), mk([3, 1, 1, 3]));
  if (JSON.stringify(nt.ranges) !== JSON.stringify([{ from: 2, to: 3 }]) || nt.zeroDays.length) problems.push('新しくできたきつい期間を見つけない');
  if (newTightness(mk([1, 1, 3]), mk([1, 1, 1])).ranges.length !== 1 || newTightness(mk([1, 1, 1]), mk([1, 1, 3])).ranges.length) problems.push('広がったきつい期間・縮んだきつい期間の扱いが違う');
  // 速さ：50人 × 31日で、1回ずつ数えて 1回 100ms 以内が目安（ここでは、ゆるく 300ms を超えたら知らせる）
  const big = await makeSample({ seed: 41, staff: 50, year: 2026, month: 12 });
  const t0 = performance.now();
  for (let i = 0; i < 5; i += 1) dayMargins(big);
  const ms = (performance.now() - t0) / 5;
  if (ms > 300) problems.push(`50人 × 31日のあと何人休めるかに ${Math.round(ms)}ms かかる`);
  check(`日ごとの余裕・きつい期間（50人×31日で 1回 ${Math.round(ms * 10) / 10}ms）`, problems);
}

// 19. 人手の余り・不足の表（最大流）と月の合計の人手（5-2）
{
  const problems = [];
  // とても小さな月 40 個で、最大流 ＝ 全部の割り当てを調べた最大（全部は tools/outlook-brute.mjs）
  for (let seed = 1; seed <= 40; seed += 1) problems.push(...checkFlow(seed));
  // 見本：わざと足りなくした日が「足りない日」に出る
  const r = staffingTable(S.buildSample('restaurant', 2026, 11)).find((x) => x.key === 'all');
  if (r.short !== 2 || JSON.stringify(r.shortDays) !== '[10]') problems.push(`飲食店の見本の全体の行が 不足 ${r.short}・足りない日 ${r.shortDays}（不足 2・10日 のはず）`);
  const c = staffingTable(S.buildSample('care', 2026, 11)).find((x) => x.key.startsWith('skill:') && x.key.endsWith(':night'));
  if (!c || c.short !== 1 || JSON.stringify(c.shortDays) !== '[20]') problems.push('介護施設の見本の、看護（夜）の行が 不足 1・20日 にならない');
  const t = monthTotals(S.buildSample('care', 2026, 11));
  if (t.total.need !== t.full.need + t.part.need + t.combined.need || t.combined.need === 0) problems.push('月の合計の人手で、区分を合わせるシフトを数えない');
  // 速さ：50人 × 31日
  const big = await makeSample({ seed: 41, staff: 50, year: 2026, month: 12 });
  const t0 = performance.now();
  staffingTable(big);
  const ms = performance.now() - t0;
  if (ms > 3000) problems.push(`50人 × 31日の人手の表に ${Math.round(ms)}ms かかる`);
  check(`人手の余り・不足の表（最大流 ＝ 総当たり・50人×31日で ${Math.round(ms)}ms）`, problems);
}

// 20. 最低◯件の見込み・直し方のボタン・不足の理由・帯の下の数（5-3）
{
  const problems = [];
  // 見本：わざと足りなくした所が、見込みにぴったり出る
  const want = { restaurant: { shortage: 2 }, retail: { shortage: 1 }, care: { skillShort: 1 } };
  for (const [kind, w] of Object.entries(want)) {
    const d = S.buildSample(kind, 2026, 11);
    const lb = lowerBound(d);
    if (JSON.stringify(lb.byRule) !== JSON.stringify(w) || lb.six) problems.push(`見本 ${kind} の見込みが ${JSON.stringify(lb.byRule)}（${JSON.stringify(w)} のはず）`);
    // 直し方のボタン：出したものは、どれも写しに当てると言ったとおりに減る
    for (const it of lb.items) {
      for (const f of fixesFor(d, it, lb)) {
        const copy = M.clone(d);
        applyFix(copy, f);
        const after = lowerBound(copy);
        if (after.six !== f.after.six || after.hard !== f.after.hard || after.six + after.hard >= lb.six + lb.hard) problems.push(`見本 ${kind} の「${f.label}」が言ったとおりに減らない`);
      }
    }
  }
  // とても小さな月の総当たり：見込み ≦ いちばん少ない件数（全部は tools/outlook-brute.mjs）
  for (let seed = 1; seed <= 6; seed += 1) problems.push(...checkMinimum(seed).problems);
  // 理由を見る：本物の表は変えない。社員の枠にパートは「埋まりません」
  {
    const d = S.buildSample('restaurant', 2026, 11);
    const res = await solveStaged(d, { loadHighs: () => highsLoader(), nodeLimit: 5, seed: 1, maxStages: 5 });
    d.month.table = res.table;
    const text = M.canonicalJSON(d);
    const asa = d.settings.shifts.find((x) => x.onePerDay && x.group === 'early');
    const list = reasonsFor(d, 10, asa.id);
    if (M.canonicalJSON(d) !== text) problems.push('理由を見ると、本物の表が変わった');
    const part = list.find((x) => d.staff.find((p) => p.id === x.pid)?.employment === 'part');
    if (!part || part.status !== 'blocked' || !part.text.includes('枠なので')) problems.push('社員の枠が足りない日に、パートの人の理由が「入れても埋まりません」にならない');
    if (!list.some((x) => x.text.includes('公休の希望'))) problems.push('休みの希望の人の理由が出ない');
  }
  // 帯の下の数（B）：公休を削った日が人の多い日なら、予定どおり休ませても足りなくならない（足し算なら増えてしまう）
  {
    const d = M.emptyData(2026, 11, 'blank');
    const E = M.newShift(d, { symbol: '早', name: '早', group: 'early', combine: true, need: { full: 0, part: 0, all: 1 } });
    d.settings.shifts = [E];
    d.staff = ['A', 'B', 'C'].map((name) => M.newStaff(d, { name, shifts: [E.id], offDays: 9 }));
    for (let day = 1; day <= 30; day += 1) for (const p of d.staff) (d.month.table[p.id] ??= {})[day] = { kind: 'shift', shift: E.id };
    const res = C.checkTable(d);
    const additive = res.totals.shortSlots + res.items.filter((it) => it.rule === 'offShort').reduce((a, it) => a + it.amount, 0);
    const least = staffingTable(d).find((r) => r.key === 'all').short;
    if (!(additive > 0 && least === 0)) problems.push(`公休を削った日が人の多い日の例で、最大流の「少なくとも」が ${least}（0 のはず。足し算なら ${additive}）`);
  }
  check('最低◯件の見込み（見本・総当たり）・直し方のボタン・不足の理由・帯の下の数', problems);
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
