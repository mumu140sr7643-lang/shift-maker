"""ブラウザで実際に押して確かめる道具（Playwright）。作り物の見本データだけを使う。

使い方:  python tools/ui_check.py                     （Chromium で確かめる）
        python tools/ui_check.py --channel msedge    （Edge で確かめる）
        python tools/ui_check.py --shots             （画面の写真も tools/out/ に残す）

確かめること:
  - 明るい・暗い × 幅 1280 / 390 / 375 で、ページの横のはみ出しが 0 か
  - 読みにくい文字（コントラスト 4.5:1 未満。大きい文字は 3:1 未満）が 0 か
  - JavaScript のエラーが 0 か
  - 控えから戻すと、前のデータが 1 文字も違わずに戻るか（リセット・月の片付け）
  - リセット・月の片付けを何回続けても、確認の文で「消える」と言ったもの以外は戻せるか
  - ひとつ前の保存に戻せるか
  - 日ごとの必要人数のキーボード操作
  - シフトを追加の小窓で、まずい記号を断るか
  - 名前に HTML を入れても、文字として出るか（動かないか）。希望とシフト表の表でも
  - 希望の入力（記号を選んでマスを押す・消す・キーボード）、シフト表（選ぶ小窓・夜勤の次の日の明け・固定）
  - 2月と12月・スタッフ 50 人の作り物の月で、崩れず、マスを押してから 0.3 秒以内に小窓が出るか
  - 書き出し・取り込み（同じ中身になる・控えに残る・まずいファイルや大きすぎるファイルを断る・名前の HTML が動かない）
  - 検査の画面（空の表の案内・6連勤以上の印と「悪くなりました」・一覧から動く・配置した人数・件数の帯と印が tools/count.mjs と同じ）
  - 決まりの強さ（手順1のチェックと1つの値・強さで件数が移る）と、希望だけで必ずエラーになるものの知らせ
  - 保存データが読めないとき、控えを残して知らせるか
  - Excel に出す（マスの記号と色・集計表・件数が画面と同じ・式が入らない）・CSV に出す（BOM・式にならない・カンマと引用符）・手順6 の集計表・ファイルの名前
  - エラーを自動で直す（上限ごとの案・表で見る・反映・元に戻す・必ず変えるマスが多い上限）と、途中から作り直す（残す日は同じ・元に戻せる・残す日に担当外があれば止める）
  - 元に戻す・やり直す（マス・入れ替え・必要人数・自動で作った表。1文字も同じに戻る・読み直すと履歴は消える）と、同じ日の2人の入れ替え（ドラッグ・小窓・固定は入れ替えない）
  - 自動で作る（中止で前のまま・計算中はほかを押せない・進み具合・件数の帯が check.js と同じ・置きかえる前の控えから戻る・記録 20 回まで・別のタブで変えたら上書きしない・作る前の確かめ）
終わりに、結果を JSON で表示する。1 つでも失敗があれば、終わりのコードは 1。
"""
import calendar
import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "out"
SHOTS = "--shots" in sys.argv
CHANNEL = sys.argv[sys.argv.index("--channel") + 1] if "--channel" in sys.argv else None
PREFIX = "shift-maker:"

CONTRAST_JS = r"""
() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (root && root.a > 0) bg = root;
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  };
  const bad = [];
  const seen = new Set();
  const els = document.querySelectorAll('body *');
  for (const el of els) {
    if (seen.has(el)) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || el.closest('[hidden]')) continue;
    if (!el.getClientRects().length) continue;
    if (el.disabled || el.closest(':disabled') || el.closest('[aria-disabled="true"]')) continue;
    const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !['checkbox', 'radio', 'color', 'hidden'].includes(el.type);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText && !isField) continue;
    if (isField && !(el.value || '').trim()) continue;
    seen.add(el);
    let fg = parse(st.color);
    if (!fg) continue;
    const opacity = (() => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; })();
    if (opacity < 1) continue;
    const bg = bgOf(el);
    if (fg.a < 1) fg = blend(fg, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(st.fontSize);
    const bold = Number(st.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) {
      const text = isField ? el.value : [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      bad.push({ text: text.slice(0, 30), ratio: Math.round(ratio * 100) / 100, need, tag: el.tagName, cls: el.className });
    }
  }
  return bad;
}
"""

OVERFLOW_JS = "() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth })"


class QuietHandler(SimpleHTTPRequestHandler):
    # つなぎ直しを減らす（何回も続けて動かすと、Windows で通信の空きが足りなくなることがあるため）
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass


class Server:
    def __enter__(self):
        handler = partial(QuietHandler, directory=str(ROOT))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()


results = {"pass": [], "fail": []}


def ok(cond, name, detail=""):
    (results["pass"] if cond else results["fail"]).append(name + (f"：{detail}" if detail and not cond else ""))
    return cond


def t(page, testid):
    return page.locator(f'[data-testid="{testid}"]')


def stored(page):
    return page.evaluate(f"() => localStorage.getItem('{PREFIX}data')")


def fresh_page(browser, base, width, scheme):
    ctx = browser.new_context(viewport={"width": width, "height": 900}, color_scheme=scheme, locale="ja-JP")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/app/")
    page.evaluate("() => localStorage.clear()")
    page.goto(base + "/app/")
    page.wait_for_selector('[data-testid="screen-title"]')
    return ctx, page, errors


def look(page, label, shot=None):
    o = page.evaluate(OVERFLOW_JS)
    ok(o["sw"] <= o["w"], f"はみ出し0 {label}", f"{o['sw']}px > {o['w']}px")
    bad = page.evaluate(CONTRAST_JS)
    ok(not bad, f"コントラスト {label}", json.dumps(bad[:5], ensure_ascii=False))
    if SHOTS and shot:
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f"{shot}.png"), full_page=True)


def go(page, n, width):
    if width < 760:
        t(page, "menu-toggle").click()
    t(page, f"step-{n}").click()
    page.wait_for_selector('[data-testid="screen-title"]')


def tour(browser, base, width, scheme):
    label = f"{scheme} {width}px"
    ctx, page, errors = fresh_page(browser, base, width, scheme)
    look(page, f"{label} 見本を選ぶ", f"welcome-{scheme}-{width}")
    for kind in ["restaurant", "retail", "care"]:
        page.evaluate("() => localStorage.clear()")
        page.goto(base + "/app/")
        t(page, f"sample-{kind}").click()
        page.wait_for_selector('[data-testid="step-1"]', state="attached")
        for n in range(1, 7):
            go(page, n, width)
            if n == 2:
                page.locator('[data-testid="need-details"] > summary').click()
                page.wait_for_selector('[data-testid="need-grid"]')
                t(page, "shift-detail-toggle").first.click()
            if n == 3:
                t(page, "staff-item").first.click()
            look(page, f"{label} {kind} 手順{n}", f"{kind}-step{n}-{scheme}-{width}" if kind == "care" or n == 2 else None)
        t(page, "data-button").click()
        look(page, f"{label} {kind} 保存と控え", f"{kind}-datapanel-{scheme}-{width}" if kind == "restaurant" else None)
        t(page, "data-panel-close").click()
    ok(not errors, f"エラー0 {label}", " / ".join(errors[:3]))
    ctx.close()


