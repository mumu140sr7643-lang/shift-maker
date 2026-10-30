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
  - 保存データが読めないとき、控えを残して知らせるか
終わりに、結果を JSON で表示する。1 つでも失敗があれば、終わりのコードは 1。
"""
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
        scenario_big(browser, base)
        scenario_add_shift(browser, base)
        scenario_text_safety(browser, base)
        scenario_broken(browser, base)
        browser.close()
    print(json.dumps({"ブラウザ": CHANNEL or "chromium", "合格": len(results["pass"]), "不合格": results["fail"]}, ensure_ascii=False, indent=2))
    sys.exit(1 if results["fail"] else 0)


if __name__ == "__main__":
    main()
