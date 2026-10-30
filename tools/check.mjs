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