def scenario_reset_backup(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    t(page, "step-3").click()
    t(page, "staff-item").first.click()
    name = t(page, "staff-name")
    name.fill("AA")
    name.press("Tab")
    before = stored(page)
    t(page, "data-button").click()
    t(page, "reset").click()
    t(page, "reset-ok").click()
    page.wait_for_selector('[data-testid="sample-retail"]')
    ok(stored(page) is None, "リセットで保存が消える")
    ok(t(page, "welcome-backup").count() == 1, "リセットのあと、見本の画面に控えが出る")
    t(page, "sample-retail").click()
    t(page, "step-3").click()
    t(page, "staff-item").first.click()
    t(page, "staff-name").fill("ZZ")
    t(page, "staff-name").press("Tab")
    t(page, "data-button").click()
    t(page, "restore-backup").click()
    t(page, "restore-backup-ok").click()
    after = stored(page)
    ok(after == before, "リセット→見本→1つ変える→控えから戻す で1文字も違わない")
    # 戻す前のデータは「ひとつ前の保存」に入っている
    t(page, "data-button").click()
    t(page, "restore-prev").click()
    t(page, "restore-prev-ok").click()
    data = json.loads(stored(page))
    ok(data["sample"] == "retail" and data["staff"][0]["name"] == "ZZ", "控えから戻したあと、ひとつ前の保存で戻せる")
    ok(not errors, "エラー0 リセットの控え", " / ".join(errors[:3]))
    ctx.close()


def rename_first_staff(page, name):
    t(page, "step-3").click()
    t(page, "staff-item").first.click()
    t(page, "staff-name").fill(name)
    t(page, "staff-name").press("Tab")


def reset(page):
    t(page, "data-button").click()
    t(page, "reset").click()
    text = t(page, "reset-dialog").inner_text()
    t(page, "reset-ok").click()
    page.wait_for_selector('[data-testid="welcome"]')
    return text


def backup_id_of(page, data_text):
    return page.evaluate(
        """(text) => {
          const list = JSON.parse(localStorage.getItem('shift-maker:backups') || '[]');
          const b = list.find((x) => JSON.stringify(x.data) === text);
          return b ? b.id : null;
        }""",
        data_text,
    )


def scenario_backup_sequences(browser, base):
    """確かめ役の 3 つの順番。どれも最後に A が 1 文字も違わずに戻ること"""
    # 1. A → リセット → 見本 → 何も変えずにリセット → 見本 → 何も変えずにリセット → A に戻す
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    rename_first_staff(page, "AA")
    a = stored(page)
    reset(page)
    for _ in range(2):
        t(page, "sample-retail").click()
        text = reset(page)
        ok("何も変えていない" in text, "見本のままでリセットするとき、控えを作らないと書く")
    ok(page.locator('[data-testid="notices"] > *').count() <= 1, "リセットを続けても、古い知らせが重ならない")
    bid = backup_id_of(page, a)
    ok(bid is not None, "順番1：何も変えずにリセットを続けても、A の控えが残る")
    if bid:
        page.locator(f'[data-testid="welcome-backup-restore"][data-backup-id="{bid}"]').click()
        ok(stored(page) == a, "順番1：A が 1 文字も違わずに戻る")
    ok(not errors, "エラー0 順番1", " / ".join(errors[:3]))
    ctx.close()

    # 2. A → リセット → 見本 → 1 つ変えてリセット → A に戻す
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    rename_first_staff(page, "AA")
    a = stored(page)
    reset(page)
    t(page, "sample-retail").click()
    rename_first_staff(page, "BB")
    b = stored(page)
    text = reset(page)
    ok("控えに残します" in text, "変えたデータでリセットするとき、控えに残すと書く")
    ok(backup_id_of(page, b) is not None, "順番2：2回目のリセットの前のデータ B も控えに残る")
    bid = backup_id_of(page, a)
    ok(bid is not None, "順番2：A の控えが残る")
    if bid:
        page.locator(f'[data-testid="welcome-backup-restore"][data-backup-id="{bid}"]').click()
        ok(stored(page) == a, "順番2：A が 1 文字も違わずに戻る")
    ok(not errors, "エラー0 順番2", " / ".join(errors[:3]))
    ctx.close()

    # 3. A → 月の片付け → 特別な日を 1 つ足す → 月の片付け → A に戻す
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-retail").click()
    rename_first_staff(page, "AA")
    t(page, "step-4").click()
    page.locator('[data-testid="brush"][data-brush="off"]').click()
    page.locator('[data-testid="request-cell"][data-row="0"][data-day="3"]').click()
    t(page, "step-6").click()
    page.locator('[data-testid="table-cell"][data-row="1"][data-day="4"]').click()
    page.locator('[data-testid="pick-option"][data-kind="off"]').click()
    a = stored(page)
    m = json.loads(a)["month"]
    ok(bool(m["requests"]) and bool(m["table"]), "順番3：A に希望と表のマスが入っている")
    for k in range(2):
        t(page, "step-1").click()
        y, mo = m["year"], m["month"] + 1 + k
        y, mo = (y + (mo - 1) // 12, (mo - 1) % 12 + 1)
        if k == 1:
            t(page, "special-add").click()
        t(page, "target-month").fill(f"{y}-{mo:02d}")
        t(page, "target-month-apply").click()
        page.wait_for_selector('[data-testid="month-dialog"]')
        t(page, "month-clear").click()
    bid = backup_id_of(page, a)
    ok(bid is not None, "順番3：月の片付けを2回続けても、A の控えが残る")
    if bid:
        t(page, "data-button").click()
        page.locator(f'[data-testid="restore-backup"][data-backup-id="{bid}"]').click()
        t(page, "restore-backup-ok").click()
        ok(stored(page) == a, "順番3：A が 1 文字も違わずに戻る")
    ok(not errors, "エラー0 順番3", " / ".join(errors[:3]))
    ctx.close()

    # 4. 控えがいっぱいのとき、消える控えを確認の文に書く
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-care").click()
    texts = []
    for i in range(6):
        rename_first_staff(page, f"X{i}")
        texts.append(reset(page))
        t(page, "sample-care").click()
    ok(all("消えます" not in x for x in texts[:5]), "控えが5つになるまでは、消える控えは無い")
    ok("いちばん古い控え" in texts[5] and "消えます" in texts[5], "6つ目の控えを作るとき、いちばん古い控えが消えると書く")
    n = page.evaluate("() => JSON.parse(localStorage.getItem('shift-maker:backups')).length")
    ok(n == 5, "控えは5つまで", str(n))
    ok(not errors, "エラー0 控えがいっぱい", " / ".join(errors[:3]))
    ctx.close()


def scenario_requests(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    t(page, "step-4").click()
    req = lambda: json.loads(stored(page))["month"]["requests"]
    data = json.loads(stored(page))
    pid = data["staff"][0]["id"]
    cell = lambda d: page.locator(f'[data-testid="request-cell"][data-row="0"][data-day="{d}"]')
    page.locator('[data-testid="brush"][data-brush="off"]').click()
    cell(3).click()
    ok(req().get(pid, {}).get("3") == {"kind": "off"} and cell(3).inner_text().strip() == "休", "休みを選んでマスを押すと、休みの希望が入る")
    cell(3).click()
    ok("3" not in req().get(pid, {}), "同じ記号でもう一度押すと、消える")
    sid = data["settings"]["shifts"][0]["id"]
    page.locator(f'[data-testid="brush"][data-brush="{sid}"]').click()
    cell(4).click()
    ok(req().get(pid, {}).get("4") == {"kind": "shift", "shift": sid}, "シフトの記号を選んでマスを押すと、出勤の固定が入る")
    page.locator('[data-testid="brush"][data-brush="clear"]').click()
    cell(4).click()
    ok("4" not in req().get(pid, {}), "「消す」を選んでマスを押すと、消える")
    page.locator('[data-testid="brush"][data-brush="paid"]').click()
    cell(5).click()
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Enter")
    ok(req().get(pid, {}).get("6") == {"kind": "paid"}, "矢印キーで動いて Enter で入る")
    page.keyboard.press("ArrowDown")
    ok(page.evaluate("() => document.activeElement.dataset.row") == "1", "↓ で下の人へ動く")
    ok(not errors, "エラー0 希望の入力", " / ".join(errors[:3]))
    ctx.close()


def scenario_table(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-care").click()
    data = json.loads(stored(page))
    pid = data["staff"][1]["id"]
    night = next(s["id"] for s in data["settings"]["shifts"] if s["night"])
    day_shift = data["settings"]["shifts"][0]["id"]
    t(page, "step-4").click()
    page.locator('[data-testid="brush"][data-brush="off"]').click()
    page.locator('[data-testid="request-cell"][data-row="1"][data-day="12"]').click()
    t(page, "step-6").click()
    tab = lambda: json.loads(stored(page))["month"]["table"].get(pid, {})
    cell = lambda d: page.locator(f'[data-testid="table-cell"][data-row="1"][data-day="{d}"]')

    def pick(kind, shift=None):
        sel = f'[data-testid="pick-option"][data-kind="{kind}"]' + (f'[data-shift="{shift}"]' if shift else "")
        page.locator(sel).click()

    cell(5).click()
    ok(t(page, "cell-picker").count() == 1, "マスを押すと、選ぶ小窓が出る")
    pick("shift", night)
    ok(tab().get("5", {}).get("shift") == night and tab().get("6") == {"kind": "ake"}, "夜勤を入れると、次の日に明けが入る")
    ok(cell(6).inner_text().strip() == "明" and "g-night" in (cell(5).get_attribute("class") or ""), "夜勤のマスは夜の色、次の日は「明」")
    cell(5).click()
    pick("shift", day_shift)
    ok("6" not in tab(), "夜勤を外すと、次の日の明けも外れる")
    cell(9).click()
    pick("off")
    cell(8).click()
    pick("shift", night)
    ok(tab().get("9") == {"kind": "off"} and t(page, "ake-blocked-notice").count() == 1, "次の日がもう埋まっていたら、明けにせずに知らせる")
    cell(2).click()
    t(page, "pick-lock").check()
    t(page, "picker-close").click()
    marks = json.loads(stored(page))["month"]["marks"].get(pid, {})
    ok(marks.get("2") == {"locked": True} and cell(2).locator("svg.lock-icon").count() == 1, "固定すると、錠の印が付く")
    ok(all("edited" not in v for v in marks.values()), "まだ自動で作っていない表では、手で変えた印を付けない")
    cell(12).click()
    ok("公休" in t(page, "pick-request").inner_text(), "小窓に、その日の希望が出る")
    pick("empty")
    ok("12" not in tab(), "「空ける」でマスが空く")
    ok(not errors, "エラー0 シフト表", " / ".join(errors[:3]))
    ctx.close()
    # 1日1人の役は太字
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    data = json.loads(stored(page))
    one = next(s for s in data["settings"]["shifts"] if s["onePerDay"])
    t(page, "step-6").click()
    page.locator('[data-testid="table-cell"][data-row="0"][data-day="1"]').click()
    page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{one["id"]}"]').click()
    w = page.locator('[data-testid="table-cell"][data-row="0"][data-day="1"] .cell-text').evaluate("e => getComputedStyle(e).fontWeight")
    ok(int(w) >= 700, "1日1人の役は太字", w)
    ok(not errors, "エラー0 1日1人の役", " / ".join(errors[:3]))
    ctx.close()


def scenario_big(browser, base):
    """2月（28日）・12月（31日）、スタッフ 50 人の作り物の月で、崩れず、重すぎないか"""
    import subprocess
    for seed, year, month in [(11, 2027, 2), (12, 2026, 12)]:
        text = subprocess.run(
            ["node", str(ROOT / "tools/make-sample.mjs"), "--seed", str(seed), "--staff", "50",
             "--year", str(year), "--month", str(month), "--with-table"],
            capture_output=True, text=True, encoding="utf-8", check=True,
        ).stdout
        data = json.loads(text)
        days = len(data["month"]["table"][data["staff"][0]["id"]])
        for width, scheme in [(1280, "light"), (375, "dark")]:
            label = f"{year}年{month}月 50人 {scheme} {width}px"
            ctx, page, errors = fresh_page(browser, base, width, scheme)
            page.evaluate("(t) => localStorage.setItem('shift-maker:data', t)", text)
            page.goto(base + "/app/")
            page.wait_for_selector('[data-testid="screen-title"]')
            for n, cells in [(4, "request-cell"), (6, "table-cell")]:
                t0 = page.evaluate("() => performance.now()")
                go(page, n, width)
                ms = page.evaluate("(t0) => performance.now() - t0", t0)
                ok(ms < 1500, f"{label} 手順{n}が1.5秒以内に出る", f"{ms:.0f}ms")
                ok(page.locator(f'[data-testid="{cells}"]').count() == 50 * days, f"{label} 手順{n}のマスが 50人×{days}日")
                look(page, f"{label} 手順{n}", f"big-{year}-{month}-step{n}-{scheme}-{width}")
            r = page.evaluate("""() => {
              const b = document.querySelector('[data-testid="table-cell"][data-row="45"][data-day="20"]');
              const t0 = performance.now();
              b.click();
              return { ms: performance.now() - t0, open: !!document.querySelector('dialog[open]') };
            }""")
            ok(r["open"] and r["ms"] < 300, f"{label} マスを押してから小窓が出るまで 0.3 秒以内", f"{r['ms']:.0f}ms")
            r = page.evaluate("""() => {
              const b = document.querySelector('[data-testid="pick-option"][data-kind="off"]');
              const t0 = performance.now();
              b.click();
              return { ms: performance.now() - t0 };
            }""")
            ok(r["ms"] < 300, f"{label} 選んでからマスが変わるまで 0.3 秒以内", f"{r['ms']:.0f}ms")
            ok(not errors, f"エラー0 {label}", " / ".join(errors[:3]))
            ctx.close()

def scenario_lock_and_ake(browser, base):
    """固定したマスは明けの自動の出し入れで変えない。夜勤のシフトを消すと、次の日の明けも消える"""
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-care").click()
    data = json.loads(stored(page))
    night = next(s["id"] for s in data["settings"]["shifts"] if s["night"])
    day_shift = next(s["id"] for s in data["settings"]["shifts"] if s["name"] == "日勤")
    t(page, "step-6").click()
    tab = lambda r: json.loads(stored(page))["month"]["table"].get(data["staff"][r]["id"], {})
    cell = lambda r, d: page.locator(f'[data-testid="table-cell"][data-row="{r}"][data-day="{d}"]')

    def pick(r, d, kind, shift=None):
        cell(r, d).click()
        sel = f'[data-testid="pick-option"][data-kind="{kind}"]' + (f'[data-shift="{shift}"]' if shift else "")
        page.locator(sel).click()

    def lock(r, d):
        cell(r, d).click()
        t(page, "pick-lock").check()
        t(page, "picker-close").click()

    # 1. 11日を空きのまま固定 → 10日に夜勤 → 11日は明けにならず、知らせる
    lock(1, 11)
    pick(1, 10, "shift", night)
    ok("11" not in tab(1) and t(page, "ake-locked-notice").count() == 1, "次の日が固定なら、夜勤を入れても明けにせず知らせる")
    # 2. 20日に夜勤（21日が明け）→ 21日を固定 → 20日を日勤に → 21日の明けは残り、知らせる
    pick(1, 20, "shift", night)
    lock(1, 21)
    pick(1, 20, "shift", day_shift)
    ok(tab(1).get("21") == {"kind": "ake"} and t(page, "ake-kept-notice").count() == 1, "次の日の明けが固定なら、夜勤を外しても明けは残し、知らせる")
    # 3. 8日に夜勤（9日が明け）・15日に夜勤（16日が明け、固定）→ 手順2で夜勤のシフトを消す
    pick(2, 8, "shift", night)
    pick(3, 15, "shift", night)
    lock(3, 16)
    t(page, "step-2").click()
    page.locator(f'[data-testid="shift-row"][data-shift-id="{night}"] [data-testid="shift-detail-toggle"]').click()
    t(page, "shift-delete").click()
    text = t(page, "dialog").inner_text()
    ok("明け（1か所）" in text, "夜勤のシフトを消す確認の文に、消える明けの数を書く", text)
    page.locator('[data-testid="shift-delete-ok"]').click()
    ok("9" not in tab(2), "夜勤のシフトを消すと、その次の日の明けも消える")
    ok(tab(3).get("16") == {"kind": "ake"}, "固定した明けは、夜勤のシフトを消しても残る")
    ok(not errors, "エラー0 固定と明け", " / ".join(errors[:3]))
    ctx.close()

def scenario_import(browser, base):
    """書き出し・取り込み。まずいファイルは断って、いまのデータのまま"""
    cases = OUT / "import-cases"
    cases.mkdir(parents=True, exist_ok=True)

    def choose(page, testid, path):
        with page.expect_file_chooser() as fc:
            t(page, testid).click()
        fc.value.set_files(str(path))

    # 1. 書き出したファイルの中身が、いまのデータと同じ
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    rename_first_staff(page, "AA")
    t(page, "data-button").click()
    with page.expect_download() as dl:
        t(page, "export-file").click()
    good = cases / "good.json"
    dl.value.save_as(str(good))
    exported = json.loads(good.read_text(encoding="utf-8"))
    ok(exported == json.loads(stored(page)), "書き出したファイルの中身が、いまのデータと同じ")
    ok(dl.value.suggested_filename.startswith("shift-maker_") and dl.value.suggested_filename.endswith(".json"), "書き出したファイルの名前", dl.value.suggested_filename)

    # 2. ほかのデータの上に取り込む → 同じ中身になり、取り込む前のデータは控えに残る
    reset(page)
    t(page, "sample-retail").click()
    rename_first_staff(page, "BB")
    b = stored(page)
    t(page, "data-button").click()
    choose(page, "import-file", good)
    text = t(page, "import-dialog").inner_text()
    ok("good.json" in text and "控えに残します" in text, "取り込む前に、何を取り込むかと控えのことを書く")
    t(page, "import-ok").click()
    ok(json.loads(stored(page)) == exported, "取り込むと、ファイルと同じ中身になる")
    ok(backup_id_of(page, b) is not None, "取り込む前のデータが控えに残る")
    ok(t(page, "import-notice").count() == 1, "取り込んだと知らせる")

    # 3. やめると何も変わらない
    before = stored(page)
    t(page, "data-button").click()
    choose(page, "import-file", good)
    t(page, "import-cancel").click()
    ok(stored(page) == before, "取り込みで「やめる」を選ぶと、何も変わらない")

    # 4. まずいファイルは断る
    bad = {
        "not-json.txt": "これはデータではありません",
        "shape.json": json.dumps({"a": 1}),
        "newer.json": json.dumps({**exported, "formatVersion": 99}, ensure_ascii=False),
    }
    formula = json.loads(json.dumps(exported))
    formula["settings"]["shifts"][0]["symbol"] = "=SUM(1)"
    bad["formula.json"] = json.dumps(formula, ensure_ascii=False)
    longname = json.loads(json.dumps(exported))
    longname["staff"][0]["name"] = "あ" * 200
    bad["longname.json"] = json.dumps(longname, ensure_ascii=False)
    missing = json.loads(json.dumps(exported))
    missing["staff"][0]["shifts"].append("s999")
    bad["missing-shift.json"] = json.dumps(missing, ensure_ascii=False)
    for name, body in bad.items():
        (cases / name).write_text(body, encoding="utf-8")
    (cases / "big.json").write_text(" " * (6 * 1024 * 1024) + "{}", encoding="utf-8")
    for name in [*bad.keys(), "big.json"]:
        before = stored(page)
        t(page, "data-button").click()
        choose(page, "import-file", cases / name)
        dlg = t(page, "import-error-dialog")
        dlg.wait_for()
        msg = dlg.inner_text()
        ok("いまのデータは、そのままです" in msg and len(msg) > 30, f"まずいファイル（{name}）は理由を出して断る", msg[:80])
        if name == "big.json":
            ok("6.0MB" in msg, "大きすぎるファイルの大きさを、小数1けたで正しく書く", msg[:80])
        t(page, "import-error-close").click()
        ok(stored(page) == before, f"まずいファイル（{name}）を断ったあと、いまのデータのまま")
    ok(not errors, "エラー0 取り込み", " / ".join(errors[:3]))
    ctx.close()

    # 5. 名前に HTML が入ったファイルを取り込んでも、文字のまま
    evil = json.loads(json.dumps(exported))
    evil["staff"][0]["name"] = "<svg onload=__x=1>"
    (cases / "evil.json").write_text(json.dumps(evil, ensure_ascii=False), encoding="utf-8")
    ctx, page, errors = fresh_page(browser, base, 1280, "dark")
    choose(page, "welcome-import", cases / "evil.json")
    ok(t(page, "import-export").count() == 0, "データが無いときは「先に書き出して」を出さない")
    t(page, "import-ok").click()
    ok(t(page, "step-1").count() == 1 and json.loads(stored(page)) == evil, "見本を選ぶ画面から取り込んで始められる")
    for n in [3, 4, 6]:
        t(page, f"step-{n}").click()
        ok(page.evaluate("() => window.__x") is None and page.locator("#screen svg:not(.lock-icon)").count() == 0, f"取り込んだ名前の HTML が、手順{n}で動かない")
    ok("<svg onload=__x=1>" in page.locator("#screen").inner_text(), "取り込んだ名前の HTML が、文字のまま出る")
    ok(not errors, "エラー0 取り込み（見本の画面から）", " / ".join(errors[:3]))
    ctx.close()

def scenario_import_more(browser, base):
    """取り込みの追加の確かめ（確かめ役の見るところ）"""
    cases = OUT / "import-cases"
    cases.mkdir(parents=True, exist_ok=True)

    def choose(page, testid, path):
        with page.expect_file_chooser() as fc:
            t(page, testid).click()
        fc.value.set_files(str(path))

    def import_ok(page, path):
        t(page, "data-button").click()
        choose(page, "import-file", path)
        t(page, "import-ok").click()

    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    rename_first_staff(page, "AA")
    a = stored(page)
    base_data = json.loads(a)

    # 1. 取り込みを2回続けても、最初のデータに戻れる
    f1 = json.loads(a)
    f1["staff"][0]["name"] = "F1"
    f2 = json.loads(a)
    f2["staff"][0]["name"] = "F2"
    (cases / "f1.json").write_text(json.dumps(f1, ensure_ascii=False), encoding="utf-8")
    (cases / "f2.json").write_text(json.dumps(f2, ensure_ascii=False), encoding="utf-8")
    import_ok(page, cases / "f1.json")
    import_ok(page, cases / "f2.json")
    bid = backup_id_of(page, a)
    ok(bid is not None, "取り込みを2回続けても、最初のデータの控えが残る")
    if bid:
        t(page, "data-button").click()
        page.locator(f'[data-testid="restore-backup"][data-backup-id="{bid}"]').click()
        t(page, "restore-backup-ok").click()
        ok(stored(page) == a, "取り込みを2回続けたあと、最初のデータに1文字も違わずに戻る")

    # 2. 古い形のファイル（tools/fixtures）を取り込める
    for fx in sorted((ROOT / "tools/fixtures").glob("*.json")):
        import_ok(page, fx)
        ok(json.loads(stored(page)) == json.loads(fx.read_text(encoding="utf-8")), f"古い形のファイル（{fx.name}）を取り込める")

    # 3. 「=」「@」で始まる名前は、そのまま文字として入る
    eq = json.loads(json.dumps(base_data))
    eq["staff"][0]["name"] = "=SUM(1)"
    eq["staff"][1]["name"] = "@B"
    (cases / "formula-name.json").write_text(json.dumps(eq, ensure_ascii=False), encoding="utf-8")
    import_ok(page, cases / "formula-name.json")
    t(page, "step-3").click()
    text = t(page, "staff-list").inner_text()
    ok("=SUM(1)" in text and "@B" in text, "「=」「@」で始まる名前は、文字のまま入る")

    # 4. もっと多くのまずいファイル（空・ほかのアプリのファイル・番号の控えがそろっていない）を断り、そのあとも使える
    nextids = json.loads(json.dumps(base_data))
    nextids["nextIds"]["staff"] = 1
    bad = {
        "empty.json": "",
        "other-app.json": json.dumps({"name": "other-app", "version": "1.0.0", "dependencies": {}}),
        "nextids.json": json.dumps(nextids, ensure_ascii=False),
    }
    for name, body in bad.items():
        (cases / name).write_text(body, encoding="utf-8")
        before = stored(page)
        t(page, "data-button").click()
        choose(page, "import-file", cases / name)
        dlg = t(page, "import-error-dialog")
        dlg.wait_for()
        ok("いまのデータは、そのままです" in dlg.inner_text(), f"まずいファイル（{name}）は理由を出して断る", dlg.inner_text()[:80])
        t(page, "import-error-close").click()
        ok(stored(page) == before, f"まずいファイル（{name}）を断ったあと、いまのデータのまま")
    newer = json.loads(json.dumps(base_data))
    newer["formatVersion"] = 99
    (cases / "newer.json").write_text(json.dumps(newer, ensure_ascii=False), encoding="utf-8")
    t(page, "data-button").click()
    choose(page, "import-file", cases / "newer.json")
    ok("新しい版" in t(page, "import-error-dialog").inner_text(), "新しすぎる版のファイルは「新しい版で作られた」と書いて断る")
    t(page, "import-error-close").click()
    t(page, "step-2").click()
    ok(t(page, "screen-title").inner_text().startswith("手順2"), "断ったあとも、画面が使える")

    # 5. 日ごとに要るスキルの入ったファイルを取り込み、そのスキルを消してもエラーにならない
    ds = json.loads(json.dumps(base_data))
    k1 = ds["settings"]["skills"][0]["id"]
    k2 = ds["settings"]["skills"][1]["id"]
    s1 = ds["settings"]["shifts"][0]["id"]
    ds["month"]["dailySkill"] = {s1: {"3": [k1], "4": [k1, k2]}}
    (cases / "daily-skill.json").write_text(json.dumps(ds, ensure_ascii=False), encoding="utf-8")
    import_ok(page, cases / "daily-skill.json")
    t(page, "step-1").click()
    t(page, "skill-delete").first.click()
    t(page, "skill-delete-ok").click()
    d = json.loads(stored(page))
    ok(all(k["id"] != k1 for k in d["settings"]["skills"]), "スキルを消せる（日ごとに要るスキルのデータがあっても）")
    ok(d["month"]["dailySkill"] == {s1: {"4": [k2]}}, "日ごとに要るスキルから、消したスキルが外れ、空になった日は消える", json.dumps(d["month"]["dailySkill"]))
    page.reload()
    page.wait_for_selector('[data-testid="screen-title"]')
    ok(t(page, "broken-notice").count() == 0, "スキルを消したあと、読み直しても読める")
    ok(not errors, "エラー0 取り込み（追加）", " / ".join(errors[:3]))
    ctx.close()

    # 6. スマホの幅でも「ファイルから取り込む」が押せて、知らせが読める
    for scheme in ["light", "dark"]:
        ctx, page, errors = fresh_page(browser, base, 375, scheme)
        t(page, "sample-care").click()
        t(page, "data-button").click()
        look(page, f"取り込み 375 {scheme} 保存と控え")
        choose(page, "import-file", cases / "shape.json")
        t(page, "import-error-dialog").wait_for()
        look(page, f"取り込み 375 {scheme} 断る小窓", f"import-error-{scheme}-375")
        t(page, "import-error-close").click()
        ok(not errors, f"エラー0 取り込み 375 {scheme}", " / ".join(errors[:3]))
        ctx.close()

def scenario_check_view(browser, base):
    """2-2：件数の帯・印・その場で検査し直す・一覧・表の下の必要人数と配置した人数"""
    import subprocess
    # 1. 空の表は数えず、案内を出す。手順5の見出し
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    t(page, "step-5").click()
    ok(t(page, "screen-title").inner_text() == "手順5 自動で作る", "手順5の見出しに「手順5」が付く")
    t(page, "step-6").click()
    band = t(page, "count-band")
    ok(band.get_attribute("data-empty") == "true" and "まだシフト表がありません" in band.inner_text(), "空の表では、エラーの数を出さずに案内を出す")
    ok(t(page, "error-list").count() == 0, "空の表では、エラーの一覧を出さない")

    # 2. 6日続けて出勤を入れると、6連勤以上が1件になり「悪くなりました」と知らせる
    data = json.loads(stored(page))
    p0 = data["staff"][0]
    sid = p0["shifts"][0]
    for d in range(1, 7):
        page.locator(f'[data-testid="table-cell"][data-row="0"][data-day="{d}"]').click()
        page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{sid}"]').click()
    ok(t(page, "count-band").get_attribute("data-empty") == "false", "1マスでも入ると、件数の帯が出る")
    ok(t(page, "band-six").get_attribute("data-count") == "1", "6日続けて出勤すると、6連勤以上が1件")
    notices = page.locator('[data-testid="worse-notice"]')
    ok(notices.count() >= 1 and "6連勤以上 0→1件" in notices.first.inner_text(), "悪くなったら「悪くなりました：6連勤以上 0→1件」と知らせる", notices.first.inner_text() if notices.count() else "")
    cells6 = page.locator('[data-testid="table-cell"][data-row="0"].m-six')
    ok(cells6.count() == 6, "6連勤以上のマスに、濃い赤の太い枠", str(cells6.count()))
    title = page.locator('[data-testid="table-cell"][data-row="0"][data-day="3"]').get_attribute("title") or ""
    ok("6連勤以上" in title, "マスにマウスを置くと、エラーの文が出る（title）", title[:60])

    # 3. 一覧を押すと、そのマスへ動く
    item = page.locator('[data-testid="error-group-six"] [data-testid="error-item"]').first
    item.click()
    focused = page.evaluate("() => ({ staff: document.activeElement.dataset.staffId, day: document.activeElement.dataset.day })")
    ok(focused["staff"] == p0["id"] and focused["day"] == "1", "一覧の項目を押すと、そのマスへ動く", json.dumps(focused))

    # 4. 表の下の配置した人数と、足りない日の色
    emp = p0["employment"]
    shift = next(s for s in data["settings"]["shifts"] if s["id"] == sid)
    row_emp = "all" if shift["combine"] else emp
    span = page.locator(f'[data-testid="need-assigned"][data-shift="{sid}"][data-emp="{row_emp}"][data-day="1"]')
    ok(span.inner_text().strip() == "配置1", "表の下に、配置した人数が出る", span.inner_text())

    # 5. 不足を押すと内訳が開く
    t(page, "band-short").click()
    ok(t(page, "band-detail").is_visible() and "不足の内訳" in t(page, "band-detail").inner_text(), "「不足」を押すと内訳が開く")

    # 6. 表の下で必要人数を変えると、検査し直す
    before = int(t(page, "band-hard").get_attribute("data-count"))
    cell = page.locator(f'input.need-cell[data-shift="{sid}"][data-emp="{row_emp}"][data-day="10"]')
    cell.click()
    page.keyboard.type("9")
    page.keyboard.press("Enter")
    after = int(t(page, "band-hard").get_attribute("data-count"))
    ok(after != before or t(page, "band-short").get_attribute("data-count") != "0", "表の下で必要人数を変えると、件数が変わる", f"{before}→{after}")
    ok(not errors, "エラー0 検査の画面", " / ".join(errors[:3]))
    ctx.close()

    # 7. 作り物の月で、件数の帯と印が tools/count.mjs と同じ
    for seed in [5, 21]:
        path = OUT / f"count-{seed}.json"
        subprocess.run(["node", str(ROOT / "tools/make-sample.mjs"), "--seed", str(seed), "--staff", "15", "--year", "2026", "--month", "11", "--with-table", "--out", str(path)], check=True)
        counted = json.loads(subprocess.run(["node", str(ROOT / "tools/count.mjs"), str(path)], capture_output=True, text=True, encoding="utf-8", check=True).stdout)
        text = path.read_text(encoding="utf-8")
        ctx, page, errors = fresh_page(browser, base, 1280, "light")
        page.evaluate("(t) => localStorage.setItem('shift-maker:data', t)", text)
        page.goto(base + "/app/")
        page.wait_for_selector('[data-testid="screen-title"]')
        t(page, "step-6").click()
        band = {k: int(t(page, f"band-{k}").get_attribute("data-count")) for k in ["six", "hard", "soft", "spare", "short"]}
        want = {"six": counted["totals"]["sixPlus"], "hard": counted["totals"]["hard"], "soft": counted["totals"]["soft"], "spare": counted["totals"]["spare"], "short": counted["totals"]["shortSlots"]}
        ok(band == want, f"種{seed}：件数の帯が tools/count.mjs と同じ", f"{band} / {want}")
        staff_ids = [p["id"] for p in json.loads(text)["staff"]]
        cover = set()
        for it in counted["items"]:
            if it["rule"] == "sixPlus":
                for d in range(max(1, it["from"]), it["to"] + 1):
                    cover.add((staff_ids.index(it["staff"]), d))
        got = page.locator('[data-testid="table-cell"].m-six').count()
        ok(got == len(cover), f"種{seed}：6連勤以上の印のマスの数が、数え方と同じ", f"{got} / {len(cover)}")
        groups = {lv: int(t(page, f"error-group-{lv}").get_attribute("data-count")) for lv in ["six", "hard", "soft"]}
        ok(groups == {"six": want["six"], "hard": want["hard"], "soft": want["soft"]}, f"種{seed}：エラーの一覧の数が帯と同じ", json.dumps(groups))
        ok(not errors, f"エラー0 種{seed}", " / ".join(errors[:3]))
        ctx.close()

def scenario_strengths(browser, base):
    """2-3：決まりの強さと手順1のチェックが1つの値・強さで件数が動く・希望だけで必ずエラーになるもの"""
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    page.locator('[data-testid="step1-details"] > summary').click()
    ok(t(page, "strength-row").count() == 28, "決まりの強さが28個並ぶ", str(t(page, "strength-row").count()))
    ok(page.locator('[data-testid="strength-sixPlus"]').inner_text().startswith("いつも数える"), "6連勤以上は選べない（いつも数える）")
    ok(page.locator('[data-testid="strength-requestDiff"]').inner_text().startswith("絶対"), "希望と違うは選べない（絶対）")
    ok("目安より3日以上長い" in page.locator('[data-testid="work-rest-run"]').locator("xpath=..").inner_text(), "連休の目安の説明に、連休が長すぎるの線を書く")
    # 強さ「なし」でチェックが外れる。チェックを入れると強さが戻る
    page.locator('[data-testid="strength-lateToEarly"]').select_option("off")
    ok(not t(page, "work-forbid-late-early").is_checked(), "遅い→早いの強さを「なし」にすると、手順1のチェックが外れる")
    ok(json.loads(stored(page))["settings"]["work"]["forbidLateToEarly"] is False, "保存も外れる")
    t(page, "work-forbid-late-early").check()
    ok(page.locator('[data-testid="strength-lateToEarly"]').input_value() == "hard", "チェックを入れると、強さが「絶対」に戻る")
    t(page, "work-avoid-single-off").uncheck()
    ok(page.locator('[data-testid="strength-singleOff"]').input_value() == "off", "1日だけの休みのチェックを外すと、強さが「なし」になる")
    ok(t(page, "step1-details").get_attribute("open") is not None, "強さを変えても、詳しい設定は開いたまま")
    # 強さで件数が動く：公休が足りないを「できれば」にすると、絶対から外れてできればに入る
    t(page, "step-6").click()
    page.locator('[data-testid="table-cell"][data-row="0"][data-day="1"]').click()
    page.locator('[data-testid="pick-option"][data-kind="off"]').click()
    hard1 = int(t(page, "band-hard").get_attribute("data-count"))
    soft1 = int(t(page, "band-soft").get_attribute("data-count"))
    t(page, "step-1").click()
    page.locator('[data-testid="strength-offShort"]').select_option("soft")
    t(page, "step-6").click()
    hard2 = int(t(page, "band-hard").get_attribute("data-count"))
    soft2 = int(t(page, "band-soft").get_attribute("data-count"))
    ok(hard2 < hard1 and soft2 - soft1 == hard1 - hard2, "強さを「できれば」にすると、件数が絶対からできればへ移る", f"{hard1}/{soft1} → {hard2}/{soft2}")
    # 希望だけで必ずエラーになるもの
    data = json.loads(stored(page))
    p0 = data["staff"][0]
    not_mine = next((s["id"] for s in data["settings"]["shifts"] if s["id"] not in p0["shifts"]), None)
    t(page, "step-4").click()
    box = t(page, "request-conflicts")
    ok(box.is_hidden(), "ぶつかる希望が無いときは、知らせを出さない")
    sid = p0["shifts"][0]
    page.locator(f'[data-testid="brush"][data-brush="{sid}"]').click()
    for d in range(1, 7):
        page.locator(f'[data-testid="request-cell"][data-row="0"][data-day="{d}"]').click()
    ok(box.is_visible() and "6連勤以上" in box.inner_text(), "6日続けて出勤の希望で、知らせを出す", box.inner_text()[:80])
    if not_mine:
        page.locator(f'[data-testid="brush"][data-brush="{not_mine}"]').click()
        page.locator('[data-testid="request-cell"][data-row="0"][data-day="10"]').click()
        ok("担当外のシフト" in box.inner_text(), "担当外のシフトの希望で、知らせを出す")
        page.locator('[data-testid="brush"][data-brush="clear"]').click()
        page.locator('[data-testid="request-cell"][data-row="0"][data-day="10"]').click()
    page.locator('[data-testid="brush"][data-brush="off"]').click()
    page.locator('[data-testid="request-cell"][data-row="0"][data-day="4"]').click()
    ok(box.is_hidden(), "希望を直すと、知らせが消える")
    look(page, "希望の知らせ 1280 light")
    ok(not errors, "エラー0 決まりの強さ", " / ".join(errors[:3]))
    ctx.close()
    # スマホの幅・暗い画面で、強さの画面
    ctx, page, errors = fresh_page(browser, base, 375, "dark")
    t(page, "sample-care").click()
    page.locator('[data-testid="step1-details"] > summary').click()
    look(page, "決まりの強さ 375 dark", "strengths-dark-375")
    ok(not errors, "エラー0 決まりの強さ 375", " / ".join(errors[:3]))
    ctx.close()

def scenario_noncount(browser, base):
    """人数に数えないシフトは、必要人数の欄を出さない。選べない決まりに理由が出る"""
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    data = json.loads(stored(page))
    sid = data["settings"]["shifts"][1]["id"]
    t(page, "step-2").click()
    page.locator(f'[data-testid="shift-row"][data-shift-id="{sid}"] [data-testid="shift-detail-toggle"]').click()
    t(page, "shift-counts").uncheck()
    row = page.locator(f'[data-testid="shift-row"][data-shift-id="{sid}"]')
    ok(row.locator('[data-testid="shift-need-off"]').count() == 1 and row.locator('[data-testid^="shift-need-"] >> visible=true').count() == 1, "人数に数えないシフトは、必要人数の欄の代わりに説明を出す")
    page.locator('[data-testid="need-details"] > summary').click()
    ok(page.locator(f'input.need-cell[data-shift="{sid}"]').count() == 0, "人数に数えないシフトは、日ごとの必要人数の表に出さない")
    ok("人数に数えないシフト" in t(page, "need-grid").inner_text(), "出さないシフトがあることを書く")
    t(page, "step-1").click()
    page.locator('[data-testid="step1-details"] > summary').click()
    ok("働きすぎを見のがさないため" in t(page, "strength-sixPlus").inner_text(), "選べない決まりに、理由を出す")
    ok(not errors, "エラー0 人数に数えないシフト", " / ".join(errors[:3]))
    ctx.close()

def scenario_month_backup(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-retail").click()
    m = json.loads(stored(page))["month"]
    ny, nm = (m["year"] + 1, 1) if m["month"] == 12 else (m["year"], m["month"] + 1)
    # 見本のままなら、控えを作らないと書く（やめて戻る）
    t(page, "target-month").fill(f"{ny}-{nm:02d}")
    t(page, "target-month-apply").click()
    ok("何も変えていない" in t(page, "month-dialog").inner_text(), "見本のままで月を片付けるとき、控えを作らないと書く")
    t(page, "month-cancel").click()
    rename_first_staff(page, "AA")
    t(page, "step-1").click()
    before = stored(page)
    t(page, "target-month").fill(f"{ny}-{nm:02d}")
    t(page, "target-month-apply").click()
    page.wait_for_selector('[data-testid="month-dialog"]')
    ok("控えに残します" in t(page, "month-dialog").inner_text(), "変えたデータで月を片付けるとき、控えに残すと書く")
    t(page, "month-clear").click()
    data = json.loads(stored(page))
    ok(data["month"]["month"] == nm and not data["month"]["special"], "月を切り替えると、特別な日が片付く")
    ok(len(data["staff"]) == len(json.loads(before)["staff"]), "月を切り替えても、スタッフは残る")
    t(page, "step-3").click()
    t(page, "staff-item").first.click()
    t(page, "staff-name").fill("QQ")
    t(page, "staff-name").press("Tab")
    t(page, "data-button").click()
    t(page, "restore-backup").click()
    t(page, "restore-backup-ok").click()
    ok(stored(page) == before, "月の片付け→1つ変える→控えから戻す で1文字も違わない")
    # やめる を選んだら何も変わらない
    t(page, "step-1").click()
    t(page, "target-month").fill(f"{ny}-{nm:02d}")
    t(page, "target-month-apply").click()
    t(page, "month-cancel").click()
    ok(stored(page) == before, "月の切り替えで「やめる」を選ぶと、何も変わらない")
    ok(not errors, "エラー0 月の控え", " / ".join(errors[:3]))
    ctx.close()


def scenario_need_grid(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    t(page, "step-2").click()
    page.locator('[data-testid="need-details"] > summary').click()
    cell = lambda r, d: page.locator(f'input.need-cell[data-row="{r}"][data-day="{d}"]')
    ov = lambda: json.loads(stored(page))["month"]["needOverride"]
    first = cell(0, 2)
    base_val = first.input_value()
    first.click()
    page.keyboard.type("7")
    page.keyboard.press("Enter")
    ok(page.evaluate("() => document.activeElement.dataset.day") == "3", "Enter で次の日へ動く")
    sid = first.get_attribute("data-shift")
    emp = first.get_attribute("data-emp")
    ok(ov().get(sid, {}).get(emp, {}).get("2") == 7, "打った数が上書きとして保存される")
    ok("is-override" in (first.get_attribute("class") or ""), "上書きしたマスに色が付く")
    page.keyboard.press("Shift+Enter")
    page.keyboard.press("Shift+Enter")
    ok(page.evaluate("() => document.activeElement.dataset.day") == "1", "Shift+Enter で前の日へ動く")
    page.keyboard.press("ArrowDown")
    ok(page.evaluate("() => document.activeElement.dataset.row") == "1", "↓ で下の行へ動く")
    first.click()
    page.keyboard.type(base_val)
    page.keyboard.press("Enter")
    ok("2" not in ov().get(sid, {}).get(emp, {}), "ふだんと同じ数を入れると上書きが消える")
    cell(1, 3).click()
    cell(1, 6).click(modifiers=["Shift"])
    page.keyboard.type("4")
    page.keyboard.press("Enter")
    sid1 = cell(1, 3).get_attribute("data-shift")
    emp1 = cell(1, 3).get_attribute("data-emp")
    got = [ov().get(sid1, {}).get(emp1, {}).get(str(d)) for d in range(3, 7)]
    ok(got == [4, 4, 4, 4] or all(cell(1, d).input_value() == "4" for d in range(3, 7)), "Shift で何日か選び、数を打って Enter で全部に入る", str(got))
    before = stored(page)
    cell(1, 10).click()
    page.keyboard.type("9")
    page.keyboard.press("Escape")
    ok(stored(page) == before and cell(1, 10).input_value() != "9", "Esc でやめると何も変わらない")
    cell(1, 11).click()
    page.keyboard.type("x")
    page.keyboard.press("Enter")
    ok(stored(page) == before, "数でないものは入らない")
    ok(not errors, "エラー0 日ごとの必要人数", " / ".join(errors[:3]))
    ctx.close()


def scenario_add_shift(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-restaurant").click()
    t(page, "step-2").click()
    count = t(page, "shift-row").count()
    for bad, why in [("", "空"), ("=A", "「=」で始まる"), ("+1", "「+」で始まる"), ("休", "休みの記号"), ("朝", "重なる")]:
        t(page, "shift-add").click()
        t(page, "add-shift-symbol").fill(bad)
        t(page, "add-shift-dialog-ok").click()
        err = t(page, "add-shift-dialog-error").inner_text()
        ok(bool(err.strip()), f"シフトを追加：記号が{why}なら小窓の中に理由を出す")
        t(page, "add-shift-dialog-cancel").click()
    ok(t(page, "shift-row").count() == count, "まずい記号のときは、シフトが増えない")
    t(page, "shift-add").click()
    t(page, "add-shift-symbol").fill("研")
    t(page, "add-shift-name").fill("研修")
    t(page, "add-shift-staff").first.check()
    t(page, "add-shift-dialog-ok").click()
    ok(t(page, "shift-row").count() == count + 1, "正しい記号なら、シフトが1つ増える")
    data = json.loads(stored(page))
    new = data["settings"]["shifts"][-1]
    ok(new["need"] == {"full": 0, "part": 0, "all": 0}, "足したシフトのふだんの必要人数ははじめ0人")
    ok(new["id"] in data["staff"][0]["shifts"], "選んだ人が、足したシフトを担当できるようになる")
    ok(not errors, "エラー0 シフトを追加", " / ".join(errors[:3]))
    ctx.close()


def scenario_text_safety(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    t(page, "sample-care").click()
    t(page, "step-3").click()
    t(page, "staff-item").first.click()
    evil = "<svg onload=__x=1>"  # 名前の欄は20文字までなので、短い仕掛けで試す
    t(page, "staff-name").fill(evil)
    t(page, "staff-name").press("Tab")
    page.reload()
    page.wait_for_selector('[data-testid="staff-list"]')
    ok(page.evaluate("() => window.__x") is None, "名前に入れた HTML が動かない")
    ok(evil in t(page, "staff-list").inner_text(), "名前に入れた HTML が、文字のまま出る")
    ok(page.locator("#screen svg").count() == 0, "名前に入れた HTML が、絵などにならない")
    for n, grid in [(4, "request-grid"), (6, "shift-grid")]:
        t(page, f"step-{n}").click()
        ok(evil in t(page, grid).inner_text(), f"手順{n}の表でも、名前の HTML が文字のまま出る")
        ok(page.locator(f'[data-testid="{grid}"] svg:not(.lock-icon)').count() == 0, f"手順{n}の表で、名前の HTML が絵にならない")
        ok(page.evaluate("() => window.__x") is None, f"手順{n}の表で、名前の HTML が動かない")
    ok(not [e for e in errors if "favicon" not in e and "/x" not in e], "エラー0 文字の扱い", " / ".join(errors[:3]))
    ctx.close()


def scenario_broken(browser, base):
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    page.evaluate(f"() => localStorage.setItem('{PREFIX}data', '{{broken')")
    page.reload()
    page.wait_for_selector('[data-testid="broken-notice"]')
    ok(t(page, "broken-notice").count() == 1, "保存データが読めないとき、知らせる")
    ok(t(page, "welcome").count() == 1, "保存データが読めないとき、見本を選ぶ画面を出す")
    raw = page.evaluate(f"() => JSON.parse(localStorage.getItem('{PREFIX}broken')).raw")
    ok(raw == "{broken", "読めなかったデータを控えに残す")
    ok(stored(page) == "{broken", "読めなかったデータを見本で上書きしない（選ぶまで）")
    t(page, "sample-blank").click()
    t(page, "data-button").click()
    ok(t(page, "broken-export-panel").count() == 1, "見本を選んだあとも、読めなかったデータを「保存と控え」からファイルにできる")
    ctx.close()


def scenario_generate(browser, base):
    """3-2：手順5 自動で作る（中止・作る・控え・記録 20 回・別のタブ・作る前の確かめ）。1分を ?seconds=6 に短くして確かめる"""
    url = base + "/app/?seconds=6"
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    page.goto(url)
    t(page, "sample-restaurant").click()
    t(page, "step-5").click()
    ok(t(page, "precheck-ok").count() == 1, "見本では、作る前の確かめにぶつかりが無いと出る")
    ok(t(page, "mode-quick").is_checked() and t(page, "mode-careful").is_disabled(), "1分で作るが選ばれ、じっくり作るはまだ選べない")
    before = stored(page)

    # 1. 中止すると、表は前のまま。計算中は、ほかの所を押せない
    t(page, "generate").click()
    page.wait_for_selector('[data-testid="run-dialog"]')
    page.wait_for_function("() => document.querySelector('[data-testid=run-stage]').textContent.includes('いまの段')", timeout=20000)
    blocked = False
    try:
        t(page, "step-6").click(timeout=800)
    except Exception:
        blocked = True
    ok(blocked, "計算中は、手順の移動を押せない")
    ok(t(page, "screen-title").inner_text() == "手順5 自動で作る", "計算中に手順が変わらない")
    t(page, "run-stop").click()
    ok(t(page, "run-dialog").count() == 0 and t(page, "run-stopped").count() == 1, "中止で小窓が閉じ、「中止しました」と出る")
    ok(stored(page) == before, "中止すると、データは1文字も変わらない")

    # 2. 作る：進み具合が出て、作り終えたら表が入り、件数の帯が check.js と同じ
    t(page, "generate").click()
    page.wait_for_function("() => (document.querySelector('[data-testid=run-best]')?.dataset.hard ?? '') !== ''", timeout=30000)
    ok("いまのいちばん良い答え：6連勤以上" in t(page, "run-best").inner_text(), "段が終わると、いまのいちばん良い答えの件数が出る")
    ok("秒たちました（あと最大" in t(page, "run-time").inner_text(), "たった秒と、あと最大何秒かが出る")
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    data = json.loads(stored(page))
    ok(len(data["month"]["runs"]) == 1, "作った記録が1つ増える")
    filled = sum(len(r) for r in data["month"]["table"].values())
    days = calendar.monthrange(data["month"]["year"], data["month"]["month"])[1]
    ok(filled == len(data["staff"]) * days, "全員の全部の日にマスが入る", str(filled))
    counted = page.evaluate(
        """async () => {
          const v = document.querySelector('[data-testid="app-version"]').textContent.replace('版 ', '');
          const C = await import(`./js/check.js?v=${v}`);
          const res = C.checkTable(JSON.parse(localStorage.getItem('shift-maker:data')));
          return { totals: res.totals, requestDiff: res.byRule.requestDiff.count, notAssigned: res.byRule.notAssigned.count, nightNext: res.byRule.nightNext.count };
        }"""
    )
    band = {k: t(page, f"band-{k}").get_attribute("data-count") for k in ["six", "hard", "soft", "spare", "short"]}
    want = {k: str(counted["totals"][x]) for k, x in [("six", "sixPlus"), ("hard", "hard"), ("soft", "soft"), ("spare", "spare"), ("short", "shortSlots")]}
    ok(band == want, "作った結果の件数の帯が、check.js で数えた数と同じ", f"{band} / {want}")
    ok(counted["requestDiff"] == 0 and counted["notAssigned"] == 0 and counted["nightNext"] == 0, "希望と違う・担当外・夜勤の次の日が 0件", json.dumps(counted))
    status = t(page, "run-status").inner_text()
    finished = t(page, "run-result").get_attribute("data-finished")
    all_solved = all(s["status"] == "solved" for s in data["month"]["runs"][-1]["stages"])
    ok((finished == "true") == all_solved and (("最後まで解ききりました" in status) == all_solved), "最後まで解ききったか・時間切れかが、段の記録と合う", status[:40])
    unfinished = [x["name"] for x in data["month"]["runs"][-1]["stages"] if x["status"] != "solved"]
    ok(all(n in status for n in unfinished), "時間切れ・前の段のままの段は、全部の名前を出す", f"{unfinished} / {status[:80]}")
    look(page, "light 1280 手順5 作った結果", "step5-result-light-1280")

    # 3. もう一度作ると、置きかえる前に確かめて控えを残す。控えから1文字も違わずに戻る
    first = stored(page)
    t(page, "run-again").click()
    text = t(page, "generate-confirm").inner_text()
    ok("置きかわります" in text and "控えに残します" in text, "表があるときは、置きかえることと控えに残すことを確かめる", text[:80])
    t(page, "generate-ok").click()
    page.wait_for_function("() => JSON.parse(localStorage.getItem('shift-maker:data')).month.runs.length === 2", timeout=60000)
    bid = backup_id_of(page, first)
    ok(bid is not None, "作る前のデータが控えに残る")
    reasons = page.evaluate("() => JSON.parse(localStorage.getItem('shift-maker:backups')).map((b) => b.reason)")
    ok("generate" in reasons, "控えの理由は「自動で作る前」")
    if bid:
        t(page, "data-button").click()
        page.locator(f'[data-testid="restore-backup"][data-backup-id="{bid}"]').click()
        t(page, "restore-backup-ok").click()
        ok(stored(page) == first, "控えから、作る前のデータが1文字も違わずに戻る")

    # 4. 記録は新しい 20 回ぶんまで
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          d.month.runs = Array.from({ length: 20 }, (_, i) => ({ at: `2026-10-01T00:${String(i).padStart(2, '0')}:00.000Z`, mode: 'quick', seconds: 1, finished: false, stages: [] }));
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    page.wait_for_selector('[data-testid="generate"]')
    t(page, "generate").click()
    t(page, "generate-ok").click()
    page.wait_for_selector('[data-testid="run-done"]', timeout=60000)
    runs = json.loads(stored(page))["month"]["runs"]
    ok(len(runs) == 20 and runs[0]["at"] == "2026-10-01T00:01:00.000Z", "記録は新しい 20 回ぶんまで（いちばん古いものが消える）", f"{len(runs)} {runs[0].get('at')}")
    ok(runs[-1].get("seed") is not None, "記録の最後が、いま作ったもの")

    # 5. 計算のあいだに別のタブで変えたら、作った表で上書きしない
    page2 = ctx.new_page()
    page2.goto(url)
    page2.wait_for_selector('[data-testid="screen-title"]')
    t(page, "generate").click()
    t(page, "generate-ok").click()
    page.wait_for_selector('[data-testid="run-dialog"]')
    changed = page2.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          d.staff[0].name = 'ZZ';
          const text = JSON.stringify(d);
          localStorage.setItem('shift-maker:data', text);
          return text;
        }"""
    )
    page.wait_for_selector('[data-testid="run-changed"]', timeout=60000)
    ok(stored(page) == changed, "別のタブで変えた内容が残り、作った表で上書きしない")
    page2.close()
    ok(not errors, "エラー0 自動で作る", " / ".join(errors[:3]))
    ctx.close()

    # 6. 作る前の確かめ：止めるもの（固定と希望が違う）と、止めずに知らせるもの（避けられない 6連勤以上）
    ctx, page, errors = fresh_page(browser, base, 375, "dark")
    page.goto(url)
    t(page, "sample-restaurant").click()
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          const p = d.staff[0];
          const sid = p.shifts.find((id) => !d.settings.shifts.find((s) => s.id === id).night);
          d.month.requests[p.id] = { ...(d.month.requests[p.id] || {}), 3: { kind: 'off' } };
          d.month.table[p.id] = { 3: { kind: 'shift', shift: sid } };
          d.month.marks[p.id] = { 3: { locked: true } };
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    go(page, 5, 375)
    ok(t(page, "solve-blockers").count() == 1 and t(page, "generate").is_disabled() and t(page, "generate-why").count() == 1, "固定と希望が違うと、作れない理由を出して「シフトを作る」を押せない")
    look(page, "dark 375 手順5 作れないとき", "step5-blockers-dark-375")
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          const p = d.staff[0];
          const sid = p.shifts.find((id) => !d.settings.shifts.find((s) => s.id === id).night);
          d.month.requests[p.id] = { 1: { kind: 'shift', shift: sid } };
          d.month.table = {};
          d.month.marks = {};
          p.prevConsecutive = 6;
          p.prevLastShift = sid;
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    page.wait_for_selector('[data-testid="generate"]')
    ok(t(page, "solve-unavoidable").count() == 1 and "6連勤以上" in t(page, "solve-unavoidable").inner_text() and t(page, "generate").is_enabled(), "避けられない 6連勤以上は、止めずに知らせる（押せる）")
    t(page, "generate").click()
    page.wait_for_selector('[data-testid="run-dialog"]')
    look(page, "dark 375 手順5 計算中", "step5-running-dark-375")
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    six = t(page, "band-six").get_attribute("data-count")
    ok(six == "1", "避けられない 6連勤以上は 1件だけ（ほかに作らない）", str(six))
    look(page, "dark 375 手順5 作った結果", "step5-result-dark-375")
    ok(not errors, "エラー0 作る前の確かめ", " / ".join(errors[:3]))
    ctx.close()


def band_vs_check(page):
    """件数の帯と、ページの中で check.js で数えた数が同じか"""
    counted = page.evaluate(
        """async () => {
          const v = document.querySelector('[data-testid="app-version"]').textContent.replace('版 ', '');
          const C = await import(`./js/check.js?v=${v}`);
          return C.checkTable(JSON.parse(localStorage.getItem('shift-maker:data'))).totals;
        }"""
    )
    band = {k: t(page, f"band-{k}").get_attribute("data-count") for k in ["six", "hard", "soft", "spare", "short"]}
    want = {k: str(counted[x]) for k, x in [("six", "sixPlus"), ("hard", "hard"), ("soft", "soft"), ("spare", "spare"), ("short", "shortSlots")]}
    return band == want, f"{band} / {want}"


def scenario_undo(browser, base):
    """4-1：元に戻す・やり直す（マス・入れ替え・必要人数・自動で作った表）と、同じ日の2人の入れ替え"""
    url = base + "/app/?seconds=6"
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    page.goto(url)
    t(page, "sample-restaurant").click()
    t(page, "step-6").click()
    ok(t(page, "undo").is_disabled() and t(page, "redo").is_disabled() and "戻せる変更はまだありません" in t(page, "undo-status").inner_text(), "はじめは、元に戻す・やり直すを押せず、理由が出る")
    cell = lambda r, d: page.locator(f'[data-testid="table-cell"][data-row="{r}"][data-day="{d}"]')
    value = lambda r, d: page.evaluate("([r, d]) => { const x = JSON.parse(localStorage.getItem('shift-maker:data')); return JSON.stringify(x.month.table[x.staff[r].id]?.[d] ?? null); }", [r, d])

    # 1. マスを変える → 元に戻す → やり直す（1文字も同じ）
    s0 = stored(page)
    data = json.loads(s0)
    sid = data["staff"][0]["shifts"][0]
    cell(0, 1).click()
    page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{sid}"]').click()
    s1 = stored(page)
    ok(t(page, "undo").is_enabled() and "Aさんの" in t(page, "undo-status").inner_text(), "変えると「元に戻す」が押せ、何が戻るかが出る", t(page, "undo-status").inner_text())
    t(page, "undo").click()
    ok(stored(page) == s0, "元に戻すと、データが1文字も違わずに戻る")
    ok("元に戻しました" in t(page, "undo-notice").first.inner_text(), "「元に戻しました」と知らせる")
    t(page, "redo").click()
    ok(stored(page) == s1, "やり直すと、変えたあとと1文字も同じになる")
    saved_at = page.evaluate("() => localStorage.getItem('shift-maker:saved-at')")
    label = t(page, "undo-status").inner_text()
    cell(0, 1).click()
    page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{sid}"]').click()
    ok(stored(page) == s1 and t(page, "undo-status").inner_text() == label and page.evaluate("() => localStorage.getItem('shift-maker:saved-at')") == saved_at, "いまと同じものを選んでも、何も変えない（履歴にも保存の時刻にも入らない）")

    # 2. ドラッグで入れ替え（同じ日のほかの人のマス）→ 件数の帯が数え直される → 元に戻す
    sid2 = data["staff"][1]["shifts"][0]
    cell(1, 4).click()
    page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{sid2}"]').click()
    cell(2, 4).click()
    page.locator('[data-testid="pick-option"][data-kind="off"]').click()
    a, b = value(1, 4), value(2, 4)
    s2 = stored(page)
    cell(1, 4).drag_to(cell(2, 4))
    ok(value(1, 4) == b and value(2, 4) == a, "ドラッグで、同じ日の2人のマスが入れ替わる", f"{value(1, 4)} {value(2, 4)}")
    same, detail = band_vs_check(page)
    ok(same, "入れ替えたあと、件数の帯が check.js と同じ", detail)
    ok("入れ替え" in t(page, "undo-status").inner_text(), "入れ替えも元に戻せる")
    t(page, "undo").click()
    ok(stored(page) == s2, "入れ替えを元に戻すと、1文字も違わずに戻る")
    same, detail = band_vs_check(page)
    ok(same, "元に戻したあと、件数の帯が check.js と同じ", detail)
    cell(1, 4).drag_to(cell(2, 5))
    ok(stored(page) == s2, "ちがう日のマスへドラッグしても、入れ替えない")

    # 3. 固定したマスは入れ替えない
    cell(2, 4).click()
    t(page, "pick-lock").check()
    t(page, "picker-close").click()
    s3 = stored(page)
    cell(1, 4).drag_to(cell(2, 4))
    ok(stored(page) == s3 and t(page, "swap-locked-notice").count() >= 1, "固定したマスへドラッグしても入れ替えず、理由を知らせる")

    # 4. 日ごとの必要人数を変える → 元に戻す
    need = page.locator('input.need-cell[data-row="0"][data-day="10"]')
    old = need.input_value()
    need.fill(str(int(old) + 3))
    need.press("Enter")
    ok("日ごとの必要人数" in t(page, "undo-status").inner_text(), "必要人数の変更も履歴に入る", t(page, "undo-status").inner_text())
    t(page, "undo").click()
    ok(page.locator('input.need-cell[data-row="0"][data-day="10"]').input_value() == old and stored(page) == s3, "必要人数の変更を元に戻すと、前の数に戻る")

    # 5. 自動で作った表を元に戻す（作る前の表に戻る。作った記録も戻る）
    t(page, "step-5").click()
    t(page, "generate").click()
    t(page, "generate-ok").click()
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    ok(t(page, "run-undo").count() == 1, "作ったあと、手順5 に「作る前の表に戻す」が出る")
    t(page, "step-6").click()
    ok("自動で作った表" in t(page, "undo-status").inner_text(), "手順6 の「元に戻す」で、自動で作った表の前に戻れる")
    t(page, "undo").click()
    ok(stored(page) == s3, "自動で作った表を元に戻すと、作る前と1文字も同じ（作った記録も戻る）")
    t(page, "redo").click()
    ok(len(json.loads(stored(page))["month"]["runs"]) == 1, "やり直すと、作った表と記録が戻る")

    # 6. 読み直すと履歴は消える（データはそのまま）
    s6 = stored(page)
    page.goto(url)
    page.wait_for_selector('[data-testid="undo"]')
    ok(t(page, "undo").is_disabled() and stored(page) == s6, "読み直すと履歴は消え、データはそのまま")
    ok(not errors, "エラー0 元に戻す", " / ".join(errors[:3]))
    ctx.close()

    # 7. スマホの幅：マスの小窓から入れ替える
    ctx, page, errors = fresh_page(browser, base, 375, "dark")
    page.goto(url)
    t(page, "sample-care").click()
    go(page, 6, 375)
    data = json.loads(stored(page))
    sid = data["staff"][1]["shifts"][0]
    page.locator('[data-testid="table-cell"][data-row="1"][data-day="3"]').click()
    page.locator(f'[data-testid="pick-option"][data-kind="shift"][data-shift="{sid}"]').click()
    page.locator('[data-testid="table-cell"][data-row="1"][data-day="3"]').click()
    page.locator('[data-testid="pick-swap"] > summary').click()
    look(page, "dark 375 手順6 入れ替えの小窓", "step6-swap-dark-375")
    page.locator(f'[data-testid="swap-option"][data-staff-id="{data["staff"][2]["id"]}"]').click()
    d2 = json.loads(stored(page))
    ok(d2["month"]["table"].get(data["staff"][2]["id"], {}).get("3", {}).get("shift") == sid and not d2["month"]["table"].get(data["staff"][1]["id"], {}).get("3"), "小窓の「この日の、ほかの人と入れ替える」で入れ替わる")
    look(page, "dark 375 手順6 元に戻す", "step6-undo-dark-375")
    ok(not errors, "エラー0 入れ替え（スマホ）", " / ".join(errors[:3]))
    ctx.close()


def scenario_repair(browser, base):
    """4-2：エラーを自動で直す（案を並べる・表で見る・反映・元に戻す・必ず変えるマスが多い上限）と、途中から作り直す（残す日・止める）"""
    url = base + "/app/?seconds=8"
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    page.goto(url)
    t(page, "sample-care").click()
    t(page, "step-6").click()
    ok(t(page, "repair").is_disabled() and "まだ空" in t(page, "repair-why").inner_text(), "表が空のときは「エラーを自動で直す」を押せず、理由が出る")
    t(page, "step-5").click()
    t(page, "generate").click()
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    t(page, "step-6").click()

    # 1. 案を探す → 並べる → 表で見る → 反映 → 元に戻す
    before = stored(page)
    t(page, "repair").click()
    ok("10・25・50・全部" in t(page, "repair-confirm").inner_text(), "押すと、何をするかの説明が出る")
    t(page, "repair-start").click()
    page.wait_for_selector('[data-testid="repair-results"]', timeout=60000)
    items = t(page, "repair-item")
    ok(items.count() == 4, "上限 10・25・50・全部 の4つが並ぶ", str(items.count()))
    ok(stored(page) == before, "案を探しても、いまの表は変わらない")
    views = t(page, "repair-view")
    if views.count():
        views.first.click()
        title = t(page, "repair-preview").locator("h2").inner_text()
        n = int(title.split("変わるマス ")[1].split("か所")[0])
        ok(page.locator(".grid-cell.is-proposed").count() == n, "案を見ると、変わるマスに点線の枠が付く（数が合う）", f"{page.locator('.grid-cell.is-proposed').count()} / {n}")
        ok("→" in t(page, "repair-preview").inner_text() and "→" in t(page, "repair-changes").inner_text(), "件数の前後と、変わるマスの文が出る")
        page.locator('[data-testid="table-cell"][data-row="0"][data-day="1"]').click()
        ok(t(page, "preview-notice").count() >= 1 and t(page, "cell-picker").count() == 0 and stored(page) == before, "案を見ているあいだは、マスを変えられない")
        look(page, "light 1280 手順6 案を見る", "step6-repair-preview-light-1280")
        t(page, "repair-apply").click()
        after = stored(page)
        ok(after != before and "エラーを自動で直す" in t(page, "undo-status").inner_text(), "「この案にする」で反映され、元に戻すの履歴に入る")
        changed = json.loads(after)
        old = json.loads(before)
        locked_same = all(
            json.dumps(old["month"]["table"].get(pid, {}).get(day)) == json.dumps(changed["month"]["table"].get(pid, {}).get(day))
            for pid, days in old["month"]["marks"].items() for day, m in days.items() if m.get("locked")
        )
        req_ok = all(
            json.dumps(changed["month"]["table"].get(pid, {}).get(day)) == json.dumps(r)
            for pid, days in old["month"]["requests"].items() for day, r in days.items()
        )
        ok(locked_same and req_ok, "固定したマスは変わらず、希望のマスは希望の値")
        t(page, "undo").click()
        ok(stored(page) == before, "元に戻すと、直す前と1文字も同じに（1回で戻る）")
    else:
        ok(t(page, "repair-none").count() == 1, "良くなる案が無いときは、そう書く")
        t(page, "repair-results-close").click()

    # 2. 必ず変えるマスが上限より多い表（希望と違うマス 6・担当外のシフト 6）
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          let n = 0;
          for (const [pid, days] of Object.entries(d.month.requests)) {
            for (const [day, r] of Object.entries(days)) {
              if (n >= 6 || d.month.marks[pid]?.[day]?.locked) continue;
              d.month.table[pid] ??= {};
              d.month.table[pid][day] = r.kind === 'off' ? { kind: 'paid' } : { kind: 'off' };
              n += 1;
            }
          }
          let m = 0;
          for (const p of d.staff) {
            const o = d.settings.shifts.find((x) => !p.shifts.includes(x.id) && !x.night);
            if (!o || m >= 6) continue;
            for (const day of [2, 3]) {
              if (m >= 6 || d.month.requests[p.id]?.[day] || d.month.marks[p.id]?.[day]?.locked) continue;
              d.month.table[p.id] ??= {};
              d.month.table[p.id][day] = { kind: 'shift', shift: o.id };
              m += 1;
            }
          }
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    page.wait_for_selector('[data-testid="repair"]')
    t(page, "repair").click()
    t(page, "repair-start").click()
    page.wait_for_selector('[data-testid="repair-results"]', timeout=60000)
    first = page.locator('[data-testid="repair-item"][data-budget="10マスまで"]')
    ok(first.get_attribute("data-status") == "too-many" and "この上限では直せませんでした" in first.inner_text(), "必ず変えるマスが上限より多いと「この上限では直せませんでした」と出る（エラーにならない）", first.inner_text()[:60])
    ok(t(page, "repair-item").count() == 4, "ほかの上限も並ぶ")
    t(page, "repair-results-close").click()
    ok(not errors, "エラー0 エラーを自動で直す", " / ".join(errors[:3]))
    ctx.close()

    # 3. 途中から作り直す：選んだ日までは1文字も同じ・元に戻せる・残す日に担当外があれば止める
    ctx, page, errors = fresh_page(browser, base, 375, "dark")
    page.goto(url)
    t(page, "sample-restaurant").click()
    go(page, 5, 375)
    t(page, "generate").click()
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    go(page, 6, 375)
    before = stored(page)
    page.locator('[data-testid="more-ops"] > summary').click()
    t(page, "restart").click()
    t(page, "restart-day").select_option("10")
    t(page, "restart-dialog-ok").click()
    page.wait_for_selector('[data-testid="restart-done"]', timeout=60000)
    a, b = json.loads(before), json.loads(stored(page))
    early_same = all(
        json.dumps(a["month"]["table"].get(p["id"], {}).get(str(day))) == json.dumps(b["month"]["table"].get(p["id"], {}).get(str(day)))
        for p in a["staff"] for day in range(1, 11)
    )
    ok(early_same and a["month"]["marks"] == b["month"]["marks"], "途中から作り直しても、選んだ日までのマスと固定の印は1文字も同じ")
    ok(b["month"]["runs"][-1].get("mode") == "restart" and b["month"]["runs"][-1].get("fromDay") == 11, "作った記録に「途中から（11日から）」が残る")
    t(page, "undo").click()
    ok(stored(page) == before, "途中から作り直したのを元に戻すと、1文字も同じ")
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          const p = d.staff.find((x) => d.settings.shifts.some((s) => !x.shifts.includes(s.id)));
          const o = d.settings.shifts.find((s) => !p.shifts.includes(s.id));
          d.month.table[p.id] ??= {};
          d.month.table[p.id][3] = { kind: 'shift', shift: o.id };
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    page.wait_for_selector('[data-testid="repair"]')
    held = stored(page)
    page.locator('[data-testid="more-ops"] > summary').click()
    t(page, "restart").click()
    t(page, "restart-day").select_option("10")
    t(page, "restart-dialog-ok").click()
    ok(t(page, "restart-blocked").count() == 1 and "担当外" in t(page, "restart-blocked").inner_text() and t(page, "run-dialog").count() == 0 and stored(page) == held, "残す日に担当外のシフトがあると、作り直す前に止めて、どのマスかを出す", t(page, "restart-blocked").inner_text()[:80] if t(page, "restart-blocked").count() else "")
    look(page, "dark 375 手順6 途中から作り直す", "step6-restart-dark-375")
    ok(not errors, "エラー0 途中から作り直す", " / ".join(errors[:3]))
    ctx.close()


def read_xlsx(path):
    """Excel のファイル（xlsx）を、zip と XML で読む。返す：{シート名: {"A1": (値, 塗りの色 or None, 式があるか)}}"""
    import zipfile
    import xml.etree.ElementTree as ET
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
    styles = ET.fromstring(z.read("xl/styles.xml"))
    fills = []
    for f in styles.find("m:fills", ns).findall("m:fill", ns):
        fg = f.find("m:patternFill/m:fgColor", ns)
        fills.append(fg.get("rgb") if fg is not None else None)
    xfs = [int(x.get("fillId", "0")) for x in styles.find("m:cellXfs", ns).findall("m:xf", ns)]
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    out = {}
    for sh in wb.find("m:sheets", ns):
        rid = sh.get(f"{{{ns['r']}}}id")
        tpath = target[rid].lstrip("/")
        tpath = tpath if tpath.startswith("xl/") else "xl/" + tpath
        cells = {}
        for c in ET.fromstring(z.read(tpath)).iter(f"{{{ns['m']}}}c"):
            v = c.find("m:v", ns)
            t = c.get("t")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t"))
            else:
                val = v.text if v is not None else None
            fill = fills[xfs[int(c.get("s", "0"))]] if c.get("s") else None
            cells[c.get("r")] = (val, fill, c.find("m:f", ns) is not None)
        out[sh.get("name")] = cells
    return out


def col_name(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def scenario_export(browser, base):
    """4-3：Excel に出す（記号・色・集計・件数・式にならない）・CSV に出す（BOM・式にならない・カンマと引用符）・画面の集計表"""
    import io
    import re
    import calendar as cal
    url = base + "/app/?seconds=6"
    ctx, page, errors = fresh_page(browser, base, 1280, "light")
    page.goto(url)
    t(page, "sample-care").click()
    t(page, "step-5").click()
    t(page, "generate").click()
    page.wait_for_selector('[data-testid="run-result"]', timeout=60000)
    # 名前に式やカンマ・引用符を入れる
    page.evaluate(
        """() => {
          const d = JSON.parse(localStorage.getItem('shift-maker:data'));
          d.staff[0].name = '=1+1';
          d.staff[1].name = 'a,"b"';
          d.staff[2].name = '@x';
          localStorage.setItem('shift-maker:data', JSON.stringify(d));
        }"""
    )
    page.goto(url)
    t(page, "step-6").click()
    data = json.loads(stored(page))
    year, month = data["month"]["year"], data["month"]["month"]
    days = cal.monthrange(year, month)[1]
    sym = {x["id"]: x["symbol"] for x in data["settings"]["shifts"]}
    color = {x["id"]: x["color"].lstrip("#").upper() for x in data["settings"]["shifts"]}
    rest = {"off": "休", "paid": "有", "half": "半", "ake": "明", "spare": "余"}
    def symbol(v):
        if not v:
            return ""
        return sym[v["shift"]] if v["kind"] == "shift" else rest[v["kind"]]
    summary_rows = page.evaluate("() => [...document.querySelectorAll('[data-testid=summary-table] tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent))")
    ok(len(summary_rows) == len(data["staff"]) + 1 and summary_rows[-1][0] == "合計", "手順6 に集計表が出る（人ごとと合計）")

    # Excel
    with page.expect_download() as dl:
        t(page, "export-excel").click()
    d = dl.value
    ok(re.fullmatch(rf"シフト表_{year}年{month}月_\d{{8}}-\d{{4}}\.xlsx", d.suggested_filename) is not None, "Excel のファイルの名前に月と日時が入る", d.suggested_filename)
    path = OUT / "export-check.xlsx"
    OUT.mkdir(parents=True, exist_ok=True)
    d.save_as(str(path))
    book = read_xlsx(str(path))
    ok(list(book.keys()) == ["シフト表", "集計表", "件数"], "Excel のシートは シフト表・集計表・件数", str(list(book.keys())))
    sheet = book["シフト表"]
    bad_sym, bad_color, formulas = [], [], 0
    for i, p in enumerate(data["staff"]):
        row = 4 + i
        if sheet.get(f"A{row}", (None,))[0] != p["name"]:
            bad_sym.append(f"名前 {row}")
        for day in range(1, days + 1):
            v = data["month"]["table"].get(p["id"], {}).get(str(day))
            val, fill, f = sheet.get(f"{col_name(day + 1)}{row}", ("", None, False))
            formulas += 1 if f else 0
            if (val or "") != symbol(v):
                bad_sym.append(f"{p['name']} {day}日")
            if v and v["kind"] == "shift" and (fill or "")[-6:] != color[v["shift"]]:
                bad_color.append(f"{p['name']} {day}日")
    ok(not bad_sym, "Excel のマスの記号と名前が、シフト表と同じ（式に見える名前も文字のまま）", ", ".join(bad_sym[:5]))
    ok(not bad_color, "Excel のシフトのマスに、シフトの「Excel に出すときの色」が付く", ", ".join(bad_color[:5]))
    ok(formulas == 0 and not any(c[2] for sh in book.values() for c in sh.values()), "Excel に式が1つも入らない")
    summ = book["集計表"]
    bad_sum = []
    for i, r in enumerate(summary_rows):
        for j, text in enumerate(r):
            got = summ.get(f"{col_name(j + 1)}{i + 2}", (None,))[0]
            if j == 0:
                if got != text:
                    bad_sum.append(f"{i}:{j}")
            elif got is None or float(got) != float(text):
                bad_sum.append(f"{i}:{j} {got}≠{text}")
    ok(not bad_sum, "Excel の集計表が、画面の集計表と同じ数", ", ".join(bad_sum[:5]))
    band = {k: t(page, f"band-{k}").get_attribute("data-count") for k in ["six", "hard", "soft", "spare", "short"]}
    cnt = book["件数"]
    got = {k: cnt.get(f"B{i}", (None,))[0] for i, k in enumerate(["six", "hard", "soft", "spare", "short"], start=1)}
    ok(got == band, "Excel の件数が、件数の帯と同じ", f"{got} / {band}")

    # CSV
    page.locator('[data-testid="more-ops"] > summary').click()
    with page.expect_download() as dl:
        t(page, "export-csv").click()
    d = dl.value
    ok(re.fullmatch(rf"シフト表_{year}年{month}月_\d{{8}}-\d{{4}}\.csv", d.suggested_filename) is not None, "CSV のファイルの名前に月と日時が入る", d.suggested_filename)
    cpath = OUT / "export-check.csv"
    d.save_as(str(cpath))
    raw = cpath.read_bytes()
    ok(raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw, "CSV は BOM 付きの UTF-8・行の終わりは CRLF")
    import csv as csvmod
    rows = list(csvmod.reader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    ok(rows[0][0] == "スタッフ" and rows[-1][0] == "合計" and len(rows) == len(data["staff"]) + 2, "CSV の形（見出し・人ごと・合計）")
    ok(rows[1][0] == "'=1+1" and rows[2][0] == 'a,"b"' and rows[3][0] == "'@x", "CSV で、= @ で始まる名前は ' を付け、カンマと引用符の名前も崩れない", str([rows[1][0], rows[2][0], rows[3][0]]))
    bad = []
    for i, p in enumerate(data["staff"]):
        for day in range(1, days + 1):
            if rows[i + 1][day] != symbol(data["month"]["table"].get(p["id"], {}).get(str(day))):
                bad.append(f"{i}:{day}")
        if [x for x in rows[i + 1][days + 1:]] != summary_rows[i][1:]:
            bad.append(f"集計 {i}")
    ok(not bad, "CSV のマスの記号と集計が、画面と同じ", ", ".join(bad[:5]))
    ok(not errors, "エラー0 書き出し", " / ".join(errors[:3]))
    ctx.close()

    # スマホの幅でも押せる
    ctx, page, errors = fresh_page(browser, base, 375, "dark")
    page.goto(url)
    t(page, "sample-restaurant").click()
    go(page, 6, 375)
    with page.expect_download() as dl:
        t(page, "export-excel").click()
    ok(dl.value.suggested_filename.endswith(".xlsx"), "スマホの幅でも Excel に出せる")
    look(page, "dark 375 手順6 集計表", "step6-summary-dark-375")
    ok(not errors, "エラー0 書き出し（スマホ）", " / ".join(errors[:3]))
    ctx.close()


def main():
    with Server() as srv, sync_playwright() as pw:
        base = f"http://127.0.0.1:{srv.port}"
        browser = pw.chromium.launch(channel=CHANNEL) if CHANNEL else pw.chromium.launch()
        for scheme in ["light", "dark"]:
            for width in [1280, 390, 375]:
                tour(browser, base, width, scheme)
        scenario_reset_backup(browser, base)
        scenario_month_backup(browser, base)
        scenario_backup_sequences(browser, base)
        scenario_need_grid(browser, base)
        scenario_requests(browser, base)
        scenario_table(browser, base)
        scenario_lock_and_ake(browser, base)
        scenario_import(browser, base)
        scenario_import_more(browser, base)
        scenario_check_view(browser, base)
        scenario_strengths(browser, base)
        scenario_noncount(browser, base)
        scenario_big(browser, base)
        scenario_add_shift(browser, base)
        scenario_text_safety(browser, base)
        scenario_broken(browser, base)
        scenario_generate(browser, base)
        scenario_undo(browser, base)
        scenario_repair(browser, base)
        scenario_export(browser, base)
        browser.close()
    print(json.dumps({"ブラウザ": CHANNEL or "chromium", "合格": len(results["pass"]), "不合格": results["fail"]}, ensure_ascii=False, indent=2))
    sys.exit(1 if results["fail"] else 0)


if __name__ == "__main__":
    main()
